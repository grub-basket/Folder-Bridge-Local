import { describe, expect, it } from 'vitest';
import { BatchStatDeps, statBatch } from '../src/batchStat';
import type { VaultStat } from '../src/types';

const file = (mtime: number): VaultStat => ({ type: 'file', ctime: 1, mtime, size: 10 });

function disk(entries: Record<string, VaultStat>, opts: { withList?: boolean; failingStat?: string[]; failingList?: string[] } = {}) {
	const calls = { stat: [] as string[], list: [] as string[], inFlight: 0, maxInFlight: 0 };
	const deps: BatchStatDeps = {
		async stat(p) {
			calls.stat.push(p);
			calls.inFlight++; calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
			await new Promise(r => setTimeout(r, 1));
			calls.inFlight--;
			if (opts.failingStat?.includes(p)) throw new Error('EIO');
			return entries[p] ?? null;
		},
		shouldContinue: () => true,
	};
	if (opts.withList) {
		deps.listWithStats = async folder => {
			calls.list.push(folder);
			if (opts.failingList?.includes(folder)) throw new Error('helper died');
			const files = Object.entries(entries).filter(([p, s]) => s.type === 'file' && p.slice(0, p.lastIndexOf('/')) === folder).map(([p, s]) => ({ path: p, stat: s }));
			return { files, folders: [] };
		};
	}
	return { deps, calls };
}

describe('statBatch', () => {
	it('stats every path a few at a time; errors and missing stay distinct', async () => {
		const paths = Array.from({ length: 20 }, (_, i) => `M/a/${i}.md`);
		const entries = Object.fromEntries(paths.slice(0, 15).map(p => [p, file(5)]));
		const { deps, calls } = disk(entries, { failingStat: ['M/a/3.md'] });
		const stats = await statBatch(paths, deps);
		expect(stats!.get('M/a/0.md')).toEqual(file(5));
		expect(stats!.get('M/a/3.md')).toBe('error');
		expect(stats!.get('M/a/19.md')).toBeNull();
		expect(calls.stat).toHaveLength(20);
		expect(calls.maxInFlight).toBeGreaterThan(1);
		expect(calls.maxInFlight).toBeLessThanOrEqual(6);
	});

	it('lists a folder with many changes once and stats only what the listing lacks', async () => {
		const many = Array.from({ length: 10 }, (_, i) => `M/copy/${i}.md`);
		const entries: Record<string, VaultStat> = Object.fromEntries(many.slice(0, 9).map(p => [p, file(7)]));
		entries['M/other/x.md'] = file(8);
		const { deps, calls } = disk(entries, { withList: true });
		const stats = await statBatch([...many, 'M/other/x.md'], deps);
		expect(calls.list).toEqual(['M/copy']); // 'M/other' has one change: a single stat is cheaper
		// Only the path the listing did not have (deleted) and the lone one were stat'ed.
		expect(calls.stat.sort()).toEqual(['M/copy/9.md', 'M/other/x.md']);
		expect(stats!.get('M/copy/0.md')).toEqual(file(7));
		expect(stats!.get('M/copy/9.md')).toBeNull();
	});

	it('falls back to single stats when the listing fails', async () => {
		const many = Array.from({ length: 8 }, (_, i) => `M/copy/${i}.md`);
		const { deps, calls } = disk(Object.fromEntries(many.map(p => [p, file(7)])), { withList: true, failingList: ['M/copy'] });
		const stats = await statBatch(many, deps);
		expect(calls.stat).toHaveLength(8);
		expect([...stats!.values()].every(s => s && s !== 'error' && s.mtime === 7)).toBe(true);
	});

	it('returns null when the mount goes away mid-batch', async () => {
		const { deps } = disk({});
		let n = 0;
		deps.shouldContinue = () => ++n < 3;
		expect(await statBatch(['M/a.md', 'M/b.md', 'M/c.md', 'M/d.md'], deps, { concurrency: 1 })).toBeNull();
	});
});
