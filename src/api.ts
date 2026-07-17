// Typed bridge to the Rust backend (which in turn drives rclone via its RC API).
import { invoke } from "@tauri-apps/api/core";

export interface RemoteInfo {
  name: string;
  type: string;
}

export interface MountInfo {
  fs: string;
  mount_point: string;
}

/** Storage quota; fields are null for backends that don't report it. */
export interface AboutInfo {
  total: number | null;
  used: number | null;
  free: number | null;
}

export interface CoreStats {
  bytes?: number;
  speed?: number; // bytes/sec
  transfers?: number;
  checks?: number;
  errors?: number;
  transferring?: unknown[];
}

export interface TransferStatus {
  finished: boolean;
  success: boolean;
  error: string;
  bytes: number;
  total_bytes: number;
  speed: number;
  eta: number | null;
  transferring: { name: string; percentage?: number; speed?: number; bytes?: number; size?: number }[];
}

export type TransferOp = "copy" | "sync";

export type Preset = "fast" | "balanced" | "lowmem";

export const PRESETS: { id: Preset; labelKey: string; hintKey: string }[] = [
  { id: "fast", labelKey: "preset.fast", hintKey: "preset.fast.hint" },
  { id: "balanced", labelKey: "preset.balanced", hintKey: "preset.balanced.hint" },
  { id: "lowmem", labelKey: "preset.lowmem", hintKey: "preset.lowmem.hint" },
];

/// The VFS options each preset maps to — shown in the mount form's advanced
/// panel and used as the editable defaults when tuning.
export interface VfsOptions {
  cacheMode: string;
  chunkSize: string;
  readAhead: string;
  dirCacheTime: string;
}

export const PRESET_DEFAULTS: Record<Preset, VfsOptions> = {
  fast: { cacheMode: "full", chunkSize: "128M", readAhead: "128M", dirCacheTime: "5m0s" },
  balanced: { cacheMode: "writes", chunkSize: "64M", readAhead: "0", dirCacheTime: "1m0s" },
  lowmem: { cacheMode: "off", chunkSize: "0", readAhead: "0", dirCacheTime: "30s" },
};

export const CACHE_MODES = ["off", "minimal", "writes", "full"];

// ---------------------------------------------------------------------------
// Backend catalog — which remote types the "Add remote" form knows how to fill.
// OAuth-based backends (Google Drive, OneDrive, Dropbox) need an interactive
// browser flow and are intentionally deferred to a later milestone.
// ---------------------------------------------------------------------------

export interface BackendField {
  key: string;
  labelKey: string;
  password?: boolean;
  placeholder?: string;
  required?: boolean;
}

export type BackendGroup = "protocol" | "nas" | "cloud";

export interface BackendDef {
  id: string; // unique UI id
  labelKey: string;
  type: string; // rclone backend type
  group: BackendGroup;
  defaults?: Record<string, string>; // params always applied for this service
  noteKey?: string; // optional setup guidance shown in the form
  fields: BackendField[];
}

// Credential fields shared by the WebDAV-based NAS services.
const WEBDAV_LOGIN: BackendField[] = [
  { key: "user", labelKey: "field.user" },
  { key: "pass", labelKey: "field.pass", password: true },
];

export const BACKENDS: BackendDef[] = [
  // --- Standard protocols ---
  {
    id: "webdav",
    labelKey: "backend.webdav",
    type: "webdav",
    group: "protocol",
    fields: [
      { key: "url", labelKey: "field.url", placeholder: "https://dav.example.com/remote.php/dav", required: true },
      { key: "vendor", labelKey: "field.vendor", placeholder: "nextcloud / owncloud / other" },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "sftp",
    labelKey: "backend.sftp",
    type: "sftp",
    group: "protocol",
    fields: [
      { key: "host", labelKey: "field.host", placeholder: "example.com", required: true },
      { key: "port", labelKey: "field.port", placeholder: "22" },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "ftp",
    labelKey: "backend.ftp",
    type: "ftp",
    group: "protocol",
    fields: [
      { key: "host", labelKey: "field.host", placeholder: "example.com", required: true },
      { key: "port", labelKey: "field.port", placeholder: "21" },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "s3",
    labelKey: "backend.s3",
    type: "s3",
    group: "protocol",
    fields: [
      { key: "provider", labelKey: "field.provider", placeholder: "AWS / Minio / Cloudflare / Other" },
      { key: "access_key_id", labelKey: "field.accessKey" },
      { key: "secret_access_key", labelKey: "field.secretKey", password: true },
      { key: "endpoint", labelKey: "field.endpoint", placeholder: "https://s3.example.com" },
      { key: "region", labelKey: "field.region", placeholder: "us-east-1" },
    ],
  },
  // --- NAS / services (all WebDAV under the hood) ---
  {
    id: "nextcloud",
    labelKey: "backend.nextcloud",
    type: "webdav",
    group: "nas",
    defaults: { vendor: "nextcloud" },
    noteKey: "note.nextcloud",
    fields: [
      { key: "url", labelKey: "field.url", placeholder: "https://your-domain/remote.php/dav", required: true },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "synology",
    labelKey: "backend.synology",
    type: "webdav",
    group: "nas",
    defaults: { vendor: "other" },
    noteKey: "note.synology",
    fields: [
      { key: "url", labelKey: "field.url", placeholder: "https://NAS-IP:5006", required: true },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "qnap",
    labelKey: "backend.qnap",
    type: "webdav",
    group: "nas",
    defaults: { vendor: "other" },
    noteKey: "note.qnap",
    fields: [
      { key: "url", labelKey: "field.url", placeholder: "https://NAS-IP:port", required: true },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "iptime",
    labelKey: "backend.iptime",
    type: "webdav",
    group: "nas",
    defaults: { vendor: "other" },
    noteKey: "note.iptime",
    fields: [
      { key: "url", labelKey: "field.url", placeholder: "https://NAS-IP:port", required: true },
      ...WEBDAV_LOGIN,
    ],
  },
  {
    id: "asustor",
    labelKey: "backend.asustor",
    type: "webdav",
    group: "nas",
    defaults: { vendor: "other" },
    noteKey: "note.asustor",
    fields: [
      { key: "url", labelKey: "field.url", placeholder: "https://NAS-IP:port", required: true },
      ...WEBDAV_LOGIN,
    ],
  },
  // --- Cloud storage (key/credential based) ---
  {
    id: "b2",
    labelKey: "backend.b2",
    type: "b2",
    group: "cloud",
    fields: [
      { key: "account", labelKey: "field.account", required: true },
      { key: "key", labelKey: "field.key", password: true, required: true },
    ],
  },
  {
    id: "mega",
    labelKey: "backend.mega",
    type: "mega",
    group: "cloud",
    fields: [
      { key: "user", labelKey: "field.user", required: true },
      { key: "pass", labelKey: "field.pass", password: true, required: true },
    ],
  },
];

// OAuth backends use an interactive browser flow (rclone authorize) instead of
// a credential form.
export const OAUTH_BACKENDS: { id: string; labelKey: string }[] = [
  { id: "drive", labelKey: "backend.drive" },
  { id: "onedrive", labelKey: "backend.onedrive" },
  { id: "dropbox", labelKey: "backend.dropbox" },
  { id: "pcloud", labelKey: "backend.pcloud" },
  { id: "box", labelKey: "backend.box" },
];

export const isOAuthBackend = (id: string) => OAUTH_BACKENDS.some((b) => b.id === id);

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

export const api = {
  rcloneReady: () => invoke<boolean>("rclone_ready"),
  winfspInstalled: () => invoke<boolean>("winfsp_installed"),
  listRemotes: () => invoke<RemoteInfo[]>("list_remotes"),
  createRemote: (name: string, kind: string, params: Record<string, string>) =>
    invoke<void>("create_remote", { name, kind, params }),
  oauthAuthorize: (kind: string) => invoke<string>("oauth_authorize", { kind }),
  testRemote: (kind: string, params: Record<string, string>) =>
    invoke<number>("test_remote", { kind, params }),
  getRemoteConfig: (name: string) => invoke<Record<string, string>>("get_remote_config", { name }),
  updateRemote: (name: string, params: Record<string, string>) =>
    invoke<void>("update_remote", { name, params }),
  deleteRemote: (name: string) => invoke<void>("delete_remote", { name }),
  listMounts: () => invoke<MountInfo[]>("list_mounts"),
  mountRemote: (remote: string, drive: string, preset: Preset, custom?: VfsOptions | null) =>
    invoke<void>("mount_remote", { remote, drive, preset, custom: custom ?? null }),
  unmount: (mountPoint: string) => invoke<void>("unmount", { mountPoint }),
  coreStats: () => invoke<CoreStats>("core_stats"),
  remoteAbout: (remote: string) => invoke<AboutInfo>("remote_about", { remote }),
  getLogs: () => invoke<string[]>("get_logs"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  startTransfer: (src: string, dst: string, operation: TransferOp, turbo: boolean, bwlimit: string) =>
    invoke<number>("start_transfer", { src, dst, operation, turbo, bwlimit }),
  transferStatus: (jobid: number) => invoke<TransferStatus>("transfer_status", { jobid }),
  stopTransfer: (jobid: number) => invoke<void>("stop_transfer", { jobid }),
  listDir: (fs: string, path: string) => invoke<string[]>("list_dir", { fs, path }),
};

export function formatBytes(n?: number): string {
  const b = n ?? 0;
  if (b < 1024) return `${b.toFixed(0)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatSpeed(bytesPerSec?: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds?: number | null): string {
  if (seconds == null || seconds < 0 || !isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
