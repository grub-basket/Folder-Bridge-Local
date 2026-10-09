import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { IgnoreMatcher, wildcardMatch } from '../src/IgnoreMatcher';
import { isVisibleFileInMount } from '../src/mountFileFilter';
import {
	normalizeForComparison, isUNCPath, isUnsupportedWindowsDevicePath,
	realPathToResourceUrl, stripLongPathPrefix, withTimeout,
} from '../src/OSHelpers';
import type { MountPoint } from '../src/types';

const mount = (over: Partial<MountPoint> = {}): MountPoint => ({
	id: 'm1', virtualPath: 'Finance/Reports', realPath: '/srv/reports', enabled: true, readOnly: false, ...over,
});

describe('PathMapper', () => {
	it('maps virtual paths to real paths and back', () => {
		const m = mount();
		const mapper = new PathMapper();
		mapper.update([m]);
		expect(mapper.getMountForPath('Finance/Reports/Q1/a.md')).toBe(m);
		expect(mapper.getMountForPath('Finance/ReportsX/a.md')).toBeUndefined();
		expect(mapper.toRealPath('Finance/Reports/Q1/a.md', m)).toBe(path.join('/srv/reports', 'Q1', 'a.md'));
		expect(mapper.toRealPath('Finance/Reports', m)).toBe('/srv/reports');
		expect(mapper.toVirtualPath(path.join('/srv/reports', 'Q1', 'a.md'), m)).toBe('Finance/Reports/Q1/a.md');
		expect(mapper.getMountRelativePath('Finance/Reports/Q1', m)).toBe('Q1');
	});

	it('refuses "." and ".." segments so a vault path cannot escape the mount', () => {
		const m = mount();
		const mapper = new PathMapper();
		mapper.update([m]);
		expect(() => mapper.toRealPath('Finance/Reports/../../etc/passwd', m)).toThrow(/\.\./);
		expect(() => mapper.toRealPath('Finance/Reports/./a.md', m)).toThrow();
	});

	it('returns undefined for real paths outside the mount', () => {
		const m = mount();
		const mapper = new PathMapper();
		mapper.update([m]);
		expect(mapper.toVirtualPath('/srv/other/a.md', m)).toBeUndefined();
		expect(mapper.toVirtualPath('/srv/reports-old/a.md', m)).toBeUndefined();
	});

	it('prefers the longest matching mount and lists virtual parents', () => {
		const a = mount({ id: 'a', virtualPath: 'Finance' , realPath: '/a' });
		const b = mount({ id: 'b', virtualPath: 'Shared/Finance/Budgets', realPath: '/b' });
		const mapper = new PathMapper();
		mapper.update([a, b]);
		expect(mapper.getVirtualMountsDirectChildren('')).toEqual(expect.arrayContaining(['Finance', 'Shared']));
		expect(mapper.getVirtualMountsDirectChildren('Shared')).toEqual(['Shared/Finance']);
		expect(mapper.hasMountsUnder('Shared')).toBe(true);
		expect(mapper.hasMountsUnder('Other')).toBe(false);
	});

	it('uses the fallback path only while selected, and forgets it when paths change', () => {
		const m = mount({ fallbackRealPath: '/fallback' });
		const mapper = new PathMapper();
		mapper.update([m]);
		mapper.setResolvedPath(m.id, '/fallback');
		expect(mapper.getEffectiveRealPath(m)).toBe('/fallback');
		mapper.update([{ ...m, realPath: '/srv/new' }]);
		expect(mapper.getEffectiveRealPath({ ...m, realPath: '/srv/new' })).toBe('/srv/new');
	});

	it('ignores disabled mounts', () => {
		const mapper = new PathMapper();
		mapper.update([mount({ enabled: false })]);
		expect(mapper.getMountForPath('Finance/Reports/a.md')).toBeUndefined();
	});
});

describe('SecurityManager', () => {
	it('allows paths inside allowlisted folders only (separator-aware)', () => {
		const s = new SecurityManager();
		s.setAllowlist(['/srv/reports']);
		expect(s.isAllowed('/srv/reports')).toBe(true);
		expect(s.isAllowed('/srv/reports/q1/a.md')).toBe(true);
		expect(s.isAllowed('/srv/reports-secret/a.md')).toBe(false);
		expect(s.isAllowed('/srv/reports/../secret')).toBe(false);
	});

	it('compares Windows paths case-insensitively and handles drive roots and UNC', () => {
		const s = new SecurityManager();
		s.setAllowlist(['Z:\\', '\\\\Server\\Share\\Finance']);
		expect(s.isAllowed('z:\\anything\\a.md')).toBe(true);
		expect(s.isAllowed('\\\\server\\share\\finance\\q1.md')).toBe(true);
		expect(s.isAllowed('\\\\server\\share\\hr\\q1.md')).toBe(false);
		expect(s.isAllowed('\\\\?\\UNC\\server\\share\\finance\\long.md')).toBe(true);
		expect(s.isAllowed('\\\\.\\PhysicalDrive0')).toBe(false);
	});

	it('rejects system folders, credential folders, relative paths and bare servers', () => {
		const s = new SecurityManager();
		expect(s.validateLocalPath('C:\\Windows\\System32', 'Path')).toMatch(/protected/);
		expect(s.validateLocalPath('D:\\Program Files\\x', 'Path')).toMatch(/protected/);
		expect(s.validateLocalPath('/etc', 'Path')).toMatch(/protected/);
		expect(s.validateLocalPath('/home/u/.ssh', 'Path')).toMatch(/credentials/);
		expect(s.validateLocalPath('relative/folder', 'Path')).toMatch(/full path/);
		expect(s.validateLocalPath('\\\\server', 'Path')).toMatch(/share name/);
		expect(s.validateLocalPath('Z:\\Finance\\Reports', 'Path')).toBeNull();
		expect(s.validateLocalPath('\\\\server\\share\\Finance', 'Path')).toBeNull();
	});

	it('rejects overlapping or hidden vault folders and mounting the vault into itself', () => {
		const s = new SecurityManager();
		const existing = [mount()];
		expect(s.validateMount({ ...mount({ virtualPath: 'Finance' }) }, existing)).toMatch(/overlaps/);
		expect(s.validateMount({ ...mount({ virtualPath: 'Finance/Reports/Sub' }) }, existing)).toMatch(/overlaps/);
		expect(s.validateMount({ ...mount({ virtualPath: '.hidden' }) }, [])).toMatch(/hidden/);
		expect(s.validateMount({ ...mount({ virtualPath: 'A/../B' }) }, [])).toMatch(/\.\./);
		expect(s.validateMount(mount({ realPath: '/vaults/work' }), [], '/vaults/work/inner')).toMatch(/vault/);
		expect(s.validateMount(mount({ realPath: '/vaults/work/inner/x' }), [], '/vaults/work/inner')).toMatch(/vault/);
		expect(s.validateMount(mount({ realPath: '/vaults/other' }), [], '/vaults/work')).toBeNull();
	});

	it('warns when two mounts expose the same files', () => {
		const s = new SecurityManager();
		expect(s.getPathWarnings('/srv/reports/q1', [mount()])).toHaveLength(1);
		expect(s.getPathWarnings('/srv/other', [mount()])).toHaveLength(0);
	});
});

describe('IgnoreMatcher', () => {
	const m = mount({ ignoreList: ['Archive', '2019/Old', '*.bak'] });

	it('matches names, mount-relative paths and globs', () => {
		const ig = new IgnoreMatcher(false);
		ig.rebuild(['~$*', 'Thumbs.db'], [m]);
		expect(ig.isIgnored('Archive', m, 'Archive')).toBe(true);
		expect(ig.isIgnored('Old', m, '2019/Old')).toBe(true);
		expect(ig.isIgnored('Old', m, '2020/Old')).toBe(false);
		expect(ig.isIgnored('x.bak', m)).toBe(true);
		expect(ig.isIgnored('~$Budget.xlsx', m)).toBe(true);
		expect(ig.isIgnored('Thumbs.db', m)).toBe(true);
		expect(ig.isIgnored('Report.md', m)).toBe(false);
	});

	it('treats a leading "/" pattern literally, even with "*" in the name', () => {
		const ig = new IgnoreMatcher(false);
		const mm = mount({ ignoreList: ['/Draft*'] });
		ig.rebuild([], [mm]);
		expect(ig.isPathIgnored('Draft*', mm)).toBe(true);
		expect(ig.isPathIgnored('Draft*/x.md', mm)).toBe(true);
		expect(ig.isPathIgnored('Drafts', mm)).toBe(false);
	});

	it('checks every segment of a path', () => {
		const ig = new IgnoreMatcher(false);
		ig.rebuild([], [m]);
		expect(ig.isPathIgnored('Archive/2018/a.md', m)).toBe(true);
		expect(ig.isPathIgnored('2019/Old/deep/a.md', m)).toBe(true);
		expect(ig.isPathIgnored('2019/New/a.md', m)).toBe(false);
	});

	it('is case-insensitive when asked (Windows)', () => {
		const ig = new IgnoreMatcher(true);
		ig.rebuild(['Thumbs.db'], [m]);
		expect(ig.isIgnored('THUMBS.DB', m)).toBe(true);
		expect(ig.isIgnored('archive', m, 'archive')).toBe(true);
		expect(ig.isPathIgnored('2019/OLD/a.md', m)).toBe(true);
	});

	it('matches wildcards like a glob', () => {
		expect(wildcardMatch('*.bak', 'x.bak')).toBe(true);
		expect(wildcardMatch('*.bak', 'x.bak.md')).toBe(false);
		expect(wildcardMatch('~$*', '~$Budget.xlsx')).toBe(true);
		expect(wildcardMatch('a*b*c', 'axxbyyc')).toBe(true);
		expect(wildcardMatch('a*b*c', 'axxbyy')).toBe(false);
		expect(wildcardMatch('*', '')).toBe(true);
		expect(wildcardMatch('a.b', 'aXb')).toBe(false); // "." is literal
	});

	it('keeps glob matching fast on hostile patterns', () => {
		const ig = new IgnoreMatcher(false);
		ig.rebuild(['a*a*a*a*a*a*a*a*a*a*b'], [m]);
		const started = Date.now();
		expect(ig.isIgnored('a'.repeat(5000), m)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe('OSHelpers', () => {
	it('normalizes Windows paths for comparison', () => {
		expect(normalizeForComparison('Z:\\Finance\\')).toBe('z:/finance');
		expect(normalizeForComparison('\\\\?\\Z:\\Finance')).toBe('z:/finance');
		expect(normalizeForComparison('\\\\?\\UNC\\srv\\share\\x')).toBe('//srv/share/x');
		expect(normalizeForComparison('/Users/you/')).toBe('/Users/you');
	});

	it('recognises UNC and device paths', () => {
		expect(isUNCPath('\\\\server\\share')).toBe(true);
		expect(isUNCPath('\\\\?\\C:\\x')).toBe(false);
		expect(isUNCPath('C:\\x')).toBe(false);
		expect(isUnsupportedWindowsDevicePath('\\\\.\\COM1')).toBe(true);
		expect(isUnsupportedWindowsDevicePath('\\\\?\\C:\\x')).toBe(false);
	});

	it('strips long-path prefixes', () => {
		expect(stripLongPathPrefix('\\\\?\\C:\\a')).toBe('C:\\a');
		expect(stripLongPathPrefix('\\\\?\\UNC\\srv\\share\\a')).toBe('\\\\srv\\share\\a');
		expect(stripLongPathPrefix('C:\\a')).toBe('C:\\a');
	});

	it('builds resource URLs the way Obsidian does', () => {
		expect(realPathToResourceUrl('app://id/', '/srv/sub dir/red #1.png', 123))
			.toBe('app://id/srv/sub%20dir/red%20%231.png?123');
	});

	it('times out slow probes', async () => {
		const never = new Promise<string>(() => { });
		await expect(withTimeout(never, 20, () => 'timeout')).resolves.toBe('timeout');
	});
});

describe('isVisibleFileInMount', () => {
	it('filters by type', () => {
		expect(isVisibleFileInMount('a/b.md', {})).toBe(true);
		expect(isVisibleFileInMount('a/b.pdf', { visibleFileFilter: 'markdown-only' })).toBe(false);
		expect(isVisibleFileInMount('a/b.canvas', { visibleFileFilter: 'markdown-only' })).toBe(true);
		expect(isVisibleFileInMount('a/b.PDF', { visibleFileFilter: 'pdf-only' })).toBe(true);
	});
});

describe('text files', async () => {
	const { RecentTexts, decodeText, mergeText } = await import('../src/textFiles');

	it('keeps pinned (open) notes when evicting', () => {
		const recent = new RecentTexts(p => p === 'open.md', 3);
		recent.set('open.md', 'base');
		for (let i = 0; i < 10; i++) recent.set(`n${i}.md`, 'x');
		expect(recent.get('open.md')).toBe('base');
		expect(recent.get('n0.md')).toBeUndefined();
	});

	it('detects UTF-16 and Windows-1252 as unsafe, UTF-8 BOM and CRLF as safe', () => {
		expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).format.unsafe).toBe(true);
		expect(decodeText(new Uint8Array([0x41, 0xa3])).format.unsafe).toBe(true);
		const bom = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]));
		expect(bom).toEqual({ text: 'a\r\n', format: { bom: true, crlf: true, unsafe: false } });
	});

	it('merges non-overlapping edits and refuses overlapping ones', () => {
		expect(mergeText('a\nb\nc', 'A\nb\nc', 'a\nb\nC')).toEqual({ clean: true, merged: 'A\nb\nC' });
		expect(mergeText('a\nb', 'x\nb', 'y\nb').clean).toBe(false);
		expect(mergeText('a', 'a', 'b')).toEqual({ clean: true, merged: 'b' });
	});
});

describe('conflict regions', async () => {
	const { conflictRegions, wordDiff } = await import('../src/textFiles');

	it('with a base, only overlapping edits clash', () => {
		// Edits separated by an unchanged line merge; adjacent ones would count as one clash (standard diff3).
		const r = conflictRegions('a\nb\nc\nd\ne', 'A\nb\nc\nd\nX', 'a\nb\nC\nd\nY');
		expect(r.filter(x => x.kind === 'conflict')).toHaveLength(1);
		expect(r[0]).toEqual({ kind: 'same', lines: ['A', 'b', 'C', 'd'] });
		expect(r[1]).toEqual({ kind: 'conflict', mine: ['X'], theirs: ['Y'] });
	});

	it('without a base, every difference is a clash', () => {
		const r = conflictRegions(undefined, 'a\nb\nc', 'a\nB\nc');
		expect(r).toEqual([{ kind: 'same', lines: ['a'] }, { kind: 'conflict', mine: ['b'], theirs: ['B'] }, { kind: 'same', lines: ['c'] }]);
	});

	it('highlights changed words', () => {
		const d = wordDiff('total: 100 USD', 'total: 150 USD');
		expect(d.filter(p => p.side === 'a').map(p => p.text)).toEqual(['100']);
		expect(d.filter(p => p.side === 'b').map(p => p.text)).toEqual(['150']);
	});
});
