import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMB, post, put } from "../api";
import { LimitsEditor } from "../components/LimitsEditor";
import { Expert, useAction, useApp } from "../ui";

export default function GlobalSettings() {
  const { t } = useTranslation();
  const { system, reloadSystem } = useApp();
  const [run, busy] = useAction();
  const [limits, setLimits] = useState(system?.settings.limits ?? { memoryMB: 0, cpus: 0 });
  const [upnp, setUpnp] = useState(system?.settings.network.upnp ?? true);
  const [lanIp, setLanIp] = useState(system?.settings.network.lanIp ?? "");
  const [publicIp, setPublicIp] = useState(system?.settings.network.publicIp ?? "");
  const [pw, setPw] = useState({ current: "", next: "", again: "" });
  const [pwError, setPwError] = useState("");

  useEffect(() => {
    if (system) setLimits(system.settings.limits);
    // Only on first load; later polls must not overwrite what the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(system)]);

  if (!system) return <main />;

  return (
    <main className="narrow">
      <h1>{t("global.title")}</h1>

      <div className="panel stack">
        <h2>{t("global.limitsTitle")}</h2>
        <p className="muted">{t("global.limitsText")}</p>
        <LimitsEditor host={system.host} value={limits} onChange={setLimits} />
        <p className="hint">{t("global.reservedNow", { mem: formatMB(system.usage.reserved.memoryMB) })}</p>
        <div className="row">
          <button className="link" onClick={() => setLimits(system.suggestedLimits)}>
            {t("global.suggested")}
          </button>
          <div className="spacer" />
          <button className="btn" disabled={busy} onClick={() => run(() => put("/api/settings", { limits }), t("common.saved")).then(reloadSystem)}>
            {t("common.save")}
          </button>
        </div>
      </div>

      <div className="panel stack">
        <h2>{t("global.networkTitle")}</h2>
        <label className="check">
          <input type="checkbox" checked={upnp} onChange={(e) => setUpnp(e.target.checked)} />
          {t("global.upnp")}
        </label>
        <p className="hint">{t("global.upnpHint")}</p>
        <Expert>
          <label className="field">
            {t("global.lanIp")}
            <input id="g-lan" value={lanIp} placeholder={t("global.auto")} onChange={(e) => setLanIp(e.target.value.trim())} />
          </label>
          <label className="field">
            {t("global.publicIp")}
            <input id="g-pub" value={publicIp} placeholder={t("global.auto")} onChange={(e) => setPublicIp(e.target.value.trim())} />
          </label>
        </Expert>
        <div className="row">
          <div className="spacer" />
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(() => put("/api/settings", { network: { upnp, lanIp, publicIp } }), t("common.saved")).then(reloadSystem)}
          >
            {t("common.save")}
          </button>
        </div>
      </div>

      <form
        className="panel stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setPwError("");
          if (pw.next !== pw.again) return setPwError(t("setup.mismatch"));
          const r = await run(() => post("/api/password", { current: pw.current, next: pw.next }), t("global.passwordChanged"));
          if (r) setPw({ current: "", next: "", again: "" });
        }}
      >
        <h2>{t("global.passwordTitle")}</h2>
        <div className="grid2">
          <label className="field">
            {t("global.currentPassword")}
            <input id="pw-cur" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </label>
          <label className="field">
            {t("global.newPassword")}
            <input id="pw-new" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </label>
          <label className="field">
            {t("setup.passwordAgain")}
            <input id="pw-again" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} />
          </label>
        </div>
        {pwError && <p className="error-text">{pwError}</p>}
        <div className="row">
          <div className="spacer" />
          <button className="btn" disabled={busy || !pw.current || !pw.next}>
            {t("global.changePassword")}
          </button>
        </div>
      </form>

      <p className="hint">
        ZimaMC {system.version} ·{" "}
        <a href="https://github.com/jirkacepelka/ZimaMC" target="_blank" rel="noreferrer">
          GitHub
        </a>{" "}
        · {t("global.addLanguage")}
      </p>
    </main>
  );
}
