import { describe, expect, it } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { FakeVault, fakeApp } from './helpers/fakeVault';
import { VaultIndex } from '../src/VaultIndex';
import { KnownEntry, TreeSyncDeps, syncPath, syncTree } from '../src/treeSync';
import type { VaultStat } from '../src/types';

/** A fake disk: path → stat, folders end without slash. */
class FakeDisk {
	entries = new Map<string, VaultStat>();
	failing = new Set<string>();
	statFailing = new Set<string>();
	/** Simulate a case-insensitive disk: stat ignores case, listings keep the real case. */
	caseInsensitive = false;
	listCalls = 0;
	statCalls = 0;
	folder(p: string): this { this.entries.set(p, { type: 'folder', ctime: 0, mtime: 0, size: 0 }); return this; }
	file(p: string, mtime = 1, size = 10): this { this.entries.set(p, { type: 'file', ctime: 0, mtime, size }); return this; }
	delete(p: string): void { for (const k of [...this.entries.keys()]) if (k === p || k.startsWith(p + '/')) this.entries.delete(k); }
	async list(folder: string) {
		this.listCalls++;
		if (this.failing.has(folder)) throw new Error('EIO: network glitch');
		const files: string[] = []; const folders: string[] = [];
		for (const [p, s] of this.entries) {
			if (p.startsWith(folder + '/') && !p.slice(folder.length + 1).includes('/')) (s.type === 'folder' ? folders : files).push(p);
		}
		return { files, folders };
	}
	async stat(p: string) {
		this.statCalls++;
		if (this.statFailing.has(p)) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
		if (this.caseInsensitive) {
			for (const [k, v] of this.entries) if (k.toLowerCase() === p.toLowerCase()) return v;
			return null;
		}
		return this.entries.get(p) ?? null;
	}
	async exact(p: string) { return this.entries.has(p); }
}

function setup(disk: FakeDisk) {
	const vault = new FakeVault();
	const index = new VaultIndex(fakeApp(vault));
	let alive = true;
	const deps: TreeSyncDeps = {
		list: p => disk.list(p),
		stat: p => disk.stat(p),
		known: (p): KnownEntry => {
			const item = index.get(p);
			if (item instanceof TFile) return { kind: 'file', mtime: item.stat.mtime, size: item.stat.size };
			if (item instanceof TFolder) return { kind: 'folder', children: item.children.map(c => c.path) };
			return null;
		},
		addFolder: p => index.addFolder(p),
		addFile: (p, s) => index.addFile(p, s),
		modifyFile: (p, s) => index.modifyFile(p, s),
		removeTree: p => index.removeTree(p),
		exactNameExists: undefined,
		shouldContinue: () => alive,
		yieldToEventLoop: async () => { },
	};
	index.ensureFolder('Fin');
	return { vault, index, deps, stop: () => { alive = false; } };
}

describe('syncTree', () => {
	it('indexes a fresh mount, folders before their files', async () => {
		const disk = new FakeDisk().folder('Fin/Q1').file('Fin/a.md').file('Fin/Q1/b.md').folder('Fin/Q1/Deep').file('Fin/Q1/Deep/c.md');
		const { vault, deps } = setup(disk);
		const result = await syncTree('Fin', deps);
		expect(vault.paths()).toEqual(['Fin/', 'Fin/Q1/', 'Fin/Q1/Deep/', 'Fin/Q1/Deep/c.md', 'Fin/Q1/b.md', 'Fin/a.md']);
		expect(result).toMatchObject({ added: 5, modified: 0, removed: 0 });
		vault.assertConsistent();
	});

	it('adds, updates and removes on a second pass, with no orphans', async () => {
		const disk = new FakeDisk().folder('Fin/Q1').file('Fin/a.md').file('Fin/Q1/b.md').folder('Fin/Q1/Deep').file('Fin/Q1/Deep/c.md');
		const { vault, deps } = setup(disk);
		await syncTree('Fin', deps);
		disk.delete('Fin/Q1');
		disk.file('Fin/a.md', 2, 20).file('Fin/new.md');
		const result = await syncTree('Fin', deps);
		expect(vault.paths()).toEqual(['Fin/', 'Fin/a.md', 'Fin/new.md']);
		expect(result).toMatchObject({ added: 1, modified: 1, removed: 1 });
		expect((vault.getAbstractFileByPath('Fin/a.md') as TFile).stat.mtime).toBe(2);
		vault.assertConsistent();
	});

	it('never removes anything under a folder that failed to list', async () => {
		const disk = new FakeDisk().folder('Fin/Q1').file('Fin/Q1/b.md').file('Fin/a.md');
		const { vault, deps } = setup(disk);
		await syncTree('Fin', deps);
		disk.failing.add('Fin/Q1');
		const result = await syncTree('Fin', deps);
		expect(result.failedFolders).toEqual(['Fin/Q1']);
		expect(vault.paths()).toContain('Fin/Q1/b.md');
		disk.failing.add('Fin');
		await syncTree('Fin', deps);
		expect(vault.paths()).toContain('Fin/a.md');
	});

	it('replaces an item whose type changed', async () => {
		const disk = new FakeDisk().file('Fin/x');
		const { vault, deps } = setup(disk);
		await syncTree('Fin', deps);
		disk.delete('Fin/x');
		disk.folder('Fin/x').file('Fin/x/inner.md');
		await syncTree('Fin', deps);
		expect(vault.getAbstractFileByPath('Fin/x')).toBeInstanceOf(TFolder);
		expect(vault.paths()).toContain('Fin/x/inner.md');
		vault.assertConsistent();
	});

	it('stops adding at the item limit', async () => {
		const disk = new FakeDisk();
		for (let i = 0; i < 20; i++) disk.file(`Fin/f${i}.md`);
		const { vault, deps } = setup(disk);
		const result = await syncTree('Fin', deps, { maxItems: 5 });
		expect(result.limitHit).toBe(true);
		expect(vault.paths().filter(p => p.endsWith('.md'))).toHaveLength(5);
	});

	it('stops when the mount is deactivated mid-scan', async () => {
		const disk = new FakeDisk();
		for (let i = 0; i < 50; i++) disk.folder(`Fin/d${i}`).file(`Fin/d${i}/x.md`);
		const s = setup(disk);
		const realList = s.deps.list;
		s.deps.list = async p => { if (p === 'Fin/d3') s.stop(); return realList(p); };
		await syncTree('Fin', s.deps);
		expect(disk.listCalls).toBeLessThan(10);
	});
});

describe('review fixes', () => {
	it('a stat error never removes anything (watcher or scan)', async () => {
		const disk = new FakeDisk().folder('Fin/Q1').file('Fin/Q1/a.md');
		const { vault, deps } = setup(disk);
		await syncTree('Fin', deps);
		disk.statFailing.add('Fin/Q1');
		disk.statFailing.add('Fin/Q1/a.md');
		await syncPath('Fin/Q1', deps);
		await syncPath('Fin/Q1/a.md', deps);
		expect(vault.paths()).toContain('Fin/Q1/a.md');
	});

	it('a case-only rename does not leave the old name behind', async () => {
		const disk = new FakeDisk().folder('Fin/reports').file('Fin/reports/x.md');
		disk.caseInsensitive = true;
		const { vault, deps } = setup(disk);
		deps.exactNameExists = p => disk.exact(p);
		deps.findCaseTwin = p => vault.paths().map(x => x.replace(/\/$/, '')).find(x => x !== p && x.toLowerCase() === p.toLowerCase());
		await syncTree('Fin', deps);
		disk.delete('Fin/reports');
		disk.folder('Fin/Reports').file('Fin/Reports/x.md');
		await syncPath('Fin/reports', deps); // old name: stats fine on a case-insensitive disk
		await syncPath('Fin/Reports', deps);
		expect(vault.paths()).toEqual(['Fin/', 'Fin/Reports/', 'Fin/Reports/x.md']);
		await syncTree('Fin', deps); // a full scan agrees
		expect(vault.paths()).toEqual(['Fin/', 'Fin/Reports/', 'Fin/Reports/x.md']);
		vault.assertConsistent();
	});

	it('keeps a note created while the scan was running', async () => {
		const disk = new FakeDisk().file('Fin/a.md');
		const { vault, index, deps } = setup(disk);
		await syncTree('Fin', deps);
		const realList = deps.list;
		deps.list = async p => {
			const listing = await realList(p);
			// Obsidian creates a note right after this listing was taken.
			disk.file('Fin/new.md', Date.now());
			index.addFile('Fin/new.md', { type: 'file', ctime: 0, mtime: Date.now(), size: 10 });
			return listing;
		};
		await syncTree('Fin', deps);
		expect(vault.paths()).toContain('Fin/new.md');
	});

	it('aborts after repeated I/O errors and reports trouble', async () => {
		const disk = new FakeDisk();
		for (let i = 0; i < 30; i++) { disk.file(`Fin/f${i}.md`); disk.statFailing.add(`Fin/f${i}.md`); }
		const { deps } = setup(disk);
		let trouble = 0;
		deps.onTrouble = () => { trouble++; };
		const result = await syncTree('Fin', deps, { statConcurrency: 1 });
		expect(result.aborted).toBe(true);
		expect(trouble).toBe(1);
		expect(disk.statCalls).toBeLessThan(30);
	});

	it('stops descending at the depth limit (link loops)', async () => {
		const disk = new FakeDisk();
		let p = 'Fin';
		for (let i = 0; i < 80; i++) { p += '/d'; disk.folder(p); }
		const { vault, deps } = setup(disk);
		await syncTree('Fin', deps);
		const depth = Math.max(...vault.paths().map(x => x.split('/').length));
		expect(depth).toBeLessThanOrEqual(66);
	});
});

describe('syncPath (watcher events)', () => {
	it('handles create, change and delete of single files', async () => {
		const disk = new FakeDisk();
		const { vault, deps } = setup(disk);
		disk.file('Fin/a.md');
		await syncPath('Fin/a.md', deps);
		expect(vault.paths()).toContain('Fin/a.md');
		disk.file('Fin/a.md', 5, 99);
		await syncPath('Fin/a.md', deps);
		expect((vault.getAbstractFileByPath('Fin/a.md') as TFile).stat.size).toBe(99);
		disk.delete('Fin/a.md');
		await syncPath('Fin/a.md', deps);
		expect(vault.paths()).not.toContain('Fin/a.md');
	});

	it('indexes a whole folder that was moved in, and creates missing parents', async () => {
		const disk = new FakeDisk().folder('Fin/2024').folder('Fin/2024/Q1').file('Fin/2024/Q1/r.md');
		const { vault, deps } = setup(disk);
		await syncPath('Fin/2024', deps);
		expect(vault.paths()).toEqual(['Fin/', 'Fin/2024/', 'Fin/2024/Q1/', 'Fin/2024/Q1/r.md']);
		disk.folder('Fin/Other').file('Fin/Other/deep.md');
		await syncPath('Fin/Other/deep.md', deps); // parent folder event not seen yet
		expect(vault.paths()).toContain('Fin/Other/deep.md');
		vault.assertConsistent();
	});

	it('does not rescan a known folder on its own timestamp event', async () => {
		const disk = new FakeDisk().folder('Fin/Big');
		for (let i = 0; i < 100; i++) disk.file(`Fin/Big/f${i}.md`);
		const { deps } = setup(disk);
		await syncTree('Fin', deps);
		disk.listCalls = 0; disk.statCalls = 0;
		await syncPath('Fin/Big', deps);
		expect(disk.listCalls).toBe(0);
		expect(disk.statCalls).toBe(1);
	});
});

describe('VaultIndex', () => {
	it('renames a folder and all descendants, like Obsidian\'s adapter', () => {
		const vault = new FakeVault();
		const index = new VaultIndex(fakeApp(vault));
		index.addFile('Fin/Q1/Deep/c.md', { type: 'file', ctime: 0, mtime: 1, size: 1 });
		index.addFile('Fin/Q1/b.md', { type: 'file', ctime: 0, mtime: 1, size: 1 });
		const file = vault.getAbstractFileByPath('Fin/Q1/b.md');
		index.renameTree('Fin/Q1', 'Fin/Quarter 1');
		expect(vault.paths()).toEqual(['Fin/', 'Fin/Quarter 1/', 'Fin/Quarter 1/Deep/', 'Fin/Quarter 1/Deep/c.md', 'Fin/Quarter 1/b.md']);
		expect(vault.getAbstractFileByPath('Fin/Quarter 1/b.md')).toBe(file); // same object: open tabs survive
		vault.assertConsistent();
	});

	it('removes a subtree completely and prunes empty virtual parents', async () => {
		const vault = new FakeVault();
		const index = new VaultIndex(fakeApp(vault));
		index.addFile('Shared/Fin/Q1/c.md', { type: 'file', ctime: 0, mtime: 1, size: 1 });
		index.removeTree('Shared/Fin');
		expect(vault.paths()).toEqual(['Shared/']);
		await index.pruneEmptyParents('Shared/Fin', async () => false);
		expect(vault.paths()).toEqual([]);
		vault.assertConsistent();
	});

	it('keeps a real vault folder when pruning', async () => {
		const vault = new FakeVault();
		const index = new VaultIndex(fakeApp(vault));
		index.ensureFolder('Real/Mount');
		index.removeTree('Real/Mount');
		await index.pruneEmptyParents('Real/Mount', async p => p === 'Real');
		expect(vault.paths()).toEqual(['Real/']);
	});
});
