/**
 * Work out which vault folders a Base reads from, so Folder Bridge can
 * suggest mounts for them. Pure functions: no Obsidian or disk access, so
 * they are unit-tested directly.
 *
 * A .base file (or a ```base block in a note) is YAML. Its "filters" (at the
 * top level and per view) are a tree of and/or/not lists whose leaves are
 * formula strings such as `file.inFolder("Finance/Reports")` or
 * `file.folder == "Budgets"`. Only those leaves are read; formulas, sorts
 * and properties never limit which notes a Base shows.
 */

/** What one Base says about folders. */
export interface BaseFolderRefs {
	/** Folders the Base reads from (vault paths, no leading/trailing slash). */
	folders: string[];
	/** Folders the Base explicitly leaves out (inside a "not", or a "!"/"!=" test). */
	excluded: string[];
	/** It filters relative to the note that embeds it (this.file…), so its folders depend on where it is shown. */
	relative: boolean;
	/** At least one view isn't limited to a folder, so it can show notes from anywhere. */
	unscopedView: boolean;
}

/** A quoted string literal; its text is the "value" group. */
const QUOTED = String.raw`(?<q>["'])(?<value>(?:(?!\k<q>).)+)\k<q>`;
/**
 * Leaf tests that name a folder. Groups: "value" = the folder (or path),
 * "bang" = a leading "!", "op" = == or !=.
 */
const FOLDER_TESTS: { re: RegExp; toFolder?: (value: string) => string }[] = [
	// file.inFolder("X"), and the early Bases syntax inFolder(file.file, "X")
	{ re: new RegExp(String.raw`(?<bang>!\s*)?(?:\bfile\.)?\binFolder\s*\(\s*(?:file(?:\.file)?\s*,\s*)?${QUOTED}\s*\)`, 'g') },
	// file.folder == "X" / file.folder != "X"
	{ re: new RegExp(String.raw`\bfile\.folder\s*(?<op>==|!=)\s*${QUOTED}`, 'g') },
	// file.folder.startsWith("X") / file.path.startsWith("X")
	{ re: new RegExp(String.raw`(?<bang>!\s*)?\bfile\.(?:folder|path)\.startsWith\s*\(\s*${QUOTED}\s*\)`, 'g') },
	// file.path == "X/note.md": the note's folder
	{ re: new RegExp(String.raw`\bfile\.path\s*(?<op>==|!=)\s*${QUOTED}`, 'g'), toFolder: v => v.includes('/') ? v.slice(0, v.lastIndexOf('/')) : '' },
];

/** Vault-path form of a folder named in a filter: trimmed, forward slashes, no leading/trailing slash. */
export function cleanFolder(raw: string): string {
	return raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}

/** Collect folder tests from one formula string. */
export function scanExpression(expression: string, negated: boolean, out: BaseFolderRefs): void {
	if (/\bthis\.file\b/.test(expression)) out.relative = true;
	for (const test of FOLDER_TESTS) {
		test.re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = test.re.exec(expression)) !== null) {
			const groups = m.groups ?? {};
			const value = groups.value ?? '';
			const not = !!groups.bang || groups.op === '!=';
			const folder = cleanFolder(test.toFolder ? test.toFolder(value) : value);
			if (!folder) continue;
			const list = (negated !== not) ? out.excluded : out.folders;
			if (!list.includes(folder)) list.push(folder);
		}
	}
}

/** Walk a filters tree (string, list, or {and|or|not: [...]}). */
function scanFilters(node: unknown, negated: boolean, out: BaseFolderRefs): void {
	if (typeof node === 'string') { scanExpression(node, negated, out); return; }
	if (Array.isArray(node)) { for (const child of node) scanFilters(child, negated, out); return; }
	if (node && typeof node === 'object') {
		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			scanFilters(child, key === 'not' ? !negated : negated, out);
		}
	}
}

function emptyRefs(): BaseFolderRefs {
	return { folders: [], excluded: [], relative: false, unscopedView: false };
}

/** Folder references of a parsed Base (the YAML object). */
export function folderRefsFromBase(base: unknown): BaseFolderRefs {
	const out = emptyRefs();
	if (!base || typeof base !== 'object') return out;
	const root = base as { filters?: unknown; views?: unknown };
	const top = emptyRefs();
	scanFilters(root.filters, false, top);
	merge(out, top);
	const views = Array.isArray(root.views) ? root.views as { filters?: unknown }[] : [];
	const topScoped = top.folders.length > 0 || top.relative;
	if (views.length === 0 && !topScoped) out.unscopedView = true;
	for (const view of views) {
		const refs = emptyRefs();
		scanFilters(view?.filters, false, refs);
		merge(out, refs);
		if (!topScoped && refs.folders.length === 0 && !refs.relative) out.unscopedView = true;
	}
	return out;
}

/**
 * Fallback for YAML that doesn't parse: read every formula-looking test in
 * the raw text. Negation is only seen through "!" and "!=", not "not:".
 */
export function folderRefsFromText(text: string): BaseFolderRefs {
	const out = emptyRefs();
	scanExpression(text, false, out);
	if (out.folders.length === 0 && !out.relative) out.unscopedView = true;
	return out;
}

/** Folder references of a Base's YAML text, parsed with `parse` (Obsidian's parseYaml), falling back to the raw text. */
export function folderRefsFromYaml(text: string, parse: (yaml: string) => unknown): BaseFolderRefs {
	let parsed: unknown;
	try {
		parsed = parse(text);
	} catch {
		return folderRefsFromText(text);
	}
	return parsed && typeof parsed === 'object' ? folderRefsFromBase(parsed) : folderRefsFromText(text);
}

function merge(into: BaseFolderRefs, from: BaseFolderRefs): void {
	for (const f of from.folders) if (!into.folders.includes(f)) into.folders.push(f);
	for (const f of from.excluded) if (!into.excluded.includes(f)) into.excluded.push(f);
	into.relative ||= from.relative;
	into.unscopedView ||= from.unscopedView;
}

/** The YAML of every ```base block in a Markdown note. */
export function embeddedBaseBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	const re = /^(\s*)(`{3,}|~{3,})[ \t]*base[ \t]*\r?\n([\s\S]*?)\r?\n\1\2[ \t]*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) blocks.push(m[3]);
	return blocks;
}

/** One Base found by a scan, with its folder references. */
export interface FoundBase {
	/** Where it is: a vault path, a disk path, or "note.md (embedded)". */
	source: string;
	refs: BaseFolderRefs;
}

export type SuggestionStatus =
	/** Can be added as a new mount. */
	| 'new'
	/** Already inside a mount. */
	| 'mounted'
	/** A mount already sits inside this folder, so it can't be mounted as a whole. */
	| 'overlaps'
	/** A real (not mounted) vault folder with this name exists. */
	| 'local';

export interface MountSuggestion {
	/** Vault folder the Bases expect. */
	folder: string;
	status: SuggestionStatus;
	/** Bases that read from it (or from a folder inside it). */
	usedBy: string[];
	/** Folders inside it that Bases also named; mounting this one covers them. */
	covers: string[];
}

export interface VaultState {
	/** Vault folders of the existing mounts. */
	mountFolders: string[];
	/** Whether a real (not mounted) vault folder exists at this path. */
	isLocalFolder(path: string): boolean;
	/** Compare paths ignoring case (Windows and macOS). */
	caseInsensitive?: boolean;
}

/**
 * Turn the folders Bases use into mount suggestions: one per top-most
 * folder (a folder inside another suggestion is covered by it), each with
 * the Bases that need it and whether it can be mounted.
 */
export function suggestMounts(bases: FoundBase[], vault: VaultState): MountSuggestion[] {
	const key = (p: string) => vault.caseInsensitive ? p.toLowerCase() : p;
	const inside = (child: string, parent: string) => key(child).startsWith(key(parent) + '/');
	const same = (a: string, b: string) => key(a) === key(b);

	const users = new Map<string, { folder: string; usedBy: Set<string> }>();
	for (const base of bases) {
		for (const folder of base.refs.folders) {
			const k = key(folder);
			const entry = users.get(k) ?? { folder, usedBy: new Set<string>() };
			entry.usedBy.add(base.source);
			users.set(k, entry);
		}
	}
	const all = [...users.values()].sort((a, b) => a.folder.length - b.folder.length || a.folder.localeCompare(b.folder));
	const suggestions: MountSuggestion[] = [];
	for (const { folder, usedBy } of all) {
		// Only a parent that is (or will be) mounted covers its subfolders. A
		// local or partly-mounted parent can't be mounted whole, so a
		// subfolder of it stays its own suggestion (often still mountable).
		const parent = suggestions.find(s => inside(folder, s.folder) && (s.status === 'new' || s.status === 'mounted'));
		if (parent) {
			parent.covers.push(folder);
			for (const u of usedBy) if (!parent.usedBy.includes(u)) parent.usedBy.push(u);
			continue;
		}
		let status: SuggestionStatus = 'new';
		if (vault.mountFolders.some(m => same(m, folder) || inside(folder, m))) status = 'mounted';
		else if (vault.mountFolders.some(m => inside(m, folder))) status = 'overlaps';
		else if (vault.isLocalFolder(folder)) status = 'local';
		suggestions.push({ folder, status, usedBy: [...usedBy], covers: [] });
	}
	// Shortest-first was needed to fold subfolders into parents; show A–Z.
	return suggestions.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Guess the share folder that matches the vault root from existing mounts:
 * a mount "Finance/Reports" ← "Z:\Finance\Reports" means the root is "Z:\".
 * Returns the most common answer, or null.
 */
export function guessShareRoot(mounts: { virtualPath: string; realPath: string }[], caseInsensitive: boolean): string | null {
	const counts = new Map<string, number>();
	for (const m of mounts) {
		const virtualParts = cleanFolder(m.virtualPath).split('/').filter(Boolean);
		const realParts = m.realPath.replace(/[\\/]+$/, '').split(/[\\/]/);
		if (virtualParts.length === 0 || realParts.length <= virtualParts.length) continue;
		const tail = realParts.slice(realParts.length - virtualParts.length);
		const eq = (a: string, b: string) => caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
		if (!tail.every((part, i) => eq(part, virtualParts[i]))) continue;
		const separator = m.realPath.includes('\\') ? '\\' : '/';
		let root = realParts.slice(0, realParts.length - virtualParts.length).join(separator);
		if (root === '' || /^[A-Za-z]:$/.test(root)) root += separator;
		counts.set(root, (counts.get(root) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [root, count] of counts) if (count > bestCount) { best = root; bestCount = count; }
	return best;
}
