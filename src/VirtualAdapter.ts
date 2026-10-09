import { normalizePath, Notice, DataAdapter, DataWriteOptions, Platform } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PathMapper } from './PathMapper';
import { SecurityManager } from './SecurityManager';
import { IgnoreMatcher } from './IgnoreMatcher';
import { MountPoint, VaultStat } from './types';
import { logger } from './logger';
import { isVisibleFileInMount } from './mountFileFilter';
import {
	realPathToResourceUrl,
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
	/** The user dragged a mount root to another vault folder. Throws when the move is invalid. */
	onMountRootMove(mount: MountPoint, newVirtualPath: string): Promise<void>;
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
	/** Diagnostics: how much mounted I/O this session did. */
	readonly ioStats = { reads: 0, lists: 0, stats: 0, writes: 0 };

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
			throw new Error(`Folder Bridge: "${mount.label || mount.virtualPath}" is offline. It reconnects automatically when the drive is back.`);
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
			return pathToFileURL(this.pathMapper.toRealPath(normalizedPath, mount)).toString();
		}
		return (this.orig() as DataAdapter & { getFilePath?(p: string): string }).getFilePath?.(normalizedPath) ?? normalizedPath;
	}

	async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
		if (this.pathMapper.getMountForPath(normalizedPath)) {
			return (await this.stat(normalizedPath)) !== null;
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
		return this.listRealDirectory(this.toReal(normalizedPath, mount), normalizePath(normalizedPath), mount);
	}

	private async listRealDirectory(
		realDirPath: string,
		virtualParentPath: string,
		mount: MountPoint,
	): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		const folders: string[] = [];
		const parentRel = this.pathMapper.getMountRelativePath(virtualParentPath, mount) ?? '';

		let entries: fs.Dirent[];
		this.ioStats.lists++;
		try {
			entries = await fs.promises.readdir(realDirPath, { withFileTypes: true });
		} catch (e) {
			throw new Error(`Folder Bridge: Cannot list "${stripLongPathPrefix(realDirPath)}": ${translateFsError(e as NodeJS.ErrnoException, 'list')}`);
		}

		const links: { entry: fs.Dirent; virtualChild: string }[] = [];
		for (const entry of entries) {
			const entryRel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
			if (this.ignore.isIgnored(entry.name, mount, entryRel)) continue;
			// Names Obsidian would rewrite (backslashes, non-NFC Unicode) or that
			// Windows maps to devices (AUX.md on a Samba share) cannot round-trip
			// to the same file: skip rather than open the wrong thing.
			if (normalizePath(entry.name) !== entry.name || invalidWindowsNameReason(entry.name)) continue;
			const virtualChild = `${virtualParentPath}/${entry.name}`;
			if (entry.isDirectory()) folders.push(virtualChild);
			else if (entry.isFile()) {
				if (isVisibleFileInMount(virtualChild, mount)) files.push(virtualChild);
			} else if (entry.isSymbolicLink() || !(entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice())) {
				// Symlinks / junctions, and entries whose type the share did not report.
				links.push({ entry, virtualChild });
			}
		}

		// Resolve links a few at a time. A link is followed only when its target
		// stays inside the mounted folders and is not an ancestor of the link
		// (which would loop forever). Errors other than "gone" fail the whole
		// folder, so a briefly unreachable DFS target is not taken for deleted.
		const parentReal = stripLongPathPrefix(realDirPath);
		for (let i = 0; i < links.length; i += 8) {
			await Promise.all(links.slice(i, i + 8).map(async ({ entry, virtualChild }) => {
				const linkPath = path.join(realDirPath, entry.name);
				let s: fs.Stats;
				let target: string;
				try {
					[s, target] = await Promise.all([fs.promises.stat(linkPath), fs.promises.realpath(linkPath)]);
				} catch (e) {
					if (isMissing(e) || (e as NodeJS.ErrnoException).code === 'ELOOP') return; // broken or looping link
					throw new Error(`Folder Bridge: Cannot resolve "${entry.name}": ${translateFsError(e as NodeJS.ErrnoException, 'stat')}`);
				}
				const rel = path.relative(target, parentReal);
				const isAncestor = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
				if (!this.security.isAllowed(target) || isAncestor) return;
				if (s.isDirectory()) folders.push(virtualChild);
				else if (s.isFile() && isVisibleFileInMount(virtualChild, mount)) files.push(virtualChild);
			}));
		}
		return { files, folders };
	}

	async read(normalizedPath: string): Promise<string> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().read(normalizedPath);
		this.assertUsable(normalizedPath, mount, 'read');
		this.assertVisibleFile(normalizedPath, mount);
		const realPath = this.toReal(normalizedPath, mount);
		this.ioStats.reads++;
		try {
			return await fs.promises.readFile(realPath, 'utf8');
		} catch (e) {
			throw await this.readError(e, realPath, 'read');
		}
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
		this.assertUsable(normalizedPath, mount, verb);
		this.assertVisibleFile(normalizedPath, mount);
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
	 * Before overwriting a file Obsidian knows, check that nobody changed it
	 * on the share since (a colleague's save the watcher has not reported, or
	 * that a share never reports). If they did, keep their version as a
	 * conflict copy in the trash folder instead of silently replacing it.
	 */
	private async protectOtherEdits(normalizedPath: string, realPath: string, mount: MountPoint): Promise<void> {
		const known = this.callbacks.getKnownMtime(normalizePath(normalizedPath));
		if (known === undefined) return;
		let onDisk: fs.Stats;
		try {
			onDisk = await fs.promises.stat(realPath);
		} catch {
			return; // missing or unreadable: the write itself reports real problems
		}
		if (!onDisk.isFile() || Math.round(onDisk.mtimeMs) === known) return;
		const ext = path.extname(realPath);
		const name = `${path.basename(realPath, ext)} (changed by someone else ${stamp()})${ext}`;
		const trashDir = await this.trashDirFor(realPath, mount);
		await fs.promises.copyFile(realPath, path.join(trashDir, name), fs.constants.COPYFILE_EXCL);
		new Notice(`Folder Bridge: "${path.basename(realPath)}" was changed outside Obsidian. Their version was kept as "${name}" in ${TRASH_FOLDER}.`, 12000);
	}

	async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().write(normalizedPath, data, options);
		const realPath = this.prepareWrite(normalizedPath, mount, 'write to');
		if (!realPath) return;
		this.ioStats.writes++;
		try {
			await this.protectOtherEdits(normalizedPath, realPath, mount);
			await this.withParents(realPath, () => fs.promises.writeFile(realPath, data, 'utf8'));
			await this.applyWriteOptions(realPath, options);
		} catch (e) {
			const message = `Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'write')}`;
			logger.error(`write failed for "${realPath}":`, e);
			throw new Error(message);
		}
		await this.notifyWritten(normalizedPath);
	}

	async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().writeBinary(normalizedPath, data, options);
		const realPath = this.prepareWrite(normalizedPath, mount, 'write to');
		if (!realPath) return;
		this.ioStats.writes++;
		try {
			await this.protectOtherEdits(normalizedPath, realPath, mount);
			await this.withParents(realPath, () => fs.promises.writeFile(realPath, Buffer.from(data)));
			await this.applyWriteOptions(realPath, options);
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'writeBinary')}`);
		}
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
		this.ioStats.writes++;
		try {
			await fs.promises.appendFile(realPath, data, 'utf8');
		} catch (e) {
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'append')}`);
		}
		await this.notifyWritten(normalizedPath);
	}

	async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) {
			// appendBinary exists from Obsidian 1.12.3; older versions never call it.
			const original = this.orig() as DataAdapter & { appendBinary?(p: string, d: ArrayBuffer, o?: DataWriteOptions): Promise<void> };
			if (!original.appendBinary) throw new Error('Folder Bridge: appendBinary is not available in this Obsidian version.');
			return original.appendBinary(normalizedPath, data, options);
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
		this.assertUsable(normalizedPath, mount, 'create');
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
		await this.notifyDelete(normalizedPath);
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

	async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) return this.unmountInsteadOfDelete(rootMount);
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().rmdir(normalizedPath, recursive);
		if (mount.readOnly) { this.warnReadOnly(mount); return; }
		this.assertUsable(normalizedPath, mount, 'remove');
		const realPath = this.toReal(normalizedPath, mount);
		try {
			if (recursive) {
				// Permanent delete of a folder: refuse when it holds things the
				// user cannot see in Obsidian (spreadsheets on a "Markdown only"
				// mount, ignored folders, executables), instead of silently
				// destroying them along with the visible notes.
				if (await this.countHidden(realPath, normalizePath(normalizedPath), mount) > 0) {
					throw new Error(`Folder Bridge: "${path.basename(realPath)}" contains files that are hidden in Obsidian, so it was not deleted. Delete it in File Explorer if you are sure.`);
				}
				await fs.promises.rm(realPath, { recursive: true });
			} else {
				await fs.promises.rmdir(realPath); // fails on a non-empty folder, as the caller asked
			}
		} catch (e) {
			if ((e as Error).message?.startsWith('Folder Bridge:')) throw e;
			throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'rmdir')}`);
		}
		await this.notifyDelete(normalizedPath);
	}

	async remove(normalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) return this.unmountInsteadOfDelete(rootMount);
		const mount = this.pathMapper.getMountForPath(normalizedPath);
		if (!mount) return this.orig().remove(normalizedPath);
		if (mount.readOnly) { this.warnReadOnly(mount); return; }
		this.assertUsable(normalizedPath, mount, 'remove');
		const realPath = this.toReal(normalizedPath, mount);
		try {
			await fs.promises.unlink(realPath);
		} catch (e) {
			if (!isMissing(e)) throw new Error(`Folder Bridge: ${translateFsError(e as NodeJS.ErrnoException, 'remove')}`);
		}
		await this.notifyDelete(normalizedPath);
	}

	// ------------------------------------------------------------------
	// rename / copy
	// ------------------------------------------------------------------

	async rename(normalizedPath: string, newNormalizedPath: string): Promise<void> {
		const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
		if (rootMount) {
			// The user moved the mount root folder in the file explorer: move the
			// mount inside the vault; the real folder on disk is untouched.
			await this.callbacks.onMountRootMove(rootMount, newNormalizedPath);
			return;
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
		if (dstMount) { this.assertUsable(newNormalizedPath, dstMount, 'copy to'); this.assertVisibleFile(newNormalizedPath, dstMount); }

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
