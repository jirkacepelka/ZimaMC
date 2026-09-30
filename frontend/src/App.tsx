import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { get, post, put, type SystemInfo } from "./api";
import { languages, setLanguage } from "./i18n";
import Dashboard from "./pages/Dashboard";
import GlobalSettings from "./pages/GlobalSettings";
import { Login, Setup } from "./pages/Auth";
import NewServer from "./pages/NewServer";
import ServerPage from "./pages/ServerPage";
import { AppContext } from "./ui";

type Phase = "loading" | "setup" | "login" | "limits" | "ready" | "error";

export default function App() {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [system, setSystem] = useState<SystemInfo | null>(null);

  const reloadSystem = useCallback(async () => {
    setSystem(await get<SystemInfo>("/api/system"));
  }, []);

  const boot = useCallback(async () => {
    try {
      const s = await get<{ setUp: boolean; loggedIn: boolean; language: string }>("/api/status");
      if (!s.setUp) return setPhase("setup");
      if (!s.loggedIn) return setPhase("login");
      await reloadSystem();
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [reloadSystem]);

  useEffect(() => {
    void boot();
    const onLogout = () => setPhase("login");
    window.addEventListener("zimamc:logout", onLogout);
    return () => window.removeEventListener("zimamc:logout", onLogout);
  }, [boot]);

  // The saved language on the server wins over the browser's on a new device.
  useEffect(() => {
    const lang = system?.settings.language;
    if (lang && lang !== i18n.language && languages.some((l) => l.code === lang)) setLanguage(lang);
  }, [system?.settings.language, i18n.language]);

  if (phase === "loading") return <div className="auth" />;
  if (phase === "error")
    return (
      <div className="auth">
        <div className="panel">
          <h2>{t("app.unreachableTitle")}</h2>
          <p>{t("app.unreachable")}</p>
          <button className="btn" onClick={() => void boot()}>
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  if (phase === "setup") return <Setup onDone={() => reloadSystem().then(() => setPhase("limits"))} />;
  if (phase === "login") return <Login onDone={() => void boot()} />;
  // `key` makes this a fresh component, so its sliders start from the suggested values.
  if (phase === "limits" && system) return <Setup key="limits" limitsOnly system={system} onDone={() => reloadSystem().then(() => setPhase("ready"))} />;

  const advanced = Boolean(system?.settings.showAdvanced);

  return (
    <AppContext.Provider value={{ system, reloadSystem, advanced }}>
      <header className="nav">
        <Link to="/" className="logo">
          <i aria-hidden="true" />
          ZimaMC
        </Link>
        <nav className="tabs">
          <NavLink to="/" end className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            {t("nav.servers")}
          </NavLink>
          <NavLink to="/new" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            {t("nav.newServer")}
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
            {t("nav.settings")}
          </NavLink>
        </nav>
        <div className="spacer" />
        <label className="check" title={t("nav.advancedHint")}>
          <input
            type="checkbox"
            checked={advanced}
            onChange={async (e) => {
              await put("/api/settings", { showAdvanced: e.target.checked });
              await reloadSystem();
            }}
          />
          <span className="hint" style={{ color: "var(--fg)" }}>
            {t("nav.advanced")}
          </span>
        </label>
        <select
          aria-label={t("nav.language")}
          value={i18n.language}
          style={{ width: "auto", padding: "4px 8px" }}
          onChange={async (e) => {
            setLanguage(e.target.value);
            await put("/api/settings", { language: e.target.value }).catch(() => {});
          }}
        >
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          className="link"
          onClick={async () => {
            await post("/api/logout").catch(() => {});
            setPhase("login");
          }}
        >
          {t("nav.logout")}
        </button>
      </header>
      <div className="grass" aria-hidden="true" />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<NewServer />} />
        <Route path="/servers/:id/*" element={<ServerPage />} />
        <Route path="/settings" element={<GlobalSettings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppContext.Provider>
  );
}
