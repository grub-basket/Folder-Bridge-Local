import { normalizePath } from 'obsidian';
import * as path from 'path';
import { MountPoint } from './types';

/**
 * PathMapper maintains the list of active mount points and provides
 * bidirectional translation between vault-relative virtual paths and
 * real absolute filesystem paths.
 *
 * All vault paths are "normalized" (forward slashes, no leading slash),
 * matching the format Obsidian uses internally.
 */
export class PathMapper {
	private mounts: MountPoint[] = [];

	/**
	 * Sorted longest-virtual-path-first so the most specific mount wins, and
	 * pre-normalized so the hot path (every adapter call) never sorts or
	 * normalizes inside its loop.
	 */
	private sortedMountCache: ReadonlyArray<{ mount: MountPoint; normalizedVirtualPath: string }> = [];

	/** Runtime-resolved fallback paths keyed by mount id. */
	private resolvedRealPaths = new Map<string, string>();
	/** Normalized virtual root per active mount object (hot path: every adapter call). */
	private normalizedRoots = new WeakMap<MountPoint, string>();
	private rootConfigurations = new Map<string, string>();

	/** Replace the active mount list (call after settings change). */
	update(mounts: MountPoint[]): void {
		this.mounts = mounts.filter(m => m.enabled);
		this.sortedMountCache = this.mounts
			.map(m => ({ mount: m, normalizedVirtualPath: normalizePath(m.virtualPath) }))
			.sort((a, b) => b.normalizedVirtualPath.length - a.normalizedVirtualPath.length);
		this.normalizedRoots = new WeakMap(this.sortedMountCache.map(e => [e.mount, e.normalizedVirtualPath]));
		// Drop a resolved fallback when the mount's paths changed underneath it.
		const rootConfigurations = new Map(this.mounts.map(mount => [mount.id, JSON.stringify([mount.realPath, mount.fallbackRealPath])]));
		for (const id of this.resolvedRealPaths.keys()) {
			if (rootConfigurations.get(id) !== this.rootConfigurations.get(id)) this.resolvedRealPaths.delete(id);
		}
		this.rootConfigurations = rootConfigurations;
	}

	setResolvedPath(mountId: string, resolvedPath: string): void {
		this.resolvedRealPaths.set(mountId, resolvedPath);
	}

	clearResolvedPath(mountId: string): void {
		this.resolvedRealPaths.delete(mountId);
	}

	getMounts(): MountPoint[] {
		return this.mounts;
	}

	/** The real path in use right now: the fallback when it was selected, else realPath. */
	getEffectiveRealPath(mount: MountPoint): string {
		return this.resolvedRealPaths.get(mount.id) ?? mount.realPath;
	}

	/** The mount whose root is exactly this virtual path. */
	getMountByVirtualPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		return this.sortedMountCache.find(({ normalizedVirtualPath }) => normalizedVirtualPath === n)?.mount;
	}

	/** The mount that owns this virtual path (its root or anything below it). */
	getMountForPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		return this.sortedMountCache.find(
			({ normalizedVirtualPath: mv }) => n === mv || n.startsWith(mv + '/')
		)?.mount;
	}

	/** Path below the mount root ("" for the root itself), or undefined when outside. */
	getMountRelativePath(virtualPath: string, mount: MountPoint): string | undefined {
		const n = normalizePath(virtualPath);
		const mv = this.normalizedRoots.get(mount) ?? normalizePath(mount.virtualPath);
		if (n === mv) return '';
		return n.startsWith(mv + '/') ? n.slice(mv.length + 1) : undefined;
	}

	/**
	 * Translate a virtual vault path to the real filesystem path inside
	 * `mount`. Throws on "." / ".." segments: Obsidian never produces them,
	 * and resolving one would let a vault path step outside the mounted folder.
	 */
	toRealPath(virtualPath: string, mount: MountPoint): string {
		const effectiveRealPath = this.getEffectiveRealPath(mount);
		const relative = this.getMountRelativePath(virtualPath, mount);
		if (relative === undefined) {
			throw new Error(`Folder Bridge: "${virtualPath}" is not inside mount "${mount.virtualPath}".`);
		}
		if (relative === '') return effectiveRealPath;
		const segments = relative.split('/');
		if (segments.some(s => s === '..' || s === '.')) {
			throw new Error(`Folder Bridge: Refusing path with "." or ".." segments: "${virtualPath}".`);
		}
		return path.join(effectiveRealPath, ...segments);
	}

	/**
	 * Translate a real filesystem path back to a virtual vault path. Returns
	 * undefined when realPath is not inside the mount.
	 */
	toVirtualPath(realPath: string, mount: MountPoint): string | undefined {
		const rel = path.relative(this.getEffectiveRealPath(mount), realPath);
		if (rel === '') return normalizePath(mount.virtualPath);
		if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined;
		return normalizePath(mount.virtualPath + '/' + rel.split(path.sep).join('/'));
	}

	/**
	 * Normalized virtual paths of mounts (or intermediate virtual folders)
	 * that are DIRECT children of parentVirtualPath ('' = vault root). Used to
	 * inject virtual folders into vault listings.
	 */
	getVirtualMountsDirectChildren(parentVirtualPath: string): string[] {
		const parent = parentVirtualPath === '' ? '' : normalizePath(parentVirtualPath);
		const result: string[] = [];
		for (const { normalizedVirtualPath: mv } of this.sortedMountCache) {
			let directChild: string | undefined;
			if (parent === '' || parent === '/') {
				const firstSlash = mv.indexOf('/');
				directChild = firstSlash === -1 ? mv : mv.slice(0, firstSlash);
			} else if (mv.startsWith(parent + '/')) {
				const remainder = mv.slice(parent.length + 1);
				const nextSlash = remainder.indexOf('/');
				directChild = nextSlash === -1 ? mv : parent + '/' + remainder.slice(0, nextSlash);
			}
			if (directChild && !result.includes(directChild)) result.push(directChild);
		}
		return result;
	}

	/** True if any active mount is this path or lives below it. */
	hasMountsUnder(virtualPath: string): boolean {
		const n = virtualPath === '' ? '' : normalizePath(virtualPath);
		if (n === '' || n === '/') return this.sortedMountCache.length > 0;
		return this.sortedMountCache.some(({ normalizedVirtualPath: mv }) => mv === n || mv.startsWith(n + '/'));
	}
}
