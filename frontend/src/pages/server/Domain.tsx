import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { del, get, post, put } from "../../api";
import { CopyAddress, useAction, useApp, useErrorText } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

interface NetInfo {
  lanIp?: string;
  publicIp?: string;
  cgnat: boolean;
  upnp: boolean;
  cloudflare: { connected: boolean; tokenUrl: string };
  playit: { connected: boolean; agentRunning: boolean };
}
interface Zone {
  id: string;
  name: string;
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "mc";

function Level({ n, done, title, text, children, actions }: { n: number; done: boolean; title: string; text: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="stack-sm">
      <div className={`level${done ? " done" : ""}`}>
        <span className="n">{done ? "✓" : n}</span>
        <div className="stack-sm" style={{ minWidth: 0 }}>
          <h3>{title}</h3>
          <div className="hint">{text}</div>
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export default function Domain({ server, reload }: ServerTabProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { advanced, reloadSystem } = useApp();
  const [run, busy] = useAction();
  const [net, setNet] = useState<NetInfo | null>(null);
  const [check, setCheck] = useState<{ reachable: boolean; unknown?: boolean; target: string } | null>(null);
  const [open, setOpen] = useState<"cf" | "playit" | null>(null);

  // Cloudflare
  const [token, setToken] = useState("");
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zoneId, setZoneId] = useState("");
  const [name, setName] = useState(slug(server.name));
  const [cfError, setCfError] = useState("");

  // playit
  const [claimUrl, setClaimUrl] = useState("");
  const [claimState, setClaimState] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadNet = async () => setNet(await get<NetInfo>("/api/network"));
  useEffect(() => {
    void loadNet();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  useEffect(() => {
    if (net?.cloudflare.connected && open === "cf" && !zones) {
      get<{ zones: Zone[] }>("/api/network/cloudflare/zones")
        .then((r) => {
          setZones(r.zones);
          setZoneId(server.domain?.zoneId ?? r.zones[0]?.id ?? "");
        })
        .catch((e) => setCfError(errorText(e)));
    }
  }, [net?.cloudflare.connected, open, zones, server.domain?.zoneId, errorText]);

  if (!net) return null;
  const addr = server.address;
  const zone = zones?.find((z) => z.id === zoneId);
  const preview = zone ? (name && name !== "@" ? `${name}.${zone.name}` : zone.name) : "";

  const startClaim = async () => {
    const r = await run(() => post<{ url: string }>("/api/network/playit/claim"));
    if (!r) return;
    setClaimUrl(r.url);
    setClaimState("WaitingForUserVisit");
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const s = await get<{ state: string }>("/api/network/playit/claim");
        setClaimState(s.state);
        if (s.state === "Connected" || s.state === "UserRejected") {
          clearInterval(poll.current!);
          await loadNet();
          await reloadSystem();
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  };

  return (
    <div className="stack">
      <div>
        <h2>{t("domain.title")}</h2>
        <p className="muted">{t("domain.intro")}</p>
      </div>

      {net.cgnat && <div className="notice warn">{t("domain.cgnat")}</div>}

      <div className="levels">
        {/* Level 1: public IP + port */}
        <Level
          n={1}
          done={Boolean(check?.reachable)}
          title={t("domain.l1.title")}
          text={
            addr.public ? (
              <>
                {t("domain.l1.text")} <b style={{ color: "var(--fg)" }}>{addr.public}</b>
              </>
            ) : (
              t("domain.l1.noIp")
            )
          }
          actions={
            <>
              <button className="btn small stone" disabled={busy} onClick={() => run(() => post(`/api/servers/${server.id}/network/open-port`), t("domain.l1.opened"))}>
                {t("domain.l1.openPort")}
              </button>
              <button
                className="btn small"
                disabled={busy || server.status !== "online"}
                title={server.status !== "online" ? t("domain.needsOnline") : undefined}
                onClick={async () => {
                  const r = await run(() => post<{ reachable: boolean; unknown?: boolean; target: string }>(`/api/servers/${server.id}/network/check`));
                  if (r) setCheck(r);
                }}
              >
                {t("domain.l1.test")}
              </button>
            </>
          }
        >
          {check && (
            <div className={`notice ${check.reachable ? "ok" : check.unknown ? "warn" : "error"}`}>
              {check.reachable ? t("domain.l1.ok", { target: check.target }) : check.unknown ? t("domain.l1.unknown") : t("domain.l1.fail", { port: server.port })}
            </div>
          )}
          {advanced && (
            <p className="hint">
              {t("domain.l1.manual", { port: server.port, ip: net.lanIp ?? "?" })}
            </p>
          )}
        </Level>

        {/* Level 2: own domain via Cloudflare */}
        <Level
          n={2}
          done={Boolean(server.domain)}
          title={t("domain.l2.title")}
          text={server.domain ? <CopyAddress value={addr.domain!} /> : t("domain.l2.text")}
          actions={
            server.domain ? (
              <>
                <button className="btn small stone" onClick={() => setOpen(open === "cf" ? null : "cf")}>
                  {t("domain.change")}
                </button>
                <button className="btn small danger" disabled={busy} onClick={() => run(() => del(`/api/servers/${server.id}/domain`)).then(reload)}>
                  {t("common.remove")}
                </button>
              </>
            ) : (
              <button className="btn small" onClick={() => setOpen(open === "cf" ? null : "cf")}>
                {t("domain.l2.setup")}
              </button>
            )
          }
        >
          {open === "cf" && (
            <div className="panel stack">
              {!net.cloudflare.connected ? (
                <>
                  <h3>{t("domain.l2.connectTitle")}</h3>
                  <ol className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
                    <li>{t("domain.l2.step0")}</li>
                    <li>
                      <a href={net.cloudflare.tokenUrl} target="_blank" rel="noreferrer">
                        {t("domain.l2.step1link")}
                      </a>{" "}
                      {t("domain.l2.step1")}
                    </li>
                    <li>{t("domain.l2.step2")}</li>
                  </ol>
                  <label className="field">
                    {t("domain.l2.token")}
                    <input id="cf-token" value={token} autoComplete="off" placeholder={t("domain.l2.tokenPlaceholder")} onChange={(e) => setToken(e.target.value)} />
                  </label>
                  {cfError && <p className="error-text">{cfError}</p>}
                  <div className="row">
                    <div className="spacer" />
                    <button
                      className="btn"
                      disabled={busy || !token.trim()}
                      onClick={async () => {
                        setCfError("");
                        try {
                          const r = await post<{ zones: Zone[] }>("/api/network/cloudflare", { token });
                          setZones(r.zones);
                          setZoneId(r.zones[0]?.id ?? "");
                          setToken("");
                          await loadNet();
                        } catch (e) {
                          setCfError(errorText(e));
                        }
                      }}
                    >
                      {t("domain.l2.connect")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid2">
                    <label className="field">
                      {t("domain.l2.name")}
                      <input id="cf-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().trim())} />
                    </label>
                    <label className="field">
                      {t("domain.l2.zone")}
                      <select id="cf-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)} disabled={!zones}>
                        {zones?.map((z) => (
                          <option key={z.id} value={z.id}>
                            {z.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {preview && <CopyAddress value={preview} />}
                  <p className="hint">{t("domain.l2.what", { port: server.port })}</p>
                  {cfError && <p className="error-text">{cfError}</p>}
                  <div className="row">
                    {advanced && (
                      <button className="link" onClick={() => run(() => del("/api/network/cloudflare")).then(loadNet).then(reload)}>
                        {t("domain.l2.disconnect")}
                      </button>
                    )}
                    <div className="spacer" />
                    <button
                      className="btn"
                      disabled={busy || !zone}
                      onClick={async () => {
                        setCfError("");
                        try {
                          await put(`/api/servers/${server.id}/domain`, { zoneId, zoneName: zone!.name, name: name || "@" });
                          setOpen(null);
                          await reload();
                        } catch (e) {
                          setCfError(errorText(e));
                        }
                      }}
                    >
                      {t("domain.l2.apply")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </Level>

        {/* Level 3: playit.gg tunnel */}
        <Level
          n={3}
          done={Boolean(server.tunnel?.address)}
          title={t("domain.l3.title")}
          text={
            server.tunnel ? (
              server.tunnel.address ? (
                <CopyAddress value={server.tunnel.address} />
              ) : (
                t("domain.l3.waiting")
              )
            ) : (
              t("domain.l3.text")
            )
          }
          actions={
            server.tunnel ? (
              <button className="btn small danger" disabled={busy} onClick={() => run(() => del(`/api/servers/${server.id}/tunnel`)).then(reload)}>
                {t("common.remove")}
              </button>
            ) : net.playit.connected ? (
              <button className="btn small" disabled={busy} onClick={() => run(() => post(`/api/servers/${server.id}/tunnel`)).then(reload)}>
                {t("domain.l3.create")}
              </button>
            ) : (
              <button className="btn small stone" onClick={() => setOpen(open === "playit" ? null : "playit")}>
                {t("domain.l3.setup")}
              </button>
            )
          }
        >
          {open === "playit" && !net.playit.connected && (
            <div className="panel stack">
              <p>{t("domain.l3.explain")}</p>
              {!claimUrl ? (
                <div className="row">
                  <div className="spacer" />
                  <button className="btn" disabled={busy} onClick={startClaim}>
                    {t("domain.l3.connect")}
                  </button>
                </div>
              ) : (
                <>
                  <ol className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
                    <li>
                      <a href={claimUrl} target="_blank" rel="noreferrer">
                        {t("domain.l3.openClaim")}
                      </a>
                    </li>
                    <li>{t("domain.l3.approve")}</li>
                  </ol>
                  <p className="hint">{t(`domain.l3.state.${claimState}`, { defaultValue: claimState })}</p>
                </>
              )}
            </div>
          )}
          {advanced && net.playit.connected && (
            <p className="hint">
              {t("domain.l3.agent", { state: net.playit.agentRunning ? t("status.online") : t("status.offline") })}{" "}
              <button className="link" onClick={() => run(() => del("/api/network/playit")).then(loadNet).then(reload)}>
                {t("domain.l3.disconnect")}
              </button>
            </p>
          )}
        </Level>
      </div>

      {addr.lan && (
        <div className="panel stack-sm">
          <span className="muted">{t("overview.home")}</span>
          <CopyAddress value={addr.lan} />
        </div>
      )}
    </div>
  );
}
