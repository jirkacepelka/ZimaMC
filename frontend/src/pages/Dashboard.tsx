import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { formatBytes, formatMB, get, post, type Server } from "../api";
import { CopyAddress, Meter, StatusPill, useAction, useApp, usePoll } from "../ui";

export function bestAddress(s: Server) {
  return s.address.domain ?? s.address.tunnel ?? s.address.public ?? s.address.lan;
}

export const isUp = (s: Server) => ["online", "starting", "downloading", "stopping"].includes(s.status);

export function ServerCard({ s, onChange }: { s: Server; onChange: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [run, busy] = useAction();
  const addr = bestAddress(s);
  return (
    <article className="card">
      <div className={`art t-${s.type}`} aria-hidden="true" />
      <div className="body">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <h3 style={{ minWidth: 0 }}>{s.name}</h3>
          <div className="spacer" />
          <StatusPill status={s.status} progress={s.downloadProgress} />
        </div>
        <dl className="kv">
          <dt>{t("server.players")}</dt>
          <dd>
            {s.players.online} / {s.properties.maxPlayers}
          </dd>
          <dt>{t("server.type")}</dt>
          <dd>
            {t(`types.${s.type}.name`)} {s.version}
          </dd>
          <dt>{t("server.memory")}</dt>
          <dd>{s.stats ? `${formatMB(s.stats.memoryMB)} / ${formatMB(s.containerMemoryMB)}` : t("server.memoryReserved", { mem: formatMB(s.memoryMB) })}</dd>
        </dl>
        {addr && <CopyAddress value={addr} />}
        <div className="row">
          <button className="btn stone" onClick={() => nav(`/servers/${s.id}`)}>
            {t("server.manage")}
          </button>
          {isUp(s) ? (
            <button className="btn danger" disabled={busy || s.status === "stopping"} onClick={() => run(() => post(`/api/servers/${s.id}/stop`)).then(onChange)}>
              {t("server.stop")}
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/servers/${s.id}/start`)).then(onChange)}>
              {t("server.start")}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { system, reloadSystem } = useApp();
  const [servers, setServers] = useState<Server[] | null>(null);

  const load = async () => {
    const r = await get<{ servers: Server[] }>("/api/servers").catch(() => null);
    if (r) setServers(r.servers);
    await reloadSystem().catch(() => {});
  };
  usePoll(load, 3000);

  const usage = system?.usage;
  const running = servers?.filter(isUp).length ?? 0;

  return (
    <main>
      {system && !system.docker && (
        <div className="notice error">
          {t("errors.docker_unavailable")}
          {system.platform === "win32" && (
            <>
              {" "}
              <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">
                {t("windows.getDocker")}
              </a>
            </>
          )}
        </div>
      )}
      {system?.docker && system.platform === "win32" && <div className="notice">{t(system.runtime === "native" ? "windows.stayOnApp" : "windows.stayOn")}</div>}
      <div className="row">
        <div>
          <h1>{t("dashboard.title")}</h1>
          {servers && servers.length > 0 && (
            <p className="muted">{t("dashboard.running", { running, total: servers.length })}</p>
          )}
        </div>
        <div className="spacer" />
        <Link to="/new" className="btn big">
          + {t("dashboard.create")}
        </Link>
      </div>

      {usage && (
        <div className="panel usage">
          <div className="stack-sm">
            <div className="row">
              <span className="muted">{t("dashboard.memory")}</span>
              <div className="spacer" />
              <b>
                {formatMB(usage.used.memoryMB)} / {usage.limits.memoryMB ? formatMB(usage.limits.memoryMB) : "∞"}
              </b>
            </div>
            <Meter value={usage.used.memoryMB} max={usage.limits.memoryMB || system!.host.memoryMB} reserve={usage.reserved.memoryMB} />
            <span className="hint">{t("dashboard.reserved", { mem: formatMB(usage.reserved.memoryMB) })}</span>
          </div>
          <div className="stack-sm">
            <div className="row">
              <span className="muted">{t("dashboard.cpu", { cores: usage.limits.cpus || system!.host.cpus, total: system!.host.cpus })}</span>
              <div className="spacer" />
              <b>{Math.round(usage.used.cpuPercent)} %</b>
            </div>
            <Meter value={usage.used.cpuPercent} max={(usage.limits.cpus || system!.host.cpus) * 100} />
            <span className="hint">{t("dashboard.cpuHint")}</span>
          </div>
          <div className="stack-sm">
            <div className="row">
              <span className="muted">{t("dashboard.disk")}</span>
              <div className="spacer" />
              <b>{formatBytes(usage.diskBytes)}</b>
            </div>
            <span className="hint">{t("dashboard.diskHint")}</span>
          </div>
        </div>
      )}

      {servers && servers.length === 0 && (
        <div className="empty">
          <h2>{t("dashboard.emptyTitle")}</h2>
          <p>{t("dashboard.emptyText")}</p>
          <Link to="/new" className="btn big">
            {t("dashboard.createFirst")}
          </Link>
        </div>
      )}

      {servers && servers.length > 0 && (
        <div className="cards">
          {servers.map((s) => (
            <ServerCard key={s.id} s={s} onChange={load} />
          ))}
        </div>
      )}
    </main>
  );
}
