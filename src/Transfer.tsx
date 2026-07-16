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
  const firstRemote = remotes[0]?.name ?? "";
  const [source, setSource] = useState<Endpoint>({ kind: "remote", path: "", remote: firstRemote });
  const [dest, setDest] = useState<Endpoint>({ kind: "local", path: "", remote: firstRemote });
  const [op, setOp] = useState<TransferOp>("copy");
  const [jobs, setJobs] = useState<Job[]>([]);

  // Poll live status for every unfinished job once a second.
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  useEffect(() => {
    const t = setInterval(() => {
      jobsRef.current.forEach((j) => {
        if (j.status?.finished) return;
        api
          .transferStatus(j.id)
          .then((s) => setJobs((cur) => cur.map((x) => (x.id === j.id ? { ...x, status: s } : x))))
          .catch(() => {});
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  async function start() {
    const src = endpointToFs(source);
    const dst = endpointToFs(dest);
    if (!src || !dst) {
      onError("请填写源和目标");
      return;
    }
    if (
      op === "sync" &&
      !confirm("同步会删除「目标」中源里没有的文件,使目标与源完全一致。确定继续?")
    ) {
      return;
    }
    try {
      const id = await api.startTransfer(src, dst, op);
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
        <EndpointEditor label="源" value={source} onChange={setSource} remotes={remotes} onError={onError} />
        <div className="xfer-arrow">↓</div>
        <EndpointEditor label="目标" value={dest} onChange={setDest} remotes={remotes} onError={onError} />

        <div className="xfer-op-row">
          <label className="xfer-op">
            操作
            <select value={op} onChange={(e) => setOp(e.target.value as TransferOp)}>
              <option value="copy">复制(只增改,不删)</option>
              <option value="sync">同步(目标与源一致,会删多余)</option>
            </select>
          </label>
          <button className="primary" onClick={start}>
            开始传输
          </button>
        </div>
        <p className="xfer-hint">
          直传绕过挂载盘符,由 rclone 多线程跑满带宽 —— 大文件批量传输比拖进盘符快得多。
        </p>
      </div>

      <div className="xfer-jobs">
        {jobs.length === 0 && <p className="empty">还没有传输任务。</p>}
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
            远程
          </button>
          <button
            className={value.kind === "local" ? "seg-on" : ""}
            onClick={() => onChange({ ...value, kind: "local" })}
          >
            本地
          </button>
        </div>
      </div>

      {value.kind === "remote" ? (
        <div className="endpoint-body">
          <select
            value={value.remote}
            onChange={(e) => onChange({ ...value, remote: e.target.value })}
          >
            {remotes.length === 0 && <option value="">（无远程）</option>}
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}:
              </option>
            ))}
          </select>
          <input
            placeholder="子路径(可选),如 backup/photos"
            value={value.path}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
        </div>
      ) : (
        <div className="endpoint-body">
          <input
            placeholder="本地文件夹路径"
            value={value.path}
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
          <button onClick={browse}>浏览…</button>
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
          {job.op === "sync" ? "同步" : "复制"} · {job.label}
        </span>
        {finished ? (
          <button className="icon-btn" title="移除" onClick={onDismiss}>
            ✕
          </button>
        ) : (
          <button className="danger" onClick={onCancel}>
            取消
          </button>
        )}
      </div>

      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="xfer-meta">
        {finished ? (
          failed ? (
            <span className="err-text">失败:{s?.error || "未知错误"}</span>
          ) : (
            <span className="ok-text">✓ 完成 · {formatBytes(done)}</span>
          )
        ) : (
          <>
            <span>{pct.toFixed(0)}%</span>
            <span>
              {formatBytes(done)} / {total > 0 ? formatBytes(total) : "…"}
            </span>
            <span className="xfer-speed">{formatSpeed(s?.speed)}</span>
            <span>剩余 {formatEta(s?.eta)}</span>
          </>
        )}
      </div>
    </div>
  );
}
