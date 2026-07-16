import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  BACKENDS,
  formatSpeed,
  PRESETS,
  Preset,
  RemoteInfo,
  MountInfo,
  CoreStats,
} from "./api";
import "./App.css";

const ALL_LETTERS = "DEFGHIJKLMNOPQRSTUVWXYZ".split("");

export default function App() {
  const [ready, setReady] = useState(false);
  const [winfsp, setWinfsp] = useState(true);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  const [stats, setStats] = useState<CoreStats | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wait for the rclone daemon, then do the first load.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const ok = await api.rcloneReady();
        if (cancelled) return;
        if (ok) {
          setReady(true);
          api.winfspInstalled().then(setWinfsp);
          refresh();
          return;
        }
      } catch {
        /* daemon not up yet */
      }
      if (!cancelled) setTimeout(poll, 400);
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll mounts + live stats while running.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      api.listMounts().then(setMounts).catch(() => {});
      api.coreStats().then(setStats).catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [ready]);

  async function refresh() {
    try {
      setRemotes(await api.listRemotes());
      setMounts(await api.listMounts());
    } catch (e) {
      setError(String(e));
    }
  }

  const usedLetters = useMemo(
    () => new Set(mounts.map((m) => m.mount_point.replace(":", "").toUpperCase())),
    [mounts]
  );
  const freeLetters = ALL_LETTERS.filter((l) => !usedLetters.has(l));

  function mountPointFor(remote: string): string | null {
    const m = mounts.find((x) => x.fs === `${remote}:`);
    return m ? m.mount_point : null;
  }

  async function handleDelete(name: string) {
    if (!confirm(`删除远程配置 "${name}"?(不会影响云端数据)`)) return;
    try {
      await api.deleteRemote(name);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">☁️</span>
          <div>
            <h1>Mountie</h1>
            <p className="tagline">把云存储挂载成本地盘符 · 由 rclone 驱动</p>
          </div>
        </div>
        <div className="status">
          <span className={`dot ${ready ? "ok" : "wait"}`} />
          {ready ? "引擎就绪" : "引擎启动中…"}
          {ready && (
            <span className="speed" title="当前总传输速率">
              ↑↓ {formatSpeed(stats?.speed)}
            </span>
          )}
        </div>
      </header>

      {!winfsp && (
        <div className="banner warn">
          未检测到 <b>WinFsp</b>,挂载盘符需要它。
          <button className="link" onClick={() => openUrl("https://winfsp.dev/rel/")}>
            前往下载安装
          </button>
        </div>
      )}
      {error && (
        <div className="banner error">
          <span className="banner-msg">{error}</span>
          <button className="link" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}

      <main>
        <section>
          <div className="section-head">
            <h2>远程配置</h2>
            <button className="primary" onClick={() => setShowAdd(true)} disabled={!ready}>
              + 添加远程
            </button>
          </div>

          {ready && remotes.length === 0 && (
            <p className="empty">还没有配置远程。点击「添加远程」连接你的第一个云存储。</p>
          )}

          <div className="cards">
            {remotes.map((r) => (
              <RemoteCard
                key={r.name}
                remote={r}
                mountPoint={mountPointFor(r.name)}
                freeLetters={freeLetters}
                onDelete={() => handleDelete(r.name)}
                onChanged={refresh}
                onError={setError}
              />
            ))}
          </div>
        </section>
      </main>

      {showAdd && (
        <AddRemoteModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function RemoteCard({
  remote,
  mountPoint,
  freeLetters,
  onDelete,
  onChanged,
  onError,
}: {
  remote: RemoteInfo;
  mountPoint: string | null;
  freeLetters: string[];
  onDelete: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [drive, setDrive] = useState(freeLetters[0] ?? "Z");
  const [preset, setPreset] = useState<Preset>("balanced");
  const [busy, setBusy] = useState(false);
  const mounted = mountPoint !== null;

  async function doMount() {
    setBusy(true);
    try {
      await api.mountRemote(remote.name, drive, preset);
      // Give rclone a moment to register the mount, then refresh.
      setTimeout(onChanged, 600);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doUnmount() {
    if (!mountPoint) return;
    setBusy(true);
    try {
      await api.unmount(mountPoint);
      setTimeout(onChanged, 400);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card ${mounted ? "mounted" : ""}`}>
      <div className="card-top">
        <div>
          <div className="card-name">{remote.name}</div>
          <span className="badge">{remote.type}</span>
        </div>
        <button className="icon-btn" title="删除" onClick={onDelete} disabled={busy}>
          🗑
        </button>
      </div>

      {mounted ? (
        <div className="mount-row">
          <span className="mounted-tag">已挂载到 {mountPoint}</span>
          <button className="danger" onClick={doUnmount} disabled={busy}>
            卸载
          </button>
        </div>
      ) : (
        <div className="mount-form">
          <label>
            盘符
            <select value={drive} onChange={(e) => setDrive(e.target.value)}>
              {freeLetters.map((l) => (
                <option key={l} value={l}>
                  {l}:
                </option>
              ))}
            </select>
          </label>
          <label title={PRESETS.find((p) => p.id === preset)?.hint}>
            性能预设
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={doMount} disabled={busy || freeLetters.length === 0}>
            {busy ? "挂载中…" : "挂载"}
          </button>
        </div>
      )}
    </div>
  );
}

function AddRemoteModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: () => void;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const [backendId, setBackendId] = useState(BACKENDS[0].id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const backend = BACKENDS.find((b) => b.id === backendId)!;

  function setField(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  const nameValid = /^[A-Za-z0-9_.\-]+$/.test(name);
  const requiredOk = backend.fields
    .filter((f) => f.required)
    .every((f) => (values[f.key] ?? "").trim().length > 0);

  async function submit() {
    if (!nameValid || !requiredOk) return;
    setBusy(true);
    try {
      // Only send non-empty fields so rclone keeps its own defaults.
      const params: Record<string, string> = {};
      for (const f of backend.fields) {
        const v = (values[f.key] ?? "").trim();
        if (v) params[f.key] = v;
      }
      await api.createRemote(name.trim(), backendId, params);
      onCreated();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>添加远程</h2>

        <label className="field">
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="给这个连接起个名字,如 mydrive"
            autoFocus
          />
          {name && !nameValid && (
            <small className="hint-err">只能包含字母、数字、下划线、点和连字符</small>
          )}
        </label>

        <label className="field">
          类型
          <select
            value={backendId}
            onChange={(e) => {
              setBackendId(e.target.value);
              setValues({});
            }}
          >
            {BACKENDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>

        {backend.fields.map((f) => (
          <label className="field" key={f.key}>
            <span>
              {f.label}
              {f.required && <span className="req">*</span>}
            </span>
            <input
              type={f.password ? "password" : "text"}
              value={values[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          </label>
        ))}

        <p className="oauth-note">
          Google Drive / OneDrive / Dropbox 等需要浏览器授权的后端将在后续版本支持。
        </p>

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            onClick={submit}
            disabled={busy || !nameValid || !requiredOk || !name}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
