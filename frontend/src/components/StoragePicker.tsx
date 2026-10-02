import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, get, post } from "../api";
import { Expert, Meter, Modal, useErrorText } from "../ui";

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
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [extra, setExtra] = useState<StorageLocation[]>([]);
  const all = [...info.locations, ...extra.filter((e) => !info.locations.some((l) => l.path === e.path))];

  /** Check a folder (typed, pasted from ZimaOS Files, or picked) and select its ZimaMC folder. */
  const check = async (folder: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await post<{ path: string; freeBytes: number; totalBytes: number }>("/api/storage/check", { path: folder });
      const name = r.path.replace(/[\\/]ZimaMC$/, "").split(/[\\/]/).pop() || r.path;
      if (!all.some((l) => l.path === r.path)) setExtra((x) => [...x, { path: r.path, label: name, freeBytes: r.freeBytes, totalBytes: r.totalBytes, default: false }]);
      onChange(r.path);
      setCustom("");
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
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
      <Expert title={t("storage.customTitle")} open={Boolean(error) || undefined}>
        <div className="row">
          <button
            type="button"
            className="btn stone"
            onClick={() => {
              setError("");
              setBrowsing(true);
            }}
          >
            {t("storage.browse")}
          </button>
          <span className="hint">{t("storage.or")}</span>
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input
            id="storage-custom"
            className="mono"
            style={{ flex: 1, minWidth: 0 }}
            value={custom}
            placeholder={t("storage.customPlaceholder")}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void check(custom))}
          />
          <button type="button" className="btn stone" disabled={busy || !custom.trim()} onClick={() => check(custom)}>
            {t("storage.check")}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        <p className="hint">{t("storage.customHint")}</p>
      </Expert>
      {browsing && (
        <FolderBrowser
          onClose={() => setBrowsing(false)}
          onPick={async (folder) => {
            if (await check(folder)) setBrowsing(false);
          }}
          busy={busy}
          error={error}
        />
      )}
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

interface Listing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

/** Click through the disks ZimaMC can reach instead of typing a path. */
function FolderBrowser({ onPick, onClose, busy, error }: { onPick: (path: string) => void; onClose: () => void; busy: boolean; error: string }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [cur, setCur] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState("");

  const open = useCallback(
    async (p?: string) => {
      setLoadError("");
      try {
        setCur(await get<Listing>(`/api/storage/browse${p ? `?path=${encodeURIComponent(p)}` : ""}`));
      } catch (e) {
        setLoadError(errorText(e));
      }
    },
    [errorText],
  );
  useEffect(() => {
    void open();
  }, [open]);

  const atRoots = !cur?.path;
  return (
    <Modal title={t("storage.browseTitle")} wide onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <button type="button" className="btn small stone" disabled={atRoots} onClick={() => open(cur?.parent || undefined)}>
            ↑ {t("storage.up")}
          </button>
          <span className="mono" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
            {atRoots ? t("storage.disks") : cur?.path}
          </span>
        </div>
        {loadError && <p className="error-text">{loadError}</p>}
        <div className="list folder-list">
          {cur?.dirs.length === 0 && <div className="item muted">{t("storage.noFolders")}</div>}
          {cur?.dirs.map((d) => (
            <button key={d.path} type="button" className="item clickable" onClick={() => open(d.path)}>
              <span aria-hidden>📁</span>
              <span className="grow mono">{d.name}</span>
            </button>
          ))}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          {!atRoots && <span className="hint mono" style={{ overflowWrap: "anywhere" }}>{t("storage.willUse", { path: `${cur?.path}/ZimaMC`.replace(/\/\/+/g, "/") })}</span>}
          <div className="spacer" />
          <button type="button" className="btn stone" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn" disabled={atRoots || busy} onClick={() => cur && onPick(cur.path)}>
            {t("storage.useFolder")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
