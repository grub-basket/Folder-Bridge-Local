/*
Folder Bridge Local — a Windows-focused, local/network-folder-only fork of
Folder Bridge by Timmothy Escolopio (MIT). Bundled by esbuild; see the source repo.
*/

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => FolderBridgePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian11 = require("obsidian");
var fs4 = __toESM(require("fs"));
var nodePath = __toESM(require("path"));

// src/types.ts
var DEFAULT_SETTINGS = {
  mountPoints: [],
  mountRootDeletionBehavior: "ask",
  showStatusBar: true,
  conflictMode: "merge",
  // Names starting with "." (.git, .DS_Store, …) are always hidden.
  globalIgnorePatterns: ["Thumbs.db", "desktop.ini", "~$*", "$RECYCLE.BIN", "System Volume Information"]
};

// src/PathMapper.ts
var import_obsidian = require("obsidian");
var path = __toESM(require("path"));
var PathMapper = class {
  constructor() {
    this.mounts = [];
    /**
     * Sorted longest-virtual-path-first so the most specific mount wins, and
     * pre-normalized so the hot path (every adapter call) never sorts or
     * normalizes inside its loop.
     */
    this.sortedMountCache = [];
    /** Runtime-resolved fallback paths keyed by mount id. */
    this.resolvedRealPaths = /* @__PURE__ */ new Map();
    /** Normalized virtual root per active mount object (hot path: every adapter call). */
    this.normalizedRoots = /* @__PURE__ */ new WeakMap();
    this.rootConfigurations = /* @__PURE__ */ new Map();
  }
  /** Replace the active mount list (call after settings change). */
  update(mounts) {
    this.mounts = mounts.filter((m) => m.enabled);
    this.sortedMountCache = this.mounts.map((m) => ({ mount: m, normalizedVirtualPath: (0, import_obsidian.normalizePath)(m.virtualPath) })).sort((a, b) => b.normalizedVirtualPath.length - a.normalizedVirtualPath.length);
    this.normalizedRoots = new WeakMap(this.sortedMountCache.map((e) => [e.mount, e.normalizedVirtualPath]));
    const rootConfigurations = new Map(this.mounts.map((mount) => [mount.id, JSON.stringify([mount.realPath, mount.fallbackRealPath])]));
    for (const id of this.resolvedRealPaths.keys()) {
      if (rootConfigurations.get(id) !== this.rootConfigurations.get(id)) this.resolvedRealPaths.delete(id);
    }
    this.rootConfigurations = rootConfigurations;
  }
  setResolvedPath(mountId, resolvedPath) {
    this.resolvedRealPaths.set(mountId, resolvedPath);
  }
  clearResolvedPath(mountId) {
    this.resolvedRealPaths.delete(mountId);
  }
  getMounts() {
    return this.mounts;
  }
  /** The real path in use right now: the fallback when it was selected, else realPath. */
  getEffectiveRealPath(mount) {
    return this.resolvedRealPaths.get(mount.id) ?? mount.realPath;
  }
  /** The mount whose root is exactly this virtual path. */
  getMountByVirtualPath(virtualPath) {
    const n = (0, import_obsidian.normalizePath)(virtualPath);
    return this.sortedMountCache.find(({ normalizedVirtualPath }) => normalizedVirtualPath === n)?.mount;
  }
  /** The mount that owns this virtual path (its root or anything below it). */
  getMountForPath(virtualPath) {
    const n = (0, import_obsidian.normalizePath)(virtualPath);
    return this.sortedMountCache.find(
      ({ normalizedVirtualPath: mv }) => n === mv || n.startsWith(mv + "/")
    )?.mount;
  }
  /** Path below the mount root ("" for the root itself), or undefined when outside. */
  getMountRelativePath(virtualPath, mount) {
    const n = (0, import_obsidian.normalizePath)(virtualPath);
    const mv = this.normalizedRoots.get(mount) ?? (0, import_obsidian.normalizePath)(mount.virtualPath);
    if (n === mv) return "";
    return n.startsWith(mv + "/") ? n.slice(mv.length + 1) : void 0;
  }
  /**
   * Translate a virtual vault path to the real filesystem path inside
   * `mount`. Throws on "." / ".." segments: Obsidian never produces them,
   * and resolving one would let a vault path step outside the mounted folder.
   */
  toRealPath(virtualPath, mount) {
    const effectiveRealPath = this.getEffectiveRealPath(mount);
    const relative3 = this.getMountRelativePath(virtualPath, mount);
    if (relative3 === void 0) {
      throw new Error(`Folder Bridge: "${virtualPath}" is not inside mount "${mount.virtualPath}".`);
    }
    if (relative3 === "") return effectiveRealPath;
    const segments = relative3.split("/");
    if (segments.some((s) => s === ".." || s === ".")) {
      throw new Error(`Folder Bridge: Refusing path with "." or ".." segments: "${virtualPath}".`);
    }
    return path.join(effectiveRealPath, ...segments);
  }
  /**
   * Translate a real filesystem path back to a virtual vault path. Returns
   * undefined when realPath is not inside the mount.
   */
  toVirtualPath(realPath, mount) {
    const rel = path.relative(this.getEffectiveRealPath(mount), realPath);
    if (rel === "") return (0, import_obsidian.normalizePath)(mount.virtualPath);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return void 0;
    return (0, import_obsidian.normalizePath)(mount.virtualPath + "/" + rel.split(path.sep).join("/"));
  }
  /**
   * Normalized virtual paths of mounts (or intermediate virtual folders)
   * that are DIRECT children of parentVirtualPath ('' = vault root). Used to
   * inject virtual folders into vault listings.
   */
  getVirtualMountsDirectChildren(parentVirtualPath) {
    const parent = parentVirtualPath === "" ? "" : (0, import_obsidian.normalizePath)(parentVirtualPath);
    const result = [];
    for (const { normalizedVirtualPath: mv } of this.sortedMountCache) {
      let directChild;
      if (parent === "" || parent === "/") {
        const firstSlash = mv.indexOf("/");
        directChild = firstSlash === -1 ? mv : mv.slice(0, firstSlash);
      } else if (mv.startsWith(parent + "/")) {
        const remainder = mv.slice(parent.length + 1);
        const nextSlash = remainder.indexOf("/");
        directChild = nextSlash === -1 ? mv : parent + "/" + remainder.slice(0, nextSlash);
      }
      if (directChild && !result.includes(directChild)) result.push(directChild);
    }
    return result;
  }
  /** True if any active mount is this path or lives below it. */
  hasMountsUnder(virtualPath) {
    const n = virtualPath === "" ? "" : (0, import_obsidian.normalizePath)(virtualPath);
    if (n === "" || n === "/") return this.sortedMountCache.length > 0;
    return this.sortedMountCache.some(({ normalizedVirtualPath: mv }) => mv === n || mv.startsWith(n + "/"));
  }
};

// src/SecurityManager.ts
var import_obsidian2 = require("obsidian");
var path3 = __toESM(require("path"));

// src/OSHelpers.ts
var fs = __toESM(require("fs"));
var path2 = __toESM(require("path"));
var import_url = require("url");
var IS_WINDOWS = typeof process !== "undefined" && process.platform === "win32";
var IS_MAC = typeof process !== "undefined" && process.platform === "darwin";
var CASE_INSENSITIVE_FS = IS_WINDOWS || IS_MAC;
var PATH_EXAMPLES = IS_WINDOWS ? { folder: "Z:\\Finance\\Reports", share: "\\\\server\\share\\Reports", describe: "A folder on this PC, a mapped drive (Z:\\Finance\\Reports) or a network share (\\\\server\\share\\Reports)." } : IS_MAC ? { folder: "/Users/you/Documents/Reports", share: "/Volumes/Share/Reports", describe: "A folder on this Mac, or a mounted network share (/Volumes/Share/Reports)." } : { folder: "/home/you/Documents/Reports", share: "/mnt/share/Reports", describe: "A folder on this computer, or a mounted network share (/mnt/share/Reports)." };
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
var ACCESS_PROBE_TIMEOUT_MS = 5e3;
var probesInFlight = /* @__PURE__ */ new Map();
function checkPathAccessible(realPath) {
  const existing = probesInFlight.get(realPath);
  if (existing) {
    return withTimeout(existing, ACCESS_PROBE_TIMEOUT_MS, () => ({
      accessible: false,
      readOnly: false,
      error: "Still waiting for the previous check (network drive offline?)."
    }));
  }
  const probe = (async () => {
    try {
      const stat = await fs.promises.stat(realPath);
      if (!stat.isDirectory()) return { accessible: false, readOnly: false, error: "Not a folder." };
    } catch (e) {
      return { accessible: false, readOnly: false, error: e.message };
    }
    let readOnly = false;
    try {
      await fs.promises.access(realPath, fs.constants.W_OK);
    } catch {
      readOnly = true;
    }
    return { accessible: true, readOnly };
  })();
  probesInFlight.set(realPath, probe);
  void probe.finally(() => {
    if (probesInFlight.get(realPath) === probe) probesInFlight.delete(realPath);
  });
  return withTimeout(probe, ACCESS_PROBE_TIMEOUT_MS, () => ({
    accessible: false,
    readOnly: false,
    error: `No response after ${ACCESS_PROBE_TIMEOUT_MS / 1e3} s (network drive offline?).`
  }));
}
async function isCloudPlaceholder(realPath) {
  try {
    await fs.promises.access(realPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function realPathToResourceUrl(resourcePathPrefix, realPath, mtime) {
  let href = (0, import_url.pathToFileURL)(stripLongPathPrefix(realPath)).href;
  if (href.startsWith("file:///")) href = href.substring(8);
  else if (href.startsWith("file://")) href = "%5C%5C" + href.substring(7);
  return `${resourcePathPrefix}${href}?${mtime || Date.now()}`;
}
function normalizeForComparison(p) {
  if (isUnsupportedWindowsDevicePath(p)) return p;
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  if (windowsStyle || IS_WINDOWS && !p.startsWith("/")) {
    const ordinaryPath = p.replace(/\//g, "\\").replace(/^\\\\\?\\([a-zA-Z]:\\)/, "$1").replace(/^\\\\\?\\UNC\\/i, "\\\\");
    const normalized2 = path2.win32.normalize(ordinaryPath);
    const root2 = path2.win32.parse(normalized2).root;
    const trimmed = normalized2 !== root2 ? normalized2.replace(/[\\/]+$/, "") : normalized2;
    const rest = trimmed.slice(root2.length).split("\\").map((seg) => seg.replace(/[. ]+$/, "")).join("\\");
    return (root2 + rest).replace(/\\/g, "/").toLowerCase();
  }
  const normalized = path2.posix.normalize(p);
  const root = path2.posix.parse(normalized).root;
  return normalized !== root ? normalized.replace(/\/+$/g, "") : normalized;
}
function isUnsupportedWindowsDevicePath(candidatePath) {
  const windowsPath = candidatePath.replace(/\//g, "\\");
  if (/^\\{1,2}\?\?\\/.test(windowsPath) || windowsPath.startsWith("\\\\.\\")) return true;
  if (!windowsPath.startsWith("\\\\?\\")) return false;
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(windowsPath)) return false;
  const unc = windowsPath.match(/^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)(?:\\|$)/i);
  return !unc || unc.slice(1).some((segment) => segment === "." || segment === "..");
}
function isUNCPath(p) {
  return /^[\\/]{2}[^\\/?.]/.test(p);
}
function ensureLongPathPrefix(p) {
  if (!IS_WINDOWS) return p;
  if (p.startsWith("\\\\?\\")) return p;
  if (p.length < 248) return p;
  const resolved = path2.win32.resolve(p);
  if (resolved.startsWith("\\\\")) return "\\\\?\\UNC\\" + resolved.slice(2);
  return "\\\\?\\" + resolved;
}
function stripLongPathPrefix(p) {
  if (/^\\\\\?\\UNC\\/i.test(p)) return "\\\\" + p.slice(8);
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}
function invalidWindowsNameReason(name) {
  if (!IS_WINDOWS) return null;
  const stem = name.split(".")[0];
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(stem.trim())) {
    return `"${name}" is a reserved device name on Windows (CON, NUL, COM1-9, LPT1-9, \u2026).`;
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    return `"${name}" contains a character Windows does not allow in file names (< > : " | ? *).`;
  }
  if (/[. ]$/.test(name)) {
    return `"${name}" ends with a dot or space, which Windows does not allow.`;
  }
  return null;
}
function translateFsError(err, op) {
  const p = err.path ? `"${stripLongPathPrefix(err.path)}"` : "path";
  switch (err.code) {
    case "EACCES":
    case "EPERM":
      return `Access denied to ${p}. Check that your account has permission on this folder or share.`;
    case "ENAMETOOLONG":
      return `Path is too long for Windows. Shorten folder or file names.`;
    case "EBUSY":
      return `${p} is open in another program (Excel, Word, \u2026). Close it and try again.`;
    case "ENOENT":
      return `${p} was not found. It may have been moved or deleted.`;
    case "ENOSPC":
      return `Not enough disk space to complete the operation.`;
    case "EEXIST":
      return `${p} already exists.`;
    case "ENOTEMPTY":
      return `${p} is not empty.`;
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `The network drive holding ${p} is not responding.`;
    default:
      return `${op}: ${err.message}`;
  }
}

// src/SecurityManager.ts
var CREDENTIAL_FOLDERS = /* @__PURE__ */ new Set([".ssh", ".gnupg"]);
var PROTECTED_PARENTS = /* @__PURE__ */ new Set(["/private"]);
var DANGEROUS_PATHS = [
  "C:\\",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/var",
  "/private/etc",
  "/private/var",
  "/System",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32"
].map(normalizeForComparison);
var SecurityManager = class {
  constructor() {
    this.allowlist = [];
  }
  /** Replace the entire allowlist (call after settings change). */
  setAllowlist(paths) {
    this.allowlist = Array.from(new Set(paths.filter(Boolean).map((p) => normalizeForComparison(p))));
  }
  /**
   * True when realPath equals an allowlisted path or is inside one. The
   * check is separator-aware ("/foo" must not match "/foobar").
   */
  isAllowed(realPath) {
    if (isUnsupportedWindowsDevicePath(realPath)) return false;
    const normalized = normalizeForComparison(realPath);
    return this.allowlist.some((allowed) => normalized === allowed || normalized.startsWith(allowed.endsWith("/") ? allowed : allowed + "/"));
  }
  /** Returns an error message when the path may not be mounted, else null. */
  validateLocalPath(candidatePath, fieldLabel) {
    const trimmedPath = candidatePath?.trim();
    if (!trimmedPath) return `${fieldLabel} cannot be empty.`;
    if (isUnsupportedWindowsDevicePath(trimmedPath)) return `${fieldLabel} uses an unsupported Windows device path.`;
    if (!path3.posix.isAbsolute(trimmedPath) && !path3.win32.isAbsolute(trimmedPath)) {
      return `${fieldLabel} must be a full path, such as ${PATH_EXAMPLES.folder}.`;
    }
    if (IS_WINDOWS && !/^[a-zA-Z]:[\\/]/.test(trimmedPath) && !isUNCPath(trimmedPath) && !trimmedPath.startsWith("\\\\?\\")) {
      return `${fieldLabel} must start with a drive letter (Z:\\\u2026) or a server name (\\\\server\\share\\\u2026).`;
    }
    if (isUNCPath(trimmedPath) && trimmedPath.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean).length < 2) {
      return `${fieldLabel} must include the share name, e.g. \\\\server\\share.`;
    }
    const comparisonPaths = [normalizeForComparison(trimmedPath)];
    if (!IS_WINDOWS && path3.posix.isAbsolute(trimmedPath)) comparisonPaths.push(path3.posix.normalize(trimmedPath));
    const protectedMessage = `"${trimmedPath}" is a protected system path and cannot be mounted.`;
    for (const dangerousNorm of DANGEROUS_PATHS) {
      if (comparisonPaths.some((norm) => norm === dangerousNorm || dangerousNorm !== "/" && norm.startsWith(dangerousNorm + "/"))) {
        return protectedMessage;
      }
    }
    if (comparisonPaths.some((norm) => PROTECTED_PARENTS.has(norm))) return protectedMessage;
    if (comparisonPaths.some((norm) => /^[a-z]:\/(windows|program files( \(x86\))?|programdata)(\/|$)/.test(norm))) {
      return protectedMessage;
    }
    if (comparisonPaths.some((norm) => norm.split("/").some((segment) => CREDENTIAL_FOLDERS.has(segment)))) {
      return `"${trimmedPath}" is a protected path (it can hold credentials) and cannot be mounted.`;
    }
    return null;
  }
  /**
   * Validates a candidate mount. `vaultBasePath` is the vault's own folder:
   * mounting the vault (or a folder containing it) into itself would loop.
   * Returns an error string on failure, or null on success.
   */
  validateMount(mount, existingMounts, vaultBasePath) {
    const virtualNorm = (0, import_obsidian2.normalizePath)(mount.virtualPath?.trim() ?? "");
    if (!virtualNorm || virtualNorm === "/") return "Vault folder cannot be empty.";
    if (virtualNorm.split("/").some((s) => s === ".." || s === ".")) return 'Vault folder cannot contain "." or ".." segments.';
    if (virtualNorm.startsWith(".")) return 'Vault folder cannot be hidden (start with ".").';
    const realPathError = this.validateLocalPath(mount.realPath, "Folder path");
    if (realPathError) return realPathError;
    if (mount.fallbackRealPath?.trim()) {
      const fallbackPathError = this.validateLocalPath(mount.fallbackRealPath, "Fallback path");
      if (fallbackPathError) return fallbackPathError;
    }
    if (vaultBasePath) {
      const vaultNorm = normalizeForComparison(vaultBasePath);
      for (const candidate of [mount.realPath, mount.fallbackRealPath]) {
        if (!candidate?.trim()) continue;
        const norm = normalizeForComparison(candidate.trim());
        if (norm === vaultNorm || norm.startsWith(vaultNorm + "/") || vaultNorm.startsWith(norm.endsWith("/") ? norm : norm + "/")) {
          return `"${candidate.trim()}" is this vault's own folder, inside it, or contains it. Mount a folder outside the vault.`;
        }
      }
    }
    for (const m of existingMounts) {
      const existingVirtualNorm = (0, import_obsidian2.normalizePath)((m.virtualPath || "").trim());
      if (!existingVirtualNorm || existingVirtualNorm === "/") continue;
      if (existingVirtualNorm === virtualNorm) return `Vault folder "${virtualNorm}" is already used by another mount.`;
      if (virtualNorm.startsWith(existingVirtualNorm + "/") || existingVirtualNorm.startsWith(virtualNorm + "/")) {
        return `Vault folder "${virtualNorm}" overlaps with existing mount "${existingVirtualNorm}".`;
      }
    }
    return null;
  }
  /**
   * Non-blocking advisories for a real path: overlaps with other mounts mean
   * the same files appear twice in the vault (duplicate Bases rows).
   */
  getPathWarnings(realPath, existingMounts = []) {
    const warnings = [];
    const norm = normalizeForComparison(realPath);
    for (const m of existingMounts) {
      if (!m.realPath) continue;
      const existingRealNorm = normalizeForComparison(m.realPath);
      if (existingRealNorm === norm || norm.startsWith(existingRealNorm + "/") || existingRealNorm.startsWith(norm + "/")) {
        warnings.push(
          `"${realPath}" overlaps with the mount of "${m.realPath}". The same files will appear twice in the vault (and twice in Bases).`
        );
      }
    }
    return warnings;
  }
};

// src/IgnoreMatcher.ts
var import_obsidian3 = require("obsidian");
function wildcardMatch(pattern, text) {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}
var IgnoreMatcher = class {
  constructor(caseInsensitive = CASE_INSENSITIVE_FS) {
    this.cache = /* @__PURE__ */ new Map();
    this.fold = caseInsensitive ? (s) => s.toLowerCase() : (s) => s;
  }
  rebuild(globalPatterns, mounts) {
    this.cache.clear();
    for (const mount of mounts) {
      const compiled = { names: /* @__PURE__ */ new Set(), paths: [], globs: [] };
      for (const raw of [...globalPatterns, ...mount.ignoreList ?? []]) {
        const pattern = raw.trim();
        if (!pattern) continue;
        if (pattern.includes("*")) {
          compiled.globs.push(this.fold(pattern));
        } else if (pattern.includes("/") || pattern.includes("\\")) {
          compiled.paths.push(this.fold((0, import_obsidian3.normalizePath)(pattern.replace(/\\/g, "/"))));
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
  isIgnored(name, mount, mountRelativePath) {
    if (name.startsWith(".")) return true;
    const compiled = this.cache.get(mount.id);
    if (!compiled) return false;
    if (mountRelativePath && compiled.paths.length > 0) {
      const rel = this.fold(mountRelativePath);
      for (const p of compiled.paths) {
        if (rel === p || rel.startsWith(p + "/")) return true;
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
  isPathIgnored(mountRelativePath, mount) {
    if (!mountRelativePath) return false;
    const parts = mountRelativePath.split("/");
    const needPrefixes = (this.cache.get(mount.id)?.paths.length ?? 0) > 0;
    let prefix = "";
    for (const part of parts) {
      if (!part) continue;
      if (needPrefixes) prefix = prefix ? `${prefix}/${part}` : part;
      if (this.isIgnored(part, mount, needPrefixes ? prefix : void 0)) return true;
    }
    return false;
  }
};

// src/VirtualAdapter.ts
var import_obsidian4 = require("obsidian");
var fs2 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
var import_url2 = require("url");

// node_modules/.pnpm/node-diff3@3.2.1/node_modules/node-diff3/dist/diff3.mjs
function LCS(buffer1, buffer2) {
  let equivalenceClasses = /* @__PURE__ */ Object.create(null);
  for (let j = 0; j < buffer2.length; j++) {
    const item = buffer2[j];
    if (equivalenceClasses[item]) {
      equivalenceClasses[item].push(j);
    } else {
      equivalenceClasses[item] = [j];
    }
  }
  const NULLRESULT = { buffer1index: -1, buffer2index: -1, chain: null };
  let candidates = [NULLRESULT];
  for (let i = 0; i < buffer1.length; i++) {
    const item = buffer1[i];
    const buffer2indices = equivalenceClasses[item] || [];
    let r = 0;
    let c = candidates[0];
    for (const j of buffer2indices) {
      let s;
      for (s = r; s < candidates.length; s++) {
        if (candidates[s].buffer2index < j && (s === candidates.length - 1 || candidates[s + 1].buffer2index > j)) {
          break;
        }
      }
      if (s < candidates.length) {
        const newCandidate = { buffer1index: i, buffer2index: j, chain: candidates[s] };
        if (r === candidates.length) {
          candidates.push(c);
        } else {
          candidates[r] = c;
        }
        r = s + 1;
        c = newCandidate;
        if (r === candidates.length) {
          break;
        }
      }
    }
    candidates[r] = c;
  }
  return candidates[candidates.length - 1];
}
function diffIndices(buffer1, buffer2) {
  const lcs = LCS(buffer1, buffer2);
  let result = [];
  let tail1 = buffer1.length;
  let tail2 = buffer2.length;
  for (let candidate = lcs; candidate !== null; candidate = candidate.chain) {
    const mismatchLength1 = tail1 - candidate.buffer1index - 1;
    const mismatchLength2 = tail2 - candidate.buffer2index - 1;
    tail1 = candidate.buffer1index;
    tail2 = candidate.buffer2index;
    if (mismatchLength1 || mismatchLength2) {
      result.push({
        buffer1: [tail1 + 1, mismatchLength1],
        buffer1Content: buffer1.slice(tail1 + 1, tail1 + 1 + mismatchLength1),
        buffer2: [tail2 + 1, mismatchLength2],
        buffer2Content: buffer2.slice(tail2 + 1, tail2 + 1 + mismatchLength2)
      });
    }
  }
  result.reverse();
  return result;
}
function diff3MergeRegions(a, o, b) {
  let hunks = [];
  function addHunk(h, ab) {
    hunks.push({
      ab,
      oStart: h.buffer1[0],
      oLength: h.buffer1[1],
      abStart: h.buffer2[0],
      abLength: h.buffer2[1]
    });
  }
  diffIndices(o, a).forEach((item) => addHunk(item, "a"));
  diffIndices(o, b).forEach((item) => addHunk(item, "b"));
  hunks.sort((x, y) => x.oStart - y.oStart);
  let results = [];
  let currOffset = 0;
  function advanceTo(endOffset) {
    if (endOffset > currOffset) {
      results.push({
        stable: true,
        buffer: "o",
        bufferStart: currOffset,
        bufferLength: endOffset - currOffset,
        bufferContent: o.slice(currOffset, endOffset)
      });
      currOffset = endOffset;
    }
  }
  while (hunks.length) {
    let hunk = hunks.shift();
    let regionStart = hunk.oStart;
    let regionEnd = hunk.oStart + hunk.oLength;
    let regionHunks = [hunk];
    advanceTo(regionStart);
    while (hunks.length) {
      const nextHunk = hunks[0];
      const nextHunkStart = nextHunk.oStart;
      if (nextHunkStart > regionEnd)
        break;
      regionEnd = Math.max(regionEnd, nextHunkStart + nextHunk.oLength);
      regionHunks.push(hunks.shift());
    }
    if (regionHunks.length === 1) {
      if (hunk.abLength > 0) {
        const buffer = hunk.ab === "a" ? a : b;
        results.push({
          stable: true,
          buffer: hunk.ab,
          bufferStart: hunk.abStart,
          bufferLength: hunk.abLength,
          bufferContent: buffer.slice(hunk.abStart, hunk.abStart + hunk.abLength)
        });
      }
    } else {
      let bounds = {
        a: [a.length, -1, o.length, -1],
        b: [b.length, -1, o.length, -1]
      };
      while (regionHunks.length) {
        hunk = regionHunks.shift();
        const oStart = hunk.oStart;
        const oEnd = oStart + hunk.oLength;
        const abStart = hunk.abStart;
        const abEnd = abStart + hunk.abLength;
        let b2 = bounds[hunk.ab];
        b2[0] = Math.min(abStart, b2[0]);
        b2[1] = Math.max(abEnd, b2[1]);
        b2[2] = Math.min(oStart, b2[2]);
        b2[3] = Math.max(oEnd, b2[3]);
      }
      const aStart = bounds.a[0] + (regionStart - bounds.a[2]);
      const aEnd = bounds.a[1] + (regionEnd - bounds.a[3]);
      const bStart = bounds.b[0] + (regionStart - bounds.b[2]);
      const bEnd = bounds.b[1] + (regionEnd - bounds.b[3]);
      let result = {
        stable: false,
        aStart,
        aLength: aEnd - aStart,
        aContent: a.slice(aStart, aEnd),
        oStart: regionStart,
        oLength: regionEnd - regionStart,
        oContent: o.slice(regionStart, regionEnd),
        bStart,
        bLength: bEnd - bStart,
        bContent: b.slice(bStart, bEnd)
      };
      results.push(result);
    }
    currOffset = regionEnd;
  }
  advanceTo(o.length);
  return results;
}
function diff3Merge(a, o, b, options) {
  let defaults = {
    excludeFalseConflicts: true,
    stringSeparator: /\s+/
  };
  options = Object.assign(defaults, options);
  if (typeof a === "string")
    a = a.split(options.stringSeparator);
  if (typeof o === "string")
    o = o.split(options.stringSeparator);
  if (typeof b === "string")
    b = b.split(options.stringSeparator);
  let results = [];
  const regions = diff3MergeRegions(a, o, b);
  let okBuffer = [];
  function flushOk() {
    if (okBuffer.length) {
      results.push({ ok: okBuffer });
    }
    okBuffer = [];
  }
  function isFalseConflict(a2, b2) {
    if (a2.length !== b2.length)
      return false;
    for (let i = 0; i < a2.length; i++) {
      if (a2[i] !== b2[i])
        return false;
    }
    return true;
  }
  regions.forEach((region) => {
    if (region.stable) {
      okBuffer.push(...region.bufferContent);
    } else {
      if (options.excludeFalseConflicts && isFalseConflict(region.aContent, region.bContent)) {
        okBuffer.push(...region.aContent);
      } else {
        flushOk();
        results.push({
          conflict: {
            a: region.aContent,
            aIndex: region.aStart,
            o: region.oContent,
            oIndex: region.oStart,
            b: region.bContent,
            bIndex: region.bStart
          }
        });
      }
    }
  });
  flushOk();
  return results;
}

// src/textFiles.ts
var utf8 = new TextDecoder("utf-8", { fatal: true });
function decodeText(buf) {
  const format = { crlf: false, bom: false, unsafe: false };
  let text;
  if (buf[0] === 255 && buf[1] === 254) {
    format.unsafe = true;
    text = new TextDecoder("utf-16le").decode(buf.subarray(2));
  } else if (buf[0] === 254 && buf[1] === 255) {
    format.unsafe = true;
    text = new TextDecoder("utf-16be").decode(buf.subarray(2));
  } else {
    let body = buf;
    if (buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
      format.bom = true;
      body = buf.subarray(3);
    }
    try {
      text = utf8.decode(body);
    } catch {
      format.unsafe = true;
      text = new TextDecoder("windows-1252").decode(body);
    }
  }
  format.crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
  return { text, format };
}
function encodeText(text, format) {
  let out = text;
  if (format?.crlf) out = out.replace(/\r?\n/g, "\r\n");
  if (format?.bom) out = "\uFEFF" + out;
  return out;
}
function mergeText(base, mine, theirs) {
  const norm = (s) => s.replace(/\r\n/g, "\n").split("\n");
  const regions = diff3Merge(norm(mine), norm(base), norm(theirs), { excludeFalseConflicts: true });
  const lines = [];
  for (const region of regions) {
    if (region.conflict) return { clean: false, merged: "" };
    if (region.ok) lines.push(...region.ok);
  }
  return { clean: true, merged: lines.join("\n") };
}
function isMergeableText(path5) {
  return /\.(md|mdx|canvas|base|txt|csv|json)$/i.test(path5);
}
var RecentTexts = class {
  /** `isPinned`: entries for notes open in an editor are never evicted (they are the merge base). */
  constructor(isPinned = () => false, maxEntries = 200, maxBytes = 8 * 1024 * 1024) {
    this.isPinned = isPinned;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.map = /* @__PURE__ */ new Map();
    this.bytes = 0;
  }
  get(path5) {
    const value = this.map.get(path5);
    if (value !== void 0) {
      this.map.delete(path5);
      this.map.set(path5, value);
    }
    return value;
  }
  set(path5, text) {
    if (text.length > this.maxBytes / 4) {
      this.delete(path5);
      return;
    }
    this.delete(path5);
    this.map.set(path5, text);
    this.bytes += text.length;
    let guard = this.map.size;
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && guard-- > 0) {
      const oldest = this.map.keys().next().value;
      const value = this.map.get(oldest);
      this.map.delete(oldest);
      if (this.isPinned(oldest)) this.map.set(oldest, value);
      else this.bytes -= value.length;
    }
  }
  delete(path5) {
    const old = this.map.get(path5);
    if (old === void 0) return;
    this.bytes -= old.length;
    this.map.delete(path5);
  }
  rename(from, to) {
    const value = this.map.get(from);
    if (value === void 0) return;
    this.delete(from);
    this.set(to, value);
  }
};

// src/logger.ts
var PREFIX = "[Folder Bridge]";
var logger = {
  debug: (...args) => console.debug(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args)
};

// src/mountFileFilter.ts
var MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".canvas", ".mdx", ".base"]);
var PDF_EXTENSIONS = /* @__PURE__ */ new Set([".pdf"]);
var EXECUTABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".scr",
  ".pif",
  ".cpl",
  ".msc",
  ".msi",
  ".msp",
  ".lnk",
  ".url",
  ".appref-ms",
  ".library-ms",
  ".searchconnector-ms",
  ".settingcontent-ms",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".jar",
  ".reg",
  ".inf",
  ".application"
]);
function getLowercaseExtension(filePath) {
  const leaf = filePath.split("/").pop() ?? filePath;
  const dotIndex = leaf.lastIndexOf(".");
  return dotIndex > 0 ? leaf.slice(dotIndex).toLowerCase() : "";
}
function isVisibleFileInMount(filePath, mount) {
  const extension = getLowercaseExtension(filePath);
  if (EXECUTABLE_EXTENSIONS.has(extension)) return false;
  const filter = mount.visibleFileFilter ?? "all";
  if (filter === "all") return true;
  if (!extension) return false;
  if (filter === "markdown-only") return MARKDOWN_EXTENSIONS.has(extension);
  if (filter === "pdf-only") return PDF_EXTENSIONS.has(extension);
  return true;
}

// src/VirtualAdapter.ts
var TRASH_FOLDER = ".folderbridge-trash";
function notFound(realPath) {
  const err = new Error(`ENOENT: no such file or directory, open '${stripLongPathPrefix(realPath)}'`);
  err.code = "ENOENT";
  return err;
}
function isMissing(e) {
  const code = e?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
function toVaultStat(s) {
  return {
    type: s.isDirectory() ? "folder" : "file",
    ctime: Math.round(s.birthtimeMs || s.ctimeMs),
    mtime: Math.round(s.mtimeMs),
    size: s.size
  };
}
function stamp(date = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
}
var VirtualAdapter = class {
  constructor(original, pathMapper, security, ignore, callbacks) {
    this.original = original;
    this.pathMapper = pathMapper;
    this.security = security;
    this.ignore = ignore;
    this.callbacks = callbacks;
    /** Mount IDs that already showed the read-only notice this session. */
    this.readOnlyNoticedMounts = /* @__PURE__ */ new Set();
    /** Diagnostics: how much mounted I/O this session did. */
    this.ioStats = { reads: 0, lists: 0, stats: 0, writes: 0 };
    /** Mounts where a safety copy could not be made (warned once). */
    this.backupWarned = /* @__PURE__ */ new Set();
    /** How each text file read so far is stored (line endings, BOM, encoding). */
    this.formats = /* @__PURE__ */ new Map();
    /** Last text Obsidian read or wrote per note: the common base for a merge. */
    this.recent = new RecentTexts((p) => this.callbacks.isOpenInEditor?.(p) ?? false);
  }
  orig() {
    return this.original;
  }
  // The real operation already succeeded when these run, so a failure to
  // update Obsidian's tree is logged, never thrown at the caller.
  async notifyDelete(normalizedPath) {
    try {
      await this.callbacks.onDeleted((0, import_obsidian4.normalizePath)(normalizedPath));
    } catch (e) {
      logger.warn("Index update after delete failed", e);
    }
  }
  async notifyWritten(normalizedPath) {
    try {
      await this.callbacks.onWritten((0, import_obsidian4.normalizePath)(normalizedPath));
    } catch (e) {
      logger.warn("Index update after write failed", e);
    }
  }
  /** Forget the one-shot read-only notice (call when the readOnly flag changes). */
  clearReadOnlyNotice(mountId) {
    this.readOnlyNoticedMounts.delete(mountId);
  }
  /**
   * Swallow a write blocked by readOnly and show a one-time notice, instead
   * of throwing, so the editor never lands in an error state.
   */
  warnReadOnly(mount) {
    if (this.readOnlyNoticedMounts.has(mount.id)) return;
    this.readOnlyNoticedMounts.add(mount.id);
    new import_obsidian4.Notice(`Folder Bridge: "${mount.virtualPath}" is read-only \u2014 this change was not saved.`, 6e3);
  }
  // ------------------------------------------------------------------
  // Path helpers
  // ------------------------------------------------------------------
  /**
   * Resolve a mounted vault path to its real path, enforce the allowlist,
   * and apply the Windows long-path prefix when needed.
   */
  toReal(normalizedPath, mount) {
    if (this.callbacks.isOffline(mount.id)) {
      throw new Error(`Folder Bridge: "${mount.label || mount.virtualPath}" is offline. It reconnects automatically when the drive is back.`);
    }
    const realPath = this.pathMapper.toRealPath(normalizedPath, mount);
    if (!this.security.isAllowed(realPath)) {
      throw new Error(`Folder Bridge: "${realPath}" is outside the mounted folders.`);
    }
    return ensureLongPathPrefix(realPath);
  }
  isPathIgnored(normalizedPath, mount) {
    const rel = this.pathMapper.getMountRelativePath(normalizedPath, mount);
    return rel !== void 0 && this.ignore.isPathIgnored(rel, mount);
  }
  assertUsable(normalizedPath, mount, verb) {
    if (this.isPathIgnored(normalizedPath, mount)) {
      throw new Error(`Folder Bridge: Cannot ${verb} ignored path "${normalizedPath}".`);
    }
  }
  assertVisibleFile(normalizedPath, mount) {
    if (!isVisibleFileInMount(normalizedPath, mount)) {
      throw new Error(`Folder Bridge: "${normalizedPath}" is hidden by this mount's file-type rules.`);
    }
  }
  /** Refuse names Windows cannot store, with a readable message instead of a raw OS error. */
  assertCreatableName(realPath) {
    const reason = invalidWindowsNameReason(path4.basename(realPath));
    if (reason) throw new Error(`Folder Bridge: ${reason}`);
  }
  /** Translate a read failure, recognising OneDrive online-only placeholders. */
  async readError(e, realPath, op) {
    const err = e;
    if (err.code === "ENOENT" || err.code === "EIO" || err.code === "UNKNOWN") {
      if (await isCloudPlaceholder(realPath)) {
        return new Error(
          `Folder Bridge: "${path4.basename(realPath)}" is an online-only OneDrive/SharePoint file and could not be downloaded. Right-click it in File Explorer and choose "Always keep on this device".`
        );
      }
      if (err.code === "ENOENT") return notFound(realPath);
    }
    return new Error(`Folder Bridge: ${translateFsError(err, op)}`);
  }
  // ------------------------------------------------------------------
  // Read-side operations
  // ------------------------------------------------------------------
  getName() {
    return this.orig().getName?.() ?? "Vault";
  }
  /**
   * Obsidian's vault.create() resolves files through getFullPath(), and
   * "Show in system explorer" uses it too. For a mounted path the real file
   * lives in the mounted folder, not under the vault folder.
   */
  getFullPath(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (mount) return this.pathMapper.toRealPath(normalizedPath, mount);
    return this.orig().getFullPath?.(normalizedPath) ?? normalizedPath;
  }
  /** Real path for a mounted file (Obsidian calls this for some desktop features). */
  getFullRealPath(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (mount) return this.pathMapper.toRealPath(normalizedPath, mount);
    return this.orig().getFullRealPath?.(normalizedPath) ?? this.getFullPath(normalizedPath);
  }
  /**
   * file:// URL of a path. Obsidian's "Open in default app" builds its URL
   * from this, so mounted files open from their real location. Never for
   * hidden or executable types.
   */
  getFilePath(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (mount) {
      if (!isVisibleFileInMount(normalizedPath, mount) || this.isPathIgnored(normalizedPath, mount)) return "";
      return (0, import_url2.pathToFileURL)(this.pathMapper.toRealPath(normalizedPath, mount)).toString();
    }
    return this.orig().getFilePath?.(normalizedPath) ?? normalizedPath;
  }
  async exists(normalizedPath, sensitive) {
    if (this.pathMapper.getMountForPath(normalizedPath)) {
      try {
        return await this.statMounted(normalizedPath) !== null;
      } catch {
        return true;
      }
    }
    if (this.pathMapper.hasMountsUnder(normalizedPath)) {
      if (await this.orig().exists(normalizedPath, sensitive)) return true;
      return this.pathMapper.getVirtualMountsDirectChildren(normalizedPath).length > 0;
    }
    return this.orig().exists(normalizedPath, sensitive);
  }
  /**
   * Stat for the tree sync: null ONLY when the path is confirmed missing or
   * hidden by the mount's rules. Every other failure (network error, offline
   * mount, permission) throws, so it is never mistaken for a deletion.
   */
  async statMounted(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) throw new Error(`Folder Bridge: "${normalizedPath}" is not in a mount.`);
    if (this.isPathIgnored(normalizedPath, mount)) return null;
    const realPath = this.toReal(normalizedPath, mount);
    this.ioStats.stats++;
    let s;
    try {
      s = await fs2.promises.stat(realPath);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    if (s.isFile() && !isVisibleFileInMount(normalizedPath, mount)) return null;
    if (!s.isFile() && !s.isDirectory()) return null;
    return toVaultStat(s);
  }
  /** Obsidian's stat: null for anything it cannot use, including errors. */
  async stat(normalizedPath) {
    if (this.pathMapper.getMountForPath(normalizedPath)) {
      try {
        return await this.statMounted(normalizedPath);
      } catch (e) {
        logger.debug(`stat failed for "${normalizedPath}":`, e);
        return null;
      }
    }
    if (this.pathMapper.hasMountsUnder(normalizedPath)) {
      const real = await this.orig().stat(normalizedPath);
      if (real) return real;
      return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    }
    return this.orig().stat(normalizedPath);
  }
  async list(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (mount) {
      try {
        return await this.listMounted(normalizedPath);
      } catch (e) {
        logger.error(`list failed for "${normalizedPath}":`, e);
        return { files: [], folders: [] };
      }
    }
    let result;
    try {
      result = await this.orig().list(normalizedPath);
    } catch {
      result = { files: [], folders: [] };
    }
    for (const child of this.pathMapper.getVirtualMountsDirectChildren(normalizedPath)) {
      if (!result.folders.includes(child)) result.folders.push(child);
    }
    return result;
  }
  /**
   * List a mounted folder, THROWING on I/O errors. The tree sync relies on
   * this: an unreadable folder must never look like an empty one, or a
   * network blip would remove its contents from the vault.
   */
  async listMounted(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) throw new Error(`Folder Bridge: "${normalizedPath}" is not in a mount.`);
    if (this.isPathIgnored(normalizedPath, mount)) return { files: [], folders: [] };
    return this.listRealDirectory(this.toReal(normalizedPath, mount), (0, import_obsidian4.normalizePath)(normalizedPath), mount);
  }
  async listRealDirectory(realDirPath, virtualParentPath, mount) {
    const files = [];
    const folders = [];
    const parentRel = this.pathMapper.getMountRelativePath(virtualParentPath, mount) ?? "";
    let entries;
    this.ioStats.lists++;
    try {
      entries = await fs2.promises.readdir(realDirPath, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Folder Bridge: Cannot list "${stripLongPathPrefix(realDirPath)}": ${translateFsError(e, "list")}`);
    }
    const links = [];
    for (const entry of entries) {
      const entryRel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
      if (this.ignore.isIgnored(entry.name, mount, entryRel)) continue;
      if ((0, import_obsidian4.normalizePath)(entry.name) !== entry.name || invalidWindowsNameReason(entry.name)) continue;
      const virtualChild = `${virtualParentPath}/${entry.name}`;
      if (entry.isDirectory()) folders.push(virtualChild);
      else if (entry.isFile()) {
        if (isVisibleFileInMount(virtualChild, mount)) files.push(virtualChild);
      } else if (entry.isSymbolicLink() || !(entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice())) {
        links.push({ entry, virtualChild });
      }
    }
    const parentReal = stripLongPathPrefix(realDirPath);
    for (let i = 0; i < links.length; i += 8) {
      await Promise.all(links.slice(i, i + 8).map(async ({ entry, virtualChild }) => {
        const linkPath = path4.join(realDirPath, entry.name);
        let s;
        let target;
        try {
          [s, target] = await Promise.all([fs2.promises.stat(linkPath), fs2.promises.realpath(linkPath)]);
        } catch (e) {
          if (isMissing(e) || e.code === "ELOOP") return;
          throw new Error(`Folder Bridge: Cannot resolve "${entry.name}": ${translateFsError(e, "stat")}`);
        }
        const rel = path4.relative(target, parentReal);
        const isAncestor = rel === "" || !rel.startsWith("..") && !path4.isAbsolute(rel);
        if (!this.security.isAllowed(target) || isAncestor) return;
        if (s.isDirectory()) folders.push(virtualChild);
        else if (s.isFile() && isVisibleFileInMount(virtualChild, mount)) files.push(virtualChild);
      }));
    }
    return { files, folders };
  }
  async read(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().read(normalizedPath);
    this.assertUsable(normalizedPath, mount, "read");
    this.assertVisibleFile(normalizedPath, mount);
    const realPath = this.toReal(normalizedPath, mount);
    this.ioStats.reads++;
    let buf;
    try {
      buf = await fs2.promises.readFile(realPath);
    } catch (e) {
      throw await this.readError(e, realPath, "read");
    }
    const key = (0, import_obsidian4.normalizePath)(normalizedPath);
    const { text, format } = decodeText(buf);
    this.formats.set(key, format);
    this.recent.set(key, text);
    return text;
  }
  async cachedRead(normalizedPath) {
    if (this.pathMapper.getMountForPath(normalizedPath)) return this.read(normalizedPath);
    const original = this.orig();
    return typeof original.cachedRead === "function" ? original.cachedRead(normalizedPath) : original.read(normalizedPath);
  }
  async readBinary(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().readBinary(normalizedPath);
    this.assertUsable(normalizedPath, mount, "read");
    this.assertVisibleFile(normalizedPath, mount);
    const realPath = this.toReal(normalizedPath, mount);
    this.ioStats.reads++;
    try {
      const buf = await fs2.promises.readFile(realPath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
      throw await this.readError(e, realPath, "readBinary");
    }
  }
  /**
   * URL the renderer uses for images, PDFs and media. Mounted files go
   * through Obsidian's own app:// handler (see realPathToResourceUrl).
   * Vault.getResourcePath(TFile) calls this too.
   */
  getResourcePath(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().getResourcePath(normalizedPath);
    const realPath = this.pathMapper.toRealPath(normalizedPath, mount);
    return realPathToResourceUrl(import_obsidian4.Platform.resourcePathPrefix, realPath, this.callbacks.getKnownMtime((0, import_obsidian4.normalizePath)(normalizedPath)));
  }
  // ------------------------------------------------------------------
  // Write-side operations
  // ------------------------------------------------------------------
  /** Shared guard for writes. Returns the real path, or null when the write was swallowed (read-only). */
  prepareWrite(normalizedPath, mount, verb) {
    if (mount.readOnly) {
      this.warnReadOnly(mount);
      return null;
    }
    this.assertUsable(normalizedPath, mount, verb);
    this.assertVisibleFile(normalizedPath, mount);
    const realPath = this.toReal(normalizedPath, mount);
    this.assertCreatableName(realPath);
    return realPath;
  }
  /** Run a write; create missing parent folders only when the first try says they are missing. */
  async withParents(realPath, op) {
    try {
      return await op();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await fs2.promises.mkdir(path4.dirname(realPath), { recursive: true });
      return op();
    }
  }
  /**
   * A note changed on disk since Obsidian last saw it (a colleague's save
   * the watcher has not reported yet, or a share that never reports).
   * Depending on the conflict setting:
   * - merge: combine both versions (three-way merge against the last text
   *   Obsidian loaded); Obsidian reloads the result after its save.
   * - copy (also the fallback when a merge is impossible): keep their
   *   version as a copy in the trash folder, then save ours.
   * - overwrite: Obsidian's normal behaviour, last save wins.
   */
  async resolveConflict(key, realPath, mount, mine) {
    const known = this.callbacks.getKnownMtime(key);
    if (known === void 0) return { text: mine, reload: false };
    let onDisk;
    try {
      onDisk = await fs2.promises.stat(realPath);
    } catch {
      return { text: mine, reload: false };
    }
    if (!onDisk.isFile() || Math.round(onDisk.mtimeMs) === known) return { text: mine, reload: false };
    const mode = this.callbacks.conflictMode();
    if (mode === "overwrite") return { text: mine, reload: false };
    const name = path4.basename(realPath);
    if (mode === "merge" && mine !== null && isMergeableText(key)) {
      const base = this.recent.get(key);
      if (base !== void 0) {
        const theirs = decodeText(await fs2.promises.readFile(realPath));
        if (!theirs.format.unsafe) {
          const result = mergeText(base, mine, theirs.text);
          if (result.clean) {
            new import_obsidian4.Notice(`Folder Bridge: "${name}" was changed on the drive while you edited it. Both sets of changes were merged.`, 8e3);
            return { text: result.merged, reload: true };
          }
        }
      }
    }
    const ext = path4.extname(realPath);
    const copyName = `${path4.basename(realPath, ext)} (changed by someone else ${stamp()})${ext}`;
    const trashDir = await this.trashDirFor(realPath, mount);
    await fs2.promises.copyFile(realPath, path4.join(trashDir, copyName), fs2.constants.COPYFILE_EXCL);
    new import_obsidian4.Notice(`Folder Bridge: "${name}" was changed outside Obsidian and both of you edited the same lines. Their version was kept as "${copyName}" in ${TRASH_FOLDER}.`, 12e3);
    return { text: mine, reload: false };
  }
  /**
   * Write a file without ever losing its current content:
   * - a file Obsidian does not know yet is created with "wx", so an existing
   *   file on the share is never replaced by vault.create();
   * - an existing file is first copied aside (same share, hidden folder);
   *   writeFile empties the file before writing, so a network drop or a
   *   full disk mid-save would otherwise leave it empty or cut short. The
   *   copy is removed once the new content is fully written.
   * - parent folders are only created for new files, so a save never
   *   recreates a folder a colleague just moved.
   */
  async saveFile(key, realPath, mount, content) {
    const isNew = this.callbacks.getKnownMtime(key) === void 0;
    if (isNew) {
      await this.withParents(realPath, () => fs2.promises.writeFile(realPath, content, { flag: "wx" }));
      return;
    }
    let backup = null;
    try {
      const current = await fs2.promises.stat(realPath);
      if (current.isFile() && current.size > 0) {
        const dir = path4.join(await this.trashDirFor(realPath, mount), ".saving");
        await fs2.promises.mkdir(dir, { recursive: true });
        const candidate = path4.join(dir, `${stamp()} ${Math.random().toString(36).slice(2, 8)} ${path4.basename(realPath)}`);
        await fs2.promises.copyFile(realPath, candidate, fs2.constants.COPYFILE_EXCL);
        backup = candidate;
      }
    } catch (e) {
      if (!isMissing(e) && !this.backupWarned.has(mount.id)) {
        this.backupWarned.add(mount.id);
        logger.warn(`No safety copy possible on "${mount.virtualPath}" (${e.message}); saving without one.`);
      }
    }
    try {
      await fs2.promises.writeFile(realPath, content);
    } catch (e) {
      const reason = translateFsError(e, "save");
      if (backup) throw new Error(`Folder Bridge: "${path4.basename(realPath)}" was not saved: ${reason} The previous version is kept at "${stripLongPathPrefix(backup)}".`);
      if (isMissing(e)) throw new Error(`Folder Bridge: "${path4.basename(realPath)}" was not saved: its folder no longer exists (moved or deleted on the drive?).`);
      throw new Error(`Folder Bridge: ${reason}`);
    }
    if (backup) await fs2.promises.unlink(backup).catch(() => {
    });
  }
  assertWritableText(key) {
    const format = this.formats.get(key);
    if (format?.unsafe) {
      throw new Error(
        `Folder Bridge: "${key.split("/").pop()}" is not stored as UTF-8 text (it uses an older Windows or UTF-16 encoding). Saving it from Obsidian would damage characters such as \xA3 \u20AC \xE9, so it was not saved. Edit it in the program that created it.`
      );
    }
    return format;
  }
  async write(normalizedPath, data, options) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().write(normalizedPath, data, options);
    const realPath = this.prepareWrite(normalizedPath, mount, "write to");
    if (!realPath) return;
    const key = (0, import_obsidian4.normalizePath)(normalizedPath);
    const format = this.assertWritableText(key);
    this.ioStats.writes++;
    let text = data;
    let reload = false;
    try {
      const resolved = await this.resolveConflict(key, realPath, mount, data);
      text = resolved.text ?? data;
      reload = resolved.reload;
      await this.saveFile(key, realPath, mount, encodeText(text, format));
      await this.applyWriteOptions(realPath, options);
    } catch (e) {
      if (e.message?.startsWith("Folder Bridge:")) throw e;
      const message = `Folder Bridge: ${translateFsError(e, "write")}`;
      logger.error(`write failed for "${realPath}":`, e);
      throw new Error(message);
    }
    this.recent.set(key, text);
    await this.notifyWritten(normalizedPath);
    if (reload) this.callbacks.requestReload(key);
  }
  async writeBinary(normalizedPath, data, options) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().writeBinary(normalizedPath, data, options);
    const realPath = this.prepareWrite(normalizedPath, mount, "write to");
    if (!realPath) return;
    const key = (0, import_obsidian4.normalizePath)(normalizedPath);
    this.ioStats.writes++;
    try {
      await this.resolveConflict(key, realPath, mount, null);
      await this.saveFile(key, realPath, mount, Buffer.from(data));
      await this.applyWriteOptions(realPath, options);
    } catch (e) {
      if (e.message?.startsWith("Folder Bridge:")) throw e;
      throw new Error(`Folder Bridge: ${translateFsError(e, "writeBinary")}`);
    }
    this.recent.delete(key);
    this.formats.delete(key);
    await this.notifyWritten(normalizedPath);
  }
  /** Honour DataWriteOptions.mtime like Obsidian's own adapter (best effort). */
  async applyWriteOptions(realPath, options) {
    if (!options?.mtime) return;
    try {
      const mtime = new Date(options.mtime);
      await fs2.promises.utimes(realPath, mtime, mtime);
    } catch {
    }
  }
  async append(normalizedPath, data, options) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().append(normalizedPath, data, options);
    const realPath = this.prepareWrite(normalizedPath, mount, "append to");
    if (!realPath) return;
    const key = (0, import_obsidian4.normalizePath)(normalizedPath);
    const format = this.assertWritableText(key);
    this.ioStats.writes++;
    try {
      await fs2.promises.appendFile(realPath, encodeText(data, format ? { ...format, bom: false } : void 0), "utf8");
    } catch (e) {
      throw new Error(`Folder Bridge: ${translateFsError(e, "append")}`);
    }
    this.recent.delete(key);
    await this.notifyWritten(normalizedPath);
  }
  async appendBinary(normalizedPath, data, options) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) {
      const original = this.orig();
      if (!original.appendBinary) throw new Error("Folder Bridge: appendBinary is not available in this Obsidian version.");
      return original.appendBinary(normalizedPath, data, options);
    }
    const realPath = this.prepareWrite(normalizedPath, mount, "append to");
    if (!realPath) return;
    this.ioStats.writes++;
    try {
      await fs2.promises.appendFile(realPath, Buffer.from(data));
    } catch (e) {
      throw new Error(`Folder Bridge: ${translateFsError(e, "appendBinary")}`);
    }
    await this.notifyWritten(normalizedPath);
  }
  async process(normalizedPath, fn, options) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().process(normalizedPath, fn, options);
    const content = await this.read(normalizedPath);
    const updated = fn(content);
    if (updated !== content) await this.write(normalizedPath, updated, options);
    return updated;
  }
  async mkdir(normalizedPath) {
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().mkdir(normalizedPath);
    if (mount.readOnly) {
      this.warnReadOnly(mount);
      return;
    }
    this.assertUsable(normalizedPath, mount, "create");
    const realPath = this.toReal(normalizedPath, mount);
    this.assertCreatableName(realPath);
    try {
      await fs2.promises.mkdir(realPath, { recursive: true });
    } catch (e) {
      const message = `Folder Bridge: ${translateFsError(e, "mkdir")}`;
      logger.error(`mkdir failed for "${realPath}":`, e);
      throw new Error(message);
    }
    try {
      this.callbacks.onFolderCreated((0, import_obsidian4.normalizePath)(normalizedPath));
    } catch (e) {
      logger.warn("Index update after mkdir failed", e);
    }
  }
  // ------------------------------------------------------------------
  // trash / remove
  // ------------------------------------------------------------------
  /**
   * Deleting a mount's root folder only ever unmounts it (asking first,
   * unless the user chose not to be asked). Returns normally when unmounted;
   * throws when the user cancelled. Deleting a whole share folder from
   * Obsidian is deliberately impossible.
   */
  async unmountInsteadOfDelete(rootMount) {
    if (!await this.callbacks.confirmUnmount(rootMount)) throw new Error("Folder Bridge: Deletion cancelled.");
  }
  /**
   * Network shares have no Recycle Bin, and Electron's trash call is not
   * guaranteed to refuse a permanent delete there. So mounted items never
   * go to the system trash: returning false makes Obsidian call
   * trashLocal(), which moves them to the trash folder on the share.
   */
  async trashSystem(normalizedPath) {
    const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
    if (rootMount) {
      await this.unmountInsteadOfDelete(rootMount);
      return true;
    }
    if (!this.pathMapper.getMountForPath(normalizedPath)) return this.orig().trashSystem(normalizedPath);
    return false;
  }
  /**
   * The trash folder for an item: `.folderbridge-trash` at the mount root,
   * or next to the item when the root is not writable or on another volume
   * (a junction). Same share, same permissions: deleted finance files never
   * get copied into the vault.
   */
  async trashDirFor(realPath, mount) {
    const candidates = [
      path4.join(ensureLongPathPrefix(this.pathMapper.getEffectiveRealPath(mount)), TRASH_FOLDER),
      path4.join(path4.dirname(realPath), TRASH_FOLDER)
    ];
    let lastError;
    for (const dir of candidates) {
      try {
        await fs2.promises.mkdir(dir, { recursive: true });
        const [a, b] = await Promise.all([fs2.promises.stat(dir), fs2.promises.stat(path4.dirname(realPath))]);
        if (a.dev === b.dev) return dir;
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`Folder Bridge: Cannot create a trash folder next to "${path4.basename(realPath)}"${lastError ? `: ${translateFsError(lastError, "trash")}` : "."} Nothing was deleted.`);
  }
  async trashLocal(normalizedPath) {
    const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
    if (rootMount) return this.unmountInsteadOfDelete(rootMount);
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().trashLocal(normalizedPath);
    if (mount.readOnly) {
      this.warnReadOnly(mount);
      return;
    }
    this.assertUsable(normalizedPath, mount, "trash");
    const realPath = this.toReal(normalizedPath, mount);
    let isFolder = false;
    try {
      isFolder = (await fs2.promises.stat(realPath)).isDirectory();
    } catch {
    }
    if (isFolder && await this.countHidden(realPath, (0, import_obsidian4.normalizePath)(normalizedPath), mount) > 0) {
      throw new Error(`Folder Bridge: "${path4.basename(realPath)}" contains files that are hidden in Obsidian, so it was not moved to the trash. Delete it in File Explorer if you are sure.`);
    }
    const trashDir = await this.trashDirFor(realPath, mount);
    const destination = path4.join(trashDir, `${stamp()} ${path4.basename(realPath)}`);
    let target = destination;
    for (let n = 2; ; n++) {
      try {
        await fs2.promises.access(target);
        target = `${destination} (${n})`;
      } catch {
        break;
      }
    }
    try {
      await fs2.promises.rename(realPath, target);
    } catch (e) {
      throw new Error(`Folder Bridge: ${translateFsError(e, "trash")} Nothing was deleted.`);
    }
    this.forget((0, import_obsidian4.normalizePath)(normalizedPath));
    await this.notifyDelete(normalizedPath);
  }
  /** Drop cached text/format for a path and everything below it. */
  forget(key) {
    this.recent.delete(key);
    this.formats.delete(key);
    for (const k of [...this.formats.keys()]) if (k.startsWith(key + "/")) this.formats.delete(k);
  }
  /**
   * Count entries under a real folder that Obsidian does not show (ignored,
   * dot-names, filtered file types). Stops at `limit`.
   */
  async countHidden(realDir, virtualDir, mount, limit = 1) {
    let hidden = 0;
    const walk = async (dir, vdir) => {
      const entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (hidden >= limit) return;
        const vchild = `${vdir}/${entry.name}`;
        const rel = this.pathMapper.getMountRelativePath(vchild, mount) ?? entry.name;
        if (this.ignore.isIgnored(entry.name, mount, rel) || (0, import_obsidian4.normalizePath)(entry.name) !== entry.name) {
          hidden++;
          continue;
        }
        if (entry.isDirectory()) await walk(path4.join(dir, entry.name), vchild);
        else if (!entry.isFile() || !isVisibleFileInMount(vchild, mount)) hidden++;
      }
    };
    await walk(realDir, virtualDir);
    return hidden;
  }
  /**
   * Permanent deletes never happen on a mount: network shares have no
   * Recycle Bin, and Obsidian calls these when its "Deleted files" setting
   * is "Permanently delete" (or a sync tool applies remote deletions). They
   * go to the trash folder on the share instead, with the same checks.
   * An empty-folder rmdir (recursive=false) is safe and stays a real rmdir.
   */
  async rmdir(normalizedPath, recursive) {
    const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
    if (rootMount) return this.unmountInsteadOfDelete(rootMount);
    const mount = this.pathMapper.getMountForPath(normalizedPath);
    if (!mount) return this.orig().rmdir(normalizedPath, recursive);
    if (recursive) return this.trashLocal(normalizedPath);
    if (mount.readOnly) {
      this.warnReadOnly(mount);
      return;
    }
    this.assertUsable(normalizedPath, mount, "remove");
    const realPath = this.toReal(normalizedPath, mount);
    try {
      await fs2.promises.rmdir(realPath);
    } catch (e) {
      throw new Error(`Folder Bridge: ${translateFsError(e, "rmdir")}`);
    }
    await this.notifyDelete(normalizedPath);
  }
  async remove(normalizedPath) {
    const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
    if (rootMount) return this.unmountInsteadOfDelete(rootMount);
    if (!this.pathMapper.getMountForPath(normalizedPath)) return this.orig().remove(normalizedPath);
    return this.trashLocal(normalizedPath);
  }
  // ------------------------------------------------------------------
  // rename / copy
  // ------------------------------------------------------------------
  async rename(normalizedPath, newNormalizedPath) {
    const rootMount = this.pathMapper.getMountByVirtualPath(normalizedPath);
    if (rootMount) {
      throw new Error(`Folder Bridge: "${rootMount.virtualPath}" is a mounted folder. To move it inside the vault, edit the mount (right-click \u2192 Edit mount\u2026) and change its vault folder.`);
    }
    const srcMount = this.pathMapper.getMountForPath(normalizedPath);
    const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);
    if (!srcMount && !dstMount) return this.orig().rename(normalizedPath, newNormalizedPath);
    if (!srcMount || !dstMount || srcMount.id !== dstMount.id) {
      throw new Error(
        `Folder Bridge: Cannot move "${normalizedPath}" to "${newNormalizedPath}" across mount boundaries. Copy the file instead.`
      );
    }
    if (srcMount.readOnly) {
      this.warnReadOnly(srcMount);
      return;
    }
    this.assertUsable(normalizedPath, srcMount, "rename");
    this.assertUsable(newNormalizedPath, dstMount, "rename to");
    const srcReal = this.toReal(normalizedPath, srcMount);
    const dstReal = this.toReal(newNormalizedPath, dstMount);
    this.assertCreatableName(dstReal);
    const MAX_WAIT_MS = 2e3;
    const POLL_MS = 100;
    let srcStat = null;
    for (let waited = 0; ; waited += POLL_MS) {
      try {
        srcStat = await fs2.promises.stat(srcReal);
        break;
      } catch {
        if (waited >= MAX_WAIT_MS) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
    if (!srcStat) {
      throw new Error(
        `Folder Bridge: Cannot rename "${path4.basename(srcReal)}": the file was not found after ${MAX_WAIT_MS / 1e3} s. If it is an online-only OneDrive file, choose "Always keep on this device" and try again.`
      );
    }
    try {
      const dstStat = await fs2.promises.stat(dstReal);
      const sameFile = dstStat.ino === srcStat.ino && dstStat.dev === srcStat.dev && dstStat.ino !== 0;
      if (!sameFile) throw new Error(`Folder Bridge: "${newNormalizedPath}" already exists.`);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    try {
      await this.withParents(dstReal, () => fs2.promises.rename(srcReal, dstReal));
    } catch (e) {
      throw new Error(`Folder Bridge: ${translateFsError(e, "rename")}`);
    }
    this.recent.rename((0, import_obsidian4.normalizePath)(normalizedPath), (0, import_obsidian4.normalizePath)(newNormalizedPath));
    const format = this.formats.get((0, import_obsidian4.normalizePath)(normalizedPath));
    this.forget((0, import_obsidian4.normalizePath)(normalizedPath));
    if (format) this.formats.set((0, import_obsidian4.normalizePath)(newNormalizedPath), format);
    try {
      this.callbacks.onRenamed((0, import_obsidian4.normalizePath)(normalizedPath), (0, import_obsidian4.normalizePath)(newNormalizedPath));
    } catch (e) {
      logger.warn("Index update after rename failed", e);
    }
  }
  async copy(normalizedPath, newNormalizedPath) {
    const srcMount = this.pathMapper.getMountForPath(normalizedPath);
    const dstMount = this.pathMapper.getMountForPath(newNormalizedPath);
    if (!srcMount && !dstMount) return this.orig().copy(normalizedPath, newNormalizedPath);
    if (dstMount?.readOnly) {
      this.warnReadOnly(dstMount);
      return;
    }
    if (srcMount) {
      this.assertUsable(normalizedPath, srcMount, "copy");
      this.assertVisibleFile(normalizedPath, srcMount);
    }
    if (dstMount) {
      this.assertUsable(newNormalizedPath, dstMount, "copy to");
      this.assertVisibleFile(newNormalizedPath, dstMount);
    }
    try {
      if (srcMount && dstMount) {
        const dstReal = this.toReal(newNormalizedPath, dstMount);
        this.assertCreatableName(dstReal);
        const srcReal = this.toReal(normalizedPath, srcMount);
        await this.withParents(dstReal, () => fs2.promises.copyFile(srcReal, dstReal, fs2.constants.COPYFILE_EXCL));
      } else if (srcMount) {
        const buf = await fs2.promises.readFile(this.toReal(normalizedPath, srcMount));
        if (await this.orig().exists(newNormalizedPath)) throw new Error(`Folder Bridge: "${newNormalizedPath}" already exists.`);
        await this.orig().writeBinary(newNormalizedPath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } else if (dstMount) {
        const data = await this.orig().readBinary(normalizedPath);
        const dstReal = this.toReal(newNormalizedPath, dstMount);
        this.assertCreatableName(dstReal);
        await this.withParents(dstReal, () => fs2.promises.writeFile(dstReal, Buffer.from(data), { flag: "wx" }));
      }
    } catch (e) {
      const err = e;
      if (err.message?.startsWith("Folder Bridge:")) throw err;
      throw new Error(`Folder Bridge: ${translateFsError(e, "copy")}`);
    }
    if (dstMount) await this.notifyWritten(newNormalizedPath);
  }
};

// src/VaultIndex.ts
var import_obsidian5 = require("obsidian");
var VaultIndex = class {
  constructor(app) {
    this.app = app;
  }
  emit(event, path5, oldPath = null, stat = null) {
    this.app.vault.onChange(event, path5, oldPath, stat);
  }
  get(path5) {
    return this.app.vault.getAbstractFileByPath((0, import_obsidian5.normalizePath)(path5));
  }
  /**
   * Create every missing folder from the vault root down to `path`
   * (inclusive). Returns false, changing nothing further, when a FILE
   * stands in the way: that file is never removed to make room.
   */
  ensureFolder(path5) {
    const n = (0, import_obsidian5.normalizePath)(path5);
    if (this.get(n) instanceof import_obsidian5.TFolder) return true;
    const segments = n.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const part = segments.slice(0, i).join("/");
      const existing = this.get(part);
      if (existing instanceof import_obsidian5.TFolder) continue;
      if (existing) return false;
      this.emit("folder-created", part);
    }
    return true;
  }
  ensureParent(path5) {
    const slash = path5.lastIndexOf("/");
    return slash <= 0 || this.ensureFolder(path5.slice(0, slash));
  }
  /** Add a file. A folder already at that path must be removed by the caller first. */
  addFile(path5, stat) {
    if (this.get(path5)) return;
    if (!this.ensureParent(path5)) return;
    this.emit("file-created", path5, null, stat);
  }
  addFolder(path5) {
    this.ensureFolder(path5);
  }
  /** Report new content for a known file (or add it when unknown). */
  modifyFile(path5, stat) {
    const existing = this.get(path5);
    if (existing instanceof import_obsidian5.TFile) this.emit("modified", path5, null, stat);
    else this.addFile(path5, stat);
  }
  /** True when Obsidian's copy of the stat differs from disk. */
  isStale(file, stat) {
    return file.stat.mtime !== stat.mtime || file.stat.size !== stat.size;
  }
  /**
   * Remove a file, or a folder with everything below it (children first).
   * Every removal fires vault "delete" listeners (explorer, metadata cache,
   * Bases), so big subtrees yield to the UI every 500 items.
   */
  async removeTree(path5) {
    const root = this.get(path5);
    if (!root) return;
    const order = [];
    const walk = (folder) => {
      for (const child of [...folder.children]) {
        if (child instanceof import_obsidian5.TFolder) walk(child);
        order.push(child);
      }
    };
    if (root instanceof import_obsidian5.TFolder) walk(root);
    order.push(root);
    for (let i = 0; i < order.length; i++) {
      const item = order[i];
      if (this.get(item.path) !== item) continue;
      this.emit(item instanceof import_obsidian5.TFolder ? "folder-removed" : "file-removed", item.path);
      if (i % 500 === 499) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  /**
   * Mirror Obsidian's own adapter after a successful rename: one "renamed"
   * event for the item, then one per descendant, so open tabs survive and
   * Obsidian's automatic link updating runs.
   */
  renameTree(oldPath, newPath) {
    const item = this.get(oldPath);
    if (!item) return;
    const descendants = [];
    if (item instanceof import_obsidian5.TFolder) {
      const walk = (folder) => {
        for (const child of folder.children) {
          descendants.push(child.path);
          if (child instanceof import_obsidian5.TFolder) walk(child);
        }
      };
      walk(item);
    }
    this.ensureParent(newPath);
    this.emit("renamed", newPath, oldPath);
    for (const child of descendants) {
      this.emit("renamed", newPath + child.slice(oldPath.length), child);
    }
  }
  /**
   * Remove now-empty virtual parent folders of a removed mount ("Finance"
   * for "Finance/Reports") unless they really exist in the vault.
   */
  async pruneEmptyParents(path5, existsInVault) {
    const segments = (0, import_obsidian5.normalizePath)(path5).split("/");
    for (let i = segments.length - 1; i >= 1; i--) {
      const part = segments.slice(0, i).join("/");
      const folder = this.get(part);
      if (!(folder instanceof import_obsidian5.TFolder) || folder.children.length > 0) return;
      if (await existsInVault(part)) return;
      this.emit("folder-removed", part);
    }
  }
};

// src/FileWatcher.ts
var fs3 = __toESM(require("fs"));
var import_obsidian6 = require("obsidian");
var DEFAULT_DEBOUNCE_MS = 300;
var MAX_BATCH_DELAY_MS = 2e3;
var DEFAULT_POLL_INTERVAL_MS = 6e4;
var MIN_POLL_INTERVAL_MS = 1e4;
var FileWatcher = class {
  constructor(host) {
    this.host = host;
    this.states = /* @__PURE__ */ new Map();
  }
  isWatching(mountId) {
    return this.states.has(mountId);
  }
  start(mount) {
    this.stop(mount.id);
    const mode = mount.watchMode ?? "native";
    if (mode === "off") return;
    const state = {
      mount,
      handle: null,
      pollTimer: null,
      pending: /* @__PURE__ */ new Set(),
      needsFullSync: false,
      flushTimer: null,
      firstPendingAt: 0,
      running: null,
      stopped: false
    };
    this.states.set(mount.id, state);
    if (mode === "poll") {
      this.startPolling(state);
      return;
    }
    const root = this.host.realRoot(mount);
    try {
      state.handle = fs3.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        this.onRawEvent(state, typeof filename === "string" ? filename : filename ? String(filename) : null);
      });
      state.handle.on("error", (error) => this.fallBackToPolling(state, error));
      logger.debug(`Watching ${root} (native, recursive)`);
    } catch (error) {
      this.fallBackToPolling(state, error);
    }
  }
  stop(mountId) {
    const state = this.states.get(mountId);
    if (!state) return;
    state.stopped = true;
    this.states.delete(mountId);
    try {
      state.handle?.close();
    } catch {
    }
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (state.flushTimer) clearTimeout(state.flushTimer);
  }
  stopAll() {
    for (const id of [...this.states.keys()]) this.stop(id);
  }
  /**
   * The next rescan is scheduled only after the previous one finished, and
   * never sooner than 5× its duration: on a slow share a scan can take
   * longer than the interval, and back-to-back scans would keep the
   * network and Node's file threads permanently busy.
   */
  startPolling(state) {
    const base = Math.max(MIN_POLL_INTERVAL_MS, state.mount.watcherPollingIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const schedule = (delay) => {
      state.pollTimer = setTimeout(() => {
        if (state.stopped) return;
        if (typeof document !== "undefined" && document.hidden) {
          schedule(base);
          return;
        }
        state.needsFullSync = true;
        const started = Date.now();
        void this.flush(state).then(() => {
          if (!state.stopped) schedule(Math.max(base, 5 * (Date.now() - started)));
        });
      }, delay);
    };
    schedule(base);
  }
  fallBackToPolling(state, error) {
    if (state.stopped || state.pollTimer) return;
    try {
      state.handle?.close();
    } catch {
    }
    state.handle = null;
    logger.warn(`Live change detection unavailable for "${state.mount.virtualPath}"; polling instead.`, error);
    this.startPolling(state);
    this.host.onFallbackToPolling(state.mount, error);
  }
  onRawEvent(state, filename) {
    if (state.stopped) return;
    if (filename === null) {
      state.needsFullSync = true;
    } else {
      const rel = filename.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!rel || this.host.isIgnored(state.mount, rel)) return;
      state.pending.add((0, import_obsidian6.normalizePath)(`${state.mount.virtualPath}/${rel}`));
    }
    this.scheduleFlush(state);
  }
  scheduleFlush(state) {
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
  flush(state) {
    if (state.running) return state.running;
    const run = (async () => {
      while (!state.stopped && (state.needsFullSync || state.pending.size > 0)) {
        if (state.needsFullSync) {
          state.needsFullSync = false;
          state.pending.clear();
          await this.host.syncAll(state.mount);
        } else {
          const paths = [...state.pending].sort((a, b) => a.split("/").length - b.split("/").length);
          state.pending.clear();
          await this.host.syncPaths(state.mount, paths);
        }
      }
    })();
    state.running = run.catch((error) => logger.error(`Change processing failed for "${state.mount.virtualPath}"`, error)).finally(() => {
      state.running = null;
    });
    return state.running;
  }
};

// src/treeSync.ts
var MAX_DEPTH = 64;
var ERROR_BREAKER = 5;
var defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
async function syncTree(rootFolder, deps, options = {}) {
  const result = { added: 0, modified: 0, removed: 0, scanned: 0, limitHit: false, aborted: false, failedFolders: [] };
  const maxItems = options.maxItems ?? 0;
  const statLimit = limiter(Math.max(1, options.statConcurrency ?? 6));
  const folderConcurrency = Math.max(1, options.folderConcurrency ?? 3);
  const yieldToEventLoop = deps.yieldToEventLoop ?? defaultYield;
  const scanStarted = Date.now();
  let sinceYield = 0;
  let consecutiveErrors = 0;
  const alive = () => !result.aborted && deps.shouldContinue();
  const ok = () => {
    consecutiveErrors = 0;
  };
  const fail = () => {
    if (++consecutiveErrors >= ERROR_BREAKER && !result.aborted) {
      result.aborted = true;
      deps.onTrouble?.();
    }
  };
  const tick = async () => {
    if (++sinceYield >= 200) {
      sinceYield = 0;
      deps.onProgress?.(result);
      await yieldToEventLoop();
    }
  };
  const canAdd = () => {
    if (maxItems > 0 && result.added >= maxItems) {
      result.limitHit = true;
      return false;
    }
    return true;
  };
  const ABORTED = new Error("scan abandoned");
  const statSafe = async (path5) => {
    try {
      const s = await statLimit(() => alive() ? deps.stat(path5) : Promise.reject(ABORTED));
      ok();
      return s;
    } catch (e) {
      if (e !== ABORTED) fail();
      return "error";
    }
  };
  const queue = [{ folder: rootFolder, depth: 0 }];
  const syncFolder = async (folder, depth) => {
    let listing;
    try {
      listing = await deps.list(folder);
      ok();
    } catch {
      fail();
      result.failedFolders.push(folder);
      return;
    }
    if (!alive()) return;
    result.scanned += listing.files.length + listing.folders.length;
    const present = /* @__PURE__ */ new Set([...listing.files, ...listing.folders]);
    const knownFolder = deps.known(folder);
    if (knownFolder?.kind === "folder") {
      for (const child of knownFolder.children) {
        if (present.has(child)) continue;
        const recheck = await statSafe(child);
        if (recheck === "error") continue;
        if (recheck && recheck.type === "file" && recheck.mtime >= scanStarted - 2e3) continue;
        if (!alive()) return;
        await deps.removeTree(child);
        result.removed++;
      }
    }
    for (const sub of listing.folders) {
      if (!alive()) return;
      const k = deps.known(sub);
      if (k?.kind !== "folder") {
        if (!canAdd()) break;
        if (k) {
          await deps.removeTree(sub);
          result.removed++;
        }
        deps.addFolder(sub);
        result.added++;
      }
      if (depth + 1 < MAX_DEPTH) queue.push({ folder: sub, depth: depth + 1 });
      await tick();
    }
    const stats = await Promise.all(listing.files.map((f) => statSafe(f)));
    if (!alive()) return;
    for (let i = 0; i < listing.files.length; i++) {
      const file = listing.files[i];
      const stat = stats[i];
      if (stat === "error" || !stat || stat.type !== "file") continue;
      const k = deps.known(file);
      if (k?.kind === "file") {
        if (k.mtime !== stat.mtime || k.size !== stat.size) {
          deps.modifyFile(file, stat);
          result.modified++;
        }
      } else {
        if (!canAdd()) break;
        if (k) {
          await deps.removeTree(file);
          result.removed++;
        }
        deps.addFile(file, stat);
        result.added++;
      }
      await tick();
    }
  };
  let running = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (running < folderConcurrency && queue.length > 0 && alive()) {
        const next = queue.shift();
        running++;
        void syncFolder(next.folder, next.depth).catch(() => {
          fail();
        }).finally(() => {
          running--;
          pump();
        });
      }
      if (running === 0 && (queue.length === 0 || !alive())) resolve();
    };
    pump();
  });
  deps.onProgress?.(result);
  return result;
}
async function syncPath(path5, deps, options = {}) {
  if (!deps.shouldContinue()) return;
  let stat;
  let k = deps.known(path5);
  try {
    stat = await deps.stat(path5);
    const twin = stat && !k ? deps.findCaseTwin?.(path5) : void 0;
    if (twin && deps.exactNameExists) {
      if (!await deps.exactNameExists(path5)) stat = null;
      else if (!await deps.exactNameExists(twin)) await deps.removeTree(twin);
    }
  } catch {
    return;
  }
  if (!deps.shouldContinue()) return;
  k = deps.known(path5);
  if (!stat) {
    if (k) await deps.removeTree(path5);
    return;
  }
  if (stat.type === "file") {
    if (k?.kind === "file") {
      if (k.mtime !== stat.mtime || k.size !== stat.size) deps.modifyFile(path5, stat);
      return;
    }
    if (k) await deps.removeTree(path5);
    deps.addFile(path5, stat);
    return;
  }
  if (k?.kind === "folder") return;
  if (k) await deps.removeTree(path5);
  deps.addFolder(path5);
  await syncTree(path5, deps, options);
}

// src/ui/MountModal.ts
var import_obsidian7 = require("obsidian");
async function browseForFolder(title, defaultPath) {
  try {
    const req = globalThis.require;
    const electron = req?.("electron");
    const dialog = electron?.remote?.dialog ?? electron?.dialog;
    if (!dialog?.showOpenDialog) {
      new import_obsidian7.Notice("The folder picker is unavailable. Type or paste the path instead.");
      return null;
    }
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title, defaultPath: defaultPath || void 0 });
    return result.canceled || !result.filePaths?.length ? null : result.filePaths[0];
  } catch (error) {
    logger.error("Folder picker failed", error);
    new import_obsidian7.Notice("The folder picker is unavailable. Type or paste the path instead.");
    return null;
  }
}
var VaultFolderSuggest = class extends import_obsidian7.AbstractInputSuggest {
  constructor(app, inputEl) {
    super(app, inputEl);
    this.inputEl = inputEl;
    /** Vault folders, collected once per dialog (the vault can hold many mounted files). */
    this.folders = null;
  }
  getSuggestions(query) {
    const q = query.toLowerCase();
    this.folders ?? (this.folders = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof import_obsidian7.TFolder && !f.isRoot()).map((f) => f.path + "/"));
    return this.folders.filter((p) => p.toLowerCase().includes(q)).slice(0, 50);
  }
  renderSuggestion(value, el) {
    el.setText(value);
  }
  selectSuggestion(value) {
    this.inputEl.value = value;
    this.inputEl.trigger("input");
    this.close();
  }
};
var MountModal = class extends import_obsidian7.Modal {
  constructor(app, plugin, existing, defaults) {
    super(app);
    this.plugin = plugin;
    this.existing = existing;
    this.errorEl = null;
    this.statusEl = null;
    this.saving = false;
    this.virtualPathInput = null;
    this.checkSeq = 0;
    this.checkTimer = null;
    const base = {
      virtualPath: "",
      realPath: "",
      enabled: true,
      readOnly: false,
      ignoreList: [],
      visibleFileFilter: "all",
      watchMode: "native"
    };
    const source = { ...existing ?? {}, ...defaults ?? {} };
    delete source.id;
    this.draft = { ...base, ...source };
    this.virtualPathTouched = !!existing || !!defaults?.virtualPath;
  }
  onOpen() {
    this.setTitle(this.existing ? "Edit mount" : "Add mount");
    this.render();
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("folderbridge-modal");
    new import_obsidian7.Setting(contentEl).setName("Real folder").setDesc(PATH_EXAMPLES.describe).addText((text) => {
      text.setPlaceholder(PATH_EXAMPLES.folder).setValue(this.draft.realPath).onChange((v) => {
        this.draft.realPath = v.trim();
        this.suggestVirtualPath();
        this.checkPath();
      });
      text.inputEl.addClass("folderbridge-input-wide");
    }).addButton((b) => b.setButtonText("Browse\u2026").onClick(async () => {
      const picked = await browseForFolder("Choose the folder to mount", this.draft.realPath);
      if (!picked) return;
      this.draft.realPath = picked;
      this.suggestVirtualPath();
      this.render();
      this.checkPath();
    }));
    this.statusEl = contentEl.createDiv({ cls: "folderbridge-path-status setting-item-description" });
    new import_obsidian7.Setting(contentEl).setName("Vault folder").setDesc("Where the folder appears in this vault. Must not already exist; it is created by the mount.").addText((text) => {
      this.virtualPathInput = text;
      text.setPlaceholder("Finance/Reports").setValue(this.draft.virtualPath).onChange((v) => {
        this.draft.virtualPath = v.trim().replace(/\/+$/, "");
        this.virtualPathTouched = this.draft.virtualPath !== "";
      });
      text.inputEl.addClass("folderbridge-input-wide");
      new VaultFolderSuggest(this.app, text.inputEl);
    });
    new import_obsidian7.Setting(contentEl).setName("Label").setDesc("Optional name shown in settings and notices.").addText((text) => text.setValue(this.draft.label ?? "").onChange((v) => {
      this.draft.label = v.trim() || void 0;
    }));
    new import_obsidian7.Setting(contentEl).setName("Read-only").setDesc("Block every change from Obsidian (edits, renames, deletes). Recommended for shared finance folders you only report from.").addToggle((t) => t.setValue(this.draft.readOnly).onChange((v) => {
      this.draft.readOnly = v;
    }));
    new import_obsidian7.Setting(contentEl).setName("File types").setDesc('Show only some files. "Notes only" keeps big shares fast when you just need notes and Bases.').addDropdown((d) => d.addOption("all", "All files").addOption("markdown-only", "Notes only (Markdown, canvas, Bases)").addOption("pdf-only", "PDF only").setValue(this.draft.visibleFileFilter ?? "all").onChange((v) => {
      this.draft.visibleFileFilter = v;
    }));
    new import_obsidian7.Setting(contentEl).setName("Ignore").setDesc("One per line. A name hides it anywhere (Archive). Starting with / or containing / means a path from the mount root (/Archive, 2019/Old). * is a wildcard (*.tmp). Hidden items are never scanned.").addTextArea((t) => {
      t.setPlaceholder("Archive\n2019/Old\n*.bak").setValue((this.draft.ignoreList ?? []).join("\n")).onChange((v) => {
        this.draft.ignoreList = v.split("\n").map((s) => s.trim()).filter(Boolean);
      });
      t.inputEl.rows = 4;
      t.inputEl.addClass("folderbridge-input-wide");
    });
    const advanced = contentEl.createEl("details", { cls: "folderbridge-advanced" });
    advanced.createEl("summary", { text: "Advanced" });
    new import_obsidian7.Setting(advanced).setName("Fallback path").setDesc(IS_WINDOWS ? "Tried when the real folder is unreachable, e.g. the \\\\server\\share form of a mapped drive for PCs where the letter differs." : "Tried when the real folder is unreachable, e.g. where the same share is mounted on another computer.").addText((text) => {
      text.setPlaceholder(PATH_EXAMPLES.share).setValue(this.draft.fallbackRealPath ?? "").onChange((v) => {
        this.draft.fallbackRealPath = v.trim() || void 0;
      });
      text.inputEl.addClass("folderbridge-input-wide");
    });
    let pollSetting = null;
    new import_obsidian7.Setting(advanced).setName("Change detection").setDesc('How edits made outside Obsidian show up. Switch to "check periodically" if a share never updates live.').addDropdown((d) => d.addOption("native", "Live (recommended)").addOption("poll", "Check periodically").addOption("off", "Off (rescan manually)").setValue(this.draft.watchMode ?? "native").onChange((v) => {
      this.draft.watchMode = v;
      pollSetting?.settingEl.toggleClass("folderbridge-hidden", v !== "poll");
    }));
    pollSetting = new import_obsidian7.Setting(advanced).setName("Check every (seconds)").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "10";
      text.setValue(String(Math.round((this.draft.watcherPollingIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) / 1e3))).onChange((v) => {
        const seconds = Number(v);
        this.draft.watcherPollingIntervalMs = Number.isFinite(seconds) && seconds >= 10 ? seconds * 1e3 : void 0;
      });
    });
    pollSetting.settingEl.toggleClass("folderbridge-hidden", (this.draft.watchMode ?? "native") !== "poll");
    new import_obsidian7.Setting(advanced).setName("Max items").setDesc("Stop indexing after this many files and folders (0 = no limit). A safety net for very large shares.").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0";
      text.setValue(String(this.draft.maxFiles ?? 0)).onChange((v) => {
        const n = Math.floor(Number(v));
        this.draft.maxFiles = Number.isFinite(n) && n > 0 ? n : void 0;
      });
    });
    this.errorEl = contentEl.createDiv({ cls: "folderbridge-error" });
    new import_obsidian7.Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close())).addButton((b) => b.setButtonText(this.existing ? "Save" : "Mount").setCta().onClick(() => void this.save()));
    this.checkPath();
  }
  /** Default the vault folder to the real folder's name for new mounts. */
  suggestVirtualPath() {
    if (this.virtualPathTouched) return;
    const name = this.draft.realPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    this.draft.virtualPath = name && !/^[a-zA-Z]:$/.test(name) ? (0, import_obsidian7.normalizePath)(name) : "";
    this.virtualPathInput?.setValue(this.draft.virtualPath);
  }
  /**
   * Probe the typed path once typing pauses. Probing every keystroke would
   * hit the network for "\\s", "\\se", "\\ser"…, and each unknown server
   * name can hang for a long time.
   */
  checkPath() {
    const seq = ++this.checkSeq;
    const el = this.statusEl;
    const realPath = this.draft.realPath;
    if (!el) return;
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    if (!realPath) {
      el.setText("");
      return;
    }
    if (isUNCPath(realPath) && realPath.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean).length < 2) {
      el.setText("Add the share name: \\\\server\\share\\folder");
      return;
    }
    el.setText("Checking\u2026");
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null;
      this.runPathCheck(seq, el, realPath);
    }, 700);
  }
  runPathCheck(seq, el, realPath) {
    void checkPathAccessible(realPath).then((result) => {
      if (seq !== this.checkSeq) return;
      if (!result.accessible) el.setText(`\u26A0 Not reachable right now: ${result.error ?? "unknown error"}`);
      else el.setText(`\u2713 Reachable${result.readOnly ? " (your account cannot write here; mount it read-only)" : ""}${isUNCPath(realPath) ? " \xB7 network share" : ""}`);
    });
  }
  async save() {
    if (this.saving) return;
    this.saving = true;
    this.errorEl?.setText("");
    try {
      const draft = { ...this.draft, virtualPath: (0, import_obsidian7.normalizePath)(this.draft.virtualPath) };
      const error = this.existing ? await this.plugin.updateMount(this.existing.id, draft) : await this.plugin.addMount(draft);
      if (error) {
        this.errorEl?.setText(error);
        return;
      }
      this.close();
    } finally {
      this.saving = false;
    }
  }
  onClose() {
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    this.contentEl.empty();
  }
};

// src/ui/MountRootDeleteModal.ts
var import_obsidian8 = require("obsidian");
var MountRootDeleteModal = class extends import_obsidian8.Modal {
  constructor(app, mountPath, onChoose) {
    super(app);
    this.mountPath = mountPath;
    this.onChoose = onChoose;
    this.remember = false;
    this.settled = false;
  }
  settle(unmount) {
    if (this.settled) return;
    this.settled = true;
    this.onChoose(unmount, unmount && this.remember);
    this.close();
  }
  onOpen() {
    const { contentEl } = this;
    this.setTitle("Unmount folder?");
    contentEl.createEl("p", { text: `"${this.mountPath}" is a mounted folder. Deleting it here only removes it from this vault; no files on the drive are deleted or moved.` });
    contentEl.createEl("p", { cls: "setting-item-description", text: "To delete the real folder, use File Explorer." });
    new import_obsidian8.Setting(contentEl).setName("Don't ask again").setDesc("Unmount without asking next time. You can change this in the plugin settings.").addToggle((toggle) => toggle.setValue(false).onChange((value) => {
      this.remember = value;
    }));
    new import_obsidian8.Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.settle(false))).addButton((b) => b.setButtonText("Unmount").setCta().onClick(() => this.settle(true)));
  }
  onClose() {
    this.contentEl.empty();
    this.settle(false);
  }
};

// src/ui/SettingsTab.ts
var import_obsidian9 = require("obsidian");
var FolderBridgeSettingTab = class extends import_obsidian9.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.render();
  }
  /** Rebuild the tab (also called after changes made from this tab). */
  render() {
    const { containerEl } = this;
    containerEl.empty();
    const { settings } = this.plugin;
    new import_obsidian9.Setting(containerEl).setName("Mounts").setDesc("Folders from this PC or the network, shown inside this vault. Removing a mount never deletes files.").setHeading().addButton((b) => b.setButtonText("Add mount").setCta().onClick(() => this.plugin.openMountModal()));
    if (settings.mountPoints.length === 0) {
      containerEl.createEl("p", { cls: "setting-item-description", text: 'No mounts yet. Use "add mount" or right-click a folder in the file explorer.' });
    }
    for (const mount of settings.mountPoints) this.renderMount(containerEl, mount);
    new import_obsidian9.Setting(containerEl).setName("Behavior").setHeading();
    new import_obsidian9.Setting(containerEl).setName("When a mount folder is deleted in Obsidian").setDesc("Deleting a mount folder in Obsidian only unmounts it; files on the drive are never deleted that way.").addDropdown((d) => d.addOption("ask", "Ask before unmounting").addOption("unmount", "Unmount without asking").setValue(settings.mountRootDeletionBehavior).onChange(async (v) => {
      settings.mountRootDeletionBehavior = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian9.Setting(containerEl).setName("When a note changed on the drive while you edit it").setDesc("A colleague saved the same note before Obsidian noticed. Merge combines both sets of changes and keeps a copy of their version only when you both changed the same lines.").addDropdown((d) => d.addOption("merge", "Merge both versions (recommended)").addOption("copy", "Keep their version as a copy, save mine").addOption("overwrite", "Save mine, discard theirs").setValue(settings.conflictMode).onChange(async (v) => {
      settings.conflictMode = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian9.Setting(containerEl).setName("Status bar").setDesc("Show the mount count and offline warnings in the status bar.").addToggle((t) => t.setValue(settings.showStatusBar).onChange(async (v) => {
      settings.showStatusBar = v;
      await this.plugin.saveSettings();
      if (v) this.plugin.createStatusBar();
      else this.plugin.removeStatusBar();
    }));
    let pending = settings.globalIgnorePatterns.join("\n");
    new import_obsidian9.Setting(containerEl).setName("Ignore in every mount").setDesc("One per line: a name, a path, or a pattern with *. Applied to all mounts.").addTextArea((t) => {
      t.setValue(pending).onChange((v) => {
        pending = v;
      });
      t.inputEl.rows = 6;
      t.inputEl.addClass("folderbridge-input-wide");
    }).addButton((b) => b.setButtonText("Apply").onClick(async () => {
      await this.plugin.setGlobalIgnorePatterns(pending.split("\n").map((s) => s.trim()).filter(Boolean));
      this.render();
    })).addExtraButton((b) => b.setIcon("reset").setTooltip("Restore defaults").onClick(async () => {
      await this.plugin.setGlobalIgnorePatterns([...DEFAULT_SETTINGS.globalIgnorePatterns]);
      this.render();
    }));
  }
  renderMount(containerEl, mount) {
    const health = this.plugin.health.get(mount.id);
    const effective = stripLongPathPrefix(this.plugin.pathMapper.getEffectiveRealPath(mount));
    const parts = [`${mount.virtualPath}  \u2190  ${effective}`];
    if (effective !== mount.realPath) parts.push("(using fallback path)");
    if (mount.readOnly) parts.push("\xB7 read-only");
    if (mount.watchMode === "poll") parts.push("\xB7 checks periodically");
    if (mount.watchMode === "off") parts.push("\xB7 change detection off");
    const row = new import_obsidian9.Setting(containerEl).setName(`${health === "unreachable" ? "\u26A0 " : ""}${this.plugin.displayName(mount)}`).setDesc(parts.join(" "));
    row.settingEl.addClass("folderbridge-mount-row");
    const syncReason = this.plugin.syncBlocked.get(mount.id);
    if (syncReason) row.descEl.createDiv({ cls: "folderbridge-error", text: `Not mounted: ${syncReason}` });
    if (health === "unreachable") {
      row.descEl.createDiv({ cls: "folderbridge-error", text: `Offline: ${this.plugin.healthError.get(mount.id) ?? "not reachable"}` });
    }
    row.addToggle((t) => t.setTooltip(mount.enabled ? "Turn off" : "Turn on").setValue(mount.enabled).onChange(async (v) => {
      await this.plugin.setMountEnabled(mount.id, v);
      this.render();
    })).addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Rescan").setDisabled(!mount.enabled).onClick(async () => {
      await this.plugin.rescanMount(mount);
      this.render();
    })).addExtraButton((b) => b.setIcon("pencil").setTooltip("Edit").onClick(() => this.plugin.openMountModal(mount))).addExtraButton((b) => b.setIcon("trash").setTooltip("Remove mount (files are kept)").onClick(async () => {
      await this.plugin.removeMount(mount.id);
      this.render();
    }));
  }
};

// src/TreeSnapshot.ts
var import_obsidian10 = require("obsidian");
function captureMount(index, mount) {
  const rootPath = (0, import_obsidian10.normalizePath)(mount.virtualPath);
  const root = index.get(rootPath);
  if (!(root instanceof import_obsidian10.TFolder)) return null;
  const entries = [];
  const walk = (folder) => {
    for (const child of folder.children) {
      if (entries.length >= MAX_ENTRIES) return;
      const rel = child.path.slice(rootPath.length + 1);
      if (child instanceof import_obsidian10.TFolder) {
        entries.push([rel, 0, 0, 0, 0]);
        walk(child);
      } else if (child instanceof import_obsidian10.TFile) {
        entries.push([rel, 1, child.stat.mtime, child.stat.size, child.stat.ctime]);
      }
    }
  };
  walk(root);
  return { virtualPath: rootPath, realPath: mount.realPath, entries };
}
var MAX_ENTRIES = 3e5;
function restoreMount(index, mount, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ENTRIES) return 0;
  const rootPath = (0, import_obsidian10.normalizePath)(mount.virtualPath);
  if (snapshot.virtualPath !== rootPath || snapshot.realPath !== mount.realPath) return 0;
  index.ensureFolder(rootPath);
  let added = 0;
  for (const entry of snapshot.entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const [rel, kind, mtime, size, ctime] = entry;
    const segments = rel.split("/");
    if (!rel || segments.some((s) => s === "" || s === "." || s === "..")) continue;
    const path5 = `${rootPath}/${rel}`;
    if (index.get(path5)) continue;
    if (kind === 0) index.addFolder(path5);
    else index.addFile(path5, { type: "file", mtime: Number(mtime) || 0, size: Number(size) || 0, ctime: Number(ctime) || 0 });
    added++;
  }
  return added;
}
function parseSnapshot(text) {
  try {
    const data = text ? JSON.parse(text) : null;
    if (data?.version === 1 && data.mounts && typeof data.mounts === "object") return data;
  } catch {
  }
  return { version: 1, mounts: {} };
}

// main.ts
var HEALTH_CHECK_INTERVAL_MS = 3e4;
function generateId() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}
var IgnoreRules = {
  patternsRemoved(before, after) {
    const kept = new Set(after.map((p) => p.trim()));
    return before.some((p) => p.trim() !== "" && !kept.has(p.trim()));
  },
  loosened(old, updated) {
    if (IgnoreRules.patternsRemoved(old.ignoreList ?? [], updated.ignoreList ?? [])) return true;
    const before = old.visibleFileFilter ?? "all";
    const after = updated.visibleFileFilter ?? "all";
    if (before !== after && before !== "all") return true;
    const limit = (n) => n && n > 0 ? n : Infinity;
    return limit(updated.maxFiles) > limit(old.maxFiles);
  }
};
var FolderBridgePlugin = class extends import_obsidian11.Plugin {
  constructor() {
    super(...arguments);
    this.pathMapper = new PathMapper();
    this.security = new SecurityManager();
    this.ignore = new IgnoreMatcher();
    this.originalAdapter = null;
    /** Reachability per mount id, refreshed by the health-check loop. */
    this.health = /* @__PURE__ */ new Map();
    /** Last probe error per mount id, shown in settings. */
    this.healthError = /* @__PURE__ */ new Map();
    /** Mounts that are currently being scanned, for the status bar. */
    this.scanning = /* @__PURE__ */ new Set();
    /** Changes on every (de)activation; long scans stop when their token is stale. */
    this.sessions = /* @__PURE__ */ new Map();
    /** Serializes tree work per mount so scans and watcher batches never interleave. */
    this.queues = /* @__PURE__ */ new Map();
    this.probesInFlight = /* @__PURE__ */ new Set();
    /** Mounts not activated because Obsidian Sync would sync them; value = reason. */
    this.syncBlocked = /* @__PURE__ */ new Map();
    this.unloaded = false;
    /** Last mount-tree snapshot read or written (see TreeSnapshot.ts). */
    this.snapshot = { version: 1, mounts: {} };
    this.snapshotTimer = null;
    this.snapshotDirty = false;
    this.restoreHookCleanup = null;
    /** When each mount running on its fallback last re-tried its (dead) primary path. */
    this.lastPrimaryProbe = /* @__PURE__ */ new Map();
    this.settingTab = null;
    this.statusBarEl = null;
    this.explorerObserver = null;
    this.observedExplorerEl = null;
    this.explorerRaf = null;
  }
  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------
  async onload() {
    this.index = new VaultIndex(this.app);
    this.watcher = new FileWatcher({
      realRoot: (mount) => this.pathMapper.getEffectiveRealPath(mount),
      isIgnored: (mount, rel) => this.ignore.isPathIgnored(rel, mount),
      syncPaths: (mount, paths) => this.enqueue(mount, (token) => this.syncChangedPaths(mount, paths, token)),
      syncAll: (mount) => this.enqueue(mount, (token) => this.syncMount(mount, token, false)),
      onFallbackToPolling: (mount) => {
        new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" does not report changes. Checking it every minute instead.`, 8e3);
      }
    });
    await this.loadSettings();
    this.applyMountState();
    this.installVirtualAdapter();
    this.hookStartupRestore();
    this.settingTab = new FolderBridgeSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addRibbonIcon("folder-plus", "Folder Bridge: add mount", () => this.openMountModal());
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
  onunload() {
    this.restoreHookCleanup?.();
    if (this.snapshotTimer !== null) window.clearTimeout(this.snapshotTimer);
    if (this.snapshotDirty) void this.saveSnapshot();
    this.unloaded = true;
    this.watcher?.stopAll();
    const plugins = this.app.plugins;
    const userDisabled = plugins?.enabledPlugins ? !plugins.enabledPlugins.has(this.manifest.id) : false;
    if (userDisabled) {
      for (const mount of this.settings.mountPoints.filter((m) => this.sessions.has(m.id))) {
        void this.index.removeTree((0, import_obsidian11.normalizePath)(mount.virtualPath)).then(() => this.index.pruneEmptyParents(mount.virtualPath, (p) => (this.originalAdapter ?? this.app.vault.adapter).exists(p)));
      }
    }
    this.sessions.clear();
    this.explorerObserver?.disconnect();
    if (this.explorerRaf !== null) cancelAnimationFrame(this.explorerRaf);
    document.querySelectorAll("[data-folder-bridge]").forEach((el) => {
      el.removeAttribute("data-folder-bridge");
      el.removeAttribute("aria-label");
    });
    if (this.originalAdapter) {
      this.app.vault.adapter = this.originalAdapter;
      this.originalAdapter = null;
    }
  }
  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.settings.mountPoints = Array.isArray(this.settings.mountPoints) ? this.settings.mountPoints : [];
    this.settings.globalIgnorePatterns = Array.isArray(this.settings.globalIgnorePatterns) ? this.settings.globalIgnorePatterns : [...DEFAULT_SETTINGS.globalIgnorePatterns];
    const accepted = [];
    for (const mount of this.settings.mountPoints) {
      if (!mount || typeof mount !== "object") continue;
      if (!mount.id) mount.id = generateId();
      const error = this.security.validateMount(mount, accepted, this.vaultBasePath());
      if (error && mount.enabled) {
        mount.enabled = false;
        logger.warn(`Disabled mount "${mount.virtualPath}": ${error}`);
        new import_obsidian11.Notice(`Folder Bridge: Disabled "${mount.virtualPath}": ${error}`, 1e4);
      }
      accepted.push(mount);
    }
    this.settings.mountPoints = accepted;
    if (this.settings.mountRootDeletionBehavior !== "unmount") this.settings.mountRootDeletionBehavior = "ask";
    if (!["merge", "copy", "overwrite"].includes(this.settings.conflictMode)) this.settings.conflictMode = "merge";
    for (const mount of accepted.filter((m) => m.enabled)) {
      const clash = await this.vaultFolderClash(mount.virtualPath);
      if (clash) {
        mount.enabled = false;
        new import_obsidian11.Notice(`Folder Bridge: Disabled "${mount.virtualPath}": ${clash}`, 1e4);
      }
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** Push the mount list into the path mapper, allowlist and ignore matcher. */
  applyMountState() {
    const enabled = this.settings.mountPoints.filter((m) => m.enabled);
    this.pathMapper.update(this.settings.mountPoints);
    this.security.setAllowlist(enabled.flatMap((m) => [m.realPath, m.fallbackRealPath ?? ""]));
    this.ignore.rebuild(this.settings.globalIgnorePatterns, this.settings.mountPoints);
    this.updateStatusBar();
    this.scheduleExplorerMarkers();
    this.refreshSettingTab();
  }
  /** Re-render the settings tab if it is open (after mount changes or a health change). */
  refreshSettingTab() {
    if (this.settingTab?.containerEl.isConnected) this.settingTab.render();
  }
  vaultBasePath() {
    const adapter = this.originalAdapter ?? this.app.vault.adapter;
    return adapter.getBasePath?.();
  }
  displayName(mount) {
    return mount.label || mount.virtualPath;
  }
  // ------------------------------------------------------------------
  // Adapter installation
  // ------------------------------------------------------------------
  installVirtualAdapter() {
    const vault = this.app.vault;
    const original = vault.adapter;
    this.originalAdapter = original;
    const adapter = new VirtualAdapter(original, this.pathMapper, this.security, this.ignore, {
      confirmUnmount: (mount) => this.confirmUnmount(mount),
      onWritten: (path5) => this.registerWrite(path5),
      onFolderCreated: (path5) => {
        if (!(this.index.get(path5) instanceof import_obsidian11.TFolder)) this.index.addFolder(path5);
      },
      onRenamed: (oldPath, newPath) => this.index.renameTree(oldPath, newPath),
      onDeleted: (path5) => this.index.removeTree(path5),
      getKnownMtime: (path5) => {
        const file = this.app.vault.getAbstractFileByPath(path5);
        return file instanceof import_obsidian11.TFile ? file.stat.mtime : void 0;
      },
      isOffline: (id) => this.health.get(id) === "unreachable" || this.syncBlocked.has(id),
      conflictMode: () => this.settings.conflictMode,
      requestReload: (path5) => this.reloadAfterSave(path5),
      isOpenInEditor: (path5) => this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view.file?.path === path5)
    });
    const bound = (owner, val) => typeof val === "function" ? val.bind(owner) : val;
    vault.adapter = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop in target) return bound(target, Reflect.get(target, prop, receiver));
        return bound(original, original[prop]);
      },
      set(_target, prop, value) {
        original[prop] = value;
        return true;
      },
      getPrototypeOf() {
        return Object.getPrototypeOf(original);
      }
    });
  }
  /**
   * A file inside a mount was written from Obsidian. Register it before the
   * write call returns: vault.create()/copy() look the new file up right
   * after, and Obsidian's own watcher never sees mounted folders.
   */
  async registerWrite(path5) {
    const mount = this.pathMapper.getMountForPath(path5);
    if (!mount) return;
    const token = this.sessions.get(mount.id);
    const stat = await this.app.vault.adapter.stat(path5);
    if (!stat || stat.type !== "file") return;
    if (token !== void 0 && this.sessions.get(mount.id) !== token) return;
    if (token === void 0 && !(this.index.get(path5) instanceof import_obsidian11.TFile)) return;
    this.index.modifyFile(path5, stat);
    this.scheduleSnapshotSave(6e4);
  }
  /**
   * After a save that merged in changes from disk, tell Obsidian the file
   * changed so the open editor shows the merged text. Obsidian ignores that
   * signal while it is still saving, so wait for the save to finish.
   */
  reloadAfterSave(path5, attempt = 0) {
    window.setTimeout(() => void (async () => {
      const file = this.app.vault.getAbstractFileByPath(path5);
      if (!(file instanceof import_obsidian11.TFile) || this.unloaded) return;
      if (file.saving && attempt < 40) {
        this.reloadAfterSave(path5, attempt + 1);
        return;
      }
      const stat = await this.app.vault.adapter.stat(path5);
      if (stat) this.index.modifyFile(path5, stat);
    })(), 150);
  }
  /**
   * Obsidian Sync (or any sync tool) would upload every mounted file to the
   * cloud and replay deletions from other devices onto the share. A mount is
   * only activated when Sync is off or the mount's folder is excluded from it.
   * Returns a reason when blocked, null when fine.
   */
  syncProblem(mount) {
    const internal = this.app.internalPlugins;
    const sync = internal?.getPluginById?.("sync") ?? internal?.plugins?.sync;
    if (!sync?.enabled) return null;
    const ignored = sync.instance?.filter?.ignoreFolders;
    const folder = (0, import_obsidian11.normalizePath)(mount.virtualPath);
    if (Array.isArray(ignored) && ignored.some((f) => typeof f === "string" && (folder === (0, import_obsidian11.normalizePath)(f) || folder.startsWith((0, import_obsidian11.normalizePath)(f) + "/")))) return null;
    if (!Array.isArray(ignored)) {
      logger.warn("Obsidian Sync is on but its excluded folders could not be read; make sure mounted folders are excluded.");
      return null;
    }
    return `Obsidian Sync is on and "${folder}" is not excluded from it. Sync would upload the shared files and could delete them on the drive from another device. Exclude this folder in Settings \u2192 Sync \u2192 Excluded folders, then rescan.`;
  }
  /** Deleting a mount root in Obsidian = unmount (files untouched), after confirmation. */
  async confirmUnmount(mount) {
    if (this.settings.mountRootDeletionBehavior !== "unmount") {
      const choice = await new Promise((resolve) => {
        new MountRootDeleteModal(this.app, mount.virtualPath, (ok, remember) => resolve({ ok, remember })).open();
      });
      if (!choice.ok) return false;
      if (choice.remember) {
        this.settings.mountRootDeletionBehavior = "unmount";
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
  snapshotFile() {
    try {
      const req = globalThis.require;
      const electron = req?.("electron");
      const userData = electron?.remote?.app?.getPath("userData");
      const appId = this.app.appId;
      if (!userData || !appId) return null;
      return nodePath.join(userData, "folder-bridge-local", `${appId.replace(/[^\w-]/g, "_")}.json`);
    } catch {
      return null;
    }
  }
  /**
   * Obsidian loads plugins, then the vault, then initializes the metadata
   * cache. Run once, right before that initialization, to put the saved
   * mount trees back so cached metadata for unchanged notes is kept.
   */
  hookStartupRestore() {
    const cache = this.app.metadataCache;
    if (cache.initialized || typeof cache.initialize !== "function") return;
    const original = cache.initialize;
    const hadOwn = Object.prototype.hasOwnProperty.call(cache, "initialize");
    const cleanup = () => {
      if (hadOwn) cache.initialize = original;
      else delete cache.initialize;
      this.restoreHookCleanup = null;
    };
    cache.initialize = async (...args) => {
      cleanup();
      try {
        await this.restoreSnapshots();
      } catch (error) {
        logger.warn("Could not restore saved mount trees; the startup scan rebuilds them.", error);
      }
      return await original.apply(cache, args);
    };
    this.restoreHookCleanup = cleanup;
  }
  async restoreSnapshots() {
    const started = performance.now();
    const file = this.snapshotFile();
    let text = null;
    try {
      if (file) text = await fs4.promises.readFile(file, "utf8");
    } catch {
    }
    this.snapshot = parseSnapshot(text);
    let restored = 0;
    for (const mount of this.settings.mountPoints.filter((m) => m.enabled)) {
      if (this.syncProblem(mount)) continue;
      restored += restoreMount(this.index, mount, this.snapshot.mounts[mount.id]);
    }
    if (restored > 0) logger.debug(`Restored ${restored} mounted items from the snapshot in ${Math.round(performance.now() - started)} ms`);
  }
  /** Save soon (debounced). Large mounts make this a few hundred KB, so not too often. */
  scheduleSnapshotSave(delayMs) {
    this.snapshotDirty = true;
    if (this.unloaded) return;
    if (this.snapshotTimer !== null) {
      if (delayMs >= 3e4) return;
      window.clearTimeout(this.snapshotTimer);
    }
    this.snapshotTimer = window.setTimeout(() => {
      this.snapshotTimer = null;
      void this.saveSnapshot();
    }, delayMs);
  }
  async saveSnapshot() {
    this.snapshotDirty = false;
    const file = this.snapshotFile();
    if (!file) return;
    const next = { version: 1, mounts: {} };
    for (const mount of this.settings.mountPoints.filter((m) => m.enabled)) {
      const live = this.health.get(mount.id) === "ok" && !this.scanning.has(mount.id);
      const snap = live ? captureMount(this.index, mount) : this.snapshot.mounts[mount.id];
      if (snap) next.mounts[mount.id] = snap;
    }
    this.snapshot = next;
    try {
      await fs4.promises.mkdir(nodePath.dirname(file), { recursive: true });
      await fs4.promises.writeFile(`${file}.tmp`, JSON.stringify(next));
      await fs4.promises.rename(`${file}.tmp`, file);
    } catch (error) {
      logger.warn("Could not save the mount snapshot", error);
    }
  }
  // ------------------------------------------------------------------
  // Mount activation and tree sync
  // ------------------------------------------------------------------
  /** Run `work` after earlier work for the same mount, with the current session token. */
  enqueue(mount, work) {
    const token = this.sessions.get(mount.id);
    if (!token) return Promise.resolve();
    const previous = this.queues.get(mount.id) ?? Promise.resolve();
    const next = previous.catch(() => {
    }).then(() => {
      if (this.sessions.get(mount.id) !== token) return;
      return work(token);
    });
    this.queues.set(mount.id, next);
    void next.finally(() => {
      if (this.queues.get(mount.id) === next) this.queues.delete(mount.id);
    }).catch(() => {
    });
    return next;
  }
  isCurrent(mountId, token) {
    return !this.unloaded && this.sessions.get(mountId) === token;
  }
  makeSyncDeps(mount, token) {
    const adapter = this.app.vault.adapter;
    const listings = /* @__PURE__ */ new Map();
    const changed = () => this.scheduleSnapshotSave(6e4);
    const caseInsensitive = CASE_INSENSITIVE_FS;
    return {
      list: (path5) => adapter.listMounted(path5),
      stat: (path5) => adapter.statMounted(path5),
      findCaseTwin: caseInsensitive ? (path5) => {
        const parent = this.index.get(path5.slice(0, path5.lastIndexOf("/")));
        const lower = path5.toLowerCase();
        return parent instanceof import_obsidian11.TFolder ? parent.children.find((c) => c.path !== path5 && c.path.toLowerCase() === lower)?.path : void 0;
      } : void 0,
      exactNameExists: caseInsensitive ? async (path5) => {
        const parent = path5.slice(0, path5.lastIndexOf("/"));
        let names = listings.get(parent);
        if (!names) {
          names = adapter.listMounted(parent).then((l) => /* @__PURE__ */ new Set([...l.files, ...l.folders]));
          listings.set(parent, names);
        }
        return (await names).has(path5);
      } : void 0,
      known: (path5) => {
        const item = this.index.get(path5);
        if (item instanceof import_obsidian11.TFile) return { kind: "file", mtime: item.stat.mtime, size: item.stat.size };
        if (item instanceof import_obsidian11.TFolder) return { kind: "folder", children: item.children.map((c) => c.path) };
        return null;
      },
      addFolder: (path5) => {
        this.index.addFolder(path5);
        changed();
      },
      addFile: (path5, stat) => {
        this.index.addFile(path5, stat);
        changed();
      },
      modifyFile: (path5, stat) => {
        this.index.modifyFile(path5, stat);
        changed();
      },
      removeTree: async (path5) => {
        await this.index.removeTree(path5);
        changed();
      },
      // Stop as soon as the share goes offline: adapter calls then fail
      // fast, and a failed stat must not be mistaken for a deleted file.
      shouldContinue: () => this.isCurrent(mount.id, token) && this.health.get(mount.id) !== "unreachable",
      // Repeated I/O errors mid-scan: the share died. Mark it offline now
      // rather than waiting for the next health check, so Obsidian's own
      // reads fail fast instead of queueing behind hung network calls.
      onTrouble: () => {
        if (!this.isCurrent(mount.id, token)) return;
        this.setHealth(mount, "unreachable", "Stopped responding during a scan.");
        this.watcher.stop(mount.id);
        new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" stopped responding. It reconnects automatically.`, 8e3);
      }
    };
  }
  /**
   * Find the reachable path (primary, else fallback). No side effects: the
   * caller applies the result only if the mount was not edited meanwhile.
   * While a mount runs on its fallback, the dead primary is re-tried only
   * every 5 minutes (each try can hold a file-system thread for a while).
   */
  async probeMount(mount) {
    const onFallback = !!mount.fallbackRealPath && this.pathMapper.getEffectiveRealPath(mount) === mount.fallbackRealPath;
    const now = Date.now();
    let error;
    if (!onFallback || now - (this.lastPrimaryProbe.get(mount.id) ?? 0) > 3e5) {
      this.lastPrimaryProbe.set(mount.id, now);
      const primary = await checkPathAccessible(mount.realPath);
      if (primary.accessible) return { reachable: true, path: mount.realPath };
      error = primary.error;
    }
    if (mount.fallbackRealPath) {
      const fallback = await checkPathAccessible(mount.fallbackRealPath);
      if (fallback.accessible) return { reachable: true, path: mount.fallbackRealPath };
      error ?? (error = fallback.error);
    }
    return { reachable: false, error: error ?? "Not reachable." };
  }
  applyProbe(mount, probe) {
    if (probe.reachable && probe.path) {
      if (probe.path === mount.realPath) this.pathMapper.clearResolvedPath(mount.id);
      else this.pathMapper.setResolvedPath(mount.id, probe.path);
      this.setHealth(mount, "ok");
    } else {
      this.setHealth(mount, "unreachable", probe.error);
    }
  }
  /** True when `mount` is still the live configuration for its id and the session is unchanged. */
  stillCurrent(mount, token) {
    return !this.unloaded && token !== void 0 && this.sessions.get(mount.id) === token && this.settings.mountPoints.find((m) => m.id === mount.id) === mount;
  }
  setHealth(mount, health, error) {
    const changed = this.health.get(mount.id) !== health;
    this.health.set(mount.id, health);
    if (error) this.healthError.set(mount.id, error);
    else this.healthError.delete(mount.id);
    this.updateStatusBar();
    this.scheduleExplorerMarkers();
    if (changed) this.refreshSettingTab();
  }
  async activateAll() {
    for (const mount of this.settings.mountPoints.filter((m) => m.enabled)) {
      if (this.unloaded) return;
      await this.activateMount(mount);
    }
  }
  /** Show a mount in the vault: index its contents and start watching. */
  async activateMount(mount, announce = false) {
    const problem = this.syncProblem(mount);
    if (problem) {
      this.syncBlocked.set(mount.id, problem);
      new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" was not mounted. ${problem}`, 0);
      this.refreshSettingTab();
      return;
    }
    this.syncBlocked.delete(mount.id);
    const token = Symbol(mount.id);
    this.sessions.set(mount.id, token);
    this.watcher.stop(mount.id);
    this.index.ensureFolder(mount.virtualPath);
    await this.enqueue(mount, async (t) => {
      const probe = await this.probeMount(mount);
      if (!this.isCurrent(mount.id, t)) return;
      this.applyProbe(mount, probe);
      if (!probe.reachable) {
        new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" is not reachable (${probe.error}). It will reconnect automatically.`, 8e3);
        return;
      }
      this.watcher.start(mount);
      await this.syncMount(mount, t, true);
      if (announce && this.isCurrent(mount.id, t)) new import_obsidian11.Notice(`Folder Bridge: Mounted "${this.displayName(mount)}".`);
    });
  }
  /** Hide a mount from the vault (does not touch any real files). */
  async deactivateMount(mount) {
    this.sessions.delete(mount.id);
    this.watcher.stop(mount.id);
    await (this.queues.get(mount.id) ?? Promise.resolve()).catch(() => {
    });
    await this.index.removeTree((0, import_obsidian11.normalizePath)(mount.virtualPath));
    await this.index.pruneEmptyParents(mount.virtualPath, (p) => (this.originalAdapter ?? this.app.vault.adapter).exists(p));
    this.health.delete(mount.id);
    this.healthError.delete(mount.id);
    this.scheduleSnapshotSave(5e3);
  }
  /** Full scan. `initial` shows a progress notice (first index can take a while). */
  async syncMount(mount, token, initial) {
    if (!this.isCurrent(mount.id, token)) return;
    this.scanning.add(mount.id);
    this.updateStatusBar();
    const notice = initial ? new import_obsidian11.Notice(`Folder Bridge: Scanning "${this.displayName(mount)}"\u2026`, 0) : null;
    const started = performance.now();
    try {
      const deps = this.makeSyncDeps(mount, token);
      deps.onProgress = (progress) => {
        notice?.setMessage(`Folder Bridge: Scanning "${this.displayName(mount)}"\u2026 ${progress.scanned.toLocaleString()} items`);
      };
      const result = await syncTree((0, import_obsidian11.normalizePath)(mount.virtualPath), deps, { maxItems: mount.maxFiles ?? 0 });
      logger.debug(`Synced "${mount.virtualPath}" in ${Math.round(performance.now() - started)} ms`, result);
      if (!this.isCurrent(mount.id, token)) return;
      if (result.limitHit) {
        new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" stopped at its limit of ${(mount.maxFiles ?? 0).toLocaleString()} items. Raise "Max items" or add ignore patterns.`, 1e4);
      }
      if (result.added || result.modified || result.removed || !this.snapshot.mounts[mount.id]) this.scheduleSnapshotSave(5e3);
      if (result.failedFolders.length > 0) {
        logger.warn(`Could not list ${result.failedFolders.length} folder(s) in "${mount.virtualPath}"`, result.failedFolders);
        if (initial || result.failedFolders.includes((0, import_obsidian11.normalizePath)(mount.virtualPath))) {
          new import_obsidian11.Notice(`Folder Bridge: ${result.failedFolders.length} folder(s) in "${this.displayName(mount)}" could not be read (permissions or network). Their contents may be incomplete.`, 8e3);
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
  async syncChangedPaths(mount, paths, token) {
    const deps = this.makeSyncDeps(mount, token);
    const root = (0, import_obsidian11.normalizePath)(mount.virtualPath);
    const handled = /* @__PURE__ */ new Set();
    const covered = (p) => {
      for (let i = p.lastIndexOf("/"); i > root.length; i = p.lastIndexOf("/", i - 1)) {
        if (handled.has(p.slice(0, i))) return true;
      }
      return false;
    };
    for (let path5 of paths) {
      if (!this.isCurrent(mount.id, token)) return;
      if (!path5.startsWith(root + "/")) continue;
      for (let parent = path5.slice(0, path5.lastIndexOf("/")); parent.length > root.length && !this.index.get(parent); parent = parent.slice(0, parent.lastIndexOf("/"))) {
        path5 = parent;
      }
      if (handled.has(path5) || covered(path5)) continue;
      handled.add(path5);
      await syncPath(path5, deps, { maxItems: mount.maxFiles ?? 0 });
    }
  }
  /** Manual "rescan": re-probe, re-index, restart watching. */
  async rescanMount(mount) {
    if (!mount.enabled) return;
    if (!this.sessions.has(mount.id) || this.syncProblem(mount)) {
      await this.activateMount(mount, true);
      return;
    }
    await this.enqueue(mount, async (token) => {
      const probe = await this.probeMount(mount);
      if (!this.isCurrent(mount.id, token)) return;
      this.applyProbe(mount, probe);
      if (!probe.reachable) {
        new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" is still not reachable.`);
        return;
      }
      if (!this.watcher.isWatching(mount.id)) this.watcher.start(mount);
      await this.syncMount(mount, token, true);
    });
  }
  async runHealthChecks() {
    if (document.hidden || this.unloaded) return;
    for (const mount of this.settings.mountPoints.filter((m) => m.enabled && this.sessions.has(m.id))) {
      if (this.probesInFlight.has(mount.id)) continue;
      this.probesInFlight.add(mount.id);
      const token = this.sessions.get(mount.id);
      void (async () => {
        try {
          const before = this.health.get(mount.id);
          const pathBefore = this.pathMapper.getEffectiveRealPath(mount);
          const probe = await this.probeMount(mount);
          if (!this.stillCurrent(mount, token)) return;
          this.applyProbe(mount, probe);
          if (!probe.reachable) {
            if (before === "ok") {
              this.watcher.stop(mount.id);
              new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" went offline. Its files stay listed but cannot be opened until it reconnects.`, 8e3);
            }
            return;
          }
          const pathChanged = this.pathMapper.getEffectiveRealPath(mount) !== pathBefore;
          if (before === "unreachable" || pathChanged) {
            if (before === "unreachable") new import_obsidian11.Notice(`Folder Bridge: "${this.displayName(mount)}" is back online.`, 4e3);
            if (pathChanged) this.watcher.stop(mount.id);
            if (!this.watcher.isWatching(mount.id)) this.watcher.start(mount);
            await this.enqueue(mount, (t) => this.syncMount(mount, t, false));
          } else if ((mount.watchMode ?? "native") !== "off" && !this.watcher.isWatching(mount.id)) {
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
  async vaultFolderClash(virtualPath) {
    const original = this.originalAdapter ?? this.app.vault.adapter;
    const n = (0, import_obsidian11.normalizePath)(virtualPath);
    if (await original.exists(n)) {
      return `"${n}" already exists in the vault. Choose a new vault folder name; the mount creates it.`;
    }
    const segments = n.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if ((await original.stat(ancestor))?.type === "file") return `"${ancestor}" is a file in the vault, so it cannot hold a mount.`;
    }
    return null;
  }
  /**
   * Re-check the folder after Windows resolves it: 8.3 short names
   * (C:\PROGRA~1), junctions and subst drives can make an innocent-looking
   * path land in a protected folder or inside the vault.
   */
  async resolvedPathError(data, others) {
    for (const candidate of [data.realPath, data.fallbackRealPath]) {
      if (!candidate?.trim()) continue;
      let resolved;
      try {
        const native = new Promise((resolve, reject) => fs4.realpath.native(candidate.trim(), (e, r) => e ? reject(e) : resolve(r)));
        resolved = await withTimeout(native, 5e3, () => candidate.trim());
      } catch {
        continue;
      }
      if (resolved === candidate.trim()) continue;
      const error = this.security.validateMount({ ...data, realPath: resolved, fallbackRealPath: void 0 }, others, this.vaultBasePath());
      if (error) return `${error} ("${candidate.trim()}" resolves to "${resolved}".)`;
    }
    return null;
  }
  /**
   * Remove now-hidden entries (stricter ignore rules or file-type filter)
   * straight from Obsidian's tree: no disk or network access needed.
   */
  async pruneHidden(mount) {
    const root = this.index.get((0, import_obsidian11.normalizePath)(mount.virtualPath));
    if (!(root instanceof import_obsidian11.TFolder)) return;
    const doomed = [];
    const walk = (folder) => {
      for (const child of folder.children) {
        const rel = this.pathMapper.getMountRelativePath(child.path, mount) ?? "";
        if (this.ignore.isIgnored(child.name, mount, rel) || child instanceof import_obsidian11.TFile && !isVisibleFileInMount(child.path, mount)) {
          doomed.push(child.path);
        } else if (child instanceof import_obsidian11.TFolder) {
          walk(child);
        }
      }
    };
    walk(root);
    for (const p of doomed) await this.index.removeTree(p);
    if (doomed.length) this.scheduleSnapshotSave(5e3);
  }
  /** Returns an error message, or null when the mount was added. */
  async addMount(data) {
    const error = this.security.validateMount(data, this.settings.mountPoints, this.vaultBasePath()) ?? await this.vaultFolderClash(data.virtualPath) ?? await this.resolvedPathError(data, this.settings.mountPoints);
    if (error) return error;
    const mount = { ...data, id: generateId() };
    for (const warning of this.security.getPathWarnings(mount.realPath, this.settings.mountPoints)) {
      new import_obsidian11.Notice(`Folder Bridge: ${warning}`, 1e4);
    }
    this.settings.mountPoints.push(mount);
    await this.saveSettings();
    this.applyMountState();
    if (mount.enabled) void this.activateMount(mount, true);
    return null;
  }
  /** Returns an error message, or null when the mount was updated. */
  async updateMount(id, data) {
    const idx = this.settings.mountPoints.findIndex((m) => m.id === id);
    if (idx === -1) return "This mount no longer exists.";
    const old = this.settings.mountPoints[idx];
    const others = this.settings.mountPoints.filter((m) => m.id !== id);
    const virtualMoved = (0, import_obsidian11.normalizePath)(old.virtualPath) !== (0, import_obsidian11.normalizePath)(data.virtualPath);
    const realChanged = normalizeForComparison(old.realPath) !== normalizeForComparison(data.realPath) || (old.fallbackRealPath ?? "") !== (data.fallbackRealPath ?? "");
    const error = this.security.validateMount(data, others, this.vaultBasePath()) ?? (virtualMoved || !old.enabled && data.enabled ? await this.vaultFolderClash(data.virtualPath) : null) ?? (realChanged ? await this.resolvedPathError(data, others) : null);
    if (error) return error;
    const updated = { ...data, id };
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const rulesChanged = !same(old.ignoreList, updated.ignoreList) || old.visibleFileFilter !== updated.visibleFileFilter || (old.maxFiles ?? 0) !== (updated.maxFiles ?? 0);
    const loosened = IgnoreRules.loosened(old, updated);
    const watchChanged = old.watchMode !== updated.watchMode || old.watcherPollingIntervalMs !== updated.watcherPollingIntervalMs || old.watcherDebounceMs !== updated.watcherDebounceMs;
    const live = old.enabled && updated.enabled && this.sessions.has(id);
    if (live && virtualMoved && !realChanged) {
      this.watcher.stop(id);
      this.sessions.set(id, Symbol(id));
      this.settings.mountPoints[idx] = updated;
      await this.saveSettings();
      this.applyMountState();
      this.index.renameTree((0, import_obsidian11.normalizePath)(old.virtualPath), (0, import_obsidian11.normalizePath)(updated.virtualPath));
      await this.index.pruneEmptyParents(old.virtualPath, (p) => (this.originalAdapter ?? this.app.vault.adapter).exists(p));
      if (rulesChanged) await this.pruneHidden(updated);
      if (loosened) void this.enqueue(updated, (t) => this.syncMount(updated, t, false));
      if (this.health.get(id) === "ok") this.watcher.start(updated);
      this.scheduleSnapshotSave(5e3);
      return null;
    }
    const remount = virtualMoved || realChanged || old.enabled !== updated.enabled;
    if (old.enabled && remount) await this.deactivateMount(old);
    this.settings.mountPoints[idx] = updated;
    await this.saveSettings();
    this.applyMountState();
    if (old.readOnly !== updated.readOnly) this.app.vault.adapter.clearReadOnlyNotice?.(id);
    if (!updated.enabled) return null;
    if (remount) {
      void this.activateMount(updated, true);
      return null;
    }
    if (rulesChanged) {
      await this.pruneHidden(updated);
      if (loosened) void this.enqueue(updated, (t) => this.syncMount(updated, t, false));
    }
    if ((watchChanged || rulesChanged) && this.health.get(id) === "ok" && this.sessions.has(id)) this.watcher.start(updated);
    return null;
  }
  async setMountEnabled(id, enabled) {
    const mount = this.settings.mountPoints.find((m) => m.id === id);
    if (!mount || mount.enabled === enabled) return;
    const error = await this.updateMount(id, { ...mount, enabled });
    if (error) new import_obsidian11.Notice(`Folder Bridge: ${error}`);
  }
  async removeMount(id) {
    const mount = this.settings.mountPoints.find((m) => m.id === id);
    if (!mount) return;
    if (mount.enabled) await this.deactivateMount(mount);
    this.settings.mountPoints = this.settings.mountPoints.filter((m) => m.id !== id);
    await this.saveSettings();
    this.applyMountState();
    new import_obsidian11.Notice(`Folder Bridge: Removed "${this.displayName(mount)}". No files were deleted.`);
  }
  /** Apply edited global ignore patterns to every active mount. */
  async setGlobalIgnorePatterns(patterns) {
    const loosened = IgnoreRules.patternsRemoved(this.settings.globalIgnorePatterns, patterns);
    this.settings.globalIgnorePatterns = patterns;
    await this.saveSettings();
    this.applyMountState();
    for (const mount of this.settings.mountPoints.filter((m) => m.enabled && this.sessions.has(m.id))) {
      await this.pruneHidden(mount);
      if (loosened) void this.enqueue(mount, (token) => this.syncMount(mount, token, false));
    }
  }
  openMountModal(existing, defaults) {
    new MountModal(this.app, this, existing, defaults).open();
  }
  // ------------------------------------------------------------------
  // Commands and menus
  // ------------------------------------------------------------------
  pickMount(placeholder, describe, onChoose) {
    const mounts = this.settings.mountPoints;
    if (mounts.length === 0) {
      new import_obsidian11.Notice("Folder Bridge: no mounts configured.");
      return;
    }
    const modal = new class extends import_obsidian11.FuzzySuggestModal {
      getItems() {
        return mounts;
      }
      getItemText(m) {
        return describe(m);
      }
      onChooseItem(m) {
        onChoose(m);
      }
    }(this.app);
    modal.setPlaceholder(placeholder);
    modal.open();
  }
  registerCommands() {
    this.addCommand({ id: "add-mount", name: "Add mount", callback: () => this.openMountModal() });
    this.addCommand({
      id: "rescan-all",
      name: "Rescan all mounts",
      callback: () => {
        for (const m of this.settings.mountPoints.filter((x) => x.enabled)) void this.rescanMount(m);
      }
    });
    this.addCommand({
      id: "toggle-mount",
      name: "Turn a mount on or off",
      callback: () => this.pickMount(
        "Choose a mount to turn on or off",
        (m) => `${m.enabled ? "On" : "Off"} \xB7 ${this.displayName(m)}`,
        (m) => void this.setMountEnabled(m.id, !m.enabled)
      )
    });
    this.addCommand({
      id: "toggle-readonly",
      name: "Make a mount read-only or writable",
      callback: () => this.pickMount(
        "Choose a mount",
        (m) => `${m.readOnly ? "Read-only" : "Writable"} \xB7 ${this.displayName(m)}`,
        (m) => void this.updateMount(m.id, { ...m, readOnly: !m.readOnly }).then((error) => {
          new import_obsidian11.Notice(error ? `Folder Bridge: ${error}` : `Folder Bridge: "${this.displayName(m)}" is now ${m.readOnly ? "writable" : "read-only"}.`);
        })
      )
    });
  }
  registerFileMenu() {
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      const mount = this.pathMapper.getMountForPath(file.path);
      if (!mount) {
        if (file instanceof import_obsidian11.TFolder && !this.pathMapper.hasMountsUnder(file.path)) {
          menu.addItem((item) => item.setTitle("Mount external folder here\u2026").setIcon("folder-plus").onClick(() => {
            let candidate = (0, import_obsidian11.normalizePath)(`${file.isRoot() ? "" : file.path + "/"}External`);
            for (let n = 2; this.app.vault.getAbstractFileByPath(candidate); n++) {
              candidate = (0, import_obsidian11.normalizePath)(`${file.isRoot() ? "" : file.path + "/"}External ${n}`);
            }
            this.openMountModal(void 0, { virtualPath: candidate });
          }));
        }
        return;
      }
      const rel = this.pathMapper.getMountRelativePath(file.path, mount);
      if (rel === "") {
        menu.addItem((item) => item.setTitle("Rescan mount").setIcon("refresh-cw").onClick(() => void this.rescanMount(mount)));
        menu.addItem((item) => item.setTitle("Edit mount\u2026").setIcon("settings").onClick(() => this.openMountModal(mount)));
        menu.addItem((item) => item.setTitle("Unmount\u2026").setIcon("unlink").onClick(() => void this.confirmUnmount(mount)));
        return;
      }
      if (rel === void 0) return;
      menu.addItem((item) => item.setTitle(`Hide "${file.name}" from this mount`).setIcon("eye-off").onClick(() => void (async () => {
        const pattern = "/" + rel;
        const ignoreList = [...mount.ignoreList ?? []];
        if (!ignoreList.includes(pattern)) ignoreList.push(pattern);
        const error = await this.updateMount(mount.id, { ...mount, ignoreList });
        new import_obsidian11.Notice(error ? `Folder Bridge: ${error}` : `Folder Bridge: Hid "${pattern}". Undo in the mount's ignore list.`);
      })()));
    }));
  }
  // ------------------------------------------------------------------
  // Status bar and explorer markers
  // ------------------------------------------------------------------
  createStatusBar() {
    if (this.statusBarEl) return;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.addEventListener("click", () => {
      const setting = this.app.setting;
      setting?.open();
      setting?.openTabById(this.manifest.id);
    });
    this.updateStatusBar();
  }
  removeStatusBar() {
    this.statusBarEl?.remove();
    this.statusBarEl = null;
  }
  updateStatusBar() {
    const el = this.statusBarEl;
    if (!el || !this.settings) return;
    const enabled = this.settings.mountPoints.filter((m) => m.enabled);
    const unreachable = enabled.filter((m) => this.health.get(m.id) === "unreachable").length;
    el.toggleClass("folderbridge-status-warning", unreachable > 0);
    if (this.scanning.size > 0) el.setText(`Folder Bridge: scanning ${this.scanning.size}\u2026`);
    else if (unreachable > 0) el.setText(`Folder Bridge: ${unreachable} offline`);
    else el.setText(`Folder Bridge: ${enabled.length} mount${enabled.length === 1 ? "" : "s"}`);
    el.setAttribute("aria-label", "Open Folder Bridge settings");
  }
  /**
   * Mark mount root folders in the file explorer. A MutationObserver plus a
   * handful of attribute lookups (one per mount) per animation frame: the
   * explorer only renders visible rows, so this stays cheap however many
   * files the mounts hold.
   */
  setupExplorerMarkers() {
    const attach = () => {
      const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
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
    this.registerEvent(this.app.workspace.on("layout-change", attach));
  }
  scheduleExplorerMarkers() {
    if (this.explorerRaf !== null || !this.observedExplorerEl) return;
    this.explorerRaf = requestAnimationFrame(() => {
      this.explorerRaf = null;
      this.applyExplorerMarkers();
    });
  }
  applyExplorerMarkers() {
    const root = this.observedExplorerEl;
    if (!root) return;
    const wanted = /* @__PURE__ */ new Map();
    for (const m of this.settings.mountPoints) if (m.enabled) wanted.set((0, import_obsidian11.normalizePath)(m.virtualPath), m);
    root.querySelectorAll(".nav-folder-title[data-folder-bridge]").forEach((el) => {
      if (wanted.has(el.dataset.path ?? "")) return;
      el.removeAttribute("data-folder-bridge");
      el.removeAttribute("aria-label");
    });
    for (const [virtualPath, mount] of wanted) {
      const el = root.querySelector(`.nav-folder-title[data-path="${CSS.escape(virtualPath)}"]`);
      if (!el) continue;
      const state = this.health.get(mount.id) === "unreachable" ? "offline" : "mounted";
      if (el.dataset.folderBridge !== state) el.dataset.folderBridge = state;
      const tip = `${state === "offline" ? "Offline \xB7 " : ""}${stripLongPathPrefix(this.pathMapper.getEffectiveRealPath(mount))}`;
      if (el.getAttribute("aria-label") !== tip) el.setAttribute("aria-label", tip);
    }
  }
};
