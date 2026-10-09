import { diff3Merge } from 'node-diff3';

/**
 * How a text file is stored on disk, so a save writes it back the same way.
 * Obsidian's editor works in UTF-8 with "\n" line breaks; Windows tools and
 * older files often use "\r\n", a byte-order mark, UTF-16 or Windows-1252.
 */
export interface TextFormat {
	/** Every line break is "\r\n": convert back on save so colleagues' tools see no whole-file change. */
	crlf: boolean;
	/** The file starts with a UTF-8 byte-order mark: keep it on save. */
	bom: boolean;
	/** Not valid UTF-8 (UTF-16, Windows-1252, …): readable, but saving would corrupt characters. */
	unsafe: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decode a text file without losing information, and report how it was stored. */
export function decodeText(buf: Uint8Array): { text: string; format: TextFormat } {
	const format: TextFormat = { crlf: false, bom: false, unsafe: false };
	let text: string;
	if (buf[0] === 0xff && buf[1] === 0xfe) {
		format.unsafe = true;
		text = new TextDecoder('utf-16le').decode(buf.subarray(2));
	} else if (buf[0] === 0xfe && buf[1] === 0xff) {
		format.unsafe = true;
		text = new TextDecoder('utf-16be').decode(buf.subarray(2));
	} else {
		let body = buf;
		if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
			format.bom = true;
			body = buf.subarray(3);
		}
		try {
			text = utf8.decode(body);
		} catch {
			// Not UTF-8: almost certainly Windows-1252 ("ANSI") on a Windows share.
			format.unsafe = true;
			text = new TextDecoder('windows-1252').decode(body);
		}
	}
	format.crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
	return { text, format };
}

/** Turn editor text back into the file's own line endings and BOM. */
export function encodeText(text: string, format: TextFormat | undefined): string {
	let out = text;
	if (format?.crlf) out = out.replace(/\r?\n/g, '\r\n');
	if (format?.bom) out = '﻿' + out;
	return out;
}

/**
 * Three-way merge of line-based text: `base` is the version both sides
 * started from, `mine` is what Obsidian is saving, `theirs` is what is on
 * disk now. Non-overlapping changes from both sides are combined; `clean`
 * is false when both changed the same lines (then nothing is merged).
 */
export function mergeText(base: string, mine: string, theirs: string): { clean: boolean; merged: string } {
	const norm = (s: string) => s.replace(/\r\n/g, '\n').split('\n');
	const regions = diff3Merge(norm(mine), norm(base), norm(theirs), { excludeFalseConflicts: true }) as Array<{ ok?: string[]; conflict?: unknown }>;
	const lines: string[] = [];
	for (const region of regions) {
		if (region.conflict) return { clean: false, merged: '' };
		if (region.ok) lines.push(...region.ok);
	}
	return { clean: true, merged: lines.join('\n') };
}

/** Text types Obsidian edits as plain text (where a merge makes sense). */
export function isMergeableText(path: string): boolean {
	return /\.(md|mdx|canvas|base|txt|csv|json)$/i.test(path);
}

/** Small LRU of the last text Obsidian read or wrote per path: the "base" for a merge. */
export class RecentTexts {
	private map = new Map<string, string>();
	private bytes = 0;

	/** `isPinned`: entries for notes open in an editor are never evicted (they are the merge base). */
	constructor(private readonly isPinned: (path: string) => boolean = () => false, private readonly maxEntries = 200, private readonly maxBytes = 8 * 1024 * 1024) { }

	get(path: string): string | undefined {
		const value = this.map.get(path);
		if (value !== undefined) { this.map.delete(path); this.map.set(path, value); }
		return value;
	}

	set(path: string, text: string): void {
		if (text.length > this.maxBytes / 4) { this.delete(path); return; } // don't keep huge files
		this.delete(path);
		this.map.set(path, text);
		this.bytes += text.length;
		let guard = this.map.size;
		while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && guard-- > 0) {
			const oldest = this.map.keys().next().value as string;
			const value = this.map.get(oldest) as string;
			this.map.delete(oldest);
			if (this.isPinned(oldest)) this.map.set(oldest, value); // keep, move to the newest end
			else this.bytes -= value.length;
		}
	}

	delete(path: string): void {
		const old = this.map.get(path);
		if (old === undefined) return;
		this.bytes -= old.length;
		this.map.delete(path);
	}

	rename(from: string, to: string): void {
		const value = this.map.get(from);
		if (value === undefined) return;
		this.delete(from);
		this.set(to, value);
	}
}
