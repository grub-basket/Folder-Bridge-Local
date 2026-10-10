import { DataAdapter, FuzzySuggestModal, Notice, Plugin, TFile, TFolder, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as nodePath from 'path';
import { DEFAULT_SETTINGS, FolderBridgeSettings, MountPoint } from './src/types';
import { PathMapper } from './src/PathMapper';
import { SecurityManager } from './src/SecurityManager';
import { IgnoreMatcher } from './src/IgnoreMatcher';
import { VirtualAdapter } from './src/VirtualAdapter';
import { VaultIndex } from './src/VaultIndex';
import { FileWatcher } from './src/FileWatcher';
import { KnownEntry, TreeSyncDeps, syncPath, syncTree } from './src/treeSync';
import { CASE_INSENSITIVE_FS, checkPathAccessible, normalizeForComparison, stripLongPathPrefix, withTimeout } from './src/OSHelpers';
import { isVisibleFileInMount } from './src/mountFileFilter';
import { MountModal } from './src/ui/MountModal';
import { MountRootDeleteModal } from './src/ui/MountRootDeleteModal';
import { ConflictInfo, ConflictModal } from './src/ui/ConflictModal';
import { mergeText } from './src/textFiles';
import { Appeared, Vanished, findMoves } from './src/moveDetect';
import { VaultStat } from './src/types';
import * as os from 'os';
import { FolderBridgeSettingTab } from './src/ui/SettingsTab';
import { InsightsModal } from './src/ui/InsightsModal';
import { BaseScanModal } from './src/ui/BaseScanModal';
import { SnapshotFile, captureMount, parseSnapshot, restoreMount } from './src/TreeSnapshot';
import { logger } from './src/logger';

type DesktopAdapter = DataAdapter & { getBasePath?(): string };

const HEALTH_CHECK_INTERVAL_MS = 30_000;

function generateId(): string {
	return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export type MountHealth = 'ok' | 'unreachable' | 'checking';

/** Decide whether a rule edit can reveal hidden items (needs a rescan) or only hide more (prune in memory). */
const IgnoreRules = {
	patternsRemoved(before: readonly string[], after: readonly string[]): boolean {
		const kept = new Set(after.map(p => p.trim()));
		return before.some(p => p.trim() !== '' && !kept.has(p.trim()));
	},
	loosened(old: MountPoint, updated: MountPoint): boolean {
		if (IgnoreRules.patternsRemoved(old.ignoreList ?? [], updated.ignoreList ?? [])) return true;
		const before = old.visibleFileFilter ?? 'all';
		const after = updated.visibleFileFilter ?? 'all';
		if (before !== after && before !== 'all') return true; // e.g. markdown-only → all, or → pdf-only
		const limit = (n?: number) => (n && n > 0 ? n : Infinity);
		return limit(updated.maxFiles) > limit(old.maxFiles);
	},
};

export default class FolderBridgePlugin extends Plugin {
	settings: FolderBridgeSettings;
	pathMapper = new PathMapper();
	security = new SecurityManager();
	ignore = new IgnoreMatcher();
	private index: VaultIndex;
	private watcher: FileWatcher;
	private originalAdapter: DataAdapter | null = null;

	/** Reachability per mount id, refreshed by the health-check loop. */
	readonly health = new Map<string, MountHealth>();
	/** Last probe error per mount id, shown in settings. */
	readonly healthError = new Map<string, string>();
	/** Mounts that are currently being scanned, for the status bar. */
	private scanning = new Set<string>();
	/** Changes on every (de)activation; long scans stop when their token is stale. */
	private sessions = new Map<string, symbol>();
	/** Serializes tree work per mount so scans and watcher batches never interleave. */
	private queues = new Map<string, Promise<void>>();
	private probesInFlight = new Set<string>();
	/** Mounts not activated because Obsidian Sync would sync them; value = reason. */
	readonly syncBlocked = new Map<string, string>();
	/** Last full check of each mount's folder on the drive (for "What's in this mount?"). */
	readonly lastScan = new Map<string, { ms: number; scanned: number; at: number }>();
	/** Unreachable mounts whose drive answers but whose folder is gone (moved/renamed). */
	readonly missing = new Set<string>();
	private unloaded = false;
	/** Last mount-tree snapshot read or written (see TreeSnapshot.ts). */
	private snapshot: SnapshotFile = { version: 1, mounts: {} };
	private snapshotTimer: number | null = null;
	private snapshotDirty = false;
	private restoreHookCleanup: (() => void) | null = null;
	/** When each mount running on its fallback last re-tried its (dead) primary path. */
	private lastPrimaryProbe = new Map<string, number>();

	private settingTab: FolderBridgeSettingTab | null = null;
	private statusBarEl: HTMLElement | null = null;
	private explorerObserver: MutationObserver | null = null;
	private observedExplorerEl: HTMLElement | null = null;
	private explorerRaf: number | null = null;

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	async onload(): Promise<void> {
		this.index = new VaultIndex(this.app);
		this.watcher = new FileWatcher({
			realRoot: mount => this.pathMapper.getEffectiveRealPath(mount),
			isIgnored: (mount, rel) => this.ignore.isPathIgnored(rel, mount),
			syncPaths: (mount, paths) => this.enqueue(mount, token => this.syncChangedPaths(mount, paths, token)),
			syncAll: mount => this.enqueue(mount, token => this.syncMount(mount, token, false)),
			onFallbackToPolling: mount => {
				new Notice(`Folder Bridge: "${this.displayName(mount)}" does not report changes. Checking it every minute instead.`, 8000);
			},
		});

		await this.loadSettings();
		this.applyMountState();
		this.installVirtualAdapter();
		this.hookStartupRestore();

		this.settingTab = new FolderBridgeSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon('folder-plus', 'Folder Bridge: add mount', () => this.openMountModal());
		if (this.settings.showStatusBar) this.createStatusBar();
		this.registerCommands();
		this.registerFileMenu();

		this.app.workspace.onLayoutReady(() => {
			this.setupExplorerMarkers();
			void this.activateAll();
			const timer = window.setInterval(() => void this.runHealthChecks(), HEALTH_CHECK_INTERVAL_MS);
			this.registerInterval(timer);
		});
	}

	onunload(): void {
		this.restoreHookCleanup?.();
		if (this.snapshotTimer !== null) window.clearTimeout(this.snapshotTimer);
		if (this.snapshotDirty) void this.saveSnapshot();
		this.unloaded = true;
		this.watcher?.stopAll();
		// Turned off by the user (Obsidian removes the id from its enabled list
		// first): take the mounted entries out of the vault, or edits to them
		// would land in real vault folders. On quit/reload keep them, so
		// Obsidian's metadata cache stays warm for the next start.
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
		const userDisabled = plugins?.enabledPlugins ? !plugins.enabledPlugins.has(this.manifest.id) : false;
		if (userDisabled) {
			for (const mount of this.settings.mountPoints.filter(m => this.sessions.has(m.id))) {
				void this.index.removeTree(normalizePath(mount.virtualPath))
					.then(() => this.index.pruneEmptyParents(mount.virtualPath, p => (this.originalAdapter ?? this.app.vault.adapter).exists(p)));
			}
		}
		this.sessions.clear();
		this.explorerObserver?.disconnect();
		if (this.explorerRaf !== null) cancelAnimationFrame(this.explorerRaf);
		document.querySelectorAll('[data-folder-bridge]').forEach(el => {
			el.removeAttribute('data-folder-bridge');
			el.removeAttribute('aria-label');
		});
		// Restore the original adapter. Mounted folders stay in Obsidian's
		// in-memory tree until the next restart, but nothing can read them.
		if (this.originalAdapter) {
			(this.app.vault as unknown as { adapter: DataAdapter }).adapter = this.originalAdapter;
			this.originalAdapter = null;
		}
	}

	// ------------------------------------------------------------------
	// Settings
	// ------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<FolderBridgeSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		this.settings.mountPoints = Array.isArray(this.settings.mountPoints) ? this.settings.mountPoints : [];
		this.settings.globalIgnorePatterns = Array.isArray(this.settings.globalIgnorePatterns)
			? this.settings.globalIgnorePatterns : [...DEFAULT_SETTINGS.globalIgnorePatterns];
		// data.json can be edited by hand or copied from another PC: re-validate
		// every mount and disable any that would expose a protected path.
		const accepted: MountPoint[] = [];
		for (const mount of this.settings.mountPoints) {
			if (!mount || typeof mount !== 'object') continue;
			if (!mount.id) mount.id = generateId();
			const error = this.security.validateMount(mount, accepted, this.vaultBasePath());
			if (error && mount.enabled) {
				mount.enabled = false;
				logger.warn(`Disabled mount "${mount.virtualPath}": ${error}`);
				new Notice(`Folder Bridge: Disabled "${mount.virtualPath}": ${error}`, 10000);
			}
			accepted.push(mount);
		}
		this.settings.mountPoints = accepted;
		if (this.settings.mountRootDeletionBehavior !== 'unmount') this.settings.mountRootDeletionBehavior = 'ask';
		if (!['merge', 'copy', 'overwrite'].includes(this.settings.conflictMode)) this.settings.conflictMode = 'merge';
		for (const mount of accepted.filter(m => m.enabled)) {
			const clash = await this.vaultFolderClash(mount.virtualPath);
			if (clash) {
				mount.enabled = false;
				new Notice(`Folder Bridge: Disabled "${mount.virtualPath}": ${clash}`, 10000);
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Push the mount list into the path mapper, allowlist and ignore matcher. */
	applyMountState(): void {
		const enabled = this.settings.mountPoints.filter(m => m.enabled);
		this.pathMapper.update(this.settings.mountPoints);
		this.security.setAllowlist(enabled.flatMap(m => [m.realPath, m.fallbackRealPath ?? '']));
		this.ignore.rebuild(this.settings.globalIgnorePatterns, this.settings.mountPoints);
		this.updateStatusBar();
		this.scheduleExplorerMarkers();
		this.refreshSettingTab();
	}

	/** Re-render the settings tab if it is open (after mount changes or a health change). */
	refreshSettingTab(): void {
		if (this.settingTab?.containerEl.isConnected) this.settingTab.render();
	}

	vaultBasePath(): string | undefined {
		const adapter = (this.originalAdapter ?? this.app.vault.adapter) as DesktopAdapter;
		return adapter.getBasePath?.();
	}

	displayName(mount: MountPoint): string {
		return mount.label || mount.virtualPath;
	}

	// ------------------------------------------------------------------
	// Adapter installation
	// ------------------------------------------------------------------

	private installVirtualAdapter(): void {
		const vault = this.app.vault as unknown as { adapter: DataAdapter };
		const original = vault.adapter;
		this.originalAdapter = original;

		const adapter = new VirtualAdapter(original, this.pathMapper, this.security, this.ignore, {
			confirmUnmount: mount => this.confirmUnmount(mount),
			onWritten: path => this.registerWrite(path),
			onFolderCreated: path => { if (!(this.index.get(path) instanceof TFolder)) this.index.addFolder(path); },
			onRenamed: (oldPath, newPath) => this.index.renameTree(oldPath, newPath),
			onDeleted: path => this.index.removeTree(path),
			getKnownMtime: path => {
				const file = this.app.vault.getAbstractFileByPath(path);
				return file instanceof TFile ? file.stat.mtime : undefined;
			},
			isOffline: id => this.health.get(id) === 'unreachable' || this.syncBlocked.has(id),
			unavailableReason: id => this.syncBlocked.get(id) ?? (this.missing.has(id) ? this.healthError.get(id) : undefined),
			conflictMode: () => this.settings.conflictMode,
			requestReload: path => this.reloadAfterSave(path),
			onUnresolvedConflict: conflict => this.openConflictDialog(conflict),
			onVanished: path => {
				// Let the vault catch up now (pairs it with its new location if it was moved).
				const mount = this.pathMapper.getMountForPath(path);
				if (mount && this.sessions.has(mount.id)) void this.enqueue(mount, t => this.syncChangedPaths(mount, [path], t));
			},
			isOpenInEditor: path => this.app.workspace.getLeavesOfType('markdown')
				.some(leaf => (leaf.view as unknown as { file?: TFile | null }).file?.path === path),
		});

		// The Proxy forwards anything VirtualAdapter does not define to the
		// original adapter, and reports the original's prototype so Obsidian's
		// `instanceof FileSystemAdapter` checks keep passing.
		const bound = (owner: object, val: unknown): unknown =>
			typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(owner) : val;
		vault.adapter = new Proxy(adapter, {
			get(target, prop, receiver): unknown {
				if (prop in target) return bound(target, Reflect.get(target, prop, receiver));
				return bound(original, (original as unknown as Record<PropertyKey, unknown>)[prop]);
			},
			set(_target, prop, value) {
				(original as unknown as Record<PropertyKey, unknown>)[prop] = value;
				return true;
			},
			getPrototypeOf(): object | null {
				return Object.getPrototypeOf(original) as object | null;
			},
		});
	}

	/**
	 * A file inside a mount was written from Obsidian. Register it before the
	 * write call returns: vault.create()/copy() look the new file up right
	 * after, and Obsidian's own watcher never sees mounted folders.
	 */
	private async registerWrite(path: string): Promise<void> {
		const mount = this.pathMapper.getMountForPath(path);
		if (!mount) return;
		const token = this.sessions.get(mount.id);
		const stat = await this.app.vault.adapter.stat(path);
		if (!stat || stat.type !== 'file') return;
		// Turned off or re-activated while we waited: leave the tree alone.
		if (token !== undefined && this.sessions.get(mount.id) !== token) return;
		// Not activated yet (startup, before its scan): still refresh the stat of a
		// file Obsidian already shows, or the next save would see our own previous
		// save as "changed by someone else" and make a needless conflict copy.
		if (token === undefined && !(this.index.get(path) instanceof TFile)) return;
		this.index.modifyFile(path, stat);
		this.scheduleSnapshotSave(60_000);
	}

	/**
	 * After a save that merged in changes from disk, tell Obsidian the file
	 * changed so the open editor shows the merged text. Obsidian ignores that
	 * signal while it is still saving, so wait for the save to finish.
	 */
	private reloadAfterSave(path: string, attempt = 0): void {
		window.setTimeout(() => void (async () => {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || this.unloaded) return;
			if ((file as unknown as { saving?: number }).saving && attempt < 40) {
				this.reloadAfterSave(path, attempt + 1);
				return;
			}
			const stat = await this.app.vault.adapter.stat(path);
			if (stat) this.index.modifyFile(path, stat);
		})(), 150);
	}

	/** Your name for labels: the operating-system login (e.g. the Windows user name). */
	private myName(): string {
		try {
			return os.userInfo().username || 'you';
		} catch {
			return 'you';
		}
	}

	/**
	 * Both you and someone else changed the same lines. Your version was
	 * saved and theirs kept as a copy; open the merge dialog once Obsidian
	 * finished saving (so applying a choice does not race that save).
	 */
	private openConflictDialog(conflict: Omit<ConflictInfo, 'myName'>, attempt = 0): void {
		window.setTimeout(() => {
			const file = this.app.vault.getAbstractFileByPath(conflict.path);
			if (!(file instanceof TFile) || this.unloaded) return;
			if ((file as unknown as { saving?: number }).saving && attempt < 40) {
				this.openConflictDialog(conflict, attempt + 1);
				return;
			}
			const info: ConflictInfo = { ...conflict, myName: this.myName() };
			new ConflictModal(this.app, info,
				resolved => this.applyResolution(file, conflict.mine, resolved),
				async () => {
					// Keep what you had, then switch the note to their version.
					const adapter = this.app.vault.adapter as unknown as VirtualAdapter;
					try {
						await adapter.keepTextCopy(conflict.path, conflict.mine, `${this.myName()}'s version`);
					} catch (error) {
						return `Could not keep a copy of your version, so nothing was changed (${(error as Error).message}).`;
					}
					return this.applyResolution(file, conflict.mine, conflict.theirs);
				},
			).open();
		}, 250);
	}

	/**
	 * Write the resolved text. If you typed more after the clash, those edits
	 * are merged on top (three-way against what was saved at the clash); if
	 * that is impossible, nothing is changed and the reason is returned.
	 */
	private async applyResolution(file: TFile, savedAtClash: string, resolved: string): Promise<string | null> {
		const norm = (s: string) => s.replace(/\r\n/g, '\n');
		let problem: string | null = null;
		try {
			await this.app.vault.process(file, current => {
				if (norm(current) === norm(savedAtClash)) return resolved;
				const merged = mergeText(savedAtClash, current, resolved);
				if (merged.clean) return merged.merged;
				problem = 'The note changed again in the same places while you were choosing, so your choices were not applied. Their version is still in the trash folder.';
				return current;
			});
		} catch (error) {
			return (error as Error).message;
		}
		if (!problem) {
			// Obsidian ignores change signals while it is writing; make the open editor show the result.
			this.reloadAfterSave(file.path);
			new Notice(`Folder Bridge: Updated "${file.name}".`, 4000);
		}
		return problem;
	}

	/**
	 * Obsidian Sync (or any sync tool) would upload every mounted file to the
	 * cloud and replay deletions from other devices onto the share. A mount is
	 * only activated when Sync is off or the mount's folder is excluded from it.
	 * Returns a reason when blocked, null when fine.
	 */
	private syncProblem(mount: MountPoint): string | null {
		type SyncPlugin = { enabled?: boolean; instance?: { filter?: { ignoreFolders?: unknown } } };
		const internal = (this.app as unknown as { internalPlugins?: { getPluginById?(id: string): SyncPlugin | null; plugins?: Record<string, SyncPlugin> } }).internalPlugins;
		const sync = internal?.getPluginById?.('sync') ?? internal?.plugins?.sync;
		if (!sync?.enabled) return null;
		const ignored = sync.instance?.filter?.ignoreFolders;
		const folder = normalizePath(mount.virtualPath);
		if (Array.isArray(ignored) && ignored.some(f => typeof f === 'string' && (folder === normalizePath(f) || folder.startsWith(normalizePath(f) + '/')))) return null;
		if (!Array.isArray(ignored)) {
			logger.warn('Obsidian Sync is on but its excluded folders could not be read; make sure mounted folders are excluded.');
			return null;
		}
		return `Obsidian Sync is on and "${folder}" is not excluded from it. Sync would upload the shared files and could delete them on the drive from another device. Exclude this folder in Settings → Sync → Excluded folders, then rescan.`;
	}

	/** Deleting a mount root in Obsidian = unmount (files untouched), after confirmation. */
	private async confirmUnmount(mount: MountPoint): Promise<boolean> {
		if (this.settings.mountRootDeletionBehavior !== 'unmount') {
			const choice = await new Promise<{ ok: boolean; remember: boolean }>(resolve => {
				new MountRootDeleteModal(this.app, mount.virtualPath, (ok, remember) => resolve({ ok, remember })).open();
			});
			if (!choice.ok) return false;
			if (choice.remember) {
				this.settings.mountRootDeletionBehavior = 'unmount';
				await this.saveSettings();
			}
		}
		await this.removeMount(mount.id);
		return true;
	}

	// ------------------------------------------------------------------
	// Startup snapshot (keeps Obsidian's metadata cache warm; see TreeSnapshot.ts)
	// ------------------------------------------------------------------

	/**
	 * The snapshot lists every mounted file name, so it lives OUTSIDE the
	 * vault (which may sit on a shared drive): in Obsidian's local app-data
	 * folder, one file per vault. Local disk also makes saving it cheap.
	 * null when that folder is unavailable; then no snapshot is kept.
	 */
	snapshotFile(): string | null {
		try {
			const req = (globalThis as { require?: (id: string) => unknown }).require;
			const electron = req?.('electron') as { remote?: { app?: { getPath(name: string): string } } } | undefined;
			const userData = electron?.remote?.app?.getPath('userData');
			const appId = (this.app as unknown as { appId?: string }).appId;
			if (!userData || !appId) return null;
			return nodePath.join(userData, 'folder-bridge-local', `${appId.replace(/[^\w-]/g, '_')}.json`);
		} catch {
			return null;
		}
	}

	/**
	 * Obsidian loads plugins, then the vault, then initializes the metadata
	 * cache. Run once, right before that initialization, to put the saved
	 * mount trees back so cached metadata for unchanged notes is kept.
	 */
	private hookStartupRestore(): void {
		type Initialize = (this: unknown, ...args: unknown[]) => Promise<unknown>;
		const cache = this.app.metadataCache as unknown as { initialized?: boolean; initialize?: Initialize };
		if (cache.initialized || typeof cache.initialize !== 'function') return; // plugin enabled after startup
		const original: Initialize = cache.initialize;
		const hadOwn = Object.prototype.hasOwnProperty.call(cache, 'initialize') as boolean;
		const cleanup = () => {
			if (hadOwn) cache.initialize = original;
			else delete cache.initialize;
			this.restoreHookCleanup = null;
		};
		cache.initialize = async (...args: unknown[]) => {
			cleanup();
			try {
				await this.restoreSnapshots();
			} catch (error) {
				logger.warn('Could not restore saved mount trees; the startup scan rebuilds them.', error);
			}
			return await (original.apply(cache, args) as Promise<unknown>);
		};
		this.restoreHookCleanup = cleanup;
	}

	private async restoreSnapshots(): Promise<void> {
		const started = performance.now();
		const file = this.snapshotFile();
		let text: string | null = null;
		try {
			if (file) text = await fs.promises.readFile(file, 'utf8');
		} catch { /* no snapshot yet */ }
		this.snapshot = parseSnapshot(text);
		let restored = 0;
		for (const mount of this.settings.mountPoints.filter(m => m.enabled)) {
			if (this.syncProblem(mount)) continue; // never show Sync files it would upload
			restored += restoreMount(this.index, mount, this.snapshot.mounts[mount.id]);
		}
		if (restored > 0) logger.debug(`Restored ${restored} mounted items from the snapshot in ${Math.round(performance.now() - started)} ms`);
	}

	/** Save soon (debounced). Large mounts make this a few hundred KB, so not too often. */
	private scheduleSnapshotSave(delayMs: number): void {
		this.snapshotDirty = true;
		if (this.unloaded) return;
		if (this.snapshotTimer !== null) {
			if (delayMs >= 30_000) return; // a save is already pending
			window.clearTimeout(this.snapshotTimer);
		}
		this.snapshotTimer = window.setTimeout(() => {
			this.snapshotTimer = null;
			void this.saveSnapshot();
		}, delayMs);
	}

	private async saveSnapshot(): Promise<void> {
		this.snapshotDirty = false;
		const file = this.snapshotFile();
		if (!file) return;
		const next: SnapshotFile = { version: 1, mounts: {} };
		for (const mount of this.settings.mountPoints.filter(m => m.enabled)) {
			// Keep the previous tree of a mount that is offline or still scanning,
			// rather than overwriting it with a partial view.
			const live = this.health.get(mount.id) === 'ok' && !this.scanning.has(mount.id);
			const snap = live ? captureMount(this.index, mount) : this.snapshot.mounts[mount.id];
			if (snap) next.mounts[mount.id] = snap;
		}
		this.snapshot = next;
		try {
			// Write a temp file and rename it, so a crash never leaves half a snapshot.
			await fs.promises.mkdir(nodePath.dirname(file), { recursive: true });
			await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(next));
			await fs.promises.rename(`${file}.tmp`, file);
		} catch (error) {
			logger.warn('Could not save the mount snapshot', error);
		}
	}

	// ------------------------------------------------------------------
	// Mount activation and tree sync
	// ------------------------------------------------------------------

	/** Run `work` after earlier work for the same mount, with the current session token. */
	private enqueue(mount: MountPoint, work: (token: symbol) => Promise<void>): Promise<void> {
		const token = this.sessions.get(mount.id);
		if (!token) return Promise.resolve();
		const previous = this.queues.get(mount.id) ?? Promise.resolve();
		const next = previous.catch(() => { }).then(() => {
			if (this.sessions.get(mount.id) !== token) return;
			return work(token);
		});
		this.queues.set(mount.id, next);
		void next.finally(() => { if (this.queues.get(mount.id) === next) this.queues.delete(mount.id); }).catch(() => { });
		return next;
	}

	private isCurrent(mountId: string, token: symbol): boolean {
		return !this.unloaded && this.sessions.get(mountId) === token;
	}

	private makeSyncDeps(mount: MountPoint, token: symbol): TreeSyncDeps {
		const adapter = this.app.vault.adapter as unknown as VirtualAdapter;
		// Parent listings for the exact-name check, shared by one batch/scan.
		const listings = new Map<string, Promise<Set<string>>>();
		const changed = () => this.scheduleSnapshotSave(60_000);
		const caseInsensitive = CASE_INSENSITIVE_FS;
		return {
			list: path => adapter.listMounted(path),
			stat: path => adapter.statMounted(path),
			findCaseTwin: caseInsensitive
				? path => {
					const parent = this.index.get(path.slice(0, path.lastIndexOf('/')));
					const lower = path.toLowerCase();
					return parent instanceof TFolder ? parent.children.find(c => c.path !== path && c.path.toLowerCase() === lower)?.path : undefined;
				}
				: undefined,
			exactNameExists: caseInsensitive
				? async path => {
					const parent = path.slice(0, path.lastIndexOf('/'));
					let names = listings.get(parent);
					if (!names) {
						names = adapter.listMounted(parent).then(l => new Set([...l.files, ...l.folders]));
						listings.set(parent, names);
					}
					return (await names).has(path);
				}
				: undefined,
			known: (path): KnownEntry => {
				const item = this.index.get(path);
				if (item instanceof TFile) return { kind: 'file', mtime: item.stat.mtime, size: item.stat.size };
				if (item instanceof TFolder) return { kind: 'folder', children: item.children.map(c => c.path) };
				return null;
			},
			addFolder: path => { this.index.addFolder(path); changed(); },
			addFile: (path, stat) => { this.index.addFile(path, stat); changed(); },
			modifyFile: (path, stat) => { this.index.modifyFile(path, stat); changed(); },
			removeTree: async path => { await this.index.removeTree(path); changed(); },
			// Stop as soon as the share goes offline: adapter calls then fail
			// fast, and a failed stat must not be mistaken for a deleted file.
			shouldContinue: () => this.isCurrent(mount.id, token) && this.health.get(mount.id) !== 'unreachable',
			// Repeated I/O errors mid-scan: the share died. Mark it offline now
			// rather than waiting for the next health check, so Obsidian's own
			// reads fail fast instead of queueing behind hung network calls.
			onTrouble: () => {
				if (!this.isCurrent(mount.id, token)) return;
				this.setHealth(mount, 'unreachable', 'Stopped responding during a scan.');
				this.watcher.stop(mount.id);
				new Notice(`Folder Bridge: "${this.displayName(mount)}" stopped responding. It reconnects automatically.`, 8000);
			},
		};
	}

	/**
	 * Find the reachable path (primary, else fallback). No side effects: the
	 * caller applies the result only if the mount was not edited meanwhile.
	 * While a mount runs on its fallback, the dead primary is re-tried only
	 * every 5 minutes (each try can hold a file-system thread for a while).
	 */
	private async probeMount(mount: MountPoint): Promise<{ reachable: boolean; path?: string; error?: string; missing?: boolean }> {
		const onFallback = !!mount.fallbackRealPath && this.pathMapper.getEffectiveRealPath(mount) === mount.fallbackRealPath;
		const now = Date.now();
		let error: string | undefined;
		if (!onFallback || now - (this.lastPrimaryProbe.get(mount.id) ?? 0) > 300_000) {
			this.lastPrimaryProbe.set(mount.id, now);
			const primary = await checkPathAccessible(mount.realPath);
			if (primary.accessible) return { reachable: true, path: mount.realPath };
			error = primary.error;
		}
		if (mount.fallbackRealPath) {
			const fallback = await checkPathAccessible(mount.fallbackRealPath);
			if (fallback.accessible) return { reachable: true, path: mount.fallbackRealPath };
			error ??= fallback.error;
		}
		// The share answers but the folder is gone: moved or renamed, not offline.
		const parent = nodePath.dirname(mount.realPath);
		if (parent !== mount.realPath && (await checkPathAccessible(parent)).accessible) {
			return { reachable: false, missing: true, error: 'Folder not found on the drive (moved or renamed?). Edit the mount to point to its new location.' };
		}
		return { reachable: false, error: error ?? 'Not reachable.' };
	}

	private applyProbe(mount: MountPoint, probe: { reachable: boolean; path?: string; error?: string; missing?: boolean }): void {
		if (probe.missing) this.missing.add(mount.id);
		else this.missing.delete(mount.id);
		if (probe.reachable && probe.path) {
			if (probe.path === mount.realPath) this.pathMapper.clearResolvedPath(mount.id);
			else this.pathMapper.setResolvedPath(mount.id, probe.path);
			this.setHealth(mount, 'ok');
		} else {
			this.setHealth(mount, 'unreachable', probe.error);
		}
	}

	/** True when `mount` is still the live configuration for its id and the session is unchanged. */
	private stillCurrent(mount: MountPoint, token: symbol | undefined): boolean {
		return !this.unloaded && token !== undefined && this.sessions.get(mount.id) === token
			&& this.settings.mountPoints.find(m => m.id === mount.id) === mount;
	}

	private setHealth(mount: MountPoint, health: MountHealth, error?: string): void {
		const changed = this.health.get(mount.id) !== health;
		this.health.set(mount.id, health);
		if (error) this.healthError.set(mount.id, error);
		else this.healthError.delete(mount.id);
		this.updateStatusBar();
		this.scheduleExplorerMarkers();
		if (changed) this.refreshSettingTab();
	}

	private async activateAll(): Promise<void> {
		// One at a time: parallel first scans of several large shares would
		// compete for the same network link and Node's small fs thread pool.
		for (const mount of this.settings.mountPoints.filter(m => m.enabled)) {
			if (this.unloaded) return;
			await this.activateMount(mount);
		}
	}

	/** Show a mount in the vault: index its contents and start watching. */
	async activateMount(mount: MountPoint, announce = false): Promise<void> {
		const problem = this.syncProblem(mount);
		if (problem) {
			this.syncBlocked.set(mount.id, problem);
			new Notice(`Folder Bridge: "${this.displayName(mount)}" was not mounted. ${problem}`, 0);
			this.refreshSettingTab();
			return;
		}
		this.syncBlocked.delete(mount.id);
		const token = Symbol(mount.id);
		this.sessions.set(mount.id, token);
		this.watcher.stop(mount.id);
		this.index.ensureFolder(mount.virtualPath);
		await this.enqueue(mount, async t => {
			const probe = await this.probeMount(mount);
			if (!this.isCurrent(mount.id, t)) return;
			this.applyProbe(mount, probe);
			if (!probe.reachable) {
				new Notice(probe.missing
					? `Folder Bridge: "${this.displayName(mount)}": ${probe.error}`
					: `Folder Bridge: "${this.displayName(mount)}" is not reachable (${probe.error}). It will reconnect automatically.`, 8000);
				return;
			}
			// Watch first: changes made during a long scan queue up behind it
			// (watcher batches go through the same per-mount queue) instead of
			// being missed.
			this.watcher.start(mount);
			await this.syncMount(mount, t, true);
			if (announce && this.isCurrent(mount.id, t)) new Notice(`Folder Bridge: Mounted "${this.displayName(mount)}".`);
		});
	}

	/** Hide a mount from the vault (does not touch any real files). */
	async deactivateMount(mount: MountPoint): Promise<void> {
		// Drop the session first: queued work, health checks and pending writes
		// all check it, so nothing can re-add entries while we remove them.
		this.sessions.delete(mount.id);
		this.watcher.stop(mount.id);
		await (this.queues.get(mount.id) ?? Promise.resolve()).catch(() => { });
		await this.index.removeTree(normalizePath(mount.virtualPath));
		await this.index.pruneEmptyParents(mount.virtualPath, p => (this.originalAdapter ?? this.app.vault.adapter).exists(p));
		this.health.delete(mount.id);
		this.healthError.delete(mount.id);
		this.lastScan.delete(mount.id); // a remount may point at a different folder
		this.scheduleSnapshotSave(5_000);
	}

	/** Full scan. `initial` shows a progress notice (first index can take a while). */
	private async syncMount(mount: MountPoint, token: symbol, initial: boolean): Promise<void> {
		if (!this.isCurrent(mount.id, token)) return;
		this.scanning.add(mount.id);
		this.updateStatusBar();
		const notice = initial ? new Notice(`Folder Bridge: Scanning "${this.displayName(mount)}"…`, 0) : null;
		const started = performance.now();
		try {
			const deps = this.makeSyncDeps(mount, token);
			deps.onProgress = progress => {
				notice?.setMessage(`Folder Bridge: Scanning "${this.displayName(mount)}"… ${progress.scanned.toLocaleString()} items`);
			};
			const result = await syncTree(normalizePath(mount.virtualPath), deps, { maxItems: mount.maxFiles ?? 0 });
			const ms = Math.round(performance.now() - started);
			logger.debug(`Synced "${mount.virtualPath}" in ${ms} ms`, result);
			if (!this.isCurrent(mount.id, token)) return;
			if (!result.aborted && result.failedFolders.length === 0) this.lastScan.set(mount.id, { ms, scanned: result.scanned, at: Date.now() });
			if (result.limitHit) {
				new Notice(`Folder Bridge: "${this.displayName(mount)}" stopped at its limit of ${(mount.maxFiles ?? 0).toLocaleString()} items. Raise "Max items" or add ignore patterns.`, 10000);
			}
			// Save soon after a scan that changed something, or when this mount has no snapshot yet.
			if (result.added || result.modified || result.removed || !this.snapshot.mounts[mount.id]) this.scheduleSnapshotSave(5_000);
			if (result.failedFolders.length > 0) {
				logger.warn(`Could not list ${result.failedFolders.length} folder(s) in "${mount.virtualPath}"`, result.failedFolders);
				if (initial || result.failedFolders.includes(normalizePath(mount.virtualPath))) {
					new Notice(`Folder Bridge: ${result.failedFolders.length} folder(s) in "${this.displayName(mount)}" could not be read (permissions or network). Their contents may be incomplete.`, 8000);
				}
			}
		} finally {
			notice?.hide();
			this.scanning.delete(mount.id);
			this.updateStatusBar();
		}
	}

	/**
	 * Apply one watcher batch (paths sorted shallowest first). Work is
	 * de-duplicated: a path whose parent Obsidian does not know is replaced by
	 * its highest unknown ancestor (one recursive sync covers the whole new
	 * subtree), and anything inside a folder already handled in this batch is
	 * skipped (a deleted folder's children, a new folder's contents).
	 */
	private async syncChangedPaths(mount: MountPoint, paths: string[], token: symbol): Promise<void> {
		const deps = this.makeSyncDeps(mount, token);
		const root = normalizePath(mount.virtualPath);
		const handled = new Set<string>();
		const covered = (p: string): boolean => {
			for (let i = p.lastIndexOf('/'); i > root.length; i = p.lastIndexOf('/', i - 1)) {
				if (handled.has(p.slice(0, i))) return true;
			}
			return false;
		};
		// Collapse the batch: highest unknown ancestor per path, no duplicates.
		const todo: string[] = [];
		const seen = new Set<string>();
		for (let path of paths) {
			if (!path.startsWith(root + '/')) continue;
			for (let parent = path.slice(0, path.lastIndexOf('/')); parent.length > root.length && !this.index.get(parent); parent = parent.slice(0, parent.lastIndexOf('/'))) {
				path = parent;
			}
			if (!seen.has(path)) { seen.add(path); todo.push(path); }
		}

		// Stat everything once; pair what vanished with what appeared (a move
		// or rename made outside Obsidian) and report those as renames, so
		// open tabs follow the note instead of closing.
		const stats = new Map<string, VaultStat | null | 'error'>();
		const vanished: Vanished[] = [];
		const appeared: Appeared[] = [];
		for (const path of todo) {
			if (!this.isCurrent(mount.id, token)) return;
			let stat: VaultStat | null | 'error';
			try { stat = await deps.stat(path); } catch { stat = 'error'; }
			stats.set(path, stat);
			const item = this.index.get(path);
			if (stat === null && item instanceof TFile) vanished.push({ path, kind: 'file', mtime: item.stat.mtime, size: item.stat.size });
			else if (stat === null && item instanceof TFolder) vanished.push({ path, kind: 'folder' });
			else if (stat && stat !== 'error' && !item) appeared.push({ path, stat });
		}
		if (vanished.length > 0 && appeared.length > 0) {
			const adapter = this.app.vault.adapter as unknown as VirtualAdapter;
			const moves = await findMoves(vanished, appeared, {
				knownChildNames: p => { const f = this.index.get(p); return f instanceof TFolder ? f.children.map(c => c.name) : []; },
				diskChildNames: async p => { const l = await adapter.listMounted(p); return [...l.files, ...l.folders].map(x => x.slice(x.lastIndexOf('/') + 1)); },
			});
			for (const move of moves) {
				if (!this.isCurrent(mount.id, token)) return;
				this.index.renameTree(move.from, move.to);
				adapter.pathRenamed(move.from, move.to);
				handled.add(move.from);
				handled.add(move.to);
				if (move.kind === 'folder') await syncTree(move.to, deps, { maxItems: mount.maxFiles ?? 0 }); // reconcile contents
				this.scheduleSnapshotSave(60_000);
			}
		}

		for (const path of todo) {
			if (!this.isCurrent(mount.id, token)) return;
			if (handled.has(path) || covered(path)) continue;
			handled.add(path);
			const stat = stats.get(path);
			if (stat === 'error') continue; // unknown state: change nothing
			await syncPath(path, deps, { maxItems: mount.maxFiles ?? 0 }, stat);
		}
	}

	/** Manual "rescan": re-probe, re-index, restart watching. */
	async rescanMount(mount: MountPoint): Promise<void> {
		if (!mount.enabled) return;
		if (!this.sessions.has(mount.id) || this.syncProblem(mount)) {
			await this.activateMount(mount, true);
			return;
		}
		await this.enqueue(mount, async token => {
			const probe = await this.probeMount(mount);
			if (!this.isCurrent(mount.id, token)) return;
			this.applyProbe(mount, probe);
			if (!probe.reachable) {
				new Notice(probe.missing ? `Folder Bridge: "${this.displayName(mount)}": ${probe.error}` : `Folder Bridge: "${this.displayName(mount)}" is still not reachable.`);
				return;
			}
			if (!this.watcher.isWatching(mount.id)) this.watcher.start(mount);
			await this.syncMount(mount, token, true);
		});
	}

	private async runHealthChecks(): Promise<void> {
		if (document.hidden || this.unloaded) return;
		for (const mount of this.settings.mountPoints.filter(m => m.enabled && this.sessions.has(m.id))) {
			// Probes also run during scans (that is how a share dying mid-scan is
			// noticed). checkPathAccessible keeps at most one call per path.
			if (this.probesInFlight.has(mount.id)) continue;
			this.probesInFlight.add(mount.id);
			const token = this.sessions.get(mount.id);
			void (async () => {
				try {
					const before = this.health.get(mount.id);
					const pathBefore = this.pathMapper.getEffectiveRealPath(mount);
					const probe = await this.probeMount(mount);
					// Edited, turned off or re-activated meanwhile: the result is stale.
					if (!this.stillCurrent(mount, token)) return;
					this.applyProbe(mount, probe);
					if (!probe.reachable) {
						if (before === 'ok') {
							this.watcher.stop(mount.id);
							new Notice(probe.missing
								? `Folder Bridge: "${this.displayName(mount)}": its folder is no longer on the drive (moved or renamed?). Its files stay listed; edit the mount to point to the new location.`
								: `Folder Bridge: "${this.displayName(mount)}" went offline. Its files stay listed but cannot be opened until it reconnects.`, 8000);
						}
						return;
					}
					const pathChanged = this.pathMapper.getEffectiveRealPath(mount) !== pathBefore;
					if (before === 'unreachable' || pathChanged) {
						if (before === 'unreachable') new Notice(`Folder Bridge: "${this.displayName(mount)}" is back online.`, 4000);
						if (pathChanged) this.watcher.stop(mount.id);
						if (!this.watcher.isWatching(mount.id)) this.watcher.start(mount);
						await this.enqueue(mount, t => this.syncMount(mount, t, false));
					} else if ((mount.watchMode ?? 'native') !== 'off' && !this.watcher.isWatching(mount.id)) {
						this.watcher.start(mount);
					}
				} finally {
					this.probesInFlight.delete(mount.id);
				}
			})();
		}
	}

	// ------------------------------------------------------------------
	// Mount management (used by settings, modals, commands)
	// ------------------------------------------------------------------

	/**
	 * A mount must not shadow a real folder or file that already exists in the
	 * vault, and no folder on its way may be a file ("Notes.md/X").
	 */
	private async vaultFolderClash(virtualPath: string): Promise<string | null> {
		const original = this.originalAdapter ?? this.app.vault.adapter;
		const n = normalizePath(virtualPath);
		if (await original.exists(n)) {
			return `"${n}" already exists in the vault. Choose a new vault folder name; the mount creates it.`;
		}
		const segments = n.split('/');
		for (let i = 1; i < segments.length; i++) {
			const ancestor = segments.slice(0, i).join('/');
			if ((await original.stat(ancestor))?.type === 'file') return `"${ancestor}" is a file in the vault, so it cannot hold a mount.`;
		}
		return null;
	}

	/**
	 * Re-check the folder after Windows resolves it: 8.3 short names
	 * (C:\PROGRA~1), junctions and subst drives can make an innocent-looking
	 * path land in a protected folder or inside the vault.
	 */
	private async resolvedPathError(data: Omit<MountPoint, 'id'>, others: MountPoint[]): Promise<string | null> {
		for (const candidate of [data.realPath, data.fallbackRealPath]) {
			if (!candidate?.trim()) continue;
			let resolved: string;
			try {
				const native = new Promise<string>((resolve, reject) => fs.realpath.native(candidate.trim(), (e, r) => e ? reject(e) : resolve(r)));
				resolved = await withTimeout(native, 5000, () => candidate.trim());
			} catch {
				continue; // unreachable right now: the textual checks already passed
			}
			if (resolved === candidate.trim()) continue;
			const error = this.security.validateMount({ ...data, realPath: resolved, fallbackRealPath: undefined }, others, this.vaultBasePath());
			if (error) return `${error} ("${candidate.trim()}" resolves to "${resolved}".)`;
		}
		return null;
	}

	/**
	 * Remove now-hidden entries (stricter ignore rules or file-type filter)
	 * straight from Obsidian's tree: no disk or network access needed.
	 */
	private async pruneHidden(mount: MountPoint): Promise<void> {
		const root = this.index.get(normalizePath(mount.virtualPath));
		if (!(root instanceof TFolder)) return;
		const doomed: string[] = [];
		const walk = (folder: TFolder): void => {
			for (const child of folder.children) {
				const rel = this.pathMapper.getMountRelativePath(child.path, mount) ?? '';
				if (this.ignore.isIgnored(child.name, mount, rel) || (child instanceof TFile && !isVisibleFileInMount(child.path, mount))) {
					doomed.push(child.path);
				} else if (child instanceof TFolder) {
					walk(child);
				}
			}
		};
		walk(root);
		for (const p of doomed) await this.index.removeTree(p);
		if (doomed.length) this.scheduleSnapshotSave(5_000);
	}

	/** Returns an error message, or null when the mount was added. */
	async addMount(data: Omit<MountPoint, 'id'>): Promise<string | null> {
		const error = this.security.validateMount(data, this.settings.mountPoints, this.vaultBasePath())
			?? await this.vaultFolderClash(data.virtualPath)
			?? await this.resolvedPathError(data, this.settings.mountPoints);
		if (error) return error;
		const mount: MountPoint = { ...data, id: generateId() };
		for (const warning of this.security.getPathWarnings(mount.realPath, this.settings.mountPoints)) {
			new Notice(`Folder Bridge: ${warning}`, 10000);
		}
		this.settings.mountPoints.push(mount);
		await this.saveSettings();
		this.applyMountState();
		if (mount.enabled) void this.activateMount(mount, true);
		return null;
	}

	/** Returns an error message, or null when the mount was updated. */
	async updateMount(id: string, data: Omit<MountPoint, 'id'>): Promise<string | null> {
		const idx = this.settings.mountPoints.findIndex(m => m.id === id);
		if (idx === -1) return 'This mount no longer exists.';
		const old = this.settings.mountPoints[idx];
		const others = this.settings.mountPoints.filter(m => m.id !== id);
		const virtualMoved = normalizePath(old.virtualPath) !== normalizePath(data.virtualPath);
		const realChanged = normalizeForComparison(old.realPath) !== normalizeForComparison(data.realPath)
			|| (old.fallbackRealPath ?? '') !== (data.fallbackRealPath ?? '');
		const error = this.security.validateMount(data, others, this.vaultBasePath())
			?? (virtualMoved || (!old.enabled && data.enabled) ? await this.vaultFolderClash(data.virtualPath) : null)
			?? (realChanged ? await this.resolvedPathError(data, others) : null);
		if (error) return error;
		const updated: MountPoint = { ...data, id };

		const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
		const rulesChanged = !same(old.ignoreList, updated.ignoreList) || old.visibleFileFilter !== updated.visibleFileFilter
			|| (old.maxFiles ?? 0) !== (updated.maxFiles ?? 0);
		const loosened = IgnoreRules.loosened(old, updated);
		const watchChanged = old.watchMode !== updated.watchMode || old.watcherPollingIntervalMs !== updated.watcherPollingIntervalMs
			|| old.watcherDebounceMs !== updated.watcherDebounceMs;
		const live = old.enabled && updated.enabled && this.sessions.has(id);

		// Only the vault location changed: rename Obsidian's entries in place.
		// That keeps every TFile (open tabs, Obsidian's metadata cache) and
		// avoids a full rescan of the share.
		if (live && virtualMoved && !realChanged) {
			this.watcher.stop(id);
			this.sessions.set(id, Symbol(id)); // cancel queued work that uses the old paths
			this.settings.mountPoints[idx] = updated;
			await this.saveSettings();
			this.applyMountState(); // the path mapper must know the new location before rename listeners read files
			this.index.renameTree(normalizePath(old.virtualPath), normalizePath(updated.virtualPath));
			await this.index.pruneEmptyParents(old.virtualPath, p => (this.originalAdapter ?? this.app.vault.adapter).exists(p));
			if (rulesChanged) await this.pruneHidden(updated);
			if (loosened) void this.enqueue(updated, t => this.syncMount(updated, t, false));
			if (this.health.get(id) === 'ok') this.watcher.start(updated);
			this.scheduleSnapshotSave(5_000);
			return null;
		}

		// Folder or on/off changed: remove the old view while the path mapper still knows it.
		const remount = virtualMoved || realChanged || old.enabled !== updated.enabled;
		if (old.enabled && remount) await this.deactivateMount(old);
		this.settings.mountPoints[idx] = updated;
		await this.saveSettings();
		this.applyMountState();
		const adapter = this.app.vault.adapter as unknown as VirtualAdapter;
		if (old.readOnly !== updated.readOnly) adapter.clearReadOnlyNotice?.(id);
		adapter.clearBlockedNotices?.(id);

		if (!updated.enabled) return null;
		if (remount) {
			void this.activateMount(updated, true);
			return null;
		}
		if (rulesChanged) {
			// Stricter rules: prune in memory. Looser rules: rescan to find what is now visible.
			await this.pruneHidden(updated);
			if (loosened) void this.enqueue(updated, t => this.syncMount(updated, t, false));
		}
		// The watcher holds the mount object: restart it after any edit.
		if ((watchChanged || rulesChanged) && this.health.get(id) === 'ok' && this.sessions.has(id)) this.watcher.start(updated);
		return null;
	}

	async setMountEnabled(id: string, enabled: boolean): Promise<void> {
		const mount = this.settings.mountPoints.find(m => m.id === id);
		if (!mount || mount.enabled === enabled) return;
		const error = await this.updateMount(id, { ...mount, enabled });
		if (error) new Notice(`Folder Bridge: ${error}`);
	}

	async removeMount(id: string): Promise<void> {
		const mount = this.settings.mountPoints.find(m => m.id === id);
		if (!mount) return;
		if (mount.enabled) await this.deactivateMount(mount);
		this.settings.mountPoints = this.settings.mountPoints.filter(m => m.id !== id);
		await this.saveSettings();
		this.applyMountState();
		new Notice(`Folder Bridge: Removed "${this.displayName(mount)}". No files were deleted.`);
	}

	/** Apply edited global ignore patterns to every active mount. */
	async setGlobalIgnorePatterns(patterns: string[]): Promise<void> {
		const loosened = IgnoreRules.patternsRemoved(this.settings.globalIgnorePatterns, patterns);
		this.settings.globalIgnorePatterns = patterns;
		await this.saveSettings();
		this.applyMountState();
		for (const mount of this.settings.mountPoints.filter(m => m.enabled && this.sessions.has(m.id))) {
			await this.pruneHidden(mount);
			if (loosened) void this.enqueue(mount, token => this.syncMount(mount, token, false));
		}
	}

	/** Edits to the same mount, one after another (each sees the result of the previous). */
	private editChains = new Map<string, Promise<string | null>>();

	/**
	 * Change a mount based on its CURRENT settings, serialized per mount. Two
	 * quick clicks (hide A, then hide B) must not build on the same stale copy,
	 * or the second save would silently drop the first.
	 */
	editMount(id: string, change: (current: MountPoint) => Omit<MountPoint, 'id'>): Promise<string | null> {
		const previous = this.editChains.get(id) ?? Promise.resolve(null);
		const next = previous.catch(() => null).then(() => {
			const current = this.settings.mountPoints.find(m => m.id === id);
			return current ? this.updateMount(id, change(current)) : 'This mount no longer exists.';
		});
		this.editChains.set(id, next);
		return next;
	}

	/** Hide one item (mount-relative path) via the mount's ignore list; pruned in memory. */
	hideInMount(id: string, rel: string): Promise<string | null> {
		const pattern = '/' + rel; // leading "/" = exactly this item, relative to the mount root
		return this.editMount(id, m => ({ ...m, ignoreList: (m.ignoreList ?? []).includes(pattern) ? m.ignoreList : [...(m.ignoreList ?? []), pattern] }));
	}

	openInsights(mount: MountPoint): void {
		new InsightsModal(this.app, this, mount).open();
	}

	openMountModal(existing?: MountPoint, defaults?: Partial<MountPoint>): void {
		new MountModal(this.app, this, existing, defaults).open();
	}

	openBaseScan(): void {
		new BaseScanModal(this.app, this).open();
	}

	// ------------------------------------------------------------------
	// Commands and menus
	// ------------------------------------------------------------------

	private pickMount(placeholder: string, describe: (m: MountPoint) => string, onChoose: (m: MountPoint) => void): void {
		const mounts = this.settings.mountPoints;
		if (mounts.length === 0) {
			new Notice('Folder Bridge: no mounts configured.');
			return;
		}
		const modal = new (class extends FuzzySuggestModal<MountPoint> {
			getItems() { return mounts; }
			getItemText(m: MountPoint) { return describe(m); }
			onChooseItem(m: MountPoint) { onChoose(m); }
		})(this.app);
		modal.setPlaceholder(placeholder);
		modal.open();
	}

	private registerCommands(): void {
		this.addCommand({ id: 'add-mount', name: 'Add mount', callback: () => this.openMountModal() });
		this.addCommand({ id: 'suggest-mounts-from-bases', name: 'Suggest mounts from Bases', callback: () => this.openBaseScan() });
		this.addCommand({
			id: 'rescan-all',
			name: 'Rescan all mounts',
			callback: () => {
				for (const m of this.settings.mountPoints.filter(x => x.enabled)) void this.rescanMount(m);
			},
		});
		this.addCommand({
			id: 'mount-insights',
			name: 'What\'s in a mount? (size report)',
			callback: () => this.pickMount('Choose a mount', m => this.displayName(m), m => this.openInsights(m)),
		});
		this.addCommand({
			id: 'toggle-mount',
			name: 'Turn a mount on or off',
			callback: () => this.pickMount('Choose a mount to turn on or off',
				m => `${m.enabled ? 'On' : 'Off'} · ${this.displayName(m)}`,
				m => void this.setMountEnabled(m.id, !m.enabled)),
		});
		this.addCommand({
			id: 'toggle-readonly',
			name: 'Make a mount read-only or writable',
			callback: () => this.pickMount('Choose a mount',
				m => `${m.readOnly ? 'Read-only' : 'Writable'} · ${this.displayName(m)}`,
				m => void this.updateMount(m.id, { ...m, readOnly: !m.readOnly }).then(error => {
					new Notice(error ? `Folder Bridge: ${error}` : `Folder Bridge: "${this.displayName(m)}" is now ${m.readOnly ? 'writable' : 'read-only'}.`);
				})),
		});
	}

	private registerFileMenu(): void {
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			const mount = this.pathMapper.getMountForPath(file.path);
			if (!mount) {
				if (file instanceof TFolder && !this.pathMapper.hasMountsUnder(file.path)) {
					menu.addItem(item => item
						.setTitle('Mount external folder here…')
						.setIcon('folder-plus')
						.onClick(() => {
							let candidate = normalizePath(`${file.isRoot() ? '' : file.path + '/'}External`);
							for (let n = 2; this.app.vault.getAbstractFileByPath(candidate); n++) {
								candidate = normalizePath(`${file.isRoot() ? '' : file.path + '/'}External ${n}`);
							}
							this.openMountModal(undefined, { virtualPath: candidate });
						}));
				}
				return;
			}

			const rel = this.pathMapper.getMountRelativePath(file.path, mount);
			if (rel === '') {
				menu.addItem(item => item.setTitle('Rescan mount').setIcon('refresh-cw').onClick(() => void this.rescanMount(mount)));
				menu.addItem(item => item.setTitle('Edit mount…').setIcon('settings').onClick(() => this.openMountModal(mount)));
				menu.addItem(item => item.setTitle('What\'s in this mount?').setIcon('bar-chart-2').onClick(() => this.openInsights(mount)));
				menu.addItem(item => item.setTitle('Unmount…').setIcon('unlink').onClick(() => void this.confirmUnmount(mount)));
				return;
			}
			if (rel === undefined) return;
			menu.addItem(item => item
				.setTitle(`Hide "${file.name}" from this mount`)
				.setIcon('eye-off')
				.onClick(() => void (async () => {
					const error = await this.hideInMount(mount.id, rel);
					new Notice(error ? `Folder Bridge: ${error}` : `Folder Bridge: Hid "/${rel}". Undo in the mount's ignore list.`);
				})()));
		}));
	}

	// ------------------------------------------------------------------
	// Status bar and explorer markers
	// ------------------------------------------------------------------

	createStatusBar(): void {
		if (this.statusBarEl) return;
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('mod-clickable');
		this.statusBarEl.addEventListener('click', () => {
			const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
			setting?.open();
			setting?.openTabById(this.manifest.id);
		});
		this.updateStatusBar();
	}

	removeStatusBar(): void {
		this.statusBarEl?.remove();
		this.statusBarEl = null;
	}

	updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el || !this.settings) return;
		const enabled = this.settings.mountPoints.filter(m => m.enabled);
		const unreachable = enabled.filter(m => this.health.get(m.id) === 'unreachable').length;
		el.toggleClass('folderbridge-status-warning', unreachable > 0);
		if (this.scanning.size > 0) el.setText(`Folder Bridge: scanning ${this.scanning.size}…`);
		else if (unreachable > 0) {
			const missing = enabled.filter(m => this.health.get(m.id) === 'unreachable' && this.missing.has(m.id)).length;
			el.setText(`Folder Bridge: ${[unreachable - missing && `${unreachable - missing} offline`, missing && `${missing} not found`].filter(Boolean).join(', ')}`);
		}
		else el.setText(`Folder Bridge: ${enabled.length} mount${enabled.length === 1 ? '' : 's'}`);
		el.setAttribute('aria-label', 'Open Folder Bridge settings');
	}

	/**
	 * Mark mount root folders in the file explorer. A MutationObserver plus a
	 * handful of attribute lookups (one per mount) per animation frame: the
	 * explorer only renders visible rows, so this stays cheap however many
	 * files the mounts hold.
	 */
	private setupExplorerMarkers(): void {
		const attach = () => {
			const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
			const el = leaf?.view?.containerEl ?? null;
			if (el === this.observedExplorerEl) return;
			this.explorerObserver?.disconnect();
			this.observedExplorerEl = el;
			if (!el) return;
			this.explorerObserver = new MutationObserver(() => this.scheduleExplorerMarkers());
			this.explorerObserver.observe(el, { childList: true, subtree: true });
			this.scheduleExplorerMarkers();
		};
		attach();
		this.registerEvent(this.app.workspace.on('layout-change', attach));
	}

	private scheduleExplorerMarkers(): void {
		if (this.explorerRaf !== null || !this.observedExplorerEl) return;
		this.explorerRaf = requestAnimationFrame(() => {
			this.explorerRaf = null;
			this.applyExplorerMarkers();
		});
	}

	private applyExplorerMarkers(): void {
		const root = this.observedExplorerEl;
		if (!root) return;
		const wanted = new Map<string, MountPoint>();
		for (const m of this.settings.mountPoints) if (m.enabled) wanted.set(normalizePath(m.virtualPath), m);
		root.querySelectorAll<HTMLElement>('.nav-folder-title[data-folder-bridge]').forEach(el => {
			if (wanted.has(el.dataset.path ?? '')) return;
			el.removeAttribute('data-folder-bridge');
			el.removeAttribute('aria-label');
		});
		for (const [virtualPath, mount] of wanted) {
			const el = root.querySelector<HTMLElement>(`.nav-folder-title[data-path="${CSS.escape(virtualPath)}"]`);
			if (!el) continue;
			const state = this.health.get(mount.id) !== 'unreachable' ? 'mounted' : this.missing.has(mount.id) ? 'missing' : 'offline';
			if (el.dataset.folderBridge !== state) el.dataset.folderBridge = state;
			const tip = `${state === 'offline' ? 'Offline · ' : state === 'missing' ? 'Folder not found · ' : ''}${stripLongPathPrefix(this.pathMapper.getEffectiveRealPath(mount))}`;
			if (el.getAttribute('aria-label') !== tip) el.setAttribute('aria-label', tip);
		}
	}
}
