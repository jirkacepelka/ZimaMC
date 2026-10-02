import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, get, post } from "../api";
import { Expert, Meter, useAction } from "../ui";

export interface StorageLocation {
  /** Storage base: ZimaMC keeps servers/ and backups/ inside. */
  path: string;
  label: string;
  freeBytes: number;
  totalBytes: number;
  default: boolean;
}

export interface CopyJob {
  state: "copying" | "done" | "failed";
  copied: number;
  total: number;
  error?: string;
}

export interface StorageInfo {
  locations: StorageLocation[];
  backups: string;
  backupsMove: CopyJob | null;
  mountHint: boolean;
}

export function useStorage() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const reload = useCallback(async () => {
    try {
      setInfo(await get<StorageInfo>("/api/storage"));
    } catch {
      /* the page still works with the default folder */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return [info, reload] as const;
}

export function useLocationLabel() {
  const { t } = useTranslation();
  return (l: Pick<StorageLocation, "label" | "default">) => (l.default ? t("storage.default") : l.label);
}

/** Pick a disk: one card per disk with its free space, and a custom folder in Expert mode. */
export function StoragePicker({
  info,
  value,
  onChange,
  needBytes,
}: {
  info: StorageInfo;
  value: string;
  onChange: (path: string) => void;
  /** Shows a warning on disks without this much free space. */
  needBytes?: number;
}) {
  const { t } = useTranslation();
  const label = useLocationLabel();
  const [run, busy] = useAction();
  const [custom, setCustom] = useState("");
  const [extra, setExtra] = useState<StorageLocation[]>([]);
  const all = [...info.locations, ...extra.filter((e) => !info.locations.some((l) => l.path === e.path))];

  const check = async () => {
    const r = await run(() => post<{ path: string; freeBytes: number }>("/api/storage/check", { path: custom }));
    if (!r) return;
    if (!all.some((l) => l.path === r.path)) setExtra((x) => [...x, { path: r.path, label: r.path, freeBytes: r.freeBytes, totalBytes: 0, default: false }]);
    onChange(r.path);
    setCustom("");
  };

  return (
    <div className="stack-sm">
      <div className="choices">
        {all.map((l) => {
          const low = needBytes !== undefined && l.freeBytes < needBytes;
          return (
            <button key={l.path} type="button" className="choice" aria-pressed={value === l.path} onClick={() => onChange(l.path)}>
              <b>{label(l)}</b>
              <small className="mono" style={{ overflowWrap: "anywhere" }}>
                {l.path}
              </small>
              {l.totalBytes > 0 && <Meter value={l.totalBytes - l.freeBytes} max={l.totalBytes} />}
              <small>{t("storage.free", { free: formatBytes(l.freeBytes), total: l.totalBytes ? formatBytes(l.totalBytes) : "?" })}</small>
              {low && <small style={{ color: "var(--gold)" }}>{t("storage.tooSmall")}</small>}
            </button>
          );
        })}
      </div>
      {info.mountHint && <p className="hint">{t("storage.mountHint")}</p>}
      <Expert title={t("storage.customTitle")}>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input
            id="storage-custom"
            className="mono"
            style={{ flex: 1, minWidth: 0 }}
            value={custom}
            placeholder={t("storage.customPlaceholder")}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void check())}
          />
          <button type="button" className="btn stone" disabled={busy || !custom.trim()} onClick={check}>
            {t("storage.check")}
          </button>
        </div>
        <p className="hint">{t("storage.customHint")}</p>
      </Expert>
    </div>
  );
}

/** Progress of a move to another disk. */
export function MoveProgress({ job }: { job: CopyJob }) {
  const { t } = useTranslation();
  if (job.state === "failed") return <div className="notice error">{t("storage.moveFailed", { reason: t(`errors.${job.error}`, { defaultValue: job.error }) })}</div>;
  if (job.state === "done") return <div className="notice ok">{t("storage.moveDone")}</div>;
  return (
    <div className="stack-sm">
      <Meter value={job.copied} max={Math.max(1, job.total)} />
      <span className="hint">{t("storage.moving", { copied: formatBytes(job.copied), total: formatBytes(job.total) })}</span>
    </div>
  );
}
