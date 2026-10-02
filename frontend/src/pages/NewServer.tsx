import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { formatMB, get, post, type Server, type ServerType } from "../api";
import { ChunkyPlanner } from "../components/ChunkyPlanner";
import { StoragePicker, useStorage } from "../components/StoragePicker";
import { Expert, useApp, useErrorText, useToast } from "../ui";

const SIZES = {
  small: { memoryMB: 2048 },
  medium: { memoryMB: 4096 },
  large: { memoryMB: 8192 },
} as const;
type Size = keyof typeof SIZES;

/** "Mods" is one simple choice; Fabric vs Forge is picked in a second row. */
type Kind = "plugins" | "vanilla" | "mods";
const kindToType = (k: Kind, loader: "FABRIC" | "FORGE", pluginServer: "PAPER" | "FOLIA"): ServerType =>
  k === "plugins" ? pluginServer : k === "vanilla" ? "VANILLA" : loader;

export default function NewServer() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const errorText = useErrorText();
  const { system, advanced } = useApp();

  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("plugins");
  const [loader, setLoader] = useState<"FABRIC" | "FORGE">("FABRIC");
  const [pluginServer, setPluginServer] = useState<"PAPER" | "FOLIA">("PAPER");
  const [versions, setVersions] = useState<string[] | null>(null);
  const [versionError, setVersionError] = useState("");
  const [version, setVersion] = useState("");
  const [size, setSize] = useState<Size>("small");
  const [memoryMB, setMemoryMB] = useState<number>(SIZES.small.memoryMB);
  const [cpus, setCpus] = useState(2);
  const [players, setPlayers] = useState("");
  const [storageInfo] = useStorage();
  const [storage, setStorage] = useState("");
  const [chunky, setChunky] = useState<boolean | null>(null);
  const [backups, setBackups] = useState(true);
  const [radius, setRadius] = useState<number | null>(null);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const type = kindToType(kind, loader, pluginServer);
  const limits = system?.settings.limits;
  const maxMem = limits?.memoryMB ? limits.memoryMB - 512 : (system?.host.memoryMB ?? 16384);
  const maxCpu = limits?.cpus || system?.host.cpus || 4;
  const overhead = (m: number) => m + Math.max(512, Math.round(m * 0.25));
  const playersOk = Number(players) >= 1 && Number(players) <= 500;
  // Limits of running servers may add up to more than the budget; just say so.
  const overBudget = Boolean(limits?.memoryMB) && overhead(memoryMB) + (system?.usage.reserved.memoryMB ?? 0) > (limits?.memoryMB ?? 0);

  useEffect(() => {
    setVersions(null);
    setVersionError("");
    get<{ versions: string[] }>(`/api/versions/${type}`)
      .then((r) => {
        setVersions(r.versions);
        setVersion("");
      })
      .catch((e) => setVersionError(errorText(e)));
  }, [type, errorText]);

  useEffect(() => setCpus(Math.min(2, maxCpu)), [maxCpu]);

  const where = storage || storageInfo?.locations[0]?.path || "";
  // Measure this machine quietly in the background, so the Chunky estimate is ready by the last step.
  useEffect(() => {
    post("/api/benchmark", { storage: where }).catch(() => {});
  }, [where]);

  // Plugin and mod servers get a last step offering Chunky.
  const worldStep = kind !== "vanilla";
  const showStorage = Boolean(storageInfo && (storageInfo.locations.length > 1 || advanced || storageInfo.mountHint));

  const pickSize = (s: Size) => {
    setSize(s);
    setMemoryMB(Math.min(SIZES[s].memoryMB, maxMem));
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      type Problem = { error: string; params: Record<string, unknown> };
      const r = await post<{ server: Server; startError?: Problem; pregenError?: Problem }>("/api/servers", {
        name,
        type,
        version: version || versions?.[0],
        size,
        maxPlayers: Number(players),
        memoryMB,
        cpus,
        port: port ? Number(port) : undefined,
        storage: storage || undefined,
        backup: { everyHours: backups ? 24 : 0 },
        pregen: worldStep && chunky && radius ? { radius } : undefined,
      });
      if (r.pregenError) toast(t("chunky.installFailed", { reason: t(`errors.${r.pregenError.error}`, { ...r.pregenError.params, defaultValue: r.pregenError.error }) }), true);
      if (r.startError) toast(t("newServer.createdNotStarted", { reason: t(`errors.${r.startError.error}`, r.startError.params) }), true);
      else toast(t("newServer.created"));
      nav(`/servers/${r.server.id}/console`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <h1>{t("newServer.title")}</h1>
      <div className="steps">
        {[t("newServer.stepName"), t("newServer.stepGame"), t("newServer.stepSize"), ...(worldStep ? [t("newServer.stepWorld")] : [])].map((label, i) => (
          <span key={label} className={`step${step === i + 1 ? " cur" : step > i + 1 ? " done" : ""}`}>
            {i + 1} · {label}
          </span>
        ))}
      </div>

      {step === 1 && (
        <form
          className="panel stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setStep(2);
          }}
        >
          <h2>{t("newServer.nameTitle")}</h2>
          <label className="field">
            {t("newServer.nameLabel")}
            <input id="new-name" autoFocus maxLength={40} value={name} placeholder={t("newServer.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row">
            <div className="spacer" />
            <button className="btn big" disabled={!name.trim()}>
              {t("common.next")}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="panel stack">
          <h2>{t("newServer.gameTitle")}</h2>
          <div className="choices">
            {(["plugins", "vanilla", "mods"] as Kind[]).map((k) => (
              <button key={k} type="button" className="choice" aria-pressed={kind === k} onClick={() => setKind(k)}>
                <b>{t(`newServer.kind.${k}.name`)}</b>
                <small>{t(`newServer.kind.${k}.text`)}</small>
              </button>
            ))}
          </div>
          {kind === "plugins" && (
            <div className="choices">
              {(["PAPER", "FOLIA"] as const).map((l) => (
                <button key={l} type="button" className="choice" aria-pressed={pluginServer === l} onClick={() => setPluginServer(l)}>
                  <b>{t(`types.${l}.name`)}</b>
                  <small>{t(`types.${l}.text`)}</small>
                </button>
              ))}
            </div>
          )}
          {kind === "mods" && (
            <div className="choices">
              {(["FABRIC", "FORGE"] as const).map((l) => (
                <button key={l} type="button" className="choice" aria-pressed={loader === l} onClick={() => setLoader(l)}>
                  <b>{t(`types.${l}.name`)}</b>
                  <small>{t(`types.${l}.text`)}</small>
                </button>
              ))}
            </div>
          )}
          <label className="field">
            {t("newServer.version")}
            <select id="new-version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={!versions}>
              <option value="">{versions?.[0] ? t("newServer.latest", { version: versions[0] }) : t("common.loading")}</option>
              {versions?.slice(1, 60).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {versionError && <p className="error-text">{versionError}</p>}
          <p className="hint">{t("newServer.versionHint")}</p>
          <div className="row">
            <button className="btn stone" onClick={() => setStep(1)}>
              {t("common.back")}
            </button>
            <div className="spacer" />
            <button className="btn big" onClick={() => setStep(3)}>
              {t("common.next")}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="panel stack">
          <h2>{t("newServer.sizeTitle")}</h2>
          <label className="field">
            {t("newServer.playersLabel")}
            <input
              id="new-players"
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              autoFocus
              placeholder={t("newServer.playersPlaceholder")}
              value={players}
              onChange={(e) => setPlayers(e.target.value.replace(/\D/g, "").slice(0, 3))}
            />
            <span className="hint">{t("newServer.playersHint")}</span>
          </label>
          <div className="field">
            {t("newServer.sizeLabel")}
            <div className="choices">
              {(Object.keys(SIZES) as Size[]).map((s) => (
                <button key={s} type="button" className="choice" aria-pressed={size === s} onClick={() => pickSize(s)} disabled={overhead(SIZES[s].memoryMB) > (limits?.memoryMB || Infinity)}>
                  <b>{t(`newServer.size.${s}`)}</b>
                  <small>{t("newServer.memoryOf", { mem: formatMB(SIZES[s].memoryMB) })}</small>
                </button>
              ))}
            </div>
          </div>
          {kind === "mods" && <p className="hint">{t("newServer.modsMemoryHint")}</p>}
          {showStorage && storageInfo && (
            <div className="field">
              {t("storage.where")}
              <StoragePicker info={storageInfo} value={where} onChange={setStorage} />
            </div>
          )}
          {type === "FOLIA" && <p className="hint">{t("newServer.foliaHint")}</p>}
          <div className="field">
            {t("newServer.backupsLabel")}
            <div className="choices">
              <button type="button" className="choice" aria-pressed={backups} onClick={() => setBackups(true)}>
                <b>{t("newServer.backupsOn")}</b>
                <small>{t("newServer.backupsOnText")}</small>
              </button>
              <button type="button" className="choice" aria-pressed={!backups} onClick={() => setBackups(false)}>
                <b>{t("newServer.backupsOff")}</b>
                <small>{t("newServer.backupsOffText")}</small>
              </button>
            </div>
          </div>
          <Expert>
            <label className="field">
              <span className="row">
                {t("server.memory")} <span className="spacer" />
                <span className="num">{formatMB(memoryMB)}</span>
              </span>
              <input id="new-mem" type="range" min={1024} max={Math.max(1024, maxMem)} step={512} value={memoryMB} onChange={(e) => setMemoryMB(Number(e.target.value))} />
            </label>
            <label className="field">
              <span className="row">
                {t("server.cpu")} <span className="spacer" />
                <span className="num">{t("limits.cores", { count: cpus })}</span>
              </span>
              <input id="new-cpu" type="range" min={0.5} max={maxCpu} step={0.5} value={cpus} onChange={(e) => setCpus(Number(e.target.value))} />
            </label>
            <label className="field">
              {t("server.port")}
              <input id="new-port" inputMode="numeric" placeholder={t("newServer.portAuto")} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
            </label>
          </Expert>
          {overBudget && <p className="hint">{t("newServer.overBudget", { limit: formatMB(limits?.memoryMB ?? 0) })}</p>}
          <p className="hint">
            {t("newServer.eulaPrefix")}{" "}
            <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
              {t("newServer.eula")}
            </a>
            .
          </p>
          {error && <p className="error-text">{error}</p>}
          <div className="row">
            <button className="btn stone" onClick={() => setStep(2)}>
              {t("common.back")}
            </button>
            <div className="spacer" />
            {worldStep ? (
              <button className="btn big" disabled={!playersOk} onClick={() => setStep(4)}>
                {t("common.next")}
              </button>
            ) : (
              <button className="btn big" disabled={busy || !playersOk} onClick={create}>
                {busy ? t("newServer.creating") : t("newServer.create")}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 4 && worldStep && (
        <div className="panel stack">
          <h2>{t("chunky.title")}</h2>
          <p>{t("chunky.text")}</p>
          <div className="choices">
            <button type="button" className="choice" aria-pressed={chunky === true} onClick={() => setChunky(true)}>
              <b>{t("chunky.yes")}</b>
              <small>{t("chunky.yesText")}</small>
            </button>
            <button type="button" className="choice" aria-pressed={chunky === false} onClick={() => setChunky(false)}>
              <b>{t("chunky.no")}</b>
              <small>{t("chunky.noText")}</small>
            </button>
          </div>
          {chunky && <ChunkyPlanner type={type} cpus={cpus} storage={where} radius={radius} onChange={setRadius} />}
          {error && <p className="error-text">{error}</p>}
          <div className="row">
            <button className="btn stone" onClick={() => setStep(3)}>
              {t("common.back")}
            </button>
            <div className="spacer" />
            <button className="btn big" disabled={busy || chunky === null || (chunky && !radius)} onClick={create}>
              {busy ? t("newServer.creating") : t("newServer.create")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
