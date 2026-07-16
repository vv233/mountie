# Mountie

An open-source RaiDrive alternative — a modern GUI that mounts cloud storage and
remote protocols (WebDAV, SFTP, FTP, S3, …) as Windows drive letters, and moves
data at full speed. Powered by [rclone](https://github.com/rclone/rclone).

> **Architecture: rclone as the engine, Tauri as the shell.** All mounting and
> transfer work is delegated to the mature, battle-tested rclone; Mountie focuses
> on making it usable without touching the command line.

## Why

rclone (70+ backends) and [WinFsp](https://winfsp.dev/) already cover everything
RaiDrive does under the hood. RaiDrive's value is its ease of use — Mountie
recreates that, in the open:

- **Fast** — the UI is [Tauri](https://tauri.app/) (Rust + web), a few MB with
  native performance; transfers ride rclone's multi-threaded engine and VFS cache.
- **Convenient** — configure remotes in a form, pick a drive letter, mount in one
  click. No CLI required.
- **Performance presets** — *Fast / Balanced / Low-memory* apply a coherent set of
  rclone VFS cache, chunk and read-ahead options behind a single choice.

## Features

- **Remote management** — add/remove WebDAV, SFTP, FTP and S3 remotes; passwords
  are obscured by rclone, never stored in plain text.
- **One-click mount** with a drive letter and a performance preset; mounts are
  presented as network drives with a friendly volume label.
- **Mount persistence** — mounted drives are remembered and automatically restored
  on the next launch.
- **System tray** — closing the window hides to the tray so mounts stay available;
  quit from the tray menu.
- **Launch at login** — optional autostart toggle.
- **Direct transfer / sync panel** — run `rclone copy` / `sync` between a remote and
  a local folder (or two remotes) with live progress, speed and ETA. This bypasses
  the mount layer and saturates the connection — much faster than dragging large
  files through a mounted drive.
- **Friendly errors** — common mount failures (missing WinFsp, drive-letter in use,
  connection/auth problems) are surfaced as actionable messages.
- **WinFsp detection** — guides installation when the required driver is missing.

## Roadmap

- [ ] OAuth backends (Google Drive / OneDrive / Dropbox)
- [ ] Visual tuning of performance presets
- [ ] Signed installers + GitHub Releases
- [ ] Cross-platform (macOS / Linux)

## Tech stack

| Layer | Choice |
|---|---|
| Mount / transfer engine | rclone, bundled as a Tauri sidecar |
| Windows filesystem | WinFsp |
| GUI | Tauri v2 + React + TypeScript + Vite |
| Integration | the GUI drives a loopback-only `rclone rcd` daemon over its RC HTTP API |

## Development

Prerequisites: [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/), and
[WinFsp](https://winfsp.dev/rel/) (needed at runtime to mount).

```powershell
# 1. Install frontend dependencies
npm install

# 2. Fetch the rclone binary into the sidecar location (binaries/ is gitignored)
pwsh scripts/fetch-rclone.ps1

# 3. Run in development
npm run tauri dev
```

Build installers:

```powershell
npm run tauri build
```

### Windows + OneDrive / antivirus note

If the repository lives in a OneDrive-synced folder, or a real-time antivirus
(e.g. Avira) locks freshly-compiled build scripts, cargo can fail with
`Access denied (os error 5)`. Two mitigations:

- A gitignored `.cargo/config.toml` redirects the build output directory outside
  OneDrive (delete it if you clone to a non-synced location).
- Add the cargo target directory and `~/.cargo` to your antivirus real-time
  exclusions, or pause real-time protection for the first full build.

## Security

The `rclone rcd` daemon binds to `127.0.0.1` only and uses a randomly generated
credential per launch, so it is not reachable off-host.

## License

[MIT](./LICENSE). Mountie invokes rclone (MIT) via its command line / API and does
not modify rclone's source.
