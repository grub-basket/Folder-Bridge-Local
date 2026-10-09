import { App, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import { VaultStat } from './types';

/**
 * Obsidian's private Vault.onChange(). The desktop file-system adapter calls
 * it from its own watcher; Folder Bridge calls it for mounted paths, which
 * that watcher never sees. It is synchronous. Event semantics (Obsidian 1.x):
 *   folder-created / file-created  always insert a NEW object (so check first)
 *   modified                       updates stat, drops the content cache
 *   file-removed / folder-removed  remove ONE node; children stay in fileMap
 *   renamed (new, old)             re-keys one node; children are separate events
 */
type VaultInternal = {
	onChange(event: string, path: string, oldPath?: string | null, stat?: VaultStat | null): void;
};

/** Thin wrapper around Vault.onChange that keeps Obsidian's tree consistent. */
export class VaultIndex {
	constructor(private readonly app: App) { }

	private emit(event: string, path: string, oldPath: string | null = null, stat: VaultStat | null = null): void {
		(this.app.vault as unknown as VaultInternal).onChange(event, path, oldPath, stat);
	}

	get(path: string): TAbstractFile | null {
		return this.app.vault.getAbstractFileByPath(normalizePath(path));
	}

	/**
	 * Create every missing folder from the vault root down to `path`
	 * (inclusive). Returns false, changing nothing further, when a FILE
	 * stands in the way: that file is never removed to make room.
	 */
	ensureFolder(path: string): boolean {
		const n = normalizePath(path);
		if (this.get(n) instanceof TFolder) return true; // common case: one lookup
		const segments = n.split('/');
		for (let i = 1; i <= segments.length; i++) {
			const part = segments.slice(0, i).join('/');
			const existing = this.get(part);
			if (existing instanceof TFolder) continue;
			if (existing) return false;
			this.emit('folder-created', part);
		}
		return true;
	}

	private ensureParent(path: string): boolean {
		const slash = path.lastIndexOf('/');
		return slash <= 0 || this.ensureFolder(path.slice(0, slash));
	}

	/** Add a file. A folder already at that path must be removed by the caller first. */
	addFile(path: string, stat: VaultStat): void {
		if (this.get(path)) return;
		if (!this.ensureParent(path)) return;
		this.emit('file-created', path, null, stat);
	}

	addFolder(path: string): void {
		this.ensureFolder(path);
	}

	/** Report new content for a known file (or add it when unknown). */
	modifyFile(path: string, stat: VaultStat): void {
		const existing = this.get(path);
		if (existing instanceof TFile) this.emit('modified', path, null, stat);
		else this.addFile(path, stat);
	}

	/** True when Obsidian's copy of the stat differs from disk. */
	isStale(file: TFile, stat: VaultStat): boolean {
		return file.stat.mtime !== stat.mtime || file.stat.size !== stat.size;
	}

	/**
	 * Remove a file, or a folder with everything below it (children first).
	 * Every removal fires vault "delete" listeners (explorer, metadata cache,
	 * Bases), so big subtrees yield to the UI every 500 items.
	 */
	async removeTree(path: string): Promise<void> {
		const root = this.get(path);
		if (!root) return;
		const order: TAbstractFile[] = [];
		const walk = (folder: TFolder): void => {
			for (const child of [...folder.children]) {
				if (child instanceof TFolder) walk(child);
				order.push(child); // post-order: a folder after its contents
			}
		};
		if (root instanceof TFolder) walk(root);
		order.push(root);
		for (let i = 0; i < order.length; i++) {
			const item = order[i];
			// Skip anything already gone or replaced while we yielded.
			if (this.get(item.path) !== item) continue;
			this.emit(item instanceof TFolder ? 'folder-removed' : 'file-removed', item.path);
			if (i % 500 === 499) await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	/**
	 * Mirror Obsidian's own adapter after a successful rename: one "renamed"
	 * event for the item, then one per descendant, so open tabs survive and
	 * Obsidian's automatic link updating runs.
	 */
	renameTree(oldPath: string, newPath: string): void {
		const item = this.get(oldPath);
		if (!item) return;
		const descendants: string[] = [];
		if (item instanceof TFolder) {
			const walk = (folder: TFolder): void => {
				for (const child of folder.children) {
					descendants.push(child.path);
					if (child instanceof TFolder) walk(child);
				}
			};
			walk(item);
		}
		this.ensureParent(newPath);
		this.emit('renamed', newPath, oldPath);
		for (const child of descendants) {
			this.emit('renamed', newPath + child.slice(oldPath.length), child);
		}
	}

	/**
	 * Remove now-empty virtual parent folders of a removed mount ("Finance"
	 * for "Finance/Reports") unless they really exist in the vault.
	 */
	async pruneEmptyParents(path: string, existsInVault: (p: string) => Promise<boolean>): Promise<void> {
		const segments = normalizePath(path).split('/');
		for (let i = segments.length - 1; i >= 1; i--) {
			const part = segments.slice(0, i).join('/');
			const folder = this.get(part);
			if (!(folder instanceof TFolder) || folder.children.length > 0) return;
			if (await existsInVault(part)) return;
			this.emit('folder-removed', part);
		}
	}
}
