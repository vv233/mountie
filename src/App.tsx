import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  AboutInfo,
  api,
  BACKENDS,
  CACHE_MODES,
  formatBytes,
  formatSpeed,
  isOAuthBackend,
  OAUTH_BACKENDS,
  PRESETS,
  PRESET_DEFAULTS,
  Preset,
  RemoteInfo,
  MountInfo,
  CoreStats,
  VfsOptions,
} from "./api";
import { useI18n } from "./i18n";
import TransferPanel from "./Transfer";
import "./App.css";

type View = "mount" | "transfer" | "logs";
type Theme = "dark" | "light";

/** Close a modal when Escape is pressed. */
function useEscClose(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

export default function App() {
  const { t, lang, setLang, tErr } = useI18n();
  const [ready, setReady] = useState(false);
  const [winfsp, setWinfsp] = useState(true);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  const [stats, setStats] = useState<CoreStats | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [view, setView] = useState<View>("mount");
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("theme") === "light" ? "light" : "dark"
  );
  const [editRemote, setEditRemote] = useState<RemoteInfo | null>(null);
  const [engineDown, setEngineDown] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  // Letters actually free on this machine (excludes real disks, USB sticks and
  // our own live mounts) — the backend checks the filesystem, not just our list.
  const [freeLetters, setFreeLetters] = useState<string[]>([]);

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
          api.getAutostart().then(setAutostart).catch(() => {});
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

  // React to engine crash/restart events from the supervisor.
  useEffect(() => {
    const un = listen<string>("engine", (e) => setEngineDown(e.payload === "down"));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Apply and remember the colour theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Check for a newer release on startup (no-op in dev / offline).
  useEffect(() => {
    check()
      .then(setUpdate)
      .catch(() => {});
  }, []);

  // Poll mounts + live stats while running.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      api.listMounts().then(setMounts).catch(() => {});
      api.coreStats().then(setStats).catch(() => {});
      api.freeDriveLetters().then(setFreeLetters).catch(() => {});
    }, 1500);
    return () => clearInterval(id);
  }, [ready]);

  async function refresh() {
    try {
      setRemotes(await api.listRemotes());
      setMounts(await api.listMounts());
      setFreeLetters(await api.freeDriveLetters());
    } catch (e) {
      setError(String(e));
    }
  }

  function mountPointFor(remote: string): string | null {
    const m = mounts.find((x) => x.fs === `${remote}:`);
    return m ? m.mount_point : null;
  }

  async function handleDelete(name: string) {
    if (!confirm(t("remotes.deleteConfirm", { name }))) return;
    try {
      await api.deleteRemote(name);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleAutostart(next: boolean) {
    try {
      await api.setAutostart(next);
      setAutostart(next);
    } catch (e) {
      setError(String(e));
    }
  }

  async function installUpdate() {
    if (!update) return;
    setUpdating(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setError(String(e));
      setUpdating(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">☁️</span>
          <div>
            <h1>Mountie</h1>
            <p className="tagline">{t("app.tagline")}</p>
          </div>
        </div>
        <div className="top-right">
          <button
            className="theme-btn"
            title={t("theme.toggle")}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀" : "🌙"}
          </button>
          <div className="lang">
            <button className={lang === "zh" ? "on" : ""} onClick={() => setLang("zh")}>
              中
            </button>
            <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
              EN
            </button>
          </div>
          <div className="status">
            <span className={`dot ${ready ? "ok" : "wait"}`} />
            {ready ? t("status.ready") : t("status.starting")}
            {ready && (
              <span className="speed" title={t("status.speedTitle")}>
                ↑↓ {formatSpeed(stats?.speed)}
              </span>
            )}
          </div>
        </div>
      </header>

      {update && (
        <div className="banner update">
          <span className="banner-msg">{t("update.available", { v: update.version })}</span>
          <button className="link" onClick={installUpdate} disabled={updating}>
            {updating ? t("update.installing") : t("update.install")}
          </button>
        </div>
      )}
      {!winfsp && (
        <div className="banner warn">
          {t("winfsp.missing")}
          <button className="link" onClick={() => openUrl("https://winfsp.dev/rel/")}>
            {t("winfsp.download")}
          </button>
        </div>
      )}
      {engineDown && <div className="banner warn">{t("err.engineDown")}</div>}
      {error && (
        <div className="banner error">
          <span className="banner-msg">{tErr(error)}</span>
          <button className="link" onClick={() => setError(null)}>
            {t("banner.dismiss")}
          </button>
        </div>
      )}

      <nav className="tabs">
        <button className={view === "mount" ? "tab on" : "tab"} onClick={() => setView("mount")}>
          {t("tab.mount")}
        </button>
        <button
          className={view === "transfer" ? "tab on" : "tab"}
          onClick={() => setView("transfer")}
        >
          {t("tab.transfer")}
        </button>
        <button className={view === "logs" ? "tab on" : "tab"} onClick={() => setView("logs")}>
          {t("tab.logs")}
        </button>
      </nav>

      <main>
        {view === "mount" && (
          <section>
            <div className="section-head">
              <h2>{t("remotes.title")}</h2>
              <button className="primary" onClick={() => setShowAdd(true)} disabled={!ready}>
                {t("remotes.add")}
              </button>
            </div>

            {ready && remotes.length === 0 && <p className="empty">{t("remotes.empty")}</p>}

            <div className="cards">
              {remotes.map((r) => (
                <RemoteCard
                  key={r.name}
                  remote={r}
                  mountPoint={mountPointFor(r.name)}
                  freeLetters={freeLetters}
                  onDelete={() => handleDelete(r.name)}
                  onEdit={() => setEditRemote(r)}
                  onChanged={refresh}
                  onError={setError}
                />
              ))}
            </div>
          </section>
        )}
        {view === "transfer" && <TransferPanel remotes={remotes} onError={setError} />}
        {view === "logs" && <LogsPanel />}
      </main>

      <footer className="footer">
        <label className="autostart">
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => toggleAutostart(e.target.checked)}
            disabled={!ready}
          />
          {t("footer.autostart")}
        </label>
        <span className="foot-hint">{t("footer.hint")}</span>
      </footer>

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

      {editRemote && (
        <EditRemoteModal
          remote={editRemote}
          onClose={() => setEditRemote(null)}
          onSaved={() => {
            setEditRemote(null);
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
  onEdit,
  onChanged,
  onError,
}: {
  remote: RemoteInfo;
  mountPoint: string | null;
  freeLetters: string[];
  onDelete: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useI18n();
  const [drive, setDrive] = useState(freeLetters[0] ?? "Z");
  const [preset, setPreset] = useState<Preset>("balanced");
  const [adv, setAdv] = useState(false);
  const [vfs, setVfs] = useState<VfsOptions>(PRESET_DEFAULTS.balanced);
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const mounted = mountPoint !== null;

  // The free-letter list arrives asynchronously and changes as drives come and
  // go, so keep the selection pointing at something actually available.
  useEffect(() => {
    if (freeLetters.length && !freeLetters.includes(drive)) setDrive(freeLetters[0]);
  }, [freeLetters]);

  // Show the remote's quota once it's mounted. Not all backends report it —
  // failures just mean we show nothing.
  useEffect(() => {
    if (!mounted) {
      setAbout(null);
      return;
    }
    api
      .remoteAbout(remote.name)
      .then(setAbout)
      .catch(() => setAbout(null));
  }, [mounted, remote.name]);

  function changePreset(p: Preset) {
    setPreset(p);
    setVfs(PRESET_DEFAULTS[p]); // reset tuning to the new preset's defaults
  }

  async function doMount() {
    setBusy(true);
    try {
      // Send tuned options only if the advanced panel is open.
      await api.mountRemote(remote.name, drive, preset, adv ? vfs : null);
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
        <div className="card-actions">
          {!isOAuthBackend(remote.type) && (
            <button className="icon-btn" title={t("remotes.editTitle")} onClick={onEdit} disabled={busy}>
              ✎
            </button>
          )}
          <button className="icon-btn" title={t("remotes.deleteTitle")} onClick={onDelete} disabled={busy}>
            🗑
          </button>
        </div>
      </div>

      {mounted ? (
        <div className="mount-row">
          <div>
            <span className="mounted-tag">{t("mount.mountedAt", { mp: mountPoint! })}</span>
            {about?.total != null && about?.free != null && (
              <div className="capacity">
                {t("mount.capacity", {
                  free: formatBytes(about.free),
                  total: formatBytes(about.total),
                })}
              </div>
            )}
          </div>
          <button className="danger" onClick={doUnmount} disabled={busy}>
            {t("mount.unmount")}
          </button>
        </div>
      ) : (
        <>
          <div className="mount-form">
            <label>
              {t("mount.drive")}
              <select value={drive} onChange={(e) => setDrive(e.target.value)}>
                {freeLetters.map((l) => (
                  <option key={l} value={l}>
                    {l}:
                  </option>
                ))}
              </select>
            </label>
            <label title={t(PRESETS.find((p) => p.id === preset)?.hintKey ?? "")}>
              {t("mount.preset")}
              <select value={preset} onChange={(e) => changePreset(e.target.value as Preset)}>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(p.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" onClick={doMount} disabled={busy || freeLetters.length === 0}>
              {busy ? t("mount.mounting") : t("mount.mount")}
            </button>
          </div>

          <button className="link adv-toggle" onClick={() => setAdv((a) => !a)}>
            {t("mount.advanced")} {adv ? "▲" : "▼"}
          </button>
          {adv && (
            <div className="adv-grid">
              <label>
                {t("mount.cacheMode")}
                <select
                  value={vfs.cacheMode}
                  onChange={(e) => setVfs({ ...vfs, cacheMode: e.target.value })}
                >
                  {CACHE_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("mount.chunkSize")}
                <input value={vfs.chunkSize} onChange={(e) => setVfs({ ...vfs, chunkSize: e.target.value })} />
              </label>
              <label>
                {t("mount.readAhead")}
                <input value={vfs.readAhead} onChange={(e) => setVfs({ ...vfs, readAhead: e.target.value })} />
              </label>
              <label>
                {t("mount.dirCacheTime")}
                <input
                  value={vfs.dirCacheTime}
                  onChange={(e) => setVfs({ ...vfs, dirCacheTime: e.target.value })}
                />
              </label>
            </div>
          )}
        </>
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
  const { t, tErr } = useI18n();
  useEscClose(onClose);
  const [name, setName] = useState("");
  const [backendId, setBackendId] = useState(BACKENDS[0].id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const oauth = isOAuthBackend(backendId);
  const def = BACKENDS.find((b) => b.id === backendId);
  const fields = def?.fields ?? [];

  function setField(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
    setTestMsg(null);
  }

  // Merge the service's preset defaults with the non-empty user fields.
  function buildParams(): Record<string, string> {
    const params: Record<string, string> = { ...(def?.defaults ?? {}) };
    for (const f of fields) {
      const v = (values[f.key] ?? "").trim();
      if (v) params[f.key] = v;
    }
    return params;
  }

  async function doTest() {
    if (!requiredOk) return;
    setTesting(true);
    setTestMsg(null);
    try {
      const n = await api.testRemote(def?.type ?? backendId, buildParams());
      setTestMsg({ ok: true, text: t("add.testOk", { n }) });
    } catch (e) {
      setTestMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  }

  const nameValid = /^[A-Za-z0-9_.\-]+$/.test(name);
  const requiredOk =
    oauth || fields.filter((f) => f.required).every((f) => (values[f.key] ?? "").trim().length > 0);

  async function submit() {
    if (!nameValid || !requiredOk) return;
    setBusy(true);
    try {
      if (oauth) {
        // Opens the browser for the user to authorize; returns the token.
        const token = await api.oauthAuthorize(backendId);
        await api.createRemote(name.trim(), backendId, { token });
      } else {
        await api.createRemote(name.trim(), def?.type ?? backendId, buildParams());
      }
      onCreated();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("add.title")}</h2>

        <label className="field">
          {t("add.name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("add.namePlaceholder")}
            autoFocus
          />
          {name && !nameValid && <small className="hint-err">{t("add.nameInvalid")}</small>}
        </label>

        <label className="field">
          {t("add.type")}
          <select
            value={backendId}
            onChange={(e) => {
              setBackendId(e.target.value);
              setValues({});
              setTestMsg(null);
            }}
          >
            <optgroup label={t("group.protocol")}>
              {BACKENDS.filter((b) => b.group === "protocol").map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("group.nas")}>
              {BACKENDS.filter((b) => b.group === "nas").map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("group.cloudkey")}>
              {BACKENDS.filter((b) => b.group === "cloud").map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("group.cloud")}>
              {OAUTH_BACKENDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {t(b.labelKey)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        {oauth ? (
          <p className="oauth-note">{busy ? t("add.authorizing") : t("add.oauthHint")}</p>
        ) : (
          <>
            {fields.map((f) => (
              <label className="field" key={f.key}>
                <span>
                  {t(f.labelKey)}
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
            {def?.noteKey && <p className="oauth-note">{t(def.noteKey)}</p>}
          </>
        )}

        {testMsg && (
          <p className={testMsg.ok ? "test-ok" : "test-err"}>
            {testMsg.ok ? testMsg.text : tErr(testMsg.text)}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy || testing}>
            {t("common.cancel")}
          </button>
          {!oauth && (
            <button onClick={doTest} disabled={busy || testing || !requiredOk}>
              {testing ? t("add.testing") : t("add.test")}
            </button>
          )}
          <button
            className="primary"
            onClick={submit}
            disabled={busy || testing || !nameValid || !requiredOk || !name}
          >
            {busy ? (oauth ? t("add.authorizing") : t("add.creating")) : oauth ? t("add.authorizeCreate") : t("add.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditRemoteModal({
  remote,
  onClose,
  onSaved,
  onError,
}: {
  remote: RemoteInfo;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: string) => void;
}) {
  const { t } = useI18n();
  useEscClose(onClose);
  // Base protocol/cloud def for this remote's rclone type (id === type).
  const def = BACKENDS.find((b) => b.id === remote.type);
  const fields = def?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getRemoteConfig(remote.name)
      .then((cfg) => {
        const v: Record<string, string> = {};
        for (const f of fields) {
          // Pre-fill non-secret fields; passwords come back obscured, leave blank.
          if (!f.password && cfg[f.key] != null) v[f.key] = String(cfg[f.key]);
        }
        setValues(v);
        setLoaded(true);
      })
      .catch((e) => {
        onError(String(e));
        setLoaded(true);
      });
  }, []);

  function setField(key: string, val: string) {
    setValues((prev) => ({ ...prev, [key]: val }));
  }

  // Required non-password fields must be present; a blank password keeps the old one.
  const requiredOk = fields
    .filter((f) => f.required && !f.password)
    .every((f) => (values[f.key] ?? "").trim().length > 0);

  async function save() {
    if (!requiredOk) return;
    setBusy(true);
    try {
      const params: Record<string, string> = {};
      for (const f of fields) {
        const val = (values[f.key] ?? "").trim();
        if (val) params[f.key] = val; // only send provided fields
      }
      await api.updateRemote(remote.name, params);
      onSaved();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {t("edit.title")} · {remote.name}
        </h2>

        {loaded &&
          fields.map((f) => (
            <label className="field" key={f.key}>
              <span>
                {t(f.labelKey)}
                {f.required && !f.password && <span className="req">*</span>}
              </span>
              <input
                type={f.password ? "password" : "text"}
                value={values[f.key] ?? ""}
                placeholder={f.password ? t("edit.passKeep") : f.placeholder}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            </label>
          ))}

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="primary" onClick={save} disabled={busy || !loaded || !requiredOk}>
            {busy ? t("edit.saving") : t("edit.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function LogsPanel() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const load = () => api.getLogs().then(setLogs).catch(() => {});
    load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="logs">
      {logs.length === 0 ? (
        <p className="empty">{t("logs.empty")}</p>
      ) : (
        <pre className="log-view">{logs.join("\n")}</pre>
      )}
    </section>
  );
}
