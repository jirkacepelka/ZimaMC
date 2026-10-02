import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { del, formatBytes, get, patch, post } from "../../api";
import { Confirm, useAction } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

interface Backup {
  file: string;
  kind: "full" | "incremental";
  size: number;
  /** Incremental backups: data new in this one. */
  added?: number;
  createdAt: string;
  auto: boolean;
}

const FREQUENCIES = [6, 12, 24, 48, 168];

export default function Backups({ server, reload }: ServerTabProps) {
  const { t } = useTranslation();
  const [run, busy] = useAction();
  const [list, setList] = useState<Backup[] | null>(null);
  const [diskBytes, setDiskBytes] = useState(0);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);

  const load = async () => {
    const r = await get<{ backups: Backup[]; diskBytes: number }>(`/api/servers/${server.id}/backups`);
    setList(r.backups);
    setDiskBytes(r.diskBytes);
  };
  const mode = server.backup.mode ?? "incremental";
  const on = server.backup.everyHours > 0;
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const saveSchedule = async (b: Partial<typeof server.backup>) => {
    await run(() => patch(`/api/servers/${server.id}`, { backup: b }), t("common.saved"));
    await reload();
  };

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row">
          <h2>{t("backups.title")}</h2>
          <div className="spacer" />
          <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/servers/${server.id}/backups`), t("backups.done")).then(load)}>
            {busy ? t("backups.working") : t("backups.now")}
          </button>
        </div>
        <p className="hint">
          {t("backups.explain")}
          {list && list.length > 0 && <> {t("backups.diskUse", { size: formatBytes(diskBytes) })}</>}
        </p>
        {list && list.length === 0 && <p className="muted">{t("backups.none")}</p>}
        {list && list.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("backups.date")}</th>
                  <th>{t("backups.size")}</th>
                  <th>{t("backups.kind")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.file}>
                    <td className="num">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="num">
                      {formatBytes(b.size)}
                      {b.kind === "incremental" && b.added !== undefined && <div className="hint">{t("backups.added", { size: formatBytes(b.added) })}</div>}
                    </td>
                    <td>
                      {b.auto ? t("backups.auto") : t("backups.manual")}
                      <div className="hint">{t(`backups.modeShort.${b.kind}`)}</div>
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                        <button className="btn small stone" onClick={() => setRestoring(b)}>
                          {t("backups.restore")}
                        </button>
                        <a className="btn small stone" href={`/api/servers/${server.id}/backups/download?file=${encodeURIComponent(b.file)}`}>
                          {t("common.download")}
                        </a>
                        <button className="btn small danger" onClick={() => setDeleting(b)}>
                          {t("common.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel stack">
        <h2>{t("backups.scheduleTitle")}</h2>
        <label className="check">
          <input id="backup-on" type="checkbox" checked={on} onChange={(e) => saveSchedule({ everyHours: e.target.checked ? 24 : 0 })} />
          {t("backups.autoOn")}
        </label>
        {on ? (
          <div className="grid2">
            <label className="field">
              {t("backups.every")}
              <select id="backup-every" value={server.backup.everyHours} onChange={(e) => saveSchedule({ everyHours: Number(e.target.value) })}>
                {[...new Set([...FREQUENCIES, server.backup.everyHours])].map((h) => (
                  <option key={h} value={h}>
                    {t("backups.hours", { count: h })}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t("backups.keep")}
              <select id="backup-keep" value={server.backup.keep} onChange={(e) => saveSchedule({ keep: Number(e.target.value) })}>
                {[3, 5, 7, 14, 30].map((n) => (
                  <option key={n} value={n}>
                    {t("backups.keepN", { count: n })}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <p className="muted">{t("backups.offText")}</p>
        )}
        <p className="hint">{t("backups.scheduleHint")}</p>
      </div>

      <div className="panel stack">
        <h2>{t("backups.modeTitle")}</h2>
        <div className="choices">
          {(["incremental", "full"] as const).map((m) => (
            <button key={m} type="button" className="choice" aria-pressed={mode === m} onClick={() => mode !== m && saveSchedule({ mode: m })}>
              <b>{t(`backups.mode.${m}.name`)}</b>
              <small>{t(`backups.mode.${m}.text`)}</small>
            </button>
          ))}
        </div>
        <p className="hint">{t("backups.modeHint")}</p>
      </div>

      {restoring && (
        <Confirm
          title={t("backups.restoreTitle")}
          text={
            server.status === "offline" || server.status === "crashed"
              ? t("backups.restoreText", { date: new Date(restoring.createdAt).toLocaleString() })
              : t("backups.restoreStopFirst")
          }
          confirmLabel={t("backups.restore")}
          danger
          onClose={() => setRestoring(null)}
          onConfirm={async () => {
            await run(() => post(`/api/servers/${server.id}/backups/restore`, { file: restoring.file }), t("backups.restored"));
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={t("backups.deleteTitle")}
          text={new Date(deleting.createdAt).toLocaleString()}
          confirmLabel={t("common.delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await run(() => del(`/api/servers/${server.id}/backups?file=${encodeURIComponent(deleting.file)}`));
            await load();
          }}
        />
      )}
    </div>
  );
}
