import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher, WatchHost } from '../src/FileWatcher';
import type { MountPoint } from '../src/types';

let dir: string;
let watcher: FileWatcher | null = null;

beforeEach(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fbl-watch-')));
});

afterEach(async () => {
	watcher?.stopAll();
	watcher = null;
	await fs.rm(dir, { recursive: true, force: true });
});

function host(over: Partial<WatchHost> = {}) {
	const seen: string[][] = [];
	const h: WatchHost = {
		realRoot: () => dir,
		isIgnored: (_m, rel) => rel.split('/').includes('ignored'),
		syncPaths: vi.fn(async (_m, paths) => { seen.push(paths); }),
		syncAll: vi.fn(async () => { }),
		onFallbackToPolling: vi.fn(),
		...over,
	};
	return { h, seen };
}

const mount = (over: Partial<MountPoint> = {}): MountPoint => ({
	id: 'm', virtualPath: 'Fin', realPath: dir, enabled: true, readOnly: false, watcherDebounceMs: 50, ...over,
});

const waitFor = async (check: () => boolean, ms = 4000) => {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error('timed out');
		await new Promise(r => setTimeout(r, 25));
	}
};

describe('FileWatcher (native recursive)', () => {
	it('reports changes in nested folders as vault paths, batched', async () => {
		await fs.mkdir(path.join(dir, 'Q1', 'Deep'), { recursive: true });
		const { h, seen } = host();
		watcher = new FileWatcher(h);
		watcher.start(mount());
		await new Promise(r => setTimeout(r, 150));
		await fs.writeFile(path.join(dir, 'Q1', 'Deep', 'a.md'), 'x');
		await fs.writeFile(path.join(dir, 'b.md'), 'y');
		await waitFor(() => seen.flat().includes('Fin/Q1/Deep/a.md') && seen.flat().includes('Fin/b.md'));
		for (const batch of seen) {
			const depths = batch.map(p => p.split('/').length);
			expect([...depths].sort((a, b) => a - b)).toEqual(depths); // shallowest first
		}
	});

	it('drops events under ignored folders', async () => {
		await fs.mkdir(path.join(dir, 'ignored'));
		const { h, seen } = host();
		watcher = new FileWatcher(h);
		watcher.start(mount());
		await new Promise(r => setTimeout(r, 150));
		await fs.writeFile(path.join(dir, 'ignored', 'x.md'), 'x');
		await fs.writeFile(path.join(dir, 'ok.md'), 'x');
		await waitFor(() => seen.flat().includes('Fin/ok.md'));
		expect(seen.flat().some(p => p.includes('ignored'))).toBe(false);
	});

	it('falls back to polling when the folder cannot be watched', async () => {
		const { h } = host({ realRoot: () => path.join(dir, 'does-not-exist') });
		watcher = new FileWatcher(h);
		watcher.start(mount());
		expect(h.onFallbackToPolling).toHaveBeenCalled();
		expect(watcher.isWatching('m')).toBe(true);
	});

	it('does nothing in "off" mode and stops cleanly', async () => {
		const { h, seen } = host();
		watcher = new FileWatcher(h);
		watcher.start(mount({ watchMode: 'off' }));
		expect(watcher.isWatching('m')).toBe(false);
		watcher.start(mount());
		watcher.stop('m');
		await fs.writeFile(path.join(dir, 'late.md'), 'x');
		await new Promise(r => setTimeout(r, 300));
		expect(seen).toHaveLength(0);
	});

	it('never runs two syncs for the same mount at once', async () => {
		let active = 0;
		let maxActive = 0;
		const { h } = host({
			syncPaths: vi.fn(async () => {
				active++; maxActive = Math.max(maxActive, active);
				await new Promise(r => setTimeout(r, 120));
				active--;
			}),
		});
		watcher = new FileWatcher(h);
		watcher.start(mount({ watcherDebounceMs: 10 }));
		await new Promise(r => setTimeout(r, 150));
		for (let i = 0; i < 6; i++) {
			await fs.writeFile(path.join(dir, `f${i}.md`), 'x');
			await new Promise(r => setTimeout(r, 40));
		}
		await waitFor(() => (h.syncPaths as ReturnType<typeof vi.fn>).mock.calls.length >= 2);
		await new Promise(r => setTimeout(r, 400));
		expect(maxActive).toBe(1);
	});
});
