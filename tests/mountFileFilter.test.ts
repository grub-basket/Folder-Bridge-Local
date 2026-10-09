import { describe, expect, it } from 'vitest';
import { isVisibleFileInMount } from '../src/mountFileFilter';

describe('isVisibleFileInMount', () => {
	it('allows all files by default', () => {
		expect(isVisibleFileInMount('Projects/note.md', {})).toBe(true);
		expect(isVisibleFileInMount('Projects/report.pdf', {})).toBe(true);
	});

	it('matches markdown-only against markdown extensions', () => {
		expect(isVisibleFileInMount('Projects/note.md', { visibleFileFilter: 'markdown-only' })).toBe(true);
		expect(isVisibleFileInMount('Projects/diagram.canvas', { visibleFileFilter: 'markdown-only' })).toBe(true);
		expect(isVisibleFileInMount('Projects/report.pdf', { visibleFileFilter: 'markdown-only' })).toBe(false);
	});

	it('matches pdf-only against pdf files', () => {
		expect(isVisibleFileInMount('Projects/report.pdf', { visibleFileFilter: 'pdf-only' })).toBe(true);
		expect(isVisibleFileInMount('Projects/note.md', { visibleFileFilter: 'pdf-only' })).toBe(false);
	});
});
