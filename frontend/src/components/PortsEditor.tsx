import { useState } from "react";
import { useTranslation } from "react-i18next";
import { put, type ExtraPort, type Server } from "../api";
import { useAction, useToast } from "../ui";

type Row = { containerPort: string; hostPort: string; protocol: "tcp" | "udp"; label: string };

/** Expert: extra ports to publish, e.g. for a plugin ZimaMC doesn't know. */
export function PortsEditor({ server, onSaved }: { server: Server; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [run, busy] = useAction();
  const auto = (server.extraPorts ?? []).filter((p) => p.service);
  const [rows, setRows] = useState<Row[]>(
    (server.extraPorts ?? [])
      .filter((p) => !p.service)
      .map((p) => ({ containerPort: String(p.containerPort), hostPort: String(p.hostPort), protocol: p.protocol, label: p.label })),
  );
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 5);

  return (
    <div className="stack-sm">
      <b>{t("ports.title")}</b>
      <p className="hint">{t("ports.hint")}</p>
      {auto.map((p: ExtraPort) => (
        <div key={`${p.protocol}:${p.hostPort}`} className="hint">
          {t("ports.auto", { label: p.label, host: p.hostPort, container: p.containerPort, protocol: p.protocol.toUpperCase() })}
        </div>
      ))}
      {rows.map((r, i) => (
        <div key={i} className="ports-row">
          <input aria-label={t("ports.label")} placeholder={t("ports.label")} value={r.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} />
          <input aria-label={t("ports.container")} placeholder={t("ports.container")} inputMode="numeric" value={r.containerPort} onChange={(e) => set(i, { containerPort: digits(e.target.value) })} />
          <input aria-label={t("ports.host")} placeholder={t("ports.host")} inputMode="numeric" value={r.hostPort} onChange={(e) => set(i, { hostPort: digits(e.target.value) })} />
          <select aria-label={t("ports.protocol")} value={r.protocol} onChange={(e) => set(i, { protocol: e.target.value as "tcp" | "udp" })}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
          <button className="btn small danger" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
            {t("common.remove")}
          </button>
        </div>
      ))}
      <div className="row">
        <button className="btn small stone" onClick={() => setRows((rs) => [...rs, { containerPort: "", hostPort: "", protocol: "tcp", label: "" }])}>
          + {t("ports.add")}
        </button>
        <div className="spacer" />
        <button
          className="btn small"
          disabled={busy || rows.some((r) => !r.containerPort)}
          onClick={async () => {
            const r = await run(() =>
              put<{ restartNeeded: boolean }>(`/api/servers/${server.id}/ports`, {
                ports: rows.map((x) => ({
                  containerPort: Number(x.containerPort),
                  hostPort: Number(x.hostPort || x.containerPort),
                  protocol: x.protocol,
                  label: x.label,
                })),
              }),
            );
            if (r) {
              toast(r.restartNeeded ? t("settings.savedRestart") : t("common.saved"));
              onSaved();
            }
          }}
        >
          {t("ports.save")}
        </button>
      </div>
    </div>
  );
}
