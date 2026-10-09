# Folder Bridge Local

Show folders from your PC, mapped drives (`Z:\Finance\Reports`) and Windows network shares (`\\server\share\Reports`) inside a small Obsidian vault.

Obsidian has no way to exclude folders from a vault. If the vault is a whole department share, Obsidian walks every file on it at startup, and on a large network drive that can stop it from loading at all. With this plugin the vault stays small, and only the folders you actually use are brought in. Everything else on the share is never scanned.

This is a trimmed fork of [Folder Bridge](https://github.com/tescolopio/Obsidian_FolderBridge) by Timmothy Escolopio. It keeps local and network folders only, and runs on desktop only. It is built for Windows 10 and 11, and also works on macOS and Linux with local folders and mounted shares (`/Volumes/…`, `/mnt/…`).

## Install

Obsidian 1.5 or newer, desktop.

1. In your vault, open the folder `.obsidian\plugins\` (turn on hidden items in File Explorer if you can't see `.obsidian`; on a Mac, press Cmd+Shift+. in Finder).
2. Create a folder named `folder-bridge-local` inside it.
3. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/grub-basket/Folder-Bridge-Local/releases/latest) and copy them into that folder.
4. In Obsidian, open **Settings → Community plugins**, turn on community plugins if asked, then turn on **Folder Bridge Local**.

## Setting it up for a big shared drive

1. **Make a small vault.** For example `Z:\Finance\_Obsidian`, or a folder on your own PC. Keep the vault itself small: notes, `.base` files and templates only.
2. **Mount the folders you need.** Use **Settings → Folder Bridge Local → Add mount**, or right-click a folder in the file explorer and choose **Mount external folder here…**.
   - **Real folder:** the folder on the drive, such as `Z:\Finance\Reports`.
   - **Vault folder:** where it appears in the vault, such as `Reports`.
3. **Keep your old paths.** If your Bases, links or templates used to point at `Reports/…` when the whole drive was the vault, mount the folder at that same vault path and they keep working.
4. **Hide what you don't need.** Each mount has an ignore list. Hidden folders are never read, so ignoring `Archive` or `2019` keeps scans fast.
5. **Use read-only for folders you only report from.** Obsidian then can't change, rename or delete anything there.

The mount folder is created by the plugin. Choose a vault folder name that doesn't exist yet.

## What each setting does

| Setting | What it does |
| --- | --- |
| Real folder | The folder to show. A drive path or a `\\server\share` path. |
| Vault folder | Where it appears in the vault. |
| Read-only | Blocks every change from Obsidian. |
| File types | All files, Markdown and canvas only, or PDF only. Markdown only is fastest on big shares. |
| Ignore | One per line. A name hides it anywhere (`Archive`). A path from the mount root hides just that item (`/Archive`, `2019/Old`). `*` is a wildcard (`*.bak`). |
| Fallback path | Tried when the real folder can't be reached. Use the `\\server\share` form of a mapped drive so the mount works on a PC where the letter differs. |
| Change detection | **Live** (default) uses one Windows change notification per mount. **Check periodically** rescans on a timer, for shares that never report changes. **Off** only updates when you rescan. |
| Max items | Stops indexing a mount after this many files and folders. A safety net. |

Settings for every mount:

- **Ignore in every mount:** defaults hide `Thumbs.db`, `desktop.ini`, Office lock files (`~$…`) and Recycle Bin folders. Names starting with a dot (`.git`, `.ssh`) are always hidden, as in a normal vault.
- **When a mount folder is deleted in Obsidian:** ask first, or unmount without asking. Either way it only unmounts.

Always hidden, whatever the settings: program and shortcut files (`.exe`, `.bat`, `.cmd`, `.lnk`, `.url`, `.ps1`, `.vbs`, `.js`, `.msi`, …), so a file someone drops on the share can't be launched from a note.

## Good to know

- **Deleting files.** Files and folders you delete from a mount are moved into a `.folderbridge-trash` folder at the top of that mount on the share, named with the date and time. Nothing is copied into the vault, and nothing is deleted for good. Empty that folder in File Explorer when you want the space back. If Obsidian's **Deleted files** setting is **Permanently delete**, deletes are permanent, but Obsidian refuses to permanently delete a folder that contains files it isn't showing you (for example spreadsheets in a "Markdown only" mount).
- **Deleting a mount's own folder** in Obsidian only unmounts it. To delete the real folder, use File Explorer.
- **Someone else changed a note at the same time.** If a note changed on the share since Obsidian last saw it, saving keeps the other version as "… (changed by someone else …)" in `.folderbridge-trash` before writing yours.
- **Offline drives.** If a drive disconnects, its files stay listed but can't be opened. The plugin checks every 30 seconds and reconnects by itself. The status bar shows how many mounts are offline.
- **Startup.** The plugin remembers each mount's file list, so Obsidian doesn't re-read every note at launch. After startup it checks the drive for changes made while Obsidian was closed. The list is stored on your PC, in Obsidian's own app data folder, not in the vault.
- **Moving files between a mount and the rest of the vault** isn't supported. Copy them instead.
- **OneDrive / SharePoint "online-only" files** have to be downloaded first. Right-click them in File Explorer and choose **Always keep on this device**.
- **The same folder mounted twice** shows its files twice, including in Bases. The plugin warns you when that happens.
- **System folders** such as `C:\Windows`, `C:\Program Files` and `C:\ProgramData` can't be mounted, and neither can the vault's own folder.

## Security note for shared vaults

Anyone who can change files in the vault's `.obsidian` folder can change this plugin (and every other plugin) and run code as you. If the vault sits on a shared drive, make sure only you can write to its `.obsidian` folder, or keep the vault on your own PC and only mount the shared folders.

## Commands

- Add mount
- Rescan all mounts
- Turn a mount on or off
- Make a mount read-only or writable

Right-click a mount's folder for **Rescan mount** and **Edit mount…**. Right-click anything inside a mount for **Hide from this mount**.

## Credits and license

MIT. Based on Folder Bridge © 2026 Tim Escolopio. See `LICENSE`.
