import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { DataAdapter } from 'obsidian';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { IgnoreMatcher } from '../src/IgnoreMatcher';
import { VirtualAdapter, VirtualAdapterCallbacks } from '../src/VirtualAdapter';
import type { MountPoint } from '../src/types';
// The same module the source gets for 'obsidian' (vitest alias).
import { Notice } from './__mocks__/obsidian';

let root: string;
let vaultDir: string;
let mountDir: string;
let offline = false;
let conflictMode: 'merge' | 'copy' | 'overwrite' = 'copy';

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'fbl-va-'));
	vaultDir = path.join(root, 'vault');
	mountDir = path.join(root, 'share', 'Reports');
	await fs.mkdir(vaultDir, { recursive: true });
	await fs.mkdir(path.join(mountDir, 'Q1'), { recursive: true });
	await fs.writeFile(path.join(mountDir, 'Q1', 'summary.md'), '# Q1');
	await fs.writeFile(path.join(mountDir, 'chart.png'), Buffer.from([1, 2, 3]));
	await fs.mkdir(path.join(mountDir, 'Archive'));
	await fs.writeFile(path.join(mountDir, 'Archive', 'old.md'), 'old');
});

afterEach(async () => {
	known.clear();
	offline = false;
	conflictMode = 'copy';
	await fs.rm(root, { recursive: true, force: true });
});

const known = new Map<string, number>();

async function learn(...paths: string[]): Promise<void> {
	for (const p of paths) known.set(p, Math.round((await fs.stat(path.join(mountDir, ...p.split('/').slice(1)))).mtimeMs));
}

function make(over: Partial<MountPoint> = {}) {
	const mount: MountPoint = {
		id: 'm1', virtualPath: 'Fin', realPath: mountDir, enabled: true, readOnly: false, ignoreList: ['Archive'], ...over,
	};
	const mapper = new PathMapper();
	mapper.update([mount]);
	const security = new SecurityManager();
	security.setAllowlist([mount.realPath]);
	const ignore = new IgnoreMatcher(false);
	ignore.rebuild([], [mount]);
	const original = {
		getBasePath: () => vaultDir,
		exists: vi.fn(async () => false),
		list: vi.fn(async () => ({ files: ['note.md'], folders: [] })),
		read: vi.fn(async () => 'vault content'),
		readBinary: vi.fn(async () => new Uint8Array([9, 9]).buffer),
		writeBinary: vi.fn(async () => { }),
		getResourcePath: vi.fn(() => 'app://id/vault/x'),
		trashLocal: vi.fn(), trashSystem: vi.fn(), rename: vi.fn(), remove: vi.fn(),
	} as unknown as DataAdapter;
	const callbacks: VirtualAdapterCallbacks = {
		confirmUnmount: vi.fn(async () => true),
		onWritten: vi.fn(async (p: string) => {
			const real = path.join(mountDir, ...p.split('/').slice(1));
			known.set(p, Math.round((await fs.stat(real)).mtimeMs));
		}),
		onFolderCreated: vi.fn(),
		onRenamed: vi.fn(),
		onDeleted: vi.fn(async () => { }),
		// Like Obsidian: it knows the files it indexed, and learns new ones on save.
		getKnownMtime: p => known.get(p),
		isOffline: () => offline,
		conflictMode: () => conflictMode,
		requestReload: vi.fn(),
	};
	const adapter = new VirtualAdapter(original, mapper, security, ignore, callbacks);
	return { adapter, callbacks, original, mount, known };
}

describe('VirtualAdapter reads', () => {
	it('lists, stats and reads mounted files, hiding ignored ones', async () => {
		const { adapter } = make();
		const listing = await adapter.list('Fin');
		expect(listing.folders).toEqual(['Fin/Q1']);
		expect(listing.files).toEqual(['Fin/chart.png']);
		expect(await adapter.read('Fin/Q1/summary.md')).toBe('# Q1');
		expect(new Uint8Array(await adapter.readBinary('Fin/chart.png'))).toEqual(new Uint8Array([1, 2, 3]));
		const stat = await adapter.stat('Fin/Q1/summary.md');
		expect(stat).toMatchObject({ type: 'file', size: 4 });
		expect(Number.isInteger(stat!.mtime)).toBe(true);
		expect(await adapter.stat('Fin/Archive/old.md')).toBeNull();
		await expect(adapter.read('Fin/Archive/old.md')).rejects.toThrow(/ignored/);
	});

	it('injects mount folders into vault listings and delegates other paths', async () => {
		const { adapter, original } = make();
		const rootListing = await adapter.list('/');
		expect(rootListing.folders).toContain('Fin');
		expect(await adapter.read('note.md')).toBe('vault content');
		expect(original.read).toHaveBeenCalledWith('note.md');
	});

	it('listMounted throws on unreadable folders while list() stays quiet', async () => {
		const { adapter } = make();
		await expect(adapter.listMounted('Fin/Missing')).rejects.toThrow();
		await expect(adapter.list('Fin/Missing')).resolves.toEqual({ files: [], folders: [] });
	});

	it('applies the file-type filter', async () => {
		const { adapter } = make({ visibleFileFilter: 'markdown-only' });
		expect((await adapter.list('Fin')).files).toEqual([]);
		expect(await adapter.stat('Fin/chart.png')).toBeNull();
	});

	it('builds app:// resource URLs and file:// URLs from the real path', () => {
		const { adapter } = make();
		const url = adapter.getResourcePath('Fin/chart.png');
		expect(url.startsWith('app://test-id/')).toBe(true);
		expect(url).toMatch(/\/share\/Reports\/chart\.png\?\d+$/);
		expect(adapter.getFilePath('Fin/chart.png')).toBe('file://' + path.join(mountDir, 'chart.png'));
		expect(adapter.getFullPath('Fin/chart.png')).toBe(path.join(mountDir, 'chart.png'));
	});

	it('fails fast without touching the disk while the mount is offline', async () => {
		const { adapter } = make();
		offline = true;
		await expect(adapter.read('Fin/Q1/summary.md')).rejects.toThrow(/offline/);
		expect(await adapter.stat('Fin/Q1/summary.md')).toBeNull();
		await expect(adapter.listMounted('Fin')).rejects.toThrow(/offline/);
		await expect(adapter.write('Fin/x.md', 'x')).rejects.toThrow(/offline/);
	});

	it('refuses paths that would leave the mount', async () => {
		const { adapter } = make();
		await expect(adapter.read('Fin/../share/secret.md')).rejects.toThrow();
		expect(await adapter.stat('Fin/Q1/../../x')).toBeNull();
	});
});

describe('VirtualAdapter writes', () => {
	it('writes, registers the file before returning, and creates parent folders', async () => {
		const { adapter, callbacks } = make();
		await adapter.write('Fin/New/note.md', 'hello');
		expect(await fs.readFile(path.join(mountDir, 'New', 'note.md'), 'utf8')).toBe('hello');
		expect(callbacks.onWritten).toHaveBeenCalledWith('Fin/New/note.md');
	});

	it('swallows writes to read-only mounts without touching disk', async () => {
		const { adapter } = make({ readOnly: true });
		await adapter.write('Fin/Q1/summary.md', 'changed');
		await adapter.remove('Fin/Q1/summary.md');
		expect(await fs.readFile(path.join(mountDir, 'Q1', 'summary.md'), 'utf8')).toBe('# Q1');
	});

	it('renames inside a mount and reports it, refusing to overwrite', async () => {
		const { adapter, callbacks } = make();
		await adapter.rename('Fin/Q1/summary.md', 'Fin/Q1/renamed.md');
		expect(callbacks.onRenamed).toHaveBeenCalledWith('Fin/Q1/summary.md', 'Fin/Q1/renamed.md');
		await fs.writeFile(path.join(mountDir, 'Q1', 'other.md'), 'x');
		await expect(adapter.rename('Fin/Q1/renamed.md', 'Fin/Q1/other.md')).rejects.toThrow(/already exists/);
		expect(await fs.readFile(path.join(mountDir, 'Q1', 'other.md'), 'utf8')).toBe('x');
	});

	it('refuses moves across the mount boundary', async () => {
		const { adapter } = make();
		await expect(adapter.rename('Fin/Q1/summary.md', 'Inbox/summary.md')).rejects.toThrow(/across mount/);
	});

	it('copies without overwriting', async () => {
		const { adapter, callbacks } = make();
		await adapter.copy('Fin/Q1/summary.md', 'Fin/copy.md');
		expect(await fs.readFile(path.join(mountDir, 'copy.md'), 'utf8')).toBe('# Q1');
		expect(callbacks.onWritten).toHaveBeenCalledWith('Fin/copy.md');
		await expect(adapter.copy('Fin/Q1/summary.md', 'Fin/copy.md')).rejects.toThrow();
	});

	it('mkdir registers the folder', async () => {
		const { adapter, callbacks } = make();
		await adapter.mkdir('Fin/Q2');
		expect((await fs.stat(path.join(mountDir, 'Q2'))).isDirectory()).toBe(true);
		expect(callbacks.onFolderCreated).toHaveBeenCalledWith('Fin/Q2');
	});

	it('rmdir without recursive refuses a non-empty folder', async () => {
		const { adapter } = make();
		await expect(adapter.rmdir('Fin/Q1', false)).rejects.toThrow();
		expect((await fs.stat(path.join(mountDir, 'Q1'))).isDirectory()).toBe(true);
	});

	it('trash moves the item into .folderbridge-trash on the share, never into the vault', async () => {
		const { adapter, callbacks } = make();
		expect(await adapter.trashSystem('Fin/Q1')).toBe(false); // never the system trash for mounts
		await adapter.trashLocal('Fin/Q1');
		await expect(fs.stat(path.join(mountDir, 'Q1'))).rejects.toMatchObject({ code: 'ENOENT' });
		const trashed = await fs.readdir(path.join(mountDir, '.folderbridge-trash'));
		expect(trashed).toHaveLength(1);
		expect(trashed[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d Q1$/);
		expect(await fs.readFile(path.join(mountDir, '.folderbridge-trash', trashed[0], 'summary.md'), 'utf8')).toBe('# Q1');
		await expect(fs.stat(path.join(vaultDir, '.trash'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(callbacks.onDeleted).toHaveBeenCalledWith('Fin/Q1');
		expect((await adapter.list('Fin')).folders).not.toContain('Fin/.folderbridge-trash');
	});

	it('tells the user once per mount and reason when the file-type rule blocks a write', async () => {
		Notice.shown.length = 0;
		const { adapter, mount } = make({ visibleFileFilter: 'markdown-only' });
		await expect(adapter.writeBinary('Fin/Q1/summary.md.edtz', new ArrayBuffer(2))).rejects.toThrow(/hidden/);
		await expect(adapter.write('Fin/Q1/data.csv', 'a,b')).rejects.toThrow(/hidden/);
		expect(Notice.shown).toHaveLength(1);
		expect(Notice.shown[0]).toMatch(/"summary\.md\.edtz" was not saved in "Fin".*All files/);
		// Reads of hidden files stay quiet; the rule only matters for writes.
		await expect(adapter.read('Fin/chart.png')).rejects.toThrow(/hidden/);
		expect(Notice.shown).toHaveLength(1);
		// Editing the mount resets it, so a still-wrong setting is reported again.
		adapter.clearBlockedNotices(mount.id);
		await expect(adapter.write('Fin/Q1/data.csv', 'a,b')).rejects.toThrow(/hidden/);
		expect(Notice.shown).toHaveLength(2);
		await expect(fs.stat(path.join(mountDir, 'Q1', 'data.csv'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('names the Ignore rule or the program-file rule when that is what blocked a write', async () => {
		Notice.shown.length = 0;
		const { adapter } = make();
		await expect(adapter.write('Fin/Archive/new.md', 'x')).rejects.toThrow(/ignored/);
		await expect(adapter.mkdir('Fin/Archive/Sub')).rejects.toThrow(/ignored/);
		await expect(adapter.writeBinary('Fin/Q1/tool.exe', new ArrayBuffer(1))).rejects.toThrow(/hidden/);
		expect(Notice.shown).toHaveLength(2);
		expect(Notice.shown[0]).toMatch(/Ignore rules/);
		expect(Notice.shown[1]).toMatch(/run programs/);
	});

	it('refuses to permanently delete a folder holding hidden files', async () => {
		const { adapter } = make({ visibleFileFilter: 'markdown-only' });
		await fs.writeFile(path.join(mountDir, 'Q1', 'budget.xlsx'), 'numbers');
		await expect(adapter.rmdir('Fin/Q1', true)).rejects.toThrow(/hidden/);
		expect((await fs.stat(path.join(mountDir, 'Q1', 'budget.xlsx'))).isFile()).toBe(true);
	});

	it('keeps a colleague\'s newer version as a conflict copy before overwriting', async () => {
		const { adapter } = make();
		// Obsidian believes the file has an older mtime than the one on disk.
		known.set('Fin/Q1/summary.md', 1000);
		await adapter.write('Fin/Q1/summary.md', 'mine');
		expect(await fs.readFile(path.join(mountDir, 'Q1', 'summary.md'), 'utf8')).toBe('mine');
		const kept = (await fs.readdir(path.join(mountDir, '.folderbridge-trash'))).filter(n => !n.startsWith('.'));
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatch(/^summary \(changed by someone else .*\)\.md$/);
		expect(await fs.readFile(path.join(mountDir, '.folderbridge-trash', kept[0]), 'utf8')).toBe('# Q1');
	});

	it('hides executables and never hands out a file URL for them', async () => {
		const { adapter } = make();
		await fs.writeFile(path.join(mountDir, 'invoice.exe'), 'MZ');
		await fs.writeFile(path.join(mountDir, 'shortcut.lnk'), 'x');
		expect((await adapter.list('Fin')).files).toEqual(['Fin/chart.png']);
		expect(adapter.getFilePath('Fin/invoice.exe')).toBe('');
	});

	it('statMounted throws on errors but reports confirmed-missing as null', async () => {
		const { adapter } = make();
		expect(await adapter.statMounted('Fin/nope.md')).toBeNull();
		offline = true;
		await expect(adapter.statMounted('Fin/Q1/summary.md')).rejects.toThrow(/offline/);
	});

	it('deleting a mount root only unmounts it, by any delete route', async () => {
		const { adapter, callbacks } = make();
		await adapter.rmdir('Fin', true);
		await adapter.trashLocal('Fin');
		expect(await adapter.trashSystem('Fin')).toBe(true);
		expect(callbacks.confirmUnmount).toHaveBeenCalledTimes(3);
		expect((await fs.stat(path.join(mountDir, 'Q1', 'summary.md'))).isFile()).toBe(true);
		(callbacks.confirmUnmount as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
		await expect(adapter.remove('Fin')).rejects.toThrow(/cancelled/);
	});
});

describe('data safety', () => {
	const real = (...p: string[]) => path.join(mountDir, ...p);

	it('merges a colleague\'s change with mine when different lines changed', async () => {
		conflictMode = 'merge';
		const { adapter, callbacks } = make();
		await fs.writeFile(real('Q1', 'note.md'), 'line 1\nline 2\nline 3\n');
		await learn('Fin/Q1/note.md');
		expect(await adapter.read('Fin/Q1/note.md')).toBe('line 1\nline 2\nline 3\n'); // Obsidian opens it
		await fs.writeFile(real('Q1', 'note.md'), 'line 1\nline 2\nline 3 (theirs)\n'); // colleague saves
		const future = new Date(Date.now() + 5000);
		await fs.utimes(real('Q1', 'note.md'), future, future);
		await adapter.write('Fin/Q1/note.md', 'line 1 (mine)\nline 2\nline 3\n'); // my save
		expect(await fs.readFile(real('Q1', 'note.md'), 'utf8')).toBe('line 1 (mine)\nline 2\nline 3 (theirs)\n');
		expect(callbacks.requestReload).toHaveBeenCalledWith('Fin/Q1/note.md');
	});

	it('falls back to a conflict copy when both changed the same line', async () => {
		conflictMode = 'merge';
		const { adapter } = make();
		await fs.writeFile(real('Q1', 'note.md'), 'total: 100\n');
		await learn('Fin/Q1/note.md');
		await adapter.read('Fin/Q1/note.md');
		await fs.writeFile(real('Q1', 'note.md'), 'total: 200\n');
		const future = new Date(Date.now() + 5000);
		await fs.utimes(real('Q1', 'note.md'), future, future);
		await adapter.write('Fin/Q1/note.md', 'total: 150\n');
		expect(await fs.readFile(real('Q1', 'note.md'), 'utf8')).toBe('total: 150\n');
		const copies = (await fs.readdir(real('.folderbridge-trash'))).filter(n => n.includes('changed by someone else'));
		expect(copies).toHaveLength(1);
		expect(await fs.readFile(real('.folderbridge-trash', copies[0]), 'utf8')).toBe('total: 200\n');
	});

	it('never saves over a file that is not UTF-8, and keeps CRLF and BOM files as they were', async () => {
		const { adapter } = make();
		await fs.writeFile(real('Q1', 'ansi.md'), Buffer.from([0x50, 0x72, 0x69, 0x63, 0x65, 0x20, 0xa3, 0x35, 0x0d, 0x0a])); // "Price £5" in Windows-1252
		await learn('Fin/Q1/ansi.md');
		expect(await adapter.read('Fin/Q1/ansi.md')).toBe('Price £5\r\n');
		await expect(adapter.write('Fin/Q1/ansi.md', 'Price £6\n')).rejects.toThrow(/not stored as UTF-8/);
		expect((await fs.readFile(real('Q1', 'ansi.md')))[6]).toBe(0xa3); // untouched

		await fs.writeFile(real('Q1', 'crlf.md'), Buffer.from('\ufeffa\r\nb\r\n', 'utf8'));
		await learn('Fin/Q1/crlf.md');
		expect(await adapter.read('Fin/Q1/crlf.md')).toBe('a\r\nb\r\n');
		await adapter.write('Fin/Q1/crlf.md', 'a\nb\nc\n');
		expect(await fs.readFile(real('Q1', 'crlf.md'), 'utf8')).toBe('\ufeffa\r\nb\r\nc\r\n');
	});

	it('creating a note never replaces a file that already exists on the drive', async () => {
		const { adapter } = make();
		await fs.writeFile(real('Q1', 'existing.md'), 'keep me');
		await expect(adapter.write('Fin/Q1/existing.md', 'new')).rejects.toThrow();
		expect(await fs.readFile(real('Q1', 'existing.md'), 'utf8')).toBe('keep me');
	});

	it('a failed save keeps the previous version', async () => {
		const { adapter } = make();
		await learn('Fin/Q1/summary.md');
		await fs.chmod(real('Q1', 'summary.md'), 0o444);
		try {
			await expect(adapter.write('Fin/Q1/summary.md', 'new')).rejects.toThrow(/previous version is kept/);
		} finally {
			await fs.chmod(real('Q1', 'summary.md'), 0o644);
		}
		expect(await fs.readFile(real('Q1', 'summary.md'), 'utf8')).toBe('# Q1');
		const saving = await fs.readdir(real('.folderbridge-trash', '.saving'));
		expect(saving).toHaveLength(1);
	});

	it('a successful save leaves no backup behind', async () => {
		const { adapter } = make();
		await learn('Fin/Q1/summary.md');
		await adapter.write('Fin/Q1/summary.md', 'new');
		expect(await fs.readdir(real('.folderbridge-trash', '.saving'))).toHaveLength(0);
	});

	it('permanent deletes go to the trash folder instead', async () => {
		const { adapter } = make();
		await adapter.remove('Fin/chart.png');
		await adapter.rmdir('Fin/Q1', true);
		const trashed = (await fs.readdir(real('.folderbridge-trash'))).filter(n => !n.startsWith('.'));
		expect(trashed.some(n => n.endsWith(' chart.png'))).toBe(true);
		expect(trashed.some(n => n.endsWith(' Q1'))).toBe(true);
	});

	it('refuses to trash a folder holding files Obsidian does not show', async () => {
		const { adapter } = make({ visibleFileFilter: 'markdown-only' });
		await fs.writeFile(real('Q1', 'budget.xlsx'), 'numbers');
		await expect(adapter.trashLocal('Fin/Q1')).rejects.toThrow(/hidden/);
		expect((await fs.stat(real('Q1', 'budget.xlsx'))).isFile()).toBe(true);
	});

	it('refuses to drag a mount root (would rewrite links in shared notes)', async () => {
		const { adapter } = make();
		await expect(adapter.rename('Fin', 'Elsewhere/Fin')).rejects.toThrow(/Edit mount/);
	});

	it('reports "exists" when the drive cannot answer', async () => {
		const { adapter } = make();
		offline = true;
		expect(await adapter.exists('Fin/whatever.md')).toBe(true);
	});

	it('a note moved or deleted on the drive while open is not recreated; the text is kept as a copy', async () => {
		const { adapter, callbacks } = make();
		await learn('Fin/Q1/summary.md');
		const vanished = vi.fn();
		(callbacks as { onVanished?: (p: string) => void }).onVanished = vanished;
		await fs.rename(real('Q1', 'summary.md'), real('Q1', 'moved.md'));
		await adapter.write('Fin/Q1/summary.md', 'my latest text');
		await expect(fs.stat(real('Q1', 'summary.md'))).rejects.toMatchObject({ code: 'ENOENT' });
		const copies = (await fs.readdir(real('.folderbridge-trash'))).filter(n => n.includes('unsaved edits'));
		expect(copies).toHaveLength(1);
		expect(await fs.readFile(real('.folderbridge-trash', copies[0]), 'utf8')).toBe('my latest text');
		await adapter.write('Fin/Q1/summary.md', 'even later text'); // same copy updated, no second file
		expect((await fs.readdir(real('.folderbridge-trash'))).filter(n => n.includes('unsaved edits'))).toHaveLength(1);
		expect(vanished).toHaveBeenCalledWith('Fin/Q1/summary.md');
	});
});

