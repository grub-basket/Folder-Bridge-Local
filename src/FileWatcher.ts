import * as fs from 'fs';
import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { logger } from './logger';

export interface WatchHost {
	/** Current real root of the mount (primary or fallback path). */
	realRoot(mount: MountPoint): string;
	/** True when the mount-relative path is hidden by ignore rules. */
	isIgnored(mount: MountPoint, mountRelativePath: string): boolean;
	/** Reconcile individual changed vault paths (shallowest first). */
	syncPaths(mount: MountPoint, virtualPaths: string[]): Promise<void>;
	/** Full rescan of the mount (poll mode, or change notifications were lost). */
	syncAll(mount: MountPoint): Promise<void>;
	/** Native watching failed and polling took over. */
	onFallbackToPolling(mount: MountPoint, error: unknown): void;
}

const DEFAULT_DEBOUNCE_MS = 300;
/** Flush at least this often while events keep streaming in (bulk copies). */
const MAX_BATCH_DELAY_MS = 2000;
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 10_000;

interface WatchState {
	mount: MountPoint;
	handle: fs.FSWatcher | null;
	pollTimer: ReturnType<typeof setTimeout> | null;
	pending: Set<string>;
	needsFullSync: boolean;
	flushTimer: ReturnType<typeof setTimeout> | null;
	firstPendingAt: number;
	running: Promise<void> | null;
	stopped: boolean;
}

/**
 * Picks up changes made outside Obsidian (Excel saving a file, a colleague
 * adding a report, a sync tool).
 *
 * Native mode opens ONE recursive watch per mount (`fs.watch` with
 * `recursive: true`): ReadDirectoryChangesW with the subtree flag on Windows,
 * which also works on SMB shares whose server supports change notification.
 * Unlike a per-folder watcher it does not walk the tree at startup and holds a
 * single handle no matter how many folders the share has.
 *
 * Poll mode (or the automatic fallback when native watching fails) rescans the
 * mount on an interval instead.
 */
export class FileWatcher {
	private states = new Map<string, WatchState>();

	constructor(private readonly host: WatchHost) { }

	isWatching(mountId: string): boolean {
		return this.states.has(mountId);
	}

	start(mount: MountPoint): void {
		this.stop(mount.id);
		const mode = mount.watchMode ?? 'native';
		if (mode === 'off') return;
		const state: WatchState = {
			mount, handle: null, pollTimer: null, pending: new Set(), needsFullSync: false,
			flushTimer: null, firstPendingAt: 0, running: null, stopped: false,
		};
		this.states.set(mount.id, state);
		if (mode === 'poll') {
			this.startPolling(state);
			return;
		}
		const root = this.host.realRoot(mount);
		try {
			state.handle = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
				this.onRawEvent(state, typeof filename === 'string' ? filename : filename ? String(filename) : null);
			});
			state.handle.on('error', error => this.fallBackToPolling(state, error));
			logger.debug(`Watching ${root} (native, recursive)`);
		} catch (error) {
			this.fallBackToPolling(state, error);
		}
	}

	stop(mountId: string): void {
		const state = this.states.get(mountId);
		if (!state) return;
		state.stopped = true;
		this.states.delete(mountId);
		try { state.handle?.close(); } catch { /* already closed */ }
		if (state.pollTimer) clearTimeout(state.pollTimer);
		if (state.flushTimer) clearTimeout(state.flushTimer);
	}

	stopAll(): void {
		for (const id of [...this.states.keys()]) this.stop(id);
	}

	/**
	 * The next rescan is scheduled only after the previous one finished, and
	 * never sooner than 5× its duration: on a slow share a scan can take
	 * longer than the interval, and back-to-back scans would keep the
	 * network and Node's file threads permanently busy.
	 */
	private startPolling(state: WatchState): void {
		const base = Math.max(MIN_POLL_INTERVAL_MS, state.mount.watcherPollingIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		const schedule = (delay: number): void => {
			state.pollTimer = setTimeout(() => {
				if (state.stopped) return;
				if (typeof document !== 'undefined' && document.hidden) { schedule(base); return; } // Obsidian in the background
				state.needsFullSync = true;
				const started = Date.now();
				void this.flush(state).then(() => {
					if (!state.stopped) schedule(Math.max(base, 5 * (Date.now() - started)));
				});
			}, delay);
		};
		schedule(base);
	}

	private fallBackToPolling(state: WatchState, error: unknown): void {
		if (state.stopped || state.pollTimer) return;
		try { state.handle?.close(); } catch { /* ignore */ }
		state.handle = null;
		logger.warn(`Live change detection unavailable for "${state.mount.virtualPath}"; polling instead.`, error);
		this.startPolling(state);
		this.host.onFallbackToPolling(state.mount, error);
	}

	private onRawEvent(state: WatchState, filename: string | null): void {
		if (state.stopped) return;
		if (filename === null) {
			// The OS dropped events (buffer overflow): only a rescan is reliable.
			state.needsFullSync = true;
		} else {
			const rel = filename.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
			if (!rel || this.host.isIgnored(state.mount, rel)) return;
			state.pending.add(normalizePath(`${state.mount.virtualPath}/${rel}`));
		}
		this.scheduleFlush(state);
	}

	private scheduleFlush(state: WatchState): void {
		const now = Date.now();
		if (!state.flushTimer) state.firstPendingAt = now;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		const debounce = state.mount.watcherDebounceMs ?? DEFAULT_DEBOUNCE_MS;
		const delay = Math.max(0, Math.min(debounce, state.firstPendingAt + MAX_BATCH_DELAY_MS - now));
		state.flushTimer = setTimeout(() => {
			state.flushTimer = null;
			void this.flush(state);
		}, delay);
	}

	/**
	 * Process queued changes. Never runs twice at once for the same mount: a
	 * flush that finds a run in progress returns it, and that run's loop picks
	 * up whatever was queued meanwhile. (The loop's last pending check and its
	 * completion happen in one microtask chain, so no event can slip between.)
	 */
	private flush(state: WatchState): Promise<void> {
		if (state.running) return state.running;
		const run = (async () => {
			while (!state.stopped && (state.needsFullSync || state.pending.size > 0)) {
				if (state.needsFullSync) {
					state.needsFullSync = false;
					state.pending.clear(); // a full rescan covers them
					await this.host.syncAll(state.mount);
				} else {
					const paths = [...state.pending].sort((a, b) => a.split('/').length - b.split('/').length);
					state.pending.clear();
					await this.host.syncPaths(state.mount, paths);
				}
			}
		})();
		state.running = run
			.catch(error => logger.error(`Change processing failed for "${state.mount.virtualPath}"`, error))
			.finally(() => { state.running = null; });
		return state.running;
	}
}
