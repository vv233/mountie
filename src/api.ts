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

export interface CoreStats {
  bytes?: number;
  speed?: number; // bytes/sec
  transfers?: number;
  checks?: number;
  errors?: number;
  transferring?: unknown[];
}

export type Preset = "fast" | "balanced" | "lowmem";

export const PRESETS: { id: Preset; label: string; hint: string }[] = [
  { id: "fast", label: "极速模式", hint: "全量缓存 + 大块预读,读写最流畅(占用磁盘/内存较多)" },
  { id: "balanced", label: "均衡", hint: "写缓存 + 中等分块,速度与占用平衡(默认)" },
  { id: "lowmem", label: "省内存", hint: "不做读缓存,占用最小(随机写较慢)" },
];

// ---------------------------------------------------------------------------
// Backend catalog — which remote types the "Add remote" form knows how to fill.
// OAuth-based backends (Google Drive, OneDrive, Dropbox) need an interactive
// browser flow and are intentionally deferred to a later milestone.
// ---------------------------------------------------------------------------

export interface BackendField {
  key: string;
  label: string;
  password?: boolean;
  placeholder?: string;
  required?: boolean;
}

export interface BackendDef {
  id: string; // rclone backend type
  label: string;
  fields: BackendField[];
}

export const BACKENDS: BackendDef[] = [
  {
    id: "webdav",
    label: "WebDAV",
    fields: [
      { key: "url", label: "服务器地址 URL", placeholder: "https://dav.example.com/remote.php/dav", required: true },
      { key: "vendor", label: "厂商 vendor", placeholder: "nextcloud / owncloud / other" },
      { key: "user", label: "用户名" },
      { key: "pass", label: "密码", password: true },
    ],
  },
  {
    id: "sftp",
    label: "SFTP",
    fields: [
      { key: "host", label: "主机", placeholder: "example.com", required: true },
      { key: "port", label: "端口", placeholder: "22" },
      { key: "user", label: "用户名" },
      { key: "pass", label: "密码", password: true },
    ],
  },
  {
    id: "ftp",
    label: "FTP",
    fields: [
      { key: "host", label: "主机", placeholder: "example.com", required: true },
      { key: "port", label: "端口", placeholder: "21" },
      { key: "user", label: "用户名" },
      { key: "pass", label: "密码", password: true },
    ],
  },
  {
    id: "s3",
    label: "S3 兼容对象存储",
    fields: [
      { key: "provider", label: "Provider", placeholder: "AWS / Minio / Cloudflare / Other" },
      { key: "access_key_id", label: "Access Key ID" },
      { key: "secret_access_key", label: "Secret Access Key", password: true },
      { key: "endpoint", label: "Endpoint", placeholder: "https://s3.example.com" },
      { key: "region", label: "Region", placeholder: "us-east-1" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

export const api = {
  rcloneReady: () => invoke<boolean>("rclone_ready"),
  winfspInstalled: () => invoke<boolean>("winfsp_installed"),
  listRemotes: () => invoke<RemoteInfo[]>("list_remotes"),
  createRemote: (name: string, kind: string, params: Record<string, string>) =>
    invoke<void>("create_remote", { name, kind, params }),
  deleteRemote: (name: string) => invoke<void>("delete_remote", { name }),
  listMounts: () => invoke<MountInfo[]>("list_mounts"),
  mountRemote: (remote: string, drive: string, preset: Preset) =>
    invoke<void>("mount_remote", { remote, drive, preset }),
  unmount: (mountPoint: string) => invoke<void>("unmount", { mountPoint }),
  coreStats: () => invoke<CoreStats>("core_stats"),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
};

export function formatSpeed(bytesPerSec?: number): string {
  const b = bytesPerSec ?? 0;
  if (b < 1024) return `${b.toFixed(0)} B/s`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB/s`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}
