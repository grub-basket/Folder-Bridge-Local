import { describe, expect, it } from 'vitest';
import { findMoves, pathsInsideNewFolders } from '../src/moveDetect';

const file = (mtime: number, size: number) => ({ type: 'file' as const, ctime: 0, mtime, size });
const folder = { type: 'folder' as const, ctime: 0, mtime: 0, size: 0 };
const deps = (known: Record<string, string[]> = {}, disk: Record<string, string[]> = {}) => ({
	knownChildNames: (p: string) => known[p] ?? [],
	diskChildNames: async (p: string) => { if (!disk[p]) throw new Error('unreadable'); return disk[p]; },
});

describe('findMoves', () => {
	it('pairs a moved or renamed file by size and timestamp', async () => {
		const moves = await findMoves(
			[{ path: 'Fin/a.md', kind: 'file', mtime: 5, size: 10 }],
			[{ path: 'Fin/Archive/renamed.md', stat: file(5, 10) }], deps());
		expect(moves).toEqual([{ from: 'Fin/a.md', to: 'Fin/Archive/renamed.md', kind: 'file' }]);
	});

	it('does not pair when size or time differ, or the match is ambiguous', async () => {
		expect(await findMoves([{ path: 'Fin/a.md', kind: 'file', mtime: 5, size: 10 }], [{ path: 'Fin/b.md', stat: file(6, 10) }], deps())).toEqual([]);
		const ambiguous = await findMoves(
			[{ path: 'Fin/a.md', kind: 'file', mtime: 5, size: 10 }, { path: 'Fin/b.md', kind: 'file', mtime: 5, size: 10 }],
			[{ path: 'Fin/X/c.md', stat: file(5, 10) }], deps());
		expect(ambiguous).toEqual([]);
		const byName = await findMoves(
			[{ path: 'Fin/a.md', kind: 'file', mtime: 5, size: 10 }, { path: 'Fin/b.md', kind: 'file', mtime: 5, size: 10 }],
			[{ path: 'Fin/X/b.md', stat: file(5, 10) }], deps());
		expect(byName).toEqual([{ from: 'Fin/b.md', to: 'Fin/X/b.md', kind: 'file' }]);
	});

	it('pairs a renamed folder when its contents match', async () => {
		const moves = await findMoves(
			[{ path: 'Fin/Q1', kind: 'folder' }], [{ path: 'Fin/Quarter 1', stat: folder }],
			deps({ 'Fin/Q1': ['a.md', 'b.md', 'c.md'] }, { 'Fin/Quarter 1': ['a.md', 'b.md', 'c.md'] }));
		expect(moves).toEqual([{ from: 'Fin/Q1', to: 'Fin/Quarter 1', kind: 'folder' }]);
	});

	it('does not pair unrelated folders', async () => {
		const moves = await findMoves(
			[{ path: 'Fin/Q1', kind: 'folder' }], [{ path: 'Fin/New', stat: folder }],
			deps({ 'Fin/Q1': ['a.md', 'b.md'] }, { 'Fin/New': ['x.md', 'y.md'] }));
		expect(moves).toEqual([]);
	});
});

describe('pathsInsideNewFolders', () => {
	it('returns watcher paths inside the new folders, once each, capped', () => {
		const paths = ['Ops/Archive', 'Ops/Archive/Week 10.md', 'Ops/Weekly/Week 10.md', 'Ops/Archive/Week 10.md', 'Ops/ArchiveX/a.md', 'Ops/Archive/Sub/b.md'];
		expect(pathsInsideNewFolders(paths, ['Ops/Archive'])).toEqual(['Ops/Archive/Week 10.md', 'Ops/Archive/Sub/b.md']);
		expect(pathsInsideNewFolders(paths, [])).toEqual([]);
		expect(pathsInsideNewFolders(paths, ['Ops/Archive'], 1)).toEqual(['Ops/Archive/Week 10.md']);
	});

	it('lets findMoves pair a note moved into a new folder', async () => {
		const moves = await findMoves(
			[{ path: 'Ops/Weekly/Week 10.md', kind: 'file', mtime: 5, size: 10 }],
			[{ path: 'Ops/Archive', stat: folder }, { path: 'Ops/Archive/Week 10.md', stat: file(5, 10) }],
			deps({}, { 'Ops/Archive': ['Week 10.md'] }));
		expect(moves).toEqual([{ from: 'Ops/Weekly/Week 10.md', to: 'Ops/Archive/Week 10.md', kind: 'file' }]);
	});
});
