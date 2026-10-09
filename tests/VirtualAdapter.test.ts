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

let root: string;
let vaultDir: string;
let mountDir: string;
let offline = false;

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
	offline = false;
	await fs.rm(root, { recursive: true, force: true });
});

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
		onMountRootMove: vi.fn(async () => { }),
		onWritten: vi.fn(async () => { }),
		onFolderCreated: vi.fn(),
		onRenamed: vi.fn(),
		onDeleted: vi.fn(async () => { }),
		getKnownMtime: () => 42,
		isOffline: () => offline,
	};
	const adapter = new VirtualAdapter(original, mapper, security, ignore, callbacks);
	return { adapter, callbacks, original, mount };
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
		expect(url.endsWith('/share/Reports/chart.png?42')).toBe(true);
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

	it('refuses to permanently delete a folder holding hidden files', async () => {
		const { adapter } = make({ visibleFileFilter: 'markdown-only' });
		await fs.writeFile(path.join(mountDir, 'Q1', 'budget.xlsx'), 'numbers');
		await expect(adapter.rmdir('Fin/Q1', true)).rejects.toThrow(/hidden/);
		expect((await fs.stat(path.join(mountDir, 'Q1', 'budget.xlsx'))).isFile()).toBe(true);
	});

	it('keeps a colleague\'s newer version as a conflict copy before overwriting', async () => {
		const { adapter } = make();
		// Obsidian believes the file has an older mtime than the one on disk.
		const callbacks = (adapter as unknown as { callbacks: VirtualAdapterCallbacks }).callbacks;
		callbacks.getKnownMtime = () => 1000;
		await adapter.write('Fin/Q1/summary.md', 'mine');
		expect(await fs.readFile(path.join(mountDir, 'Q1', 'summary.md'), 'utf8')).toBe('mine');
		const kept = await fs.readdir(path.join(mountDir, '.folderbridge-trash'));
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
