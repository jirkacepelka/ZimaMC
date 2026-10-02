import { useState } from "react";
import { useTranslation } from "react-i18next";
import { get, post, type Server } from "../api";
import { Confirm, Meter, useAction, usePoll } from "../ui";

interface Status {
  pregen: Server["pregen"] | null;
  progress: { state: "running" | "finished" | "paused" | "cancelled"; chunks?: number; percent?: number; eta?: string; rate?: number } | null;
}

/** Progress of Chunky's world pre-generation, with pause, continue and cancel. */
export function PregenPanel({ server }: { server: Server }) {
  const { t } = useTranslation();
  const [run, busy] = useAction();
  const [status, setStatus] = useState<Status | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const online = server.status === "online";

  usePoll(
    async () => {
      if (!server.pregen) return;
      setStatus(await get<Status>(`/api/servers/${server.id}/pregen`).catch(() => null));
    },
    5000,
    [server.id, Boolean(server.pregen)],
  );

  if (!server.pregen) return null;
  const pg = server.pregen;
  const p = status?.progress;
  const send = (cmd: string) => run(() => post(`/api/servers/${server.id}/command`, { command: cmd })).then(() => setTimeout(() => void get<Status>(`/api/servers/${server.id}/pregen`).then(setStatus).catch(() => {}), 1500));
  const done = pg.state === "done" || p?.state === "finished";

  return (
    <div className="panel stack">
      <h2>{t("pregen.title")}</h2>
      {pg.state === "failed" ? (
        <div className="notice error">{t("pregen.failed")}</div>
      ) : done ? (
        <div className="notice ok">{t("pregen.done", { radius: pg.radius.toLocaleString() })}</div>
      ) : pg.state === "pending" ? (
        <p className="muted">{online ? t("pregen.starting") : t("pregen.waiting", { radius: pg.radius.toLocaleString() })}</p>
      ) : !online ? (
        <p className="muted">{pg.paused ? t("pregen.paused") : t("pregen.offline")}</p>
      ) : p && p.percent !== undefined ? (
        <div className="stack-sm">
          <Meter value={p.percent} max={100} />
          <span className="hint">
            {t("pregen.progress", { percent: p.percent.toFixed(1), chunks: (p.chunks ?? 0).toLocaleString() })}
            {p.eta && <> · {t("pregen.eta", { eta: p.eta })}</>}
            {p.rate !== undefined && <> · {t("pregen.rate", { rate: Math.round(p.rate) })}</>}
          </span>
          {p.state === "paused" && <span className="hint">{t("pregen.paused")}</span>}
          {p.state === "cancelled" && <span className="hint">{t("pregen.cancelled")}</span>}
        </div>
      ) : (
        <p className="muted">{p?.state === "paused" ? t("pregen.paused") : p?.state === "cancelled" ? t("pregen.cancelled") : t("pregen.running", { radius: pg.radius.toLocaleString() })}</p>
      )}
      {online && !done && pg.state !== "failed" && pg.state !== "pending" && (
        <div className="row">
          <span className="hint">{t("pregen.hint")}</span>
          <div className="spacer" />
          {p?.state === "paused" || p?.state === "cancelled" ? (
            <button className="btn small" disabled={busy} onClick={() => send(p.state === "cancelled" ? "chunky start" : "chunky continue")}>
              {t("pregen.continue")}
            </button>
          ) : (
            <button className="btn small stone" disabled={busy} onClick={() => send("chunky pause")}>
              {t("pregen.pause")}
            </button>
          )}
          {p?.state !== "cancelled" && (
            <button className="btn small danger" disabled={busy} onClick={() => setCancelling(true)}>
              {t("pregen.cancel")}
            </button>
          )}
        </div>
      )}
      {cancelling && (
        <Confirm
          title={t("pregen.cancelTitle")}
          text={t("pregen.cancelText")}
          confirmLabel={t("pregen.cancel")}
          danger
          onClose={() => setCancelling(false)}
          onConfirm={async () => {
            // Chunky asks for confirmation of a cancel.
            await send("chunky cancel");
            await send("chunky confirm");
          }}
        />
      )}
    </div>
  );
}
