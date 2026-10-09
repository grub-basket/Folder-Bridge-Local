import { describe, expect, it } from 'vitest';
import { TreeNode, computeInsights, formatBytes } from '../src/mountInsights';

const file = (path: string, size = 100): TreeNode => ({ path, name: path.split('/').pop()!, extension: path.split('.').pop(), stat: { size } });
const folder = (path: string, children: TreeNode[]): TreeNode => ({ path, name: path.split('/').pop()!, children });

describe('computeInsights', () => {
	const tree = folder('Fin', [
		file('Fin/readme.md'),
		folder('Fin/Archive', [
			folder('Fin/Archive/2019', Array.from({ length: 40 }, (_, i) => file(`Fin/Archive/2019/r${i}.xlsx`, 1000))),
			folder('Fin/Archive/2020', Array.from({ length: 10 }, (_, i) => file(`Fin/Archive/2020/n${i}.md`))),
		]),
		folder('Fin/Reports', [file('Fin/Reports/q1.md'), file('Fin/Reports/q1.pdf', 5000)]),
		folder('Fin/Empty', []),
	]);

	it('counts files, notes, folders and bytes for the whole mount', () => {
		const r = computeInsights(tree);
		expect(r.files).toBe(53);
		expect(r.notes).toBe(12);
		expect(r.folders).toBe(5);
		expect(r.bytes).toBe(40 * 1000 + 12 * 100 + 5000);
	});

	it('lists the biggest folders first and skips a subfolder that repeats its parent', () => {
		const r = computeInsights(tree);
		expect(r.biggest.map(b => b.rel)).toEqual(['Archive', 'Archive/2019', 'Archive/2020', 'Reports']); // Empty has no items
		// Archive/2019 (40 of Archive's 52 items, 77%) is listed; 2020 too; both below 80%.
		const r2 = computeInsights(folder('Fin', [folder('Fin/A', [folder('Fin/A/B', Array.from({ length: 9 }, (_, i) => file(`Fin/A/B/${i}.md`)))])]));
		expect(r2.biggest.map(b => b.rel)).toEqual(['A']); // A/B is 90% of A → repeated, skipped
	});

	it('formats sizes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
	});
});
