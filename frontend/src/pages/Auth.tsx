import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { post, put, type SystemInfo } from "../api";
import { LimitsEditor } from "../components/LimitsEditor";
import { languages, setLanguage } from "../i18n";
import { useErrorText } from "../ui";

function Brand() {
  return (
    <div className="logo" style={{ fontSize: 28 }}>
      <i aria-hidden="true" />
      ZimaMC
    </div>
  );
}

export function Setup({ onDone, limitsOnly, system }: { onDone: () => void; limitsOnly?: boolean; system?: SystemInfo }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [limits, setLimits] = useState(system?.suggestedLimits ?? { memoryMB: 0, cpus: 0 });

  if (limitsOnly && system) {
    return (
      <div className="auth">
        <div className="panel" style={{ maxWidth: 560 }}>
          <Brand />
          <div className="steps">
            <span className="step done">1 · {t("setup.stepAccount")}</span>
            <span className="step cur">2 · {t("setup.stepLimits")}</span>
          </div>
          <h2>{t("setup.limitsTitle")}</h2>
          <p className="muted">{t("setup.limitsText")}</p>
          <LimitsEditor host={system.host} value={limits} onChange={setLimits} />
          <div className="row">
            <div className="spacer" />
            <button
              className="btn big"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await put("/api/settings", { limits });
                  onDone();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("setup.finish")}
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) return setError(t("setup.mismatch"));
    setBusy(true);
    setError("");
    try {
      await post("/api/setup", { password, language: i18n.language });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="panel" onSubmit={submit}>
        <Brand />
        <div className="steps">
          <span className="step cur">1 · {t("setup.stepAccount")}</span>
          <span className="step">2 · {t("setup.stepLimits")}</span>
        </div>
        <h2>{t("setup.welcome")}</h2>
        <p className="muted">{t("setup.intro")}</p>
        <label className="field">
          {t("nav.language")}
          <select id="setup-lang" value={i18n.language} onChange={(e) => setLanguage(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("setup.password")}
          <input id="setup-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        </label>
        <label className="field">
          {t("setup.passwordAgain")}
          <input id="setup-pw2" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
        <p className="hint">{t("setup.passwordHint")}</p>
        {error && <p className="error-text">{error}</p>}
        <button className="btn big" disabled={busy}>
          {t("setup.continue")}
        </button>
      </form>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await post("/api/login", { password });
            onDone();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Brand />
        <h2>{t("login.title")}</h2>
        <label className="field">
          {t("setup.password")}
          <input id="login-pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn big" disabled={busy}>
          {t("login.submit")}
        </button>
        <p className="hint">{t("login.forgot")}</p>
      </form>
    </div>
  );
}
