import { VaultStat } from './types';

export type BatchStat = VaultStat | null | 'error';

export interface BatchStatDeps {
	/** Same contract as TreeSyncDeps.stat: null only when confirmed missing or hidden, throws otherwise. */
	stat(path: string): Promise<VaultStat | null>;
	/** Optional (Windows fast scan): a folder listing that carries file stats. */
	listWithStats?(folderPath: string): Promise<{ files: { path: string; stat?: VaultStat }[]; folders: string[] }>;
	shouldContinue(): boolean;
}

export interface BatchStatOptions {
	/** Changed paths in one folder from which one listing replaces their stats. */
	sameFolderMin?: number;
	/** Single stats in flight at once. */
	concurrency?: number;
}

/**
 * Stat the paths of one watcher batch. Single stats run a few at a time
 * (each is a network round trip on a share). With listWithStats (fast scan),
 * a folder holding many changed paths — a copy or unzip of many files — is
 * listed once instead: the files found in that listing take their stat from
 * it. Everything else (gone, hidden, folders, links) still gets a normal
 * stat, so a missing entry in a listing never decides that a file is gone.
 * Returns null when the batch was abandoned (shouldContinue went false).
 */
export async function statBatch(paths: readonly string[], deps: BatchStatDeps, options: BatchStatOptions = {}): Promise<Map<string, BatchStat> | null> {
	const sameFolderMin = options.sameFolderMin ?? 8;
	const concurrency = Math.max(1, options.concurrency ?? 6);
	const stats = new Map<string, BatchStat>();

	if (deps.listWithStats) {
		const byFolder = new Map<string, string[]>();
		for (const p of paths) {
			const folder = p.slice(0, p.lastIndexOf('/'));
			const list = byFolder.get(folder);
			if (list) list.push(p);
			else byFolder.set(folder, [p]);
		}
		for (const [folder, children] of byFolder) {
			if (children.length < sameFolderMin) continue;
			if (!deps.shouldContinue()) return null;
			try {
				const listing = await deps.listWithStats(folder);
				const listed = new Map(listing.files.map(f => [f.path, f.stat]));
				for (const child of children) {
					const s = listed.get(child);
					if (s) stats.set(child, s);
				}
			} catch { /* the single stats below decide */ }
		}
	}

	const rest = paths.filter(p => !stats.has(p));
	let next = 0;
	let abandoned = false;
	const worker = async (): Promise<void> => {
		while (next < rest.length) {
			if (!deps.shouldContinue()) { abandoned = true; return; }
			const p = rest[next++];
			try {
				stats.set(p, await deps.stat(p));
			} catch {
				stats.set(p, 'error');
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, rest.length) }, worker));
	return abandoned ? null : stats;
}
