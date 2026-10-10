import { VaultStat } from './types';

export interface Vanished {
	path: string;
	kind: 'file' | 'folder';
	/** For files: what Obsidian last knew. */
	mtime?: number;
	size?: number;
}

export interface Appeared {
	path: string;
	stat: VaultStat;
}

export interface MoveDeps {
	/** Child names Obsidian still has for a vanished folder. */
	knownChildNames(path: string): string[];
	/** Child names on disk for a folder that appeared (may throw: then no pairing). */
	diskChildNames(path: string): Promise<string[]>;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Two folders are "the same" when at least half of their entries share names (or both are empty). */
function similar(a: string[], b: string[]): boolean {
	if (a.length === 0 && b.length === 0) return true;
	const set = new Set(a);
	const shared = b.filter(n => set.has(n)).length;
	return shared / Math.max(a.length, b.length) >= 0.5;
}

/**
 * Pair things that disappeared with things that appeared in the same watcher
 * batch: a move or rename made outside Obsidian (File Explorer, a colleague).
 * Reporting those as renames keeps open tabs on the moved notes, instead of
 * closing them as deleted and showing new files.
 *
 * Files pair when size and modification time match exactly (both survive a
 * move on the same share); ties are broken by an identical name, and
 * anything still ambiguous is left alone. Folders pair when their contents
 * largely match; with several candidates the name must match too.
 */
export async function findMoves(vanished: Vanished[], appeared: Appeared[], deps: MoveDeps): Promise<{ from: string; to: string; kind: 'file' | 'folder' }[]> {
	const moves: { from: string; to: string; kind: 'file' | 'folder' }[] = [];
	const used = new Set<string>();

	for (const a of appeared.filter(x => x.stat.type === 'file')) {
		let candidates = vanished.filter(v => v.kind === 'file' && !used.has(v.path) && v.size === a.stat.size && v.mtime === a.stat.mtime);
		if (candidates.length > 1) candidates = candidates.filter(v => baseName(v.path) === baseName(a.path));
		if (candidates.length !== 1) continue;
		used.add(candidates[0].path);
		moves.push({ from: candidates[0].path, to: a.path, kind: 'file' });
	}

	const goneFolders = vanished.filter(v => v.kind === 'folder');
	const newFolders = appeared.filter(x => x.stat.type === 'folder');
	for (const a of newFolders) {
		let candidates = goneFolders.filter(v => !used.has(v.path));
		if (!(goneFolders.length === 1 && newFolders.length === 1)) {
			candidates = candidates.filter(v => baseName(v.path) === baseName(a.path));
		}
		if (candidates.length !== 1) continue;
		let onDisk: string[];
		try {
			onDisk = await deps.diskChildNames(a.path);
		} catch {
			continue;
		}
		if (!similar(deps.knownChildNames(candidates[0].path), onDisk)) continue;
		used.add(candidates[0].path);
		moves.push({ from: candidates[0].path, to: a.path, kind: 'folder' });
	}
	return moves;
}

/**
 * Watcher paths inside folders that appeared in the same batch. A note moved
 * into a new folder is reported as "new folder" only (the batch collapses to
 * the highest unknown ancestor); these paths let findMoves still see the
 * note itself. Capped: a large folder copied in is not a move to pair.
 */
export function pathsInsideNewFolders(paths: readonly string[], newFolders: readonly string[], limit = 200): string[] {
	const inside = new Set<string>();
	for (const p of paths) {
		if (newFolders.some(f => p.startsWith(f + '/'))) inside.add(p);
		if (inside.size >= limit) break;
	}
	return [...inside];
}
