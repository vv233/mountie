import { createContext, useContext, useMemo, useState, ReactNode } from "react";

export type Lang = "zh" | "en";

type Entry = { zh: string; en: string };

// All user-facing strings. `{name}` style placeholders are filled by t(key, vars).
const DICT: Record<string, Entry> = {
  "app.tagline": {
    zh: "把云存储挂载成本地盘符 · 由 rclone 驱动",
    en: "Mount cloud storage as local drives · powered by rclone",
  },
  "status.ready": { zh: "引擎就绪", en: "Engine ready" },
  "status.starting": { zh: "引擎启动中…", en: "Starting engine…" },
  "status.speedTitle": { zh: "当前总传输速率", en: "Total transfer speed" },

  "winfsp.missing": { zh: "未检测到 WinFsp,挂载盘符需要它。", en: "WinFsp not found — it is required to mount drives." },
  "winfsp.download": { zh: "前往下载安装", en: "Download & install" },
  "banner.dismiss": { zh: "知道了", en: "Dismiss" },

  "tab.mount": { zh: "挂载盘符", en: "Mount drives" },
  "tab.transfer": { zh: "直传 / 同步", en: "Transfer / Sync" },

  "remotes.title": { zh: "远程配置", en: "Remotes" },
  "remotes.add": { zh: "+ 添加远程", en: "+ Add remote" },
  "remotes.empty": {
    zh: "还没有配置远程。点击「添加远程」连接你的第一个云存储。",
    en: "No remotes yet. Click “Add remote” to connect your first cloud storage.",
  },
  "remotes.deleteConfirm": {
    zh: '删除远程配置 "{name}"?(不会影响云端数据)',
    en: 'Delete remote "{name}"? (Cloud data is not affected.)',
  },
  "remotes.deleteTitle": { zh: "删除", en: "Delete" },
  "remotes.editTitle": { zh: "编辑", en: "Edit" },
  "edit.title": { zh: "编辑远程", en: "Edit remote" },
  "edit.save": { zh: "保存", en: "Save" },
  "edit.saving": { zh: "保存中…", en: "Saving…" },
  "edit.passKeep": { zh: "留空则保持不变", en: "Leave blank to keep current" },

  "mount.drive": { zh: "盘符", en: "Drive" },
  "mount.preset": { zh: "性能预设", en: "Preset" },
  "mount.mount": { zh: "挂载", en: "Mount" },
  "mount.mounting": { zh: "挂载中…", en: "Mounting…" },
  "mount.mountedAt": { zh: "已挂载到 {mp}", en: "Mounted at {mp}" },
  "mount.unmount": { zh: "卸载", en: "Unmount" },
  "mount.advanced": { zh: "高级调优", en: "Advanced tuning" },
  "mount.cacheMode": { zh: "缓存模式", en: "Cache mode" },
  "mount.chunkSize": { zh: "读取分块", en: "Read chunk" },
  "mount.readAhead": { zh: "预读", en: "Read-ahead" },
  "mount.dirCacheTime": { zh: "目录缓存时间", en: "Dir cache time" },

  "add.title": { zh: "添加远程", en: "Add remote" },
  "add.name": { zh: "名称", en: "Name" },
  "add.namePlaceholder": { zh: "给这个连接起个名字,如 mydrive", en: "Name this connection, e.g. mydrive" },
  "add.nameInvalid": {
    zh: "只能包含字母、数字、下划线、点和连字符",
    en: "Only letters, digits, underscore, dot and hyphen",
  },
  "add.type": { zh: "类型", en: "Type" },
  "group.protocol": { zh: "标准协议", en: "Protocols" },
  "group.nas": { zh: "NAS / 服务", en: "NAS / Services" },
  "group.cloudkey": { zh: "云存储(密钥登录)", en: "Cloud (key login)" },
  "group.cloud": { zh: "云盘(浏览器授权)", en: "Cloud (OAuth)" },
  "note.nextcloud": {
    zh: "URL 填 Nextcloud/ownCloud 的 WebDAV 地址,通常是 https://你的域名/remote.php/dav",
    en: "URL is your Nextcloud/ownCloud WebDAV address, usually https://your-domain/remote.php/dav",
  },
  "note.synology": {
    zh: "先在 DSM 启用「WebDAV Server」套件;地址通常是 https://NAS地址:5006(https)或 :5005(http)",
    en: "Enable the WebDAV Server package in DSM first; URL is usually https://NAS:5006 (https) or :5005 (http)",
  },
  "note.qnap": {
    zh: "先在 QTS 控制台启用 WebDAV;地址形如 https://NAS地址:端口",
    en: "Enable WebDAV in the QTS control panel first; URL looks like https://NAS:port",
  },
  "note.iptime": {
    zh: "在 ipTIME NAS 上启用 WebDAV 后填写其地址",
    en: "Enable WebDAV on the ipTIME NAS, then enter its address",
  },
  "note.asustor": {
    zh: "在 ADM 上启用 WebDAV 后填写其地址",
    en: "Enable WebDAV in ADM, then enter its address",
  },
  "add.oauthNote": {
    zh: "Google Drive / OneDrive / Dropbox 等需要浏览器授权的后端将在后续版本支持。",
    en: "OAuth backends (Google Drive / OneDrive / Dropbox) are coming in a later release.",
  },
  "common.cancel": { zh: "取消", en: "Cancel" },
  "add.test": { zh: "测试连接", en: "Test" },
  "add.testing": { zh: "测试中…", en: "Testing…" },
  "add.testOk": { zh: "连接成功 · 根目录 {n} 项", en: "Connected · {n} items in root" },
  "add.create": { zh: "创建", en: "Create" },
  "add.creating": { zh: "创建中…", en: "Creating…" },

  "footer.autostart": { zh: "开机自启", en: "Launch at login" },
  "footer.hint": {
    zh: "关闭窗口会最小化到托盘,挂载的盘符保持可用;退出请用托盘菜单",
    en: "Closing the window hides to the tray and keeps drives mounted; quit from the tray menu",
  },

  // Transfer panel
  "xfer.source": { zh: "源", en: "Source" },
  "xfer.dest": { zh: "目标", en: "Destination" },
  "xfer.remote": { zh: "远程", en: "Remote" },
  "xfer.local": { zh: "本地", en: "Local" },
  "xfer.noRemote": { zh: "(无远程)", en: "(no remotes)" },
  "xfer.subpath": { zh: "子路径(可选),如 backup/photos", en: "Subpath (optional), e.g. backup/photos" },
  "xfer.localPath": { zh: "本地文件夹路径", en: "Local folder path" },
  "xfer.browse": { zh: "浏览…", en: "Browse…" },
  "xfer.op": { zh: "操作", en: "Operation" },
  "xfer.copy": { zh: "复制(只增改,不删)", en: "Copy (add/update, never delete)" },
  "xfer.sync": { zh: "同步(目标与源一致,会删多余)", en: "Sync (make destination match source)" },
  "xfer.start": { zh: "开始传输", en: "Start transfer" },
  "xfer.turbo": { zh: "大文件自动加速", en: "Auto turbo for large files" },
  "xfer.turboHint": {
    zh: "大文件自动用多线程并行传输,小文件不受影响",
    en: "Large files are automatically transferred with parallel streams; small files are unaffected",
  },
  "xfer.hint": {
    zh: "直传绕过挂载盘符,由 rclone 多线程跑满带宽 —— 大文件批量传输比拖进盘符快得多。",
    en: "Direct transfer bypasses the mounted drive and lets rclone saturate the connection — much faster than dragging large files through a drive.",
  },
  "xfer.empty": { zh: "还没有传输任务。", en: "No transfers yet." },
  "xfer.needBoth": { zh: "请填写源和目标", en: "Please set both source and destination" },
  "xfer.syncConfirm": {
    zh: "同步会删除「目标」中源里没有的文件,使目标与源完全一致。确定继续?",
    en: "Sync will delete files in the destination that are not in the source, making them identical. Continue?",
  },
  "xfer.opCopy": { zh: "复制", en: "Copy" },
  "xfer.opSync": { zh: "同步", en: "Sync" },
  "xfer.remove": { zh: "移除", en: "Remove" },
  "xfer.done": { zh: "✓ 完成 · {bytes}", en: "✓ Done · {bytes}" },
  "xfer.failed": { zh: "失败:{err}", en: "Failed: {err}" },
  "xfer.eta": { zh: "剩余 {eta}", en: "ETA {eta}" },

  // Presets (labels + hints)
  "preset.fast": { zh: "极速模式", en: "Fast" },
  "preset.fast.hint": {
    zh: "全量缓存 + 大块预读,读写最流畅(占用磁盘/内存较多)",
    en: "Full cache + large read-ahead, smoothest I/O (uses more disk/memory)",
  },
  "preset.balanced": { zh: "均衡", en: "Balanced" },
  "preset.balanced.hint": {
    zh: "写缓存 + 中等分块,速度与占用平衡(默认)",
    en: "Write cache + medium chunks, balanced speed and footprint (default)",
  },
  "preset.lowmem": { zh: "省内存", en: "Low-memory" },
  "preset.lowmem.hint": {
    zh: "不做读缓存,占用最小(随机写较慢)",
    en: "No read cache, smallest footprint (slower random writes)",
  },

  // Backend labels + fields
  "backend.webdav": { zh: "WebDAV", en: "WebDAV" },
  "backend.sftp": { zh: "SFTP", en: "SFTP" },
  "backend.ftp": { zh: "FTP", en: "FTP" },
  "backend.s3": { zh: "S3 兼容对象存储", en: "S3-compatible object storage" },
  "backend.nextcloud": { zh: "Nextcloud", en: "Nextcloud" },
  "backend.synology": { zh: "Synology", en: "Synology" },
  "backend.qnap": { zh: "QNAP", en: "QNAP" },
  "backend.iptime": { zh: "ipTIME", en: "ipTIME" },
  "backend.asustor": { zh: "ASUSTOR", en: "ASUSTOR" },
  "backend.b2": { zh: "Backblaze B2", en: "Backblaze B2" },
  "backend.mega": { zh: "MEGA", en: "MEGA" },
  "backend.drive": { zh: "Google Drive", en: "Google Drive" },
  "backend.onedrive": { zh: "OneDrive", en: "OneDrive" },
  "backend.dropbox": { zh: "Dropbox", en: "Dropbox" },
  "backend.pcloud": { zh: "pCloud", en: "pCloud" },
  "backend.box": { zh: "Box", en: "Box" },
  "add.oauthHint": {
    zh: "点击下方按钮会打开浏览器,登录并授权 rclone 访问;完成后自动创建远程。授权过程 Mountie 不接触你的账号密码。",
    en: "The button below opens your browser to sign in and authorize rclone; the remote is created once you finish. Mountie never sees your account password.",
  },
  "add.authorizeCreate": { zh: "授权并创建", en: "Authorize & create" },
  "add.authorizing": {
    zh: "已打开浏览器,请完成登录授权…",
    en: "Browser opened — complete sign-in to continue…",
  },
  "field.url": { zh: "服务器地址 URL", en: "Server URL" },
  "field.vendor": { zh: "厂商 vendor", en: "Vendor" },
  "field.user": { zh: "用户名", en: "Username" },
  "field.pass": { zh: "密码", en: "Password" },
  "field.host": { zh: "主机", en: "Host" },
  "field.port": { zh: "端口", en: "Port" },
  "field.provider": { zh: "Provider", en: "Provider" },
  "field.accessKey": { zh: "Access Key ID", en: "Access Key ID" },
  "field.secretKey": { zh: "Secret Access Key", en: "Secret Access Key" },
  "field.endpoint": { zh: "Endpoint", en: "Endpoint" },
  "field.region": { zh: "Region", en: "Region" },
  "field.account": { zh: "账户 / Key ID", en: "Account / Key ID" },
  "field.key": { zh: "应用密钥", en: "Application Key" },
};

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx>({ lang: "zh", setLang: () => {}, t: (k) => k });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem("lang");
    return saved === "en" || saved === "zh" ? saved : "zh";
  });

  const value = useMemo<I18nCtx>(() => {
    const setLang = (l: Lang) => {
      localStorage.setItem("lang", l);
      setLangState(l);
    };
    const t = (key: string, vars?: Record<string, string | number>) => {
      let s = DICT[key]?.[lang] ?? key;
      if (vars) {
        for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]));
      }
      return s;
    };
    return { lang, setLang, t };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
