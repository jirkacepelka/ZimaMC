import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ApiError, get, post, type Server } from "../api";
import { StatusPill, useAction, useApp, usePoll } from "../ui";
import { isUp } from "./Dashboard";
import Backups from "./server/Backups";
import Console from "./server/Console";
import Domain from "./server/Domain";
import Files from "./server/Files";
import Overview from "./server/Overview";
import Players from "./server/Players";
import Plugins from "./server/Plugins";
import Settings from "./server/Settings";

export interface ServerTabProps {
  server: Server;
  reload: () => Promise<void>;
}

export default function ServerPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const nav = useNavigate();
  const { advanced } = useApp();
  const [server, setServer] = useState<Server | null>(null);
  const [gone, setGone] = useState(false);
  const [run, busy] = useAction();

  const reload = async () => {
    try {
      setServer((await get<{ server: Server }>(`/api/servers/${id}`)).server);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
    }
  };
  usePoll(reload, 3000, [id]);

  if (gone) return <Navigate to="/" replace />;
  if (!server) return <main />;

  const hasContent = server.type !== "VANILLA";
  const tabs: [string, string, boolean][] = [
    ["", t("tabs.overview"), true],
    ["console", t("tabs.console"), true],
    ["plugins", server.type === "PAPER" || server.type === "FOLIA" ? t("tabs.plugins") : t("tabs.mods"), hasContent],
    ["players", t("tabs.players"), true],
    ["domain", t("tabs.domain"), true],
    ["backups", t("tabs.backups"), true],
    ["files", t("tabs.files"), true],
    ["settings", t("tabs.settings"), true],
  ];
  const up = isUp(server);
  const props = { server, reload };

  return (
    <main>
      <div className="row">
        <h1 style={{ minWidth: 0, overflowWrap: "anywhere" }}>{server.name}</h1>
        <StatusPill status={server.status} progress={server.downloadProgress} />
        <div className="spacer" />
        {up ? (
          <>
            <button className="btn stone" disabled={busy || server.status !== "online"} onClick={() => run(() => post(`/api/servers/${id}/restart`)).then(reload)}>
              {t("server.restart")}
            </button>
            <button className="btn danger" disabled={busy || server.status === "stopping"} onClick={() => run(() => post(`/api/servers/${id}/stop`)).then(reload)}>
              {t("server.stop")}
            </button>
            {advanced && server.status === "stopping" && (
              <button className="btn danger" onClick={() => run(() => post(`/api/servers/${id}/kill`)).then(reload)}>
                {t("server.kill")}
              </button>
            )}
          </>
        ) : (
          <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/servers/${id}/start`)).then(reload)}>
            {t("server.start")}
          </button>
        )}
      </div>
      {server.problem && (server.status === "crashed" || server.status === "offline") ? (
        <div className="notice error">
          {t(`problems.${server.problem.code}`, { ...server.problem.params, defaultValue: t("server.crashed") })}{" "}
          <button className="link" onClick={() => nav(`/servers/${id}/console`)}>
            {t("server.openConsole")}
          </button>
        </div>
      ) : server.status === "crashed" && (
        <div className="notice error">
          {t("server.crashed")}{" "}
          <button className="link" onClick={() => nav(`/servers/${id}/console`)}>
            {t("server.openConsole")}
          </button>
        </div>
      )}
      <div className="split">
        <nav className="side" aria-label={t("tabs.label")}>
          {tabs
            .filter(([, , show]) => show)
            .map(([path, label]) => (
              <NavLink key={path} to={`/servers/${id}/${path}`} end={path === ""} className={({ isActive }) => (isActive ? "active" : "")}>
                {label}
              </NavLink>
            ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <Routes>
            <Route index element={<Overview {...props} />} />
            <Route path="console" element={<Console {...props} />} />
            <Route path="plugins" element={<Plugins {...props} />} />
            <Route path="players" element={<Players {...props} />} />
            <Route path="domain" element={<Domain {...props} />} />
            <Route path="backups" element={<Backups {...props} />} />
            <Route path="files" element={<Files {...props} />} />
            <Route path="settings" element={<Settings {...props} />} />
            <Route path="*" element={<Navigate to={`/servers/${id}`} replace />} />
          </Routes>
        </div>
      </div>
    </main>
  );
}
