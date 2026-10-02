import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { formatMB } from "../../api";
import { CopyAddress, Meter } from "../../ui";
import { PregenPanel } from "../../components/PregenPanel";
import type { ServerTabProps } from "../ServerPage";

export default function Overview({ server: s }: ServerTabProps) {
  const { t } = useTranslation();
  const a = s.address;
  return (
    <div className="stack">
      <div className="panel stack">
        <h2>{t("overview.joinTitle")}</h2>
        {a.domain && (
          <div className="stack-sm">
            <span className="muted">{t("overview.domain")}</span>
            <CopyAddress value={a.domain} />
          </div>
        )}
        {a.tunnel && (
          <div className="stack-sm">
            <span className="muted">{t("overview.tunnel")}</span>
            <CopyAddress value={a.tunnel} />
          </div>
        )}
        {a.public && !a.domain && !a.tunnel && (
          <div className="stack-sm">
            <span className="muted">{t("overview.internet")}</span>
            <CopyAddress value={a.public} />
          </div>
        )}
        {a.lan && (
          <div className="stack-sm">
            <span className="muted">{t("overview.home")}</span>
            <CopyAddress value={a.lan} />
          </div>
        )}
        {!a.domain && !a.tunnel && (
          <p className="hint">
            {t("overview.friendsHint")} <Link to={`/servers/${s.id}/domain`}>{t("overview.setupFriends")}</Link>
          </p>
        )}
      </div>

      {s.services.length > 0 && (
        <div className="panel stack">
          <h2>{t("services.title")}</h2>
          {s.services.map((svc) => (
            <div key={`${svc.protocol}:${svc.hostPort}`} className="stack-sm">
              <span className="muted">
                {svc.label || t("services.unnamed")}
                {svc.kind === "game" && ` · ${t("services.gameHint", { port: svc.hostPort, protocol: svc.protocol.toUpperCase() })}`}
              </span>
              <CopyAddress value={svc.url ?? svc.address} open={svc.url} />
              {svc.service === "bluemap" && <p className="hint">{t("services.bluemap")}</p>}
            </div>
          ))}
          <p className="hint">{t("services.hint")}</p>
        </div>
      )}

      <div className="grid2">
        <div className="panel stack-sm">
          <div className="row">
            <span className="muted">{t("server.memory")}</span>
            <div className="spacer" />
            <b className="num">{s.stats ? `${formatMB(s.stats.memoryMB)} / ${formatMB(s.containerMemoryMB)}` : "–"}</b>
          </div>
          <Meter value={s.stats?.memoryMB ?? 0} max={s.containerMemoryMB} />
        </div>
        <div className="panel stack-sm">
          <div className="row">
            <span className="muted">{t("server.cpu")}</span>
            <div className="spacer" />
            <b className="num">{s.stats ? `${Math.round(s.stats.cpuPercent)} %` : "–"}</b>
          </div>
          <Meter value={s.stats?.cpuPercent ?? 0} max={s.cpus * 100} />
        </div>
      </div>

      <div className="panel stack">
        <h2>{t("overview.playersTitle", { online: s.players.online, max: s.properties.maxPlayers })}</h2>
        {s.players.names.length ? (
          <div className="chips">
            {s.players.names.map((n) => (
              <span key={n} className="chip" style={{ paddingRight: 10 }}>
                {n}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">{t("overview.noPlayers")}</p>
        )}
      </div>

      <PregenPanel server={s} />

      <div className="panel">
        <dl className="kv">
          <dt>{t("server.type")}</dt>
          <dd>
            {t(`types.${s.type}.name`)} {s.version}
          </dd>
          <dt>{t("server.port")}</dt>
          <dd>{s.port}</dd>
          <dt>{t("server.memory")}</dt>
          <dd>{formatMB(s.memoryMB)}</dd>
          <dt>{t("server.cpu")}</dt>
          <dd>{t("limits.cores", { count: s.cpus })}</dd>
          <dt>{t("overview.lastBackup")}</dt>
          <dd>{s.backup.lastAt ? new Date(s.backup.lastAt).toLocaleString() : t("overview.never")}</dd>
        </dl>
      </div>
    </div>
  );
}
