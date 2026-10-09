import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { countFolder, findBasesOnDisk } from '../src/baseScan';

let root: string;

async function put(rel: string, content: string): Promise<void> {
	const full = path.join(root, ...rel.split('/'));
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'fbl-bases-'));
	await put('Dashboards/Reports.base', 'filters: file.inFolder("Finance/Reports")');
	await put('Finance/Reports/Q1.md', '# Q1');
	await put('Finance/Budgets/Plan.md', '# Plan\n\n```base\nfilters: file.inFolder("Finance/Budgets")\n```\n');
	await put('.hidden-folder/hidden.base', 'filters: file.inFolder("Hidden")');
	await put('Archive/old.base', 'filters: file.inFolder("Old")');
	for (let i = 0; i < 30; i++) await put(`Deep/${'d/'.repeat(i % 5)}n${i}.md`, 'x');
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe('findBasesOnDisk', () => {
	it('finds .base files, skipping dot folders and skipped names', async () => {
		const result = await findBasesOnDisk(root, { readNotes: false, skip: name => name === 'Archive', concurrency: 3 });
		expect(result.bases.map(b => b.relPath)).toEqual(['Dashboards/Reports.base']);
		expect(result.bases[0].text).toContain('Finance/Reports');
		expect(result.progress.notesRead).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.errors).toEqual([]);
	});

	it('reads notes for embedded Bases only when asked', async () => {
		const result = await findBasesOnDisk(root, { readNotes: true });
		const embedded = result.bases.filter(b => b.embedded);
		expect(embedded).toEqual([{ relPath: 'Finance/Budgets/Plan.md', text: 'filters: file.inFolder("Finance/Budgets")', embedded: true }]);
		expect(result.bases.map(b => b.relPath)).toContain('Archive/old.base');
		expect(result.progress.notesRead).toBeGreaterThan(30);
	});

	it('stops when cancelled', async () => {
		const cancel = { cancelled: false };
		const result = await findBasesOnDisk(root, { readNotes: false, cancel, onProgress: () => { cancel.cancelled = true; }, concurrency: 1 });
		expect(result.cancelled).toBe(true);
		expect(result.progress.folders).toBe(1);
	});

	it('reports an unreadable root instead of throwing', async () => {
		const result = await findBasesOnDisk(path.join(root, 'missing'), { readNotes: false });
		expect(result.bases).toEqual([]);
		expect(result.errors).toHaveLength(1);
	});
});

describe('countFolder', () => {
	it('counts files, folders and bytes, and stops at the limit', async () => {
		const all = await countFolder(path.join(root, 'Deep'));
		expect(all).toMatchObject({ files: 30, folders: 4, bytes: 30, capped: false });
		const capped = await countFolder(path.join(root, 'Deep'), { limit: 10 });
		expect(capped.capped).toBe(true);
		expect(capped.files + capped.folders).toBe(10);
	});
});
