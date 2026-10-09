/** Minimal view of Obsidian's TFolder/TFile, so this stays testable without Obsidian. */
export interface TreeNode {
	path: string;
	name: string;
	children?: TreeNode[];
	extension?: string;
	stat?: { size: number };
}

export interface FolderTotals {
	path: string;
	/** Path below the mount root, e.g. "Archive/2019". */
	rel: string;
	depth: number;
	files: number;
	notes: number;
	folders: number;
	bytes: number;
}

export interface MountInsights extends Omit<FolderTotals, 'path' | 'rel' | 'depth'> {
	/** Folders worth looking at, biggest first (by files + folders inside). */
	biggest: FolderTotals[];
}

const NOTE_EXTENSIONS = new Set(['md', 'canvas', 'base', 'mdx']);
const items = (t: Pick<FolderTotals, 'files' | 'folders'>) => t.files + t.folders;

/**
 * Count what a mount brings into the vault, and pick the folders that hold
 * most of it. A subfolder that makes up nearly all of an already-listed
 * parent is skipped (it would just repeat the parent's row).
 */
export function computeInsights(root: TreeNode, options: { maxDepth?: number; limit?: number } = {}): MountInsights {
	const maxDepth = options.maxDepth ?? 3;
	const limit = options.limit ?? 12;
	const all: FolderTotals[] = [];
	const rootPrefix = root.path.length + 1;

	const walk = (folder: TreeNode, depth: number): FolderTotals => {
		const totals: FolderTotals = { path: folder.path, rel: folder.path.slice(rootPrefix), depth, files: 0, notes: 0, folders: 0, bytes: 0 };
		for (const child of folder.children ?? []) {
			if (child.children) {
				const sub = walk(child, depth + 1);
				totals.folders += 1 + sub.folders;
				totals.files += sub.files;
				totals.notes += sub.notes;
				totals.bytes += sub.bytes;
			} else {
				totals.files++;
				totals.bytes += child.stat?.size ?? 0;
				if (NOTE_EXTENSIONS.has((child.extension ?? '').toLowerCase())) totals.notes++;
			}
		}
		if (depth >= 1 && depth <= maxDepth) all.push(totals);
		return totals;
	};
	const total = walk(root, 0);

	all.sort((a, b) => items(b) - items(a));
	const biggest: FolderTotals[] = [];
	for (const candidate of all) {
		if (biggest.length >= limit || items(candidate) === 0) break;
		const parent = biggest.find(p => candidate.path.startsWith(p.path + '/'));
		if (parent && items(candidate) >= 0.8 * items(parent)) continue;
		biggest.push(candidate);
	}
	return { files: total.files, notes: total.notes, folders: total.folders, bytes: total.bytes, biggest };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
