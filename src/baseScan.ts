import * as fs from 'fs';
import * as path from 'path';
import { embeddedBaseBlocks } from './baseFolders';

/** Set cancelled to stop a running walk (it returns what it found so far). */
export interface CancelToken { cancelled: boolean }

export interface DiskScanOptions {
	/** Also read Markdown notes for ```base blocks (reads every note: slower). */
	readNotes: boolean;
	/** True for names to skip (hidden, ignored); dot-names are always skipped. */
	skip?: (name: string) => boolean;
	cancel?: CancelToken;
	onProgress?: (progress: DiskScanProgress) => void;
	/** Notes bigger than this are not read for embedded Bases. */
	maxNoteBytes?: number;
	/** How many folders are listed at once (network shares like a few in flight). */
	concurrency?: number;
	/** Bases are pushed here as they are found, so a caller that stops waiting still has them. */
	collect?: DiskBase[];
}

export interface DiskScanProgress { folders: number; bases: number; notesRead: number }

/** A Base found on disk: a .base file, or one ```base block of a note. */
export interface DiskBase {
	/** Path relative to the scanned root, forward slashes. */
	relPath: string;
	/** The YAML. */
	text: string;
	/** True when it came from a ```base block inside a note. */
	embedded: boolean;
}

export interface DiskScanResult {
	bases: DiskBase[];
	/** Folders or files that couldn't be read, with the reason. */
	errors: string[];
	progress: DiskScanProgress;
	cancelled: boolean;
}

/**
 * Walk a folder tree on disk for Bases. Only folder listings are needed for
 * .base files; note contents are read only when readNotes is on. Never
 * follows symbolic links or junctions, so a link back up the tree can't loop.
 */
export async function findBasesOnDisk(root: string, options: DiskScanOptions): Promise<DiskScanResult> {
	const progress: DiskScanProgress = { folders: 0, bases: 0, notesRead: 0 };
	const bases: DiskBase[] = options.collect ?? [];
	const errors: string[] = [];
	const maxNoteBytes = options.maxNoteBytes ?? 2 * 1024 * 1024;
	const queue: string[] = [''];
	const concurrency = Math.max(1, options.concurrency ?? 6);
	const skip = (name: string) => name.startsWith('.') || (options.skip?.(name) ?? false);

	const visit = async (rel: string): Promise<void> => {
		const dir = rel ? path.join(root, ...rel.split('/')) : root;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (e) {
			errors.push(`${rel || '.'}: ${(e as Error).message}`);
			return;
		}
		progress.folders++;
		for (const entry of entries) {
			if (options.cancel?.cancelled) return;
			if (skip(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) { queue.push(childRel); continue; }
			if (!entry.isFile()) continue;
			const lower = entry.name.toLowerCase();
			const full = path.join(dir, entry.name);
			try {
				if (lower.endsWith('.base')) {
					bases.push({ relPath: childRel, text: await fs.promises.readFile(full, 'utf8'), embedded: false });
					progress.bases++;
				} else if (options.readNotes && lower.endsWith('.md')) {
					const stat = await fs.promises.stat(full);
					if (stat.size > maxNoteBytes) continue;
					const text = await fs.promises.readFile(full, 'utf8');
					progress.notesRead++;
					if (!/^\s*(`{3,}|~{3,})[ \t]*base[ \t]*$/m.test(text)) continue;
					for (const block of embeddedBaseBlocks(text)) {
						bases.push({ relPath: childRel, text: block, embedded: true });
						progress.bases++;
					}
				}
			} catch (e) {
				errors.push(`${childRel}: ${(e as Error).message}`);
			}
		}
		options.onProgress?.(progress);
	};

	// Idle workers wait for a signal, not a timer: Chromium slows timers in a
	// background window to once a minute, which would stall a long scan.
	let active = 0;
	let waiting: (() => void)[] = [];
	const wakeAll = () => { const w = waiting; waiting = []; for (const resolve of w) resolve(); };
	const workers = Array.from({ length: concurrency }, async () => {
		for (;;) {
			if (options.cancel?.cancelled) { wakeAll(); return; }
			const next = queue.shift();
			if (next === undefined) {
				// Another worker may still be listing a folder that adds more.
				if (active === 0) { wakeAll(); return; }
				await new Promise<void>(resolve => waiting.push(resolve));
				continue;
			}
			active++;
			try { await visit(next); } finally { active--; wakeAll(); }
		}
	});
	await Promise.all(workers);
	bases.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return { bases, errors, progress, cancelled: !!options.cancel?.cancelled };
}

export interface FolderCount {
	files: number;
	folders: number;
	bytes: number;
	/** The count stopped at the limit; the real numbers are bigger. */
	capped: boolean;
}

/** Count what a folder holds (what a mount of it would bring in), stopping at `limit` items. */
export async function countFolder(root: string, options: { limit?: number; skip?: (name: string) => boolean; cancel?: CancelToken } = {}): Promise<FolderCount> {
	const limit = options.limit ?? 50_000;
	const result: FolderCount = { files: 0, folders: 0, bytes: 0, capped: false };
	const queue = [root];
	while (queue.length) {
		if (options.cancel?.cancelled) break;
		const dir = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.') || options.skip?.(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { result.folders++; queue.push(full); }
			else if (entry.isFile()) {
				result.files++;
				try { result.bytes += (await fs.promises.stat(full)).size; } catch { /* vanished meanwhile */ }
			}
			if (result.files + result.folders >= limit) { result.capped = true; return result; }
		}
	}
	return result;
}
