import { TAbstractFile, TFile, TFolder } from 'obsidian';

type Stat = { ctime: number; mtime: number; size: number };

/**
 * In-memory copy of Obsidian 1.x Vault.onChange semantics (taken from the
 * shipped app.js), so VaultIndex/treeSync are tested against the real rules:
 * created events always insert a new object, removed events drop ONE node.
 */
export class FakeVault {
	fileMap: Record<string, TAbstractFile> = {};
	events: string[] = [];

	constructor() {
		const root = new TFolder();
		root.path = '/';
		this.fileMap['/'] = root;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return Object.prototype.hasOwnProperty.call(this.fileMap, path) ? this.fileMap[path] : null;
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return Object.values(this.fileMap);
	}

	private parentOf(path: string): TFolder | null {
		const i = path.lastIndexOf('/');
		const parent = i === -1 ? this.fileMap['/'] : this.fileMap[path.slice(0, i)];
		return parent instanceof TFolder ? parent : null;
	}

	private addChild(item: TAbstractFile): void {
		const parent = this.parentOf(item.path);
		if (parent && parent !== item.parent) {
			if (item.parent) item.parent.children.remove(item);
			parent.children.push(item);
			item.parent = parent;
		}
	}

	private removeChild(item: TAbstractFile): void {
		item.parent?.children.remove(item);
		item.parent = null;
	}

	private setPath(item: TAbstractFile, path: string): void {
		item.path = path;
		item.name = path.split('/').pop() ?? path;
	}

	onChange(event: string, path: string, oldPath?: string | null, stat?: Stat | null): void {
		this.events.push(`${event}:${path}${oldPath ? '<' + oldPath : ''}`);
		if (event === 'folder-created') {
			const f = new TFolder(); this.setPath(f, path);
			this.fileMap[path] = f; this.addChild(f);
		} else if (event === 'file-created') {
			const f = new TFile(); this.setPath(f, path); f.stat = { ...(stat as Stat) };
			this.fileMap[path] = f; this.addChild(f);
		} else if (event === 'modified') {
			const f = this.fileMap[path];
			if (f instanceof TFile) f.stat = { ...(stat as Stat) };
		} else if (event === 'file-removed' || event === 'folder-removed') {
			const f = this.fileMap[path];
			if (f) { this.removeChild(f); delete this.fileMap[path]; }
		} else if (event === 'renamed' && oldPath) {
			const f = this.fileMap[oldPath];
			if (f) {
				this.removeChild(f); this.setPath(f, path); this.addChild(f);
				this.fileMap[path] = f; delete this.fileMap[oldPath];
			}
		}
	}

	/** Sorted list of every path except the root, with a trailing "/" on folders. */
	paths(): string[] {
		return Object.keys(this.fileMap).filter(p => p !== '/')
			.map(p => this.fileMap[p] instanceof TFolder ? p + '/' : p).sort();
	}

	/** Every node's parent links to it and every child is in fileMap. */
	assertConsistent(): void {
		for (const [key, item] of Object.entries(this.fileMap)) {
			if (item.path !== key) throw new Error(`fileMap key ${key} holds ${item.path}`);
			if (key !== '/' && !item.parent?.children.includes(item)) throw new Error(`${key} is not in its parent's children`);
			if (item instanceof TFolder) {
				for (const child of item.children) {
					if (this.fileMap[child.path] !== child) throw new Error(`orphan child ${child.path} under ${key}`);
				}
			}
		}
	}
}

// Obsidian adds Array.prototype.remove; the fake needs it too.
declare global { interface Array<T> { remove(item: T): void } }
if (!Array.prototype.remove) {
	Object.defineProperty(Array.prototype, 'remove', {
		value: function <T>(this: T[], item: T) { const i = this.indexOf(item); if (i !== -1) this.splice(i, 1); },
	});
}

export function fakeApp(vault: FakeVault) {
	return { vault } as unknown as import('obsidian').App;
}
