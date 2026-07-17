# Contributing to Mountie

Thanks for your interest! Mountie is a Tauri (Rust + React/TypeScript) GUI that
wraps [rclone](https://github.com/rclone/rclone). Contributions of all sizes are
welcome.

## Getting set up

Prerequisites: [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/), and
[WinFsp](https://winfsp.dev/rel/) (to actually mount on Windows).

```powershell
npm install
pwsh scripts/fetch-rclone.ps1   # download the bundled rclone sidecar
                                # macOS/Linux: bash scripts/fetch-rclone.sh
npm run tauri dev
```

If you build inside a OneDrive folder or with an aggressive antivirus, see the
"Windows + OneDrive / antivirus note" in the [README](./README.md).

## Before opening a PR

Please make sure the checks that CI runs pass locally:

```powershell
npm test                                    # frontend unit tests (vitest)
npx tsc --noEmit                            # type-check
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

## Guidelines

- **Match the surrounding style.** The Rust lives in `src-tauri/src/`, the UI in
  `src/`. Keep comments purposeful, not noisy.
- **User-facing strings must be i18n keys.** Add both `zh` and `en` entries in
  `src/i18n.tsx`; never hard-code display text in components.
- **The backend is a thin bridge to rclone's RC API.** Prefer driving rclone over
  reimplementing behavior. New commands go in `src-tauri/src/rclone.rs` and are
  registered in `src-tauri/src/lib.rs`.
- **Add a test** for pure logic where practical (Rust in the module's `tests`
  submodule, frontend in a `*.test.ts` file).

## Adding a backend

Most backends are just data: add an entry to `BACKENDS` (or `OAUTH_BACKENDS`) in
`src/api.ts` with its rclone `type`, fields, and i18n label keys. WebDAV-based NAS
devices are presets over the `webdav` type with a `defaults.vendor`.

## Reporting bugs

Open an issue with your OS version, Mountie version, the backend type, and the
relevant lines from the in-app **Logs** tab.
