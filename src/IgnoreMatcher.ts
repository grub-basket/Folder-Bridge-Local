import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { CASE_INSENSITIVE_FS } from './OSHelpers';

interface CompiledPatterns {
	names: Set<string>;
	paths: string[];
	/** Already case-folded when matching is case-insensitive. */
	globs: string[];
}

/**
 * Match `text` against a pattern where "*" means "any run of characters".
 * Greedy with single-point backtracking: O(text × pattern) worst case and
 * linear in practice. (A RegExp built from the pattern, as upstream did,
 * backtracks catastrophically: "a*a*a*a*a*a*b" against 80 "a"s takes 0.75 s, 160 never finishes.)
 */
export function wildcardMatch(pattern: string, text: string): boolean {
	let p = 0, t = 0, star = -1, mark = 0;
	while (t < text.length) {
		if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) { p++; t++; }
		else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t; }
		else if (star !== -1) { p = star + 1; t = ++mark; }
		else return false;
	}
	while (p < pattern.length && pattern[p] === '*') p++;
	return p === pattern.length;
}

/**
 * Decides which files and folders inside a mount are hidden from Obsidian.
 *
 * Pattern kinds (global patterns apply to every mount, then each mount adds
 * its own ignoreList):
 *   - plain name          "node_modules"   → any file/folder with that name
 *   - contains "/"        "Archive/2019"   → that subtree, relative to the mount root
 *                         "/Archive"       → leading "/": exactly that item from the root, no wildcards
 *   - contains "*"        "*.tmp", "~$*"   → glob on the name ("*" never crosses "/")
 *
 * Matching is case-insensitive on Windows and macOS, like their file systems, so
 * "thumbs.db" and "Thumbs.db" are the same file.
 */
export class IgnoreMatcher {
	private cache = new Map<string, CompiledPatterns>();
	private readonly fold: (s: string) => string;

	constructor(caseInsensitive = CASE_INSENSITIVE_FS) {
		this.fold = caseInsensitive ? s => s.toLowerCase() : s => s;
	}

	rebuild(globalPatterns: readonly string[], mounts: readonly MountPoint[]): void {
		this.cache.clear();
		for (const mount of mounts) {
			const compiled: CompiledPatterns = { names: new Set(), paths: [], globs: [] };
			for (const raw of [...globalPatterns, ...(mount.ignoreList ?? [])]) {
				const pattern = raw.trim();
				if (!pattern) continue;
				if (pattern.startsWith('/')) {
					// "/x/y": exactly that item below the mount root, taken literally
					// (a folder named "Draft*" is still just that folder).
					compiled.paths.push(this.fold(normalizePath(pattern)));
				} else if (pattern.includes('*')) {
					compiled.globs.push(this.fold(pattern));
				} else if (pattern.includes('/') || pattern.includes('\\')) {
					compiled.paths.push(this.fold(normalizePath(pattern.replace(/\\/g, '/'))));
				} else {
					compiled.names.add(this.fold(pattern));
				}
			}
			this.cache.set(mount.id, compiled);
		}
	}

	/**
	 * True when `name` (leaf file/folder name) or `mountRelativePath` (path
	 * from the mount root, forward slashes) is hidden for this mount.
	 */
	isIgnored(name: string, mount: MountPoint, mountRelativePath?: string): boolean {
		// Dot-names are always hidden, as Obsidian hides them in a vault: this
		// covers .git, .ssh, .obsidian and the plugin's own .folderbridge-trash.
		if (name.startsWith('.')) return true;
		const compiled = this.cache.get(mount.id);
		if (!compiled) return false;
		if (mountRelativePath && compiled.paths.length > 0) {
			const rel = this.fold(mountRelativePath);
			for (const p of compiled.paths) {
				if (rel === p || rel.startsWith(p + '/')) return true;
			}
		}
		const folded = this.fold(name);
		if (compiled.names.has(folded)) return true;
		for (const glob of compiled.globs) {
			if (wildcardMatch(glob, folded)) return true;
		}
		return false;
	}

	/**
	 * True when any segment of a mount-relative path is ignored. Use for paths
	 * whose ancestors were not checked individually (watcher events, direct
	 * adapter calls).
	 */
	isPathIgnored(mountRelativePath: string, mount: MountPoint): boolean {
		if (!mountRelativePath) return false;
		const parts = mountRelativePath.split('/');
		// Prefix strings are only needed when the mount has path patterns.
		const needPrefixes = (this.cache.get(mount.id)?.paths.length ?? 0) > 0;
		let prefix = '';
		for (const part of parts) {
			if (!part) continue;
			if (needPrefixes) prefix = prefix ? `${prefix}/${part}` : part;
			if (this.isIgnored(part, mount, needPrefixes ? prefix : undefined)) return true;
		}
		return false;
	}
}
