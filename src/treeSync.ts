import { VaultStat } from './types';

/** What Obsidian currently holds for a path. */
export type KnownEntry =
	| { kind: 'file'; mtime: number; size: number }
	| { kind: 'folder'; children: string[] }
	| null;

export interface TreeSyncDeps {
	/** List a mounted folder. MUST throw on I/O errors (an empty result means empty). */
	list(folderPath: string): Promise<{ files: string[]; folders: string[] }>;
	/**
	 * Stat a mounted path. null ONLY when the path is confirmed missing (or
	 * hidden by the mount's rules); any other failure MUST throw, so a
	 * network hiccup is never mistaken for a deletion.
	 */
	stat(path: string): Promise<VaultStat | null>;
	/**
	 * Case-insensitive filesystems (Windows, macOS): true when the path's last
	 * segment exists on disk with exactly this capitalisation. Omit on
	 * case-sensitive systems.
	 */
	exactNameExists?(path: string): Promise<boolean>;
	/** Case-insensitive filesystems: a known sibling whose name differs from `path` only in case. */
	findCaseTwin?(path: string): string | undefined;
	known(path: string): KnownEntry;
	addFolder(path: string): void;
	addFile(path: string, stat: VaultStat): void;
	modifyFile(path: string, stat: VaultStat): void;
	removeTree(path: string): Promise<void>;
	/** Checked between steps; return false to abandon (mount disabled, offline, unloading). */
	shouldContinue(): boolean;
	/** Too many I/O errors in a row: the share is probably down. */
	onTrouble?(): void;
	onProgress?(progress: TreeSyncResult): void;
	yieldToEventLoop?(this: void): Promise<void>;
}

export interface TreeSyncResult {
	added: number;
	modified: number;
	removed: number;
	/** Items seen on disk (files + folders), for progress display. */
	scanned: number;
	limitHit: boolean;
	/** Stopped early after repeated I/O errors (see TreeSyncDeps.onTrouble). */
	aborted: boolean;
	/** Folders that could not be listed; their vault contents were left untouched. */
	failedFolders: string[];
}

export interface TreeSyncOptions {
	/** Stop adding new items after this many (0 = unlimited). */
	maxItems?: number;
	/** Parallel stat calls across all folders. Node runs 4 fs calls at once; a few more keeps that queue full. */
	statConcurrency?: number;
	/** Folders listed/processed at the same time. */
	folderConcurrency?: number;
}

/** Deeper than this is almost certainly a link loop. */
export const MAX_DEPTH = 64;
/** Consecutive I/O errors before a scan gives up and reports trouble. */
const ERROR_BREAKER = 5;

const defaultYield = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Tiny counting semaphore. */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= max) await new Promise<void>(resolve => waiting.push(resolve));
		active++;
		try {
			return await task();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

/**
 * Make Obsidian's view of `rootFolder` match the disk: add what is new,
 * update what changed (mtime/size), remove what is gone. Used for the
 * initial index, manual rescans, poll mode, and watcher overflow recovery.
 *
 * Safety rules:
 * - A folder that fails to list is skipped entirely, and a file whose stat
 *   fails is left alone: a network hiccup must never look like "deleted".
 * - Before removing an entry that is missing from a listing, it is
 *   re-checked: a note Obsidian created while the listing was in flight
 *   has a fresh mtime and is kept.
 * - Several I/O errors in a row abort the scan and call onTrouble().
 */
export async function syncTree(rootFolder: string, deps: TreeSyncDeps, options: TreeSyncOptions = {}): Promise<TreeSyncResult> {
	const result: TreeSyncResult = { added: 0, modified: 0, removed: 0, scanned: 0, limitHit: false, aborted: false, failedFolders: [] };
	const maxItems = options.maxItems ?? 0;
	const statLimit = limiter(Math.max(1, options.statConcurrency ?? 6));
	const folderConcurrency = Math.max(1, options.folderConcurrency ?? 3);
	const yieldToEventLoop = deps.yieldToEventLoop ?? defaultYield;
	const scanStarted = Date.now();
	let sinceYield = 0;
	let consecutiveErrors = 0;

	const alive = (): boolean => !result.aborted && deps.shouldContinue();
	const ok = (): void => { consecutiveErrors = 0; };
	const fail = (): void => {
		if (++consecutiveErrors >= ERROR_BREAKER && !result.aborted) {
			result.aborted = true;
			deps.onTrouble?.();
		}
	};
	const tick = async (): Promise<void> => {
		if (++sinceYield >= 200) {
			sinceYield = 0;
			deps.onProgress?.(result);
			await yieldToEventLoop();
		}
	};
	const canAdd = (): boolean => {
		if (maxItems > 0 && result.added >= maxItems) {
			result.limitHit = true;
			return false;
		}
		return true;
	};
	const ABORTED = new Error('scan abandoned');
	const statSafe = async (path: string): Promise<VaultStat | null | 'error'> => {
		try {
			// Re-check when the slot frees up: once the scan is abandoned, queued
			// stats must not keep hitting a dead share.
			const s = await statLimit(() => alive() ? deps.stat(path) : Promise.reject(ABORTED));
			ok();
			return s;
		} catch (e) {
			if (e !== ABORTED) fail();
			return 'error';
		}
	};

	const queue: { folder: string; depth: number }[] = [{ folder: rootFolder, depth: 0 }];

	const syncFolder = async (folder: string, depth: number): Promise<void> => {
		let listing: { files: string[]; folders: string[] };
		try {
			listing = await deps.list(folder);
			ok();
		} catch {
			fail();
			result.failedFolders.push(folder);
			return;
		}
		if (!alive()) return;
		result.scanned += listing.files.length + listing.folders.length;

		// Remove what Obsidian knows but the listing lacks — after a re-check.
		const present = new Set([...listing.files, ...listing.folders]);
		const knownFolder = deps.known(folder);
		if (knownFolder?.kind === 'folder') {
			for (const child of knownFolder.children) {
				if (present.has(child)) continue;
				const recheck = await statSafe(child);
				if (recheck === 'error') continue;
				// Still there with a fresh timestamp: created during this scan.
				if (recheck && recheck.type === 'file' && recheck.mtime >= scanStarted - 2000) continue;
				if (!alive()) return;
				await deps.removeTree(child);
				result.removed++;
			}
		}

		// Folders first so files always have a parent to attach to.
		for (const sub of listing.folders) {
			if (!alive()) return;
			const k = deps.known(sub);
			if (k?.kind !== 'folder') {
				if (!canAdd()) break;
				if (k) { await deps.removeTree(sub); result.removed++; }
				deps.addFolder(sub);
				result.added++;
			}
			if (depth + 1 < MAX_DEPTH) queue.push({ folder: sub, depth: depth + 1 });
			await tick();
		}

		const stats = await Promise.all(listing.files.map(f => statSafe(f)));
		if (!alive()) return;
		for (let i = 0; i < listing.files.length; i++) {
			const file = listing.files[i];
			const stat = stats[i];
			if (stat === 'error' || !stat || stat.type !== 'file') continue; // unreadable, vanished, or raced into a folder
			const k = deps.known(file);
			if (k?.kind === 'file') {
				if (k.mtime !== stat.mtime || k.size !== stat.size) {
					deps.modifyFile(file, stat);
					result.modified++;
				}
			} else {
				if (!canAdd()) break;
				if (k) { await deps.removeTree(file); result.removed++; }
				deps.addFile(file, stat);
				result.added++;
			}
			await tick();
		}
	};

	// A few folder workers share one queue, so listing the next folder
	// overlaps with stat'ing the current one instead of idling between them.
	let running = 0;
	await new Promise<void>(resolve => {
		const pump = (): void => {
			while (running < folderConcurrency && queue.length > 0 && alive()) {
				const next = queue.shift()!;
				running++;
				void syncFolder(next.folder, next.depth)
					.catch(() => { fail(); })
					.finally(() => { running--; pump(); });
			}
			if (running === 0 && (queue.length === 0 || !alive())) resolve();
		};
		pump();
	});

	deps.onProgress?.(result);
	return result;
}

/**
 * Reconcile one path reported by the file watcher: a single stat instead of
 * a folder listing. A folder that appeared is indexed recursively, because
 * moving a folder in reports only the folder itself.
 */
export async function syncPath(path: string, deps: TreeSyncDeps, options: TreeSyncOptions = {}): Promise<void> {
	if (!deps.shouldContinue()) return;
	let stat: VaultStat | null;
	let k = deps.known(path);
	try {
		stat = await deps.stat(path);
		// Case-only rename on Windows: "reports" still stats fine after it
		// became "Reports". When Obsidian knows a sibling differing only in
		// case, ask which name really exists (one parent listing, rare) so
		// neither an old name comes back nor a twin is left behind.
		const twin = stat && !k ? deps.findCaseTwin?.(path) : undefined;
		if (twin && deps.exactNameExists) {
			if (!(await deps.exactNameExists(path))) stat = null;
			else if (!(await deps.exactNameExists(twin))) await deps.removeTree(twin);
		}
	} catch {
		return; // unknown state: change nothing
	}
	if (!deps.shouldContinue()) return;
	k = deps.known(path);
	if (!stat) {
		if (k) await deps.removeTree(path);
		return;
	}
	if (stat.type === 'file') {
		if (k?.kind === 'file') {
			if (k.mtime !== stat.mtime || k.size !== stat.size) deps.modifyFile(path, stat);
			return;
		}
		if (k) await deps.removeTree(path);
		deps.addFile(path, stat);
		return;
	}
	// A known folder: its own event (Windows reports a folder's timestamp
	// change whenever a child changes) needs no work. The children's events
	// arrive separately. Re-listing here would cost a full folder scan per event.
	if (k?.kind === 'folder') return;
	if (k) await deps.removeTree(path);
	deps.addFolder(path);
	await syncTree(path, deps, options);
}
