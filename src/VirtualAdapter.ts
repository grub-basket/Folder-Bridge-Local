import { normalizePath, Notice, DataAdapter, DataWriteOptions, Platform } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { PathMapper } from './PathMapper';
import { SecurityManager } from './SecurityManager';
import { IgnoreMatcher } from './IgnoreMatcher';
import { ConflictMode, MountPoint, VaultStat } from './types';
import { RecentTexts, TextFormat, decodeText, encodeText, isMergeableText, mergeText } from './textFiles';
import { logger } from './logger';
import { EXECUTABLE_EXTENSIONS, getLowercaseExtension, isVisibleFileInMount } from './mountFileFilter';
import type { FolderLister, RawDirEntry } from './fastScan';
import {
	realPathToResourceUrl,
	realPathToExternalUrl,
	ensureLongPathPrefix,
	stripLongPathPrefix,
	invalidWindowsNameReason,
	translateFsError,
	isCloudPlaceholder,
} from './OSHelpers';

/** Folder (on the share) that receives deleted items and conflict copies. Dot-names are never shown. */
export const TRASH_FOLDER = '.folderbridge-trash';

/**
 * Obsidian's own adapter updates the vault tree from its file watcher, which
 * never sees mounted folders. These callbacks do that job instead, and run
 * BEFORE the adapter call returns: vault.create(), createFolder() and copy()
 * look the new item up immediately afterwards.
 */
export interface VirtualAdapterCallbacks {
	/** The user deleted a mount's root folder: resolve true to unmount, false to cancel. */
	confirmUnmount(mount: MountPoint): Promise<boolean>;
	/** A mounted file was created or written from inside Obsidian. */
	onWritten(normalizedPath: string): Promise<void>;
	/** A mounted folder was created from inside Obsidian. */
	onFolderCreated(normalizedPath: string): void;
	/** A mounted file or folder was renamed from inside Obsidian. */
	onRenamed(oldPath: string, newPath: string): void;
	/** A mounted file or folder was deleted from inside Obsidian. */
	onDeleted(normalizedPath: string): Promise<void>;
	/** mtime Obsidian already holds for a path (resource-URL cache key, conflict check). */
	getKnownMtime(normalizedPath: string): number | undefined;
	/** True while the health check considers this mount unreachable. */
	isOffline(mountId: string): boolean;
	/** Why it is unreachable, when more specific than "offline" (e.g. folder moved). */
	unavailableReason?(mountId: string): string | undefined;
	/** What to do when a note changed on disk since Obsidian last saw it. */
	conflictMode(): ConflictMode;
	/** A save merged in changes from disk: make Obsidian reload the note once its save finished. */
	requestReload(normalizedPath: string): void;
	/** True while a note is open in an editor (its merge base must not be evicted). */
	isOpenInEditor?(normalizedPath: string): boolean;
	/** A note Obsidian knows was saved, but it is gone from the drive (moved or deleted elsewhere). */
	onVanished?(normalizedPath: string): void;
	/** Both sides changed the same lines: offer the merge dialog (their version is already kept as a copy). */
	onUnresolvedConflict?(conflict: { path: string; base?: string; mine: string; theirs: string; copyName: string }): void;
}

function notFound(realPath: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${stripLongPathPrefix(realPath)}'`);
	err.code = 'ENOENT';
	return err;
}

/** Errors that mean "this path is not there", as opposed to "could not check". */
function isMissing(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Same shape as Obsidian's own adapter: ctime is the birth (created) time. */
function toVaultStat(s: fs.Stats): VaultStat {
	return {
		type: s.isDirectory() ? 'folder' : 'file',
		ctime: Math.round(s.birthtimeMs || s.ctimeMs),
		mtime: Math.round(s.mtimeMs),
		size: s.size,
	};
}

/** "2026-10-08 21.40.05" — sortable and valid in Windows file names. */
function stamp(date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
}

/**
 * VirtualAdapter wraps Obsidian's built-in FileSystemAdapter.
 *
 * Every vault I/O method checks whether the path falls inside a mount. If so
 * it runs the operation with Node's `fs` against the real folder (local disk,
 * mapped drive or UNC share). Otherwise it delegates to the original adapter
 * unchanged. Methods this class does not define are forwarded to the
 * original by the Proxy installed in main.ts.
 */
export class VirtualAdapter {
	/** Mount IDs that already showed the read-only notice this session. */
	private readOnlyNoticedMounts = new Set<string>();
	/** "<mount id>:<reason>" pairs whose blocked-write notice was shown. */
	private blockedNoticed = new Set<string>();
	/** Diagnostics: how much mounted I/O this session did. */
	readonly ioStats = { reads: 0, lists: 0, stats: 0, writes: 0, fastLists: 0 };
	/** Mounts where a safety copy could not be made (warned once). */
	private backupWarned = new Set<string>();
	/** How each text file read so far is stored (line endings, BOM, encoding). */
	private formats = new Map<string, TextFormat>();
	/** Last text Obsidian read or wrote per note: the common base for a merge. */
	private recent = new RecentTexts(p => this.callbacks.isOpenInEditor?.(p) ?? false);

	constructor(
		private readonly original: DataAdapter,
		private readonly pathMapper: PathMapper,
		private readonly security: SecurityManager,
		private readonly ignore: IgnoreMatcher,
		private readonly callbacks: VirtualAdapterCallbacks,
	) { }

	private orig(): DataAdapter { return this.original; }

	// The real operation already succeeded when these run, so a failure to
	// update Obsidian's tree is logged, never thrown at the caller.
	private async notifyDelete(normalizedPath: string): Promise<void> {
		try { await this.callbacks.onDeleted(normalizePath(normalizedPath)); } catch (e) { logger.warn('Index update after delete failed', e); }
	}

	private async notifyWritten(normalizedPath: string): Promise<void> {
		try { await this.callbacks.onWritten(normalizePath(normalizedPath)); } catch (e) { logger.warn('Index update after write failed', e); }
	}

	/** Forget the one-shot read-only notice (call when the readOnly flag changes). */
	clearReadOnlyNotice(mountId: string): void {
		this.readOnlyNoticedMounts.delete(mountId);
	}

	/** Forget the one-shot blocked-write notices (call when a mount's rules change). */
	clearBlockedNotices(mountId: string): void {
		for (const key of [...this.blockedNoticed]) {
			if (key.startsWith(mountId + ':')) this.blockedNoticed.delete(key);
		}
	}

	/**
	 * A write refused by the mount's Ignore or File types rules throws, and
	 * Obsidian shows that to the user only when the user did it. Another
	 * plugin saving in the background (an edit history, an export, a cache
	 * file) would fail silently, so say it once per mount and reason.
	 */
	private warnBlocked(mount: MountPoint, reason: 'ignored' | 'type', normalizedPath: string): void {
		const key = `${mount.id}:${reason}`;
		if (this.blockedNoticed.has(key)) return;
		this.blockedNoticed.add(key);
		const name = normalizedPath.split('/').pop() ?? normalizedPath;
		let why: string;
		if (reason === 'ignored') {
			why = 'it matches one of the mount\'s Ignore rules';
		} else if (EXECUTABLE_EXTENSIONS.has(getLowercaseExtension(normalizedPath))) {
			why = 'files that can run programs are never saved to a mount';
		} else {
			const shown = mount.visibleFileFilter === 'pdf-only' ? 'PDFs' : 'notes (Markdown, canvas, Bases)';
			why = `the mount only shows ${shown}. To allow other files, edit the mount (right-click it → Edit mount…) and set File types to "All files"`;
		}
		new Notice(`Folder Bridge: "${name}" was not saved in "${mount.virtualPath}" because ${why}. If you didn't save it yourself, another plugin tried to.`, 15000);
	}

	/** The rule checks for a write, with the one-time notice when one refuses it. */
	private assertWritable(normalizedPath: string, mount: MountPoint, verb: string, checkType = true): void {
		try {
			this.assertUsable(normalizedPath, mount, verb);
		} catch (e) {
			this.warnBlocked(mount, 'ignored', normalizedPath);
			throw e;
		}
		if (!checkType) return;
		try {
			this.assertVisibleFile(normalizedPath, mount);
		} catch (e) {
			this.warnBlocked(mount, 'type', normalizedPath);
			throw e;
		}
	}

	/**
	 * Swallow a write blocked by readOnly and show a one-time notice, instead
	 * of throwing, so the editor never lands in an error state.
	 */
	private warnReadOnly(mount: MountPoint): void {
		if (this.readOnlyNoticedMounts.has(mount.id)) return;
		this.readOnlyNoticedMounts.add(mount.id);
		new Notice(`Folder Bridge: "${mount.virtualPath}" is read-only — this change was not saved.`, 6000);
	}

	// ------------------------------------------------------------------
	// Path helpers
	// ------------------------------------------------------------------

	/**
	 * Resolve a mounted vault path to its real path, enforce the allowlist,
	 * and apply the Windows long-path prefix when needed.
	 */
	private toReal(normalizedPath: string, mount: MountPoint): string {
		// Fail fast while the share is down: every call against a dead SMB
		// server ties up one of Node's four file-system threads for up to a
		// minute, and Obsidian (metadata cache, Bases) would queue hundreds.
		if (this.callbacks.isOffline(mount.id)) {
			const reason = this.callbacks.unavailableReason?.(mount.id);
			throw new Error(reason
				? `Folder Bridge: "${mount.label || mount.virtualPath}": ${reason}`
				: `Folder Bridge: "${mount.label || mount.virtualPath}" is offline. It reconnects automatically when the drive is back.`);
		}
		const realPath = this.pathMapper.toRealPath(normalizedPath, mount);
		if (!this.security.isAllowed(realPath)) {
			throw new Error(`Folder Bridge: "${realPath}" is outside the mounted folders.`);
		}
		return ensureLongPathPrefix(realPath);
	}

	private isPathIgnored(normalizedPath: string, mount: MountPoint): boolean {
		const rel = this.pathMapper.getMountRelativePath(normalizedPath, mount);
		return rel !== undefined && this.ignore.isPathIgnored(rel, mount);
	}

	private assertUsable(normalizedPath: string, mount: MountPoint, verb: string): void {
		if (this.isPathIgnored(normalizedPath, mount)) {
			throw new Error(`Folder Bridge: Cannot ${verb} ignored path "${normalizedPath}".`);
		}
	}

	private assertVisibleFile(normalizedPath: string, mount: MountPoint): void {
		if (!isVisibleFileInMount(normalizedPath, mount)) {
			throw new Error(`Folder Bridge: "${normalizedPath}" is hidden by this mount's file-type rules.`);
		}
	}

	/** Refuse names Windows cannot store, with a readable message instead of a raw OS error. */
	private assertCreatableName(realPath: string): void {
		const reason = invalidWindowsNameReason(path.basename(realPath));
		if (reason) throw new Error(`Folder Bridge: ${reason}`);
	}

	/** Translate a read failure, recognising OneDrive online-only placeholders. */
	private async readError(e: unknown, realPath: string, op: string): Promise<Error> {
		const err = e as NodeJS.ErrnoException;
		if (err.code === 'ENOENT' || err.code === 'EIO' || err.code === 'UNKNOWN') {
			if (await isCloudPlaceholder(realPath)) {
				return new Error(
					`Folder Bridge: "${path.basename(realPath)}" is an online-only OneDrive/SharePoint file and could not be downloaded. ` +
					`Right-click it in File Explorer and choose "Always keep on this device".`
				);
			}
			if (err.code === 'ENOENT') return notFound(realPath);
		}
		return new Error(`Folder Bridge: ${translateFsError(err, op)}`);
	}

	// ------------------------------------------------------------------
	// Read-side operations
	// ------------------------------------------------------------------

	getName(): string { return this.orig().getName?.() ?? 'Vault'; }

	/**
	 * Obsidian's vault.create() resolves files through getFullPath(), and
	 * "Show in system explorer" uses it too. For a mounted path the real file
	 * lives in the mounted folder, not under the vault folder.
	 */
	getFullPath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) return this.pathMapper.toRealPath(normalizedPath, mount);
		return (this.orig() as DataAdapter & { getFullPath?(p: string): string }).getFullPath?.(normalizedPath) ?? normalizedPath;
	}

	/** Real path for a mounted file (Obsidian calls this for some desktop features). */
	getFullRealPath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) return this.pathMapper.toRealPath(normalizedPath, mount);
		return (this.orig() as DataAdapter & { getFullRealPath?(p: string): string }).getFullRealPath?.(normalizedPath) ?? this.getFullPath(normalizedPath);
	}

	/**
	 * file:// URL of a path. Obsidian's "Open in default app" builds its URL
	 * from this, so mounted files open from their real location. Never for
	 * hidden or executable types.
	 */
	getFilePath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			if (!isVisibleFileInMount(normalizedPath, mount) || this.isPathIgnored(normalizedPath, mount)) return '';
			// Obsidian opens this URL for "Open in default app".
			return realPathToExternalUrl(this.pathMapper.toRealPath(normalizedPath, mount));
		}
		return (this.orig() as DataAdapter & { getFilePath?(p: string): string }).getFilePath?.(normalizedPath) ?? normalizedPath;
	}

	async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
		if (this.pathMapper.getMountForPath(normalizedPath)) {
			// When the drive cannot answer, say "exists": vault.create() checks only
			// this before writing, and "missing" there would let it replace a file.
			try {
				return (await this.statMounted(normalizedPath)) !== null;
			} catch {
				return true;
			}
		}
		// A virtual parent of a mount ("Finance" for a mount at "Finance/Reports")
		// exists even when there is no such folder in the vault.
		if (this.pathMapper.hasMountsUnder(normalizedPath)) {
			if (await this.orig().exists(normalizedPath, sensitive)) return true;
			return this.pathMapper.getVirtualMountsDirectChildren(normalizedPath).length > 0;
		}
		return this.orig().exists(normalizedPath, sensitive);
	}

	/**
	 * Stat for the tree sync: null ONLY when the path is confirmed missing or
	 * hidden by the mount's rules. Every other failure (network error, offline
	 * mount, permission) throws, so it is never mistaken for a deletion.
	 */
	async statMounted(normalizedPath: string): Promise<VaultStat | null> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) throw new Error(`Folder Bridge: "${normalizedPath}" is not in a mount.`);
		if (this.isPathIgnored(normalizedPath, mount)) return null;
		const realPath = this.toReal(normalizedPath, mount);
		this.ioStats.stats++;
		let s: fs.Stats;
		try {
			s = await fs.promises.stat(realPath);
		} catch (e) {
			if (isMissing(e)) return null;
			throw e;
		}
		if (s.isFile() && !isVisibleFileInMount(normalizedPath, mount)) return null;
		if (!s.isFile() && !s.isDirectory()) return null;
		return toVaultStat(s);
	}

	/** Obsidian's stat: null for anything it cannot use, including errors. */
	async stat(normalizedPath: string): Promise<VaultStat | null> {
		if (this.pathMapper.getMountForPath(normalizedPath)) {
			try {
				return await this.statMounted(normalizedPath);
			} catch (e) {
				logger.debug(`stat failed for "${normalizedPath}":`, e);
				return null;
			}
		}
		// Virtual intermediate folder (parent of a mount that is not a real vault folder).
		if (this.pathMapper.hasMountsUnder(normalizedPath)) {
			const real = await this.orig().stat(normalizedPath);
			if (real) return real;
			return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
		}
		return this.orig().stat(normalizedPath);
	}

	async list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (mount) {
			try {
				return await this.listMounted(normalizedPath);
			} catch (e) {
				logger.error(`list failed for "${normalizedPath}":`, e);
				// Empty instead of throwing keeps the file explorer usable.
				return { files: [], folders: [] };
			}
		}

		// Merge the real vault listing with injected virtual mount folders.
		let result: { files: string[]; folders: string[] };
		try {
			result = await this.orig().list(normalizedPath);
		} catch {
			result = { files: [], folders: [] }; // may exist only as a virtual parent
		}
		for (const child of this.pathMapper.getVirtualMountsDirectChildren(normalizedPath)) {
			if (!result.folders.includes(child)) result.folders.push(child);
		}
		return result;
	}

	/**
	 * List a mounted folder, THROWING on I/O errors. The tree sync relies on
	 * this: an unreadable folder must never look like an empty one, or a
	 * network blip would remove its contents from the vault.
	 */
	async listMounted(normalizedPath: string): Promise<{ files: string[]; folders: string[] }> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) throw new Error(`Folder Bridge: "${normalizedPath}" is not in a mount.`);
		if (this.isPathIgnored(normalizedPath, mount)) return { files: [], folders: [] };
		const { files, folders } = await this.listRealDirectory(this.toReal(normalizedPath, mount), normalizePath(normalizedPath), mount);
		return { files, folders };
	}

	/**
	 * listMounted, plus the stat of each plain file, from ONE directory query
	 * through the fast-scan helper (Windows). Exactly the same filters apply.
	 * When the helper fails in any way this falls back to listMounted (files
	 * then have no stat, and the caller stats them), so it throws exactly
	 * when listMounted would.
	 */
	async listMountedWithStats(normalizedPath: string, lister: FolderLister): Promise<{ files: { path: string; stat?: VaultStat }[]; folders: string[] }> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) throw new Error(`Folder Bridge: "${normalizedPath}" is not in a mount.`);
		if (this.isPathIgnored(normalizedPath, mount)) return { files: [], folders: [] };
		const realDirPath = this.toReal(normalizedPath, mount);
		let raw: RawDirEntry[] | undefined;
		try {
			raw = await lister.list(realDirPath);
			this.ioStats.fastLists++;
		} catch (e) {
			logger.debug(`Fast scan fell back to fs for "${normalizedPath}":`, e);
		}
		const { files, folders, stats } = await this.listRealDirectory(realDirPath, normalizePath(normalizedPath), mount, raw);
		return { files: files.map(p => ({ path: p, stat: stats.get(p) })), folders };
	}

	/**
	 * List one real folder and apply the mount's rules. `raw` comes from the
	 * fast-scan helper; without it the folder is read with fs.readdir. Both
	 * are typed the same way (see kindFromAttributes), then share every filter.
	 */
	private async listRealDirectory(
		realDirPath: string,
		virtualParentPath: string,
		mount: MountPoint,
		raw?: RawDirEntry[],
	): Promise<{ files: string[]; folders: string[]; stats: Map<string, VaultStat> }> {
		const files: string[] = [];
		const folders: string[] = [];
		/** Plain files the helper already stat'ed (links are always resolved with fs below). */
		const stats = new Map<string, VaultStat>();
		const parentRel = this.pathMapper.getMountRelativePath(virtualParentPath, mount) ?? '';

		let entries: { name: string; kind: RawDirEntry['kind']; raw?: RawDirEntry }[];
		if (raw) {
			entries = raw.map(e => ({ name: e.name, kind: e.kind, raw: e }));
		} else {
			this.ioStats.lists++;
			let dirents: fs.Dirent[];
			try {
				dirents = await fs.promises.readdir(realDirPath, { withFileTypes: true });
			} catch (e) {
				throw new Error(`Folder Bridge: Cannot list "${stripLongPathPrefix(realDirPath)}": ${translateFsError(e as NodeJS.ErrnoException, 'list')}`);
			}
			entries = dirents.map(d => ({
				name: d.name,
				kind: d.isDirectory() ? 'folder'
					: d.isFile() ? 'file'
						// Symlinks / junctions, and entries whose type the share did not report.
						: d.isSymbolicLink() || !(d.isFIFO() || d.isSocket() || d.isBlockDevice() || d.isCharacterDevice()) ? 'link'
							: 'other',
			}));
		}

		const links: { name: string; virtualChild: string }[] = [];
		for (const entry of entries) {
			const entryRel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
			if (this.ignore.isIgnored(entry.name, mount, entryRel)) continue;
			// Names Obsidian would rewrite (backslashes, non-NFC Unicode) or that
			// Windows maps to devices (AUX.md on a Samba share) cannot round-trip
			// to the same file: skip rather than open the wrong thing.
			if (normalizePath(entry.name) !== entry.name || invalidWindowsNameReason(entry.name)) continue;
			const virtualChild = `${virtualParentPath}/${entry.name}`;
			if (entry.kind === 'folder') folders.push(virtualChild);
			else if (entry.kind === 'file') {
				if (!isVisibleFileInMount(virtualChild, mount)) continue;
				files.push(virtualChild);
				// ctime 0 would make toVaultStat fall back to the change time,
				// which a directory query does not return: let fs stat that one.
				if (entry.raw && entry.raw.ctime !== 0) {
					stats.set(virtualChild, { type: 'file', ctime: entry.raw.ctime, mtime: entry.raw.mtime, size: entry.raw.size });
				}
			} else if (entry.kind === 'link') {
				links.push({ name: entry.name, virtualChild });
			}
		}

		// Resolve links a few at a time. A link is followed only when its target
		// stays inside the mounted folders and is not an ancestor of the link
		// (which would loop forever). Errors other than "gone" fail the whole
		// folder, so a briefly unreachable DFS target is not taken for deleted.
		const parentReal = stripLongPathPrefix(realDirPath);
		const toMountForm = links.length > 0 ? await this.resolvedToMountForm(mount) : (p: string) => p;
		for (let i = 0; i < links.length; i += 8) {
			await Promise.all(links.slice(i, i + 8).map(async ({ name, virtualChild }) => {
				const linkPath = path.join(realDirPath, name);
				let s: fs.Stats;
				let target: string;
				try {
					[s, target] = await Promise.all([fs.promises.stat(linkPath), fs.promises.realpath(linkPath)]);
				} catch (e) {
					if (isMissing(e) || (e as NodeJS.ErrnoException).code === 'ELOOP') return; // broken or looping link
					throw new Error(`Folder Bridge: Cannot resolve "${name}": ${translateFsError(e as NodeJS.ErrnoException, 'stat')}`);
				}
				target = toMountForm(stripLongPathPrefix(target));
				const rel = path.relative(target, parentReal);
				const isAncestor = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
				if (!this.security.isAllowed(target) || isAncestor) return;
				if (s.isDirectory()) folders.push(virtualChild);
				else if (s.isFile() && isVisibleFileInMount(virtualChild, mount)) files.push(virtualChild);
			}));
		}
		return { files, folders, stats };
	}

	/**
	 * realpath answers in the folder's resolved form: on a mapped drive
	 * Y:\x comes back as \\server\share\x, through a linked folder as its
	 * target. Map such results back into the mount's own form, so the
	 * allowlist and the loop check compare like with like.
	 */
	private async resolvedToMountForm(mount: MountPoint): Promise<(p: string) => string> {
		const root = stripLongPathPrefix(this.pathMapper.getEffectiveRealPath(mount));
		let resolvedRoot: string;
		try {
			resolvedRoot = stripLongPathPrefix(await fs.promises.realpath(ensureLongPathPrefix(root)));
		} catch {
			return p => p; // compare as before; the checks then refuse what they cannot place
		}
		if (path.relative(resolvedRoot, root) === '') return p => p;
		return p => {
			const rel = path.relative(resolvedRoot, p);
			return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? path.join(root, rel) : p;
		};
	}

	async read(normalizedPath: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().read(normalizedPath);
		this.assertUsable(normalizedPath, mount, 'read');
		this.assertVisibleFile(normalizedPath, mount);
		const realPath = this.toReal(normalizedPath, mount);
		this.ioStats.reads++;
		let buf: Buffer;
		try {
			buf = await fs.promises.readFile(realPath);
		} catch (e) {
			throw await this.readError(e, realPath, 'read');
		}
		const key = normalizePath(normalizedPath);
		const { text, format } = decodeText(buf);
		this.formats.set(key, format);
		this.recent.set(key, text);
		return text;
	}

	async cachedRead(normalizedPath: string): Promise<string> {
		if (this.pathMapper.getMountForPath(normalizedPath)) return this.read(normalizedPath);
		const original = this.orig() as DataAdapter & { cachedRead?: (p: string) => Promise<string> };
		return typeof original.cachedRead === 'function' ? original.cachedRead(normalizedPath) : original.read(normalizedPath);
	}

	async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().readBinary(normalizedPath);
		this.assertUsable(normalizedPath, mount, 'read');
		this.assertVisibleFile(normalizedPath, mount);
		const realPath = this.toReal(normalizedPath, mount);
		this.ioStats.reads++;
		try {
			const buf = await fs.promises.readFile(realPath);
			// A Buffer may be a slice of a shared pool; copy out exactly its bytes.
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		} catch (e) {
			throw await this.readError(e, realPath, 'readBinary');
		}
	}

	/**
	 * URL the renderer uses for images, PDFs and media. Mounted files go
	 * through Obsidian's own app:// handler (see realPathToResourceUrl).
	 * Vault.getResourcePath(TFile) calls this too.
	 */
	getResourcePath(normalizedPath: string): string {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().getResourcePath(normalizedPath);
		const realPath = this.pathMapper.toRealPath(normalizedPath, mount);
		return realPathToResourceUrl(Platform.resourcePathPrefix, realPath, this.callbacks.getKnownMtime(normalizePath(normalizedPath)));
	}

	// ------------------------------------------------------------------
	// Write-side operations
	// ------------------------------------------------------------------

	/** Shared guard for writes. Returns the real path, or null when the write was swallowed (read-only). */
	private prepareWrite(normalizedPath: string, mount: MountPoint, verb: string): string | null {
		if (mount.readOnly) { this.warnReadOnly(mount); return null; }
		this.assertWritable(normalizedPath, mount, verb);
		const realPath = this.toReal(normalizedPath, mount);
		this.assertCreatableName(realPath);
		return realPath;
	}

	/** Run a write; create missing parent folders only when the first try says they are missing. */
	private async withParents<T>(realPath: string, op: () => Promise<T>): Promise<T> {
		try {
			return await op();
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
			await fs.promises.mkdir(path.dirname(realPath), { recursive: true });
			return op();
		}
	}

	/**
	 * A note changed on disk since Obsidian last saw it (a colleague's save
	 * the watcher has not reported yet, or a share that never reports).
	 * Depending on the conflict setting:
	 * - merge: combine both versions (three-way merge against the last text
	 *   Obsidian loaded); Obsidian reloads the result after its save.
	 * - copy (also the fallback when a merge is impossible): keep their
	 *   version as a copy in the trash folder, then save ours.
	 * - overwrite: Obsidian's normal behaviour, last save wins.
	 */
	private async resolveConflict(key: string, realPath: string, mount: MountPoint, mine: string | null): Promise<{ text: string | null; reload: boolean }> {
		const known = this.callbacks.getKnownMtime(key);
		if (known === undefined) return { text: mine, reload: false };
		let onDisk: fs.Stats;
		try {
			onDisk = await fs.promises.stat(realPath);
		} catch {
			return { text: mine, reload: false }; // missing or unreadable: the write reports real problems
		}
		if (!onDisk.isFile() || Math.round(onDisk.mtimeMs) === known) return { text: mine, reload: false };
		const mode = this.callbacks.conflictMode();
		if (mode === 'overwrite') return { text: mine, reload: false };
		const name = path.basename(realPath);
		const base = this.recent.get(key);
		let theirsText: string | undefined;
		if (mode === 'merge' && mine !== null && isMergeableText(key)) {
			const theirs = decodeText(await fs.promises.readFile(realPath));
			if (!theirs.format.unsafe) {
				theirsText = theirs.text;
				if (base !== undefined) {
					const result = mergeText(base, mine, theirs.text);
					if (result.clean) {
						new Notice(`Folder Bridge: "${name}" was changed on the drive while you edited it. Both sets of changes were merged.`, 8000);
						return { text: result.merged, reload: true };
					}
				}
			}
		}
		const ext = path.extname(realPath);
		const copyName = `${path.basename(realPath, ext)} (changed by someone else ${stamp()})${ext}`;
		const trashDir = await this.trashDirFor(realPath, mount);
		await fs.promises.copyFile(realPath, path.join(trashDir, copyName), fs.constants.COPYFILE_EXCL);
		if (theirsText !== undefined && mine !== null && this.callbacks.onUnresolvedConflict) {
			// Your text is saved now; the dialog lets you combine the two afterwards.
			this.callbacks.onUnresolvedConflict({ path: key, base, mine, theirs: theirsText, copyName });
		} else {
			new Notice(`Folder Bridge: "${name}" was changed outside Obsidian and both of you edited the same lines. Their version was kept as "${copyName}" in ${TRASH_FOLDER}.`, 12000);
		}
		return { text: mine, reload: false };
	}

	/**
	 * Write a file without ever losing its current content:
	 * - a file Obsidian does not know yet is created with "wx", so an existing
	 *   file on the share is never replaced by vault.create();
	 * - an existing file is first copied aside (same share, hidden folder);
	 *   writeFile empties the file before writing, so a network drop or a
	 *   full disk mid-save would otherwise leave it empty or cut short. The
	 *   copy is removed once the new content is fully written.
	 * - parent folders are only created for new files, so a save never
	 *   recreates a folder a colleague just moved.
	 */
	private async saveFile(key: string, realPath: string, mount: MountPoint, content: string | Buffer): Promise<'saved' | 'vanished'> {
		const isNew = this.callbacks.getKnownMtime(key) === undefined;
		if (isNew) {
			await this.withParents(realPath, () => fs.promises.writeFile(realPath, content, { flag: 'wx' }));
			return 'saved';
		}
		let backup: string | null = null;
		let current: fs.Stats | null = null;
		try {
			current = await fs.promises.stat(realPath);
		} catch (e) {
			if (!isMissing(e)) throw e;
		}
		if (!current) {
			// Obsidian knows this note but it is gone from the drive: someone
			// moved or deleted it while it was open. Recreating it would bring a
			// deleted note back, or leave a duplicate next to the moved one; keep
			// your text as a copy instead and let the vault catch up.
			await this.keepUnsavedEdits(key, realPath, mount, content);
			return 'vanished';
		}
		try {
			if (current.isFile() && current.size > 0) {
				const dir = path.join(await this.trashDirFor(realPath, mount), '.saving');
				await fs.promises.mkdir(dir, { recursive: true });
				const candidate = path.join(dir, `${stamp()} ${Math.random().toString(36).slice(2, 8)} ${path.basename(realPath)}`);
				await fs.promises.copyFile(realPath, candidate, fs.constants.COPYFILE_EXCL);
				backup = candidate;
			}
		} catch (e) {
			// Best effort: some shares let you edit files but not create new ones.
			// Saving without the safety copy is still better than refusing to save.
			if (!isMissing(e) && !this.backupWarned.has(mount.id)) {
				this.backupWarned.add(mount.id);
				logger.warn(`No safety copy possible on "${mount.virtualPath}" (${(e as Error).message}); saving without one.`);
			}
		}
		try {
			await fs.promises.writeFile(realPath, content);
		} catch (e) {
			const reason = translateFsError(e as NodeJS.ErrnoException, 'save');
			if (backup) throw new Error(`Folder Bridge: "${path.basename(realPath)}" was not saved: ${reason} The previous version is kept at "${stripLongPathPrefix(backup)}".`);
			if (isMissing(e)) throw new Error(`Folder Bridge: "${path.basename(realPath)}" was not saved: its folder no longer exists (moved or deleted on the drive?).`);
			throw new Error(`Folder Bridge: ${reason}`);
		}
		if (backup) await fs.promises.unlink(backup).catch(() => { /* harmless leftover */ });
		return 'saved';
	}

	/** One "unsaved edits" copy per note per session, updated on every later save. */
	private unsavedCopies = new Map<string, string>();

	private async keepUnsavedEdits(key: string, realPath: string, mount: MountPoint, content: string | Buffer): Promise<void> {
		let target = this.unsavedCopies.get(key);
		if (!target) {
			const ext = path.extname(realPath);
			target = path.join(await this.trashDirFor(path.join(this.pathMapper.getEffectiveRealPath(mount), 'x'), mount), `${path.basename(realPath, ext)} (unsaved edits ${stamp()})${ext}`);
			this.unsavedCopies.set(key, target);
			new Notice(`Folder Bridge: "${path.basename(realPath)}" was moved or deleted on the drive while you were editing it. Your text was kept as "${path.basename(target)}" in ${TRASH_FOLDER}.`, 0);
		}
		await fs.promises.writeFile(target, content);
		this.callbacks.onVanished?.(key);
	}

	/** Save some text as a copy in the trash folder next to a mounted note. Returns the copy's name. */
	async keepTextCopy(normalizedPath: string, text: string, label: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) throw new Error(`Folder Bridge: "${normalizedPath}" is not in a mount.`);
		const realPath = this.toReal(normalizedPath, mount);
		const ext = path.extname(realPath);
		const copyName = `${path.basename(realPath, ext)} (${label.replace(/[<>:"/\\|?*]/g, '_')} ${stamp()})${ext}`;
		const trashDir = await this.trashDirFor(realPath, mount);
		await fs.promises.writeFile(path.join(trashDir, copyName), encodeText(text, this.formats.get(normalizePath(normalizedPath))), { flag: 'wx' });
		return copyName;
	}

	private assertWritableText(key: string): TextFormat | undefined {
		const format = this.formats.get(key);
		if (format?.unsafe) {
			throw new Error(
				`Folder Bridge: "${key.split('/').pop()}" is not stored as UTF-8 text (it uses an older Windows or UTF-16 encoding). ` +
				`Saving it from Obsidian would damage characters such as £ € é, so it was not saved. Edit it in the program that created it.`
			);
		}
		return format;
	}

	async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().write(normalizedPath, data, options);
		const realPath = this.prepareWrite(normalizedPath, mount, 'write to');
		if (!realPath) return;
		const key = normalizePath(normalizedPath);
		const format = this.assertWritableText(key);
		this.ioStats.writes++;
		let text = data;
		let reload = false;
		try {
			const resolved = await this.resolveConflict(key, realPath, mount, data);
			text = resolved.text ?? data;
			reload = resolved.reload;
			if (await this.saveFile(key, realPath, mount, encodeText(text, format)) === 'vanished') return;
			await this.applyWriteOptions(realPath, options);
		} catch (e) {
			if ((e as Error).message?.startsWith('Folder Bridge:')) throw e;
			const message = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'write')}`;
			logger.error(`write failed for "${realPath}":`, e);
			throw new Error(message);
		}
		this.recent.set(key, text);
		await this.notifyWritten(normalizedPath);
		if (reload) this.callbacks.requestReload(key);
	}

	async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().writeBinary(normalizedPath, data, options);
		const realPath = this.prepareWrite(normalizedPath, mount, 'write to');
		if (!realPath) return;
		const key = normalizePath(normalizedPath);
		this.ioStats.writes++;
		try {
			await this.resolveConflict(key, realPath, mount, null); // binary: copy or overwrite, never merge
			if (await this.saveFile(key, realPath, mount, Buffer.from(data)) === 'vanished') return;
			await this.applyWriteOptions(realPath, options);
		} catch (e) {
			if ((e as Error).message?.startsWith('Folder Bridge:')) throw e;
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'writeBinary')}`);
		}
		this.recent.delete(key);
		this.formats.delete(key);
		await this.notifyWritten(normalizedPath);
	}

	/** Honour DataWriteOptions.mtime like Obsidian's own adapter (best effort). */
	private async applyWriteOptions(realPath: string, options?: DataWriteOptions): Promise<void> {
		if (!options?.mtime) return;
		try {
			const mtime = new Date(options.mtime);
			await fs.promises.utimes(realPath, mtime, mtime);
		} catch {
			// Some shares refuse timestamp changes; the content is already saved.
		}
	}

	async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().append(normalizedPath, data, options);
		const realPath = this.prepareWrite(normalizedPath, mount, 'append to');
		if (!realPath) return;
		const key = normalizePath(normalizedPath);
		const format = this.assertWritableText(key);
		this.ioStats.writes++;
		try {
			// Appending never empties the file; only line endings are matched (no BOM mid-file).
			await fs.promises.appendFile(realPath, encodeText(data, format ? { ...format, bom: false } : undefined), 'utf8');
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'append')}`);
		}
		this.recent.delete(key);
		await this.notifyWritten(normalizedPath);
	}

	async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) {
			// appendBinary only exists from Obsidian 1.12.3 (minAppVersion is 1.5.0), so it
			// is looked up as an optional method; older versions never call it.
			const forward = (this.original as unknown as Record<string, unknown>)['appendBinary'];
			if (typeof forward !== 'function') throw new Error('Folder Bridge: appendBinary is not available in this Obsidian version.');
			return (forward as (p: string, d: ArrayBuffer, o?: DataWriteOptions) => Promise<void>).call(this.original, normalizedPath, data, options) as Promise<void>;
		}
		const realPath = this.prepareWrite(normalizedPath, mount, 'append to');
		if (!realPath) return;
		this.ioStats.writes++;
		try {
			await fs.promises.appendFile(realPath, Buffer.from(data));
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'appendBinary')}`);
		}
		await this.notifyWritten(normalizedPath);
	}

	async process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().process(normalizedPath, fn, options);
		const content = await this.read(normalizedPath);
		const updated = fn(content);
		if (updated !== content) await this.write(normalizedPath, updated, options);
		return updated;
	}

	async mkdir(normalizedPath: string): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().mkdir(normalizedPath);
		if (mount.readOnly) { this.warnReadOnly(mount); return; }
		this.assertWritable(normalizedPath, mount, 'create', false);
		const realPath = this.toReal(normalizedPath, mount);
		this.assertCreatableName(realPath);
		try {
			await fs.promises.mkdir(realPath, { recursive: true });
		} catch (e) {
			const message = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'mkdir')}`;
			logger.error(`mkdir failed for "${realPath}":`, e);
			throw new Error(message);
		}
		try { this.callbacks.onFolderCreated(normalizePath(normalizedPath)); } catch (e) { logger.warn('Index update after mkdir failed', e); }
	}

	// ------------------------------------------------------------------
	// trash / remove
	// ------------------------------------------------------------------

	/**
	 * Deleting a mount's root folder only ever unmounts it (asking first,
	 * unless the user chose not to be asked). Returns normally when unmounted;
	 * throws when the user cancelled. Deleting a whole share folder from
	 * Obsidian is deliberately impossible.
	 */
	private async unmountInsteadOfDelete(rootMount: MountPoint): Promise<void> {
		if (!(await this.callbacks.confirmUnmount(rootMount))) throw new Error('Folder Bridge: Deletion cancelled.');
	}

	/**
	 * Network shares have no Recycle Bin, and Electron's trash call is not
	 * guaranteed to refuse a permanent delete there. So mounted items never
	 * go to the system trash: returning false makes Obsidian call
	 * trashLocal(), which moves them to the trash folder on the share.
	 */
	async trashSystem(normalizedPath: string): Promise<boolean> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			await this.unmountInsteadOfDelete(rootMount);
			return true;
		}
		if (!this.pathMapper.getMountForPath(normalizedPath)) return this.orig().trashSystem(normalizedPath);
		return false;
	}

	/**
	 * The trash folder for an item: `.folderbridge-trash` at the mount root,
	 * or next to the item when the root is not writable or on another volume
	 * (a junction). Same share, same permissions: deleted finance files never
	 * get copied into the vault.
	 */
	private async trashDirFor(realPath: string, mount: MountPoint): Promise<string> {
		const candidates = [
			path.join(ensureLongPathPrefix(this.pathMapper.getEffectiveRealPath(mount)), TRASH_FOLDER),
			path.join(path.dirname(realPath), TRASH_FOLDER),
		];
		let lastError: unknown;
		for (const dir of candidates) {
			try {
				await fs.promises.mkdir(dir, { recursive: true });
				const [a, b] = await Promise.all([fs.promises.stat(dir), fs.promises.stat(path.dirname(realPath))]);
				if (a.dev === b.dev) return dir;
			} catch (e) {
				lastError = e;
			}
		}
		throw new Error(`Folder Bridge: Cannot create a trash folder next to "${path.basename(realPath)}"${lastError ? `: ${translateFsError(lastError as NodeJS.ErrnoException, 'trash')}` : '.'} Nothing was deleted.`);
	}

	async trashLocal(normalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) return this.unmountInsteadOfDelete(rootMount);
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().trashLocal(normalizedPath);
		if (mount.readOnly) { this.warnReadOnly(mount); return; }
		this.assertUsable(normalizedPath, mount, 'trash');
		const realPath = this.toReal(normalizedPath, mount);
		// A folder that holds things Obsidian does not show (other file types on
		// a "Notes only" mount, ignored or hidden entries) is not moved: the user
		// would be removing files they never saw from colleagues' view.
		let isFolder = false;
		try { isFolder = (await fs.promises.stat(realPath)).isDirectory(); } catch { /* the rename below reports it */ }
		if (isFolder && await this.countHidden(realPath, normalizePath(normalizedPath), mount) > 0) {
			throw new Error(`Folder Bridge: "${path.basename(realPath)}" contains files that are hidden in Obsidian, so it was not moved to the trash. Delete it in File Explorer if you are sure.`);
		}
		const trashDir = await this.trashDirFor(realPath, mount);
		// A rename on the same volume: atomic, nothing is copied or deleted.
		const destination = path.join(trashDir, `${stamp()} ${path.basename(realPath)}`);
		let target = destination;
		for (let n = 2; ; n++) {
			try {
				await fs.promises.access(target);
				target = `${destination} (${n})`;
			} catch {
				break;
			}
		}
		try {
			await fs.promises.rename(realPath, target);
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'trash')} Nothing was deleted.`);
		}
		this.forget(normalizePath(normalizedPath));
		await this.notifyDelete(normalizedPath);
	}

	/** Keep merge bases and formats when a note was moved outside Obsidian. */
	pathRenamed(from: string, to: string): void {
		this.recent.rename(from, to);
		const format = this.formats.get(from);
		if (format) { this.formats.delete(from); this.formats.set(to, format); }
	}

	/** Drop cached text/format for a path and everything below it. */
	private forget(key: string): void {
		this.recent.delete(key);
		this.formats.delete(key);
		for (const k of [...this.formats.keys()]) if (k.startsWith(key + '/')) this.formats.delete(k);
	}

	/**
	 * Count entries under a real folder that Obsidian does not show (ignored,
	 * dot-names, filtered file types). Stops at `limit`.
	 */
	private async countHidden(realDir: string, virtualDir: string, mount: MountPoint, limit = 1): Promise<number> {
		let hidden = 0;
		const walk = async (dir: string, vdir: string): Promise<void> => {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (hidden >= limit) return;
				const vchild = `${vdir}/${entry.name}`;
				const rel = this.pathMapper.getMountRelativePath(vchild, mount) ?? entry.name;
				if (this.ignore.isIgnored(entry.name, mount, rel) || normalizePath(entry.name) !== entry.name) { hidden++; continue; }
				if (entry.isDirectory()) await walk(path.join(dir, entry.name), vchild);
				else if (!entry.isFile() || !isVisibleFileInMount(vchild, mount)) hidden++;
			}
		};
		await walk(realDir, virtualDir);
		return hidden;
	}

	/**
	 * Permanent deletes never happen on a mount: network shares have no
	 * Recycle Bin, and Obsidian calls these when its "Deleted files" setting
	 * is "Permanently delete" (or a sync tool applies remote deletions). They
	 * go to the trash folder on the share instead, with the same checks.
	 * An empty-folder rmdir (recursive=false) is safe and stays a real rmdir.
	 */
	async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) return this.unmountInsteadOfDelete(rootMount);
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().rmdir(normalizedPath, recursive);
		if (recursive) return this.trashLocal(normalizedPath);
		if (mount.readOnly) { this.warnReadOnly(mount); return; }
		this.assertUsable(normalizedPath, mount, 'remove');
		const realPath = this.toReal(normalizedPath, mount);
		try {
			await fs.promises.rmdir(realPath); // fails on a non-empty folder, as the caller asked
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'rmdir')}`);
		}
		await this.notifyDelete(normalizedPath);
	}

	async remove(normalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) return this.unmountInsteadOfDelete(rootMount);
		if (!this.pathMapper.getMountForPath(normalizedPath)) return this.orig().remove(normalizedPath);
		return this.trashLocal(normalizedPath);
	}

	// ------------------------------------------------------------------
	// rename / copy
	// ------------------------------------------------------------------

	async rename(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			// Dragging a mount's folder in the explorer goes through Obsidian's
			// link updater, which would rewrite links in shared notes on the drive
			// to match this vault's layout. Moving it in the mount settings does not.
			throw new Error(`Folder Bridge: "${rootMount.virtualPath}" is a mounted folder. To move it inside the vault, edit the mount (right-click → Edit mount…) and change its vault folder.`);
		}

		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);
		if (!srcMount && !dstMount) return this.orig().rename(normalizedPath, newNormalizedPath);
		if (!srcMount || !dstMount || srcMount.id !== dstMount.id) {
			throw new Error(
				`Folder Bridge: Cannot move "${normalizedPath}" to "${newNormalizedPath}" across mount boundaries. ` +
				`Copy the file instead.`
			);
		}
		if (srcMount.readOnly) { this.warnReadOnly(srcMount); return; }
		this.assertUsable(normalizedPath, srcMount, 'rename');
		this.assertUsable(newNormalizedPath, dstMount, 'rename to');
		const srcReal = this.toReal(normalizedPath, srcMount);
		const dstReal = this.toReal(newNormalizedPath, dstMount);
		this.assertCreatableName(dstReal);

		// vault.create() can register a file and focus its title before
		// write() finished; renaming right away would race the write. OneDrive
		// can also report a transient ENOENT on a freshly written file.
		const MAX_WAIT_MS = 2000;
		const POLL_MS = 100;
		let srcStat: fs.Stats | null = null;
		for (let waited = 0; ; waited += POLL_MS) {
			try {
				srcStat = await fs.promises.stat(srcReal);
				break;
			} catch {
				if (waited >= MAX_WAIT_MS) break;
				await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
			}
		}
		if (!srcStat) {
			throw new Error(
				`Folder Bridge: Cannot rename "${path.basename(srcReal)}": the file was not found after ${MAX_WAIT_MS / 1000} s. ` +
				`If it is an online-only OneDrive file, choose "Always keep on this device" and try again.`,
			);
		}

		// Windows rename silently replaces an existing file; Obsidian expects
		// the move to fail instead. Only a case-only rename of the SAME file
		// ("a.md" → "A.md" on a case-insensitive disk) may pass.
		try {
			const dstStat = await fs.promises.stat(dstReal);
			const sameFile = dstStat.ino === srcStat.ino && dstStat.dev === srcStat.dev && dstStat.ino !== 0;
			if (!sameFile) throw new Error(`Folder Bridge: "${newNormalizedPath}" already exists.`);
		} catch (e) {
			if (!isMissing(e)) throw e;
		}

		try {
			await this.withParents(dstReal, () => fs.promises.rename(srcReal, dstReal));
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'rename')}`);
		}
		this.recent.rename(normalizePath(normalizedPath), normalizePath(newNormalizedPath));
		const format = this.formats.get(normalizePath(normalizedPath));
		this.forget(normalizePath(normalizedPath));
		if (format) this.formats.set(normalizePath(newNormalizedPath), format);
		try {
			this.callbacks.onRenamed(normalizePath(normalizedPath), normalizePath(newNormalizedPath));
		} catch (e) {
			logger.warn('Index update after rename failed', e);
		}
	}

	async copy(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const srcMount = this.pathMapper.getMountForPath(normalizedPath);
		const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);
		if (!srcMount && !dstMount) return this.orig().copy(normalizedPath, newNormalizedPath);
		if (dstMount?.readOnly) { this.warnReadOnly(dstMount); return; }
		if (srcMount) { this.assertUsable(normalizedPath, srcMount, 'copy'); this.assertVisibleFile(normalizedPath, srcMount); }
		if (dstMount) this.assertWritable(newNormalizedPath, dstMount, 'copy to');

		try {
			if (srcMount && dstMount) {
				const dstReal = this.toReal(newNormalizedPath, dstMount);
				this.assertCreatableName(dstReal);
				const srcReal = this.toReal(normalizedPath, srcMount);
				// COPYFILE_EXCL: fail instead of overwriting, like Obsidian's own copy.
				await this.withParents(dstReal, () => fs.promises.copyFile(srcReal, dstReal, fs.constants.COPYFILE_EXCL));
			} else if (srcMount) {
				const buf = await fs.promises.readFile(this.toReal(normalizedPath, srcMount));
				if (await this.orig().exists(newNormalizedPath)) throw new Error(`Folder Bridge: "${newNormalizedPath}" already exists.`);
				await this.orig().writeBinary(newNormalizedPath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
			} else if (dstMount) {
				const data = await this.orig().readBinary(normalizedPath);
				const dstReal = this.toReal(newNormalizedPath, dstMount);
				this.assertCreatableName(dstReal);
				await this.withParents(dstReal, () => fs.promises.writeFile(dstReal, Buffer.from(data), { flag: 'wx' }));
			}
		} catch (e) {
			const err = e as Error;
			if (err.message?.startsWith('Folder Bridge:')) throw err;
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'copy')}`);
		}
		if (dstMount) await this.notifyWritten(newNormalizedPath);
	}
}
