import { describe, expect, it } from 'vitest';
import {
	cleanFolder, embeddedBaseBlocks, folderRefsFromBase, folderRefsFromText, guessShareRoot, suggestMounts,
} from '../src/baseFolders';

describe('folderRefsFromBase', () => {
	it('reads inFolder, folder and path tests from top-level and view filters', () => {
		const refs = folderRefsFromBase({
			filters: { and: ['file.inFolder("Finance/Reports")', 'file.hasTag("q1")'] },
			views: [
				{ type: 'table', name: 'Budgets', filters: { or: ["file.folder == 'Finance/Budgets/'", 'file.path.startsWith("Shared/Exports")'] } },
				{ type: 'table', name: 'One note', filters: 'file.path == "Ops/Weekly/plan.md"' },
			],
		});
		expect(refs.folders).toEqual(['Finance/Reports', 'Finance/Budgets', 'Shared/Exports', 'Ops/Weekly']);
		expect(refs.excluded).toEqual([]);
		expect(refs.unscopedView).toBe(false);
	});

	it('treats "not", "!" and "!=" as exclusions, and a double "not" as inclusion', () => {
		const refs = folderRefsFromBase({
			filters: {
				and: [
					'file.inFolder("Finance")',
					{ not: ['file.inFolder("Finance/Archive")', { not: ['file.inFolder("Finance/Archive/Keep")'] }] },
					'!file.inFolder("Finance/Tmp")',
					'file.folder != "Finance/Old"',
				],
			},
		});
		expect(refs.folders).toEqual(['Finance', 'Finance/Archive/Keep']);
		expect(refs.excluded).toEqual(['Finance/Archive', 'Finance/Tmp', 'Finance/Old']);
	});

	it('supports the early inFolder(file.file, "X") syntax and several tests in one string', () => {
		const refs = folderRefsFromBase({ filters: 'inFolder(file.file, "A") || file.inFolder(\'B\')' });
		expect(refs.folders).toEqual(['A', 'B']);
	});

	it('flags views that are not limited to a folder, and filters relative to the embedding note', () => {
		expect(folderRefsFromBase({ filters: 'file.hasTag("invoice")' }).unscopedView).toBe(true);
		expect(folderRefsFromBase({ views: [{ filters: 'file.inFolder("A")' }, { type: 'cards' }] }).unscopedView).toBe(true);
		expect(folderRefsFromBase({ filters: 'file.inFolder("A")', views: [{ type: 'cards' }] }).unscopedView).toBe(false);
		const relative = folderRefsFromBase({ filters: 'file.inFolder(this.file.folder)' });
		expect(relative.relative).toBe(true);
		expect(relative.unscopedView).toBe(false);
		expect(relative.folders).toEqual([]);
	});

	it('ignores formulas and properties (they never limit which notes show)', () => {
		const refs = folderRefsFromBase({
			formulas: { inReports: 'if(file.inFolder("Formula/Only"), 1, 0)' },
			filters: 'file.inFolder("Real")',
		});
		expect(refs.folders).toEqual(['Real']);
	});

	it('survives junk input', () => {
		expect(folderRefsFromBase(null).folders).toEqual([]);
		expect(folderRefsFromBase('just text').folders).toEqual([]);
		expect(folderRefsFromBase({ filters: 42, views: 'nope' }).folders).toEqual([]);
	});
});

describe('folderRefsFromText (YAML that does not parse)', () => {
	it('still finds folder tests in the raw text', () => {
		const refs = folderRefsFromText('filters:\n  and:\n    - file.inFolder("X/Y")\n    - !file.inFolder("X/Y/Z")\n  :broken');
		expect(refs.folders).toEqual(['X/Y']);
		expect(refs.excluded).toEqual(['X/Y/Z']);
	});
});

describe('embeddedBaseBlocks', () => {
	it('finds ```base and ~~~base blocks, not other code', () => {
		const md = [
			'# Dashboard', '', '```base', 'filters: file.inFolder("A")', '```', '',
			'```js', 'file.inFolder("NotABase")', '```', '',
			'~~~~ base', 'filters: file.inFolder("B")', 'views: []', '~~~~', '',
			'  ```base', '  filters: file.inFolder("C")', '  ```',
		].join('\n');
		const blocks = embeddedBaseBlocks(md);
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toBe('filters: file.inFolder("A")');
		expect(blocks[1]).toContain('file.inFolder("B")');
		expect(blocks[2]).toContain('file.inFolder("C")');
	});

	it('handles Windows line endings', () => {
		expect(embeddedBaseBlocks('```base\r\nfilters: x\r\n```\r\n')).toEqual(['filters: x']);
	});
});

describe('cleanFolder', () => {
	it('normalizes slashes', () => {
		expect(cleanFolder(' /Finance\\Reports// ')).toBe('Finance/Reports');
		expect(cleanFolder('a//b')).toBe('a/b');
	});
});

describe('suggestMounts', () => {
	const refs = (...folders: string[]) => ({ folders, excluded: [], relative: false, unscopedView: false });

	it('keeps the top-most folder, lists what it covers, and merges who uses it', () => {
		const suggestions = suggestMounts([
			{ source: 'Budgets.base', refs: refs('Finance/Reports/2026', 'Finance/Budgets') },
			{ source: 'Reports.base', refs: refs('Finance/Reports') },
			{ source: 'Ops.base', refs: refs('Ops') },
		], { mountFolders: [], isLocalFolder: () => false });
		expect(suggestions.map(s => s.folder)).toEqual(['Finance/Budgets', 'Finance/Reports', 'Ops']);
		const reports = suggestions.find(s => s.folder === 'Finance/Reports')!;
		expect(reports.covers).toEqual(['Finance/Reports/2026']);
		expect(reports.usedBy.sort()).toEqual(['Budgets.base', 'Reports.base']);
		expect(suggestions.every(s => s.status === 'new')).toBe(true);
	});

	it('marks folders already mounted, overlapping a mount, or existing in the vault', () => {
		const suggestions = suggestMounts([
			{ source: 'x.base', refs: refs('Finance/Invoices', 'Finance/Invoices/2026', 'Big', 'Local', 'New') },
		], { mountFolders: ['Finance/Invoices', 'Big/Inner'], isLocalFolder: p => p === 'Local' });
		const status = Object.fromEntries(suggestions.map(s => [s.folder, s.status]));
		expect(status).toEqual({ Big: 'overlaps', New: 'new', Local: 'local', 'Finance/Invoices': 'mounted' });
	});

	it('keeps subfolders of a local or partly-mounted folder as their own suggestions', () => {
		const suggestions = suggestMounts([
			{ source: 'x.base', refs: refs('Finance', 'Finance/Reports', 'Projects', 'Projects/Archive') },
		], { mountFolders: ['Finance/Budgets'], isLocalFolder: p => p === 'Projects' });
		const status = Object.fromEntries(suggestions.map(s => [s.folder, s.status]));
		expect(status).toEqual({ Finance: 'overlaps', 'Finance/Reports': 'new', Projects: 'local', 'Projects/Archive': 'new' });
		expect(suggestions.every(s => s.covers.length === 0)).toBe(true);
	});

	it('compares case-insensitively when asked', () => {
		const suggestions = suggestMounts([
			{ source: 'a.base', refs: refs('Finance/Reports') },
			{ source: 'b.base', refs: refs('finance/reports/Q1') },
		], { mountFolders: ['FINANCE/REPORTS'], isLocalFolder: () => false, caseInsensitive: true });
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].status).toBe('mounted');
		expect(suggestions[0].covers).toEqual(['finance/reports/Q1']);
	});
});

describe('guessShareRoot', () => {
	it('strips the vault folder from the mount\'s real path', () => {
		expect(guessShareRoot([
			{ virtualPath: 'Finance/Reports', realPath: 'Z:\\Finance\\Reports' },
			{ virtualPath: 'Ops', realPath: 'Z:\\Ops\\' },
		], true)).toBe('Z:\\');
		expect(guessShareRoot([{ virtualPath: 'Reports', realPath: '\\\\server\\share\\Reports' }], true)).toBe('\\\\server\\share');
		expect(guessShareRoot([{ virtualPath: 'Docs/A', realPath: '/Volumes/Share/Docs/A' }], false)).toBe('/Volumes/Share');
	});

	it('returns null when no mount mirrors its vault folder', () => {
		expect(guessShareRoot([{ virtualPath: 'Invoices', realPath: 'Z:\\Finance\\External' }], true)).toBeNull();
		expect(guessShareRoot([], true)).toBeNull();
	});
});
