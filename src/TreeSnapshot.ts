import { TFile, TFolder, normalizePath } from 'obsidian';
import { VaultIndex } from './VaultIndex';
import { MountPoint } from './types';

/** [mount-relative path, 0 = folder | 1 = file, mtime, size, ctime] */
type Entry = [string, 0 | 1, number, number, number];

interface MountSnapshot {
	virtualPath: string;
	realPath: string;
	entries: Entry[];
}

export interface SnapshotFile {
	version: 1;
	mounts: Record<string, MountSnapshot>;
}

/**
 * Why this exists: at startup Obsidian loads plugins, then the vault, then
 * initializes its metadata cache, which DROPS cached metadata for every file
 * it cannot see. Mounted files are only discovered later, so without help
 * every launch re-reads every mounted note over the network (measured: 3,003
 * reads for a 3,000-note mount on each reload).
 *
 * The plugin saves what each mount looked like, and puts that tree back into
 * the vault right before the metadata cache initializes. Unchanged notes then
 * hit the cache. The normal scan after startup still reconciles everything
 * with the disk, so a stale snapshot only costs a moment of staleness.
 */
export function captureMount(index: VaultIndex, mount: MountPoint): MountSnapshot | null {
	const rootPath = normalizePath(mount.virtualPath);
	const root = index.get(rootPath);
	if (!(root instanceof TFolder)) return null;
	const entries: Entry[] = [];
	const walk = (folder: TFolder): void => {
		for (const child of folder.children) {
			if (entries.length >= MAX_ENTRIES) return;
			const rel = child.path.slice(rootPath.length + 1);
			if (child instanceof TFolder) {
				entries.push([rel, 0, 0, 0, 0]);
				walk(child);
			} else if (child instanceof TFile) {
				entries.push([rel, 1, child.stat.mtime, child.stat.size, child.stat.ctime]);
			}
		}
	};
	walk(root);
	return { virtualPath: rootPath, realPath: mount.realPath, entries };
}

/** Snapshots stop at this many entries (the startup scan adds the rest); bigger files are not trusted. */
export const MAX_ENTRIES = 300_000;

/** Restore one mount's saved tree. Returns how many items were added. */
export function restoreMount(index: VaultIndex, mount: MountPoint, snapshot: MountSnapshot | undefined): number {
	if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ENTRIES) return 0;
	const rootPath = normalizePath(mount.virtualPath);
	// Only trust a snapshot of this exact mount configuration.
	if (snapshot.virtualPath !== rootPath || snapshot.realPath !== mount.realPath) return 0;
	index.ensureFolder(rootPath);
	let added = 0;
	for (const entry of snapshot.entries) {
		if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
		const [rel, kind, mtime, size, ctime] = entry;
		const segments = rel.split('/');
		if (!rel || segments.some(s => s === '' || s === '.' || s === '..')) continue;
		const path = `${rootPath}/${rel}`;
		if (index.get(path)) continue;
		if (kind === 0) index.addFolder(path);
		else index.addFile(path, { type: 'file', mtime: Number(mtime) || 0, size: Number(size) || 0, ctime: Number(ctime) || 0 });
		added++;
	}
	return added;
}

export function parseSnapshot(text: string | null): SnapshotFile {
	try {
		const data = text ? JSON.parse(text) as SnapshotFile : null;
		if (data?.version === 1 && data.mounts && typeof data.mounts === 'object') return data;
	} catch {
		// Corrupt or partial file: start fresh, the scan rebuilds everything.
	}
	return { version: 1, mounts: {} };
}
