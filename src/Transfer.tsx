import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  formatBytes,
  formatEta,
  formatSpeed,
  RemoteInfo,
  TransferOp,
  TransferStatus,
} from "./api";
import { useI18n } from "./i18n";

// An endpoint is either a local folder or a remote (+ optional subpath).
interface Endpoint {
  kind: "local" | "remote";
  path: string;
  remote: string;
}

function endpointToFs(e: Endpoint): string {
  if (e.kind === "local") return e.path.trim();
  const sub = e.path.trim().replace(/^[\\/]+/, "");
  return `${e.remote}:${sub}`;
}

interface Job {
  id: number;
  label: string;
  op: TransferOp;
  status?: TransferStatus;
}

export default function TransferPanel({
  remotes,
  onError,
}: {
  remotes: RemoteInfo[];
  onError: (e: string) => void;
}) {
  const { t } = useI18n();
  const firstRemote = remotes[0]?.name ?? "";
  const [source, setSource] = useState<Endpoint>({ kind: "remote", path: "", remote: firstRemote });
  const [dest, setDest] = useState<Endpoint>({ kind: "local", path: "", remote: firstRemote });
  const [op, setOp] = useState<TransferOp>("copy");
  const [turbo, setTurbo] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);

  // Poll live status for every unfinished job once a second.
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  useEffect(() => {
    const timer = setInterval(() => {
      jobsRef.current.forEach((j) => {
        if (j.status?.finished) return;
        api
          .transferStatus(j.id)
          .then((s) => setJobs((cur) => cur.map((x) => (x.id === j.id ? { ...x, status: s } : x))))
          .catch(() => {});
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function start() {
    const src = endpointToFs(source);
    const dst = endpointToFs(dest);
    if (!src || !dst) {
      onError(t("xfer.needBoth"));
      return;
    }
    if (op === "sync" && !confirm(t("xfer.syncConfirm"))) return;
    try {
      const id = await api.startTransfer(src, dst, op, turbo);
      setJobs((prev) => [{ id, label: `${src}  →  ${dst}`, op }, ...prev]);
    } catch (e) {
      onError(String(e));
    }
  }

  async function cancel(id: number) {
    try {
      await api.stopTransfer(id);
    } catch (e) {
      onError(String(e));
    }
  }

  function dismiss(id: number) {
    setJobs((cur) => cur.filter((j) => j.id !== id));
  }

  return (
    <section className="transfer">
      <div className="xfer-form">
        <EndpointEditor label={t("xfer.source")} value={source} onChange={setSource} remotes={remotes} onError={onError} />
        <div className="xfer-arrow">↓</div>
        <EndpointEditor label={t("xfer.dest")} value={dest} onChange={setDest} remotes={remotes} onError={onError} />

        <div className="xfer-op-row">
          <label className="xfer-op">
            {t("xfer.op")}
            <select value={op} onChange={(e) => setOp(e.target.value as TransferOp)}>
              <option value="copy">{t("xfer.copy")}</option>
              <option value="sync">{t("xfer.sync")}</option>
            </select>
          </label>
          <button className="primary" onClick={start}>
            {t("xfer.start")}
          </button>
        </div>
        <label className="xfer-turbo" title={t("xfer.turboHint")}>
          <input type="checkbox" checked={turbo} onChange={(e) => setTurbo(e.target.checked)} />
          {t("xfer.turbo")}
        </label>
        <p className="xfer-hint">{t("xfer.hint")}</p>
      </div>

      <div className="xfer-jobs">
        {jobs.length === 0 && <p className="empty">{t("xfer.empty")}</p>}
        {jobs.map((j) => (
          <TransferCard key={j.id} job={j} onCancel={() => cancel(j.id)} onDismiss={() => dismiss(j.id)} />
        ))}
      </div>
    </section>
  );
}

function EndpointEditor({
  label,
  value,
  onChange,
  remotes,
  onError,
}: {
  label: string;
  value: Endpoint;
  onChange: (e: Endpoint) => void;
  remotes: RemoteInfo[];
  onError: (e: string) => void;
}) {
  const { t } = useI18n();

  async function browse() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") onChange({ ...value, kind: "local", path: picked });
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <div className="endpoint">
      <div className="endpoint-head">
        <span className="endpoint-label">{label}</span>
        <div className="seg">
          <button
            className={value.kind === "remote" ? "seg-on" : ""}
            onClick={() => onChange({ ...value, kind: "remote" })}
          >
            {t("xfer.remote")}
          </button>
          <button
            className={value.kind === "local" ? "seg-on" : ""}
            onClick={() => onChange({ ...value, kind: "local" })}
          >
            {t("xfer.local")}
          </button>
        </div>
      </div>

      {value.kind === "remote" ? (
        <div className="endpoint-body">
          <select value={value.remote} onChange={(e) => onChange({ ...value, remote: e.target.value })}>
            {remotes.length === 0 && <option value="">{t("xfer.noRemote")}</option>}
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}:
              </option>
            ))}
          </select>
          <input
            placeholder={t("xfer.subpath")}
            value={value.path}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
        </div>
      ) : (
        <div className="endpoint-body">
          <input
            placeholder={t("xfer.localPath")}
            value={value.path}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
          <button onClick={browse}>{t("xfer.browse")}</button>
        </div>
      )}
    </div>
  );
}

function TransferCard({
  job,
  onCancel,
  onDismiss,
}: {
  job: Job;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const s = job.status;
  const total = s?.total_bytes ?? 0;
  const done = s?.bytes ?? 0;
  const pct = s?.finished ? 100 : total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const finished = s?.finished ?? false;
  const failed = finished && !s?.success;

  return (
    <div className={`xfer-card ${finished ? (failed ? "failed" : "done") : ""}`}>
      <div className="xfer-card-top">
        <span className="xfer-label" title={job.label}>
          {job.op === "sync" ? t("xfer.opSync") : t("xfer.opCopy")} · {job.label}
        </span>
        {finished ? (
          <button className="icon-btn" title={t("xfer.remove")} onClick={onDismiss}>
            ✕
          </button>
        ) : (
          <button className="danger" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
      </div>

      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="xfer-meta">
        {finished ? (
          failed ? (
            <span className="err-text">{t("xfer.failed", { err: s?.error || "?" })}</span>
          ) : (
            <span className="ok-text">{t("xfer.done", { bytes: formatBytes(done) })}</span>
          )
        ) : (
          <>
            <span>{pct.toFixed(0)}%</span>
            <span>
              {formatBytes(done)} / {total > 0 ? formatBytes(total) : "…"}
            </span>
            <span className="xfer-speed">{formatSpeed(s?.speed)}</span>
            <span>{t("xfer.eta", { eta: formatEta(s?.eta) })}</span>
          </>
        )}
      </div>
    </div>
  );
}
