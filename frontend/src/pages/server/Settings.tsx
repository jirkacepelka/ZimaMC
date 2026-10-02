import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { del, formatMB, get, patch, type Properties, type Server } from "../../api";
import { PortsEditor } from "../../components/PortsEditor";
import { StoragePanel } from "../../components/StoragePanel";
import { Confirm, Expert, useAction, useApp, useToast } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

export default function Settings({ server, reload }: ServerTabProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const { system } = useApp();
  const [run, busy] = useAction();
  const [name, setName] = useState(server.name);
  const [props, setProps] = useState<Properties>(server.properties);
  const [memoryMB, setMemoryMB] = useState(server.memoryMB);
  const [cpus, setCpus] = useState(server.cpus);
  const [port, setPort] = useState(String(server.port));
  const [version, setVersion] = useState(server.version);
  const [versions, setVersions] = useState<string[]>([]);
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const [jvmFlags, setJvmFlags] = useState(server.advanced.jvmFlags ?? "");
  const [javaTag, setJavaTag] = useState(server.advanced.javaImageTag ?? "");
  const [extraEnv, setExtraEnv] = useState(
    Object.entries(server.advanced.extraEnv ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [deleting, setDeleting] = useState(false);
  const [keepFiles, setKeepFiles] = useState(false);

  useEffect(() => {
    get<{ versions: string[] }>(`/api/versions/${server.type}`)
      .then((r) => setVersions(r.versions))
      .catch(() => {});
  }, [server.type]);

  const limits = system?.settings.limits;
  const maxMem = limits?.memoryMB ? limits.memoryMB - 512 : (system?.host.memoryMB ?? 16384);
  const maxCpu = limits?.cpus || system?.host.cpus || 4;
  const set = <K extends keyof Properties>(k: K, v: Properties[K]) => setProps((p) => ({ ...p, [k]: v }));

  const save = async () => {
    const env = Object.fromEntries(
      extraEnv
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    const r = await run(() =>
      patch<{ server: Server; restartNeeded: boolean }>(`/api/servers/${server.id}`, {
        name,
        properties: props,
        memoryMB,
        cpus,
        port: Number(port),
        version,
        autoStart,
        advanced: { jvmFlags, javaImageTag: javaTag, extraEnv: env },
      }),
    );
    if (r) {
      toast(r.restartNeeded ? t("settings.savedRestart") : t("common.saved"));
      await reload();
    }
  };

  return (
    <div className="stack">
      <div className="panel stack">
        <h2>{t("settings.general")}</h2>
        <label className="field">
          {t("settings.name")}
          <input id="set-name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          {t("settings.motd")}
          <input id="set-motd" maxLength={120} value={props.motd} onChange={(e) => set("motd", e.target.value)} />
        </label>
        <div className="grid2">
          <label className="field">
            {t("settings.gamemode")}
            <select id="set-mode" value={props.gamemode} onChange={(e) => set("gamemode", e.target.value as Properties["gamemode"])}>
              {(["survival", "creative", "adventure", "spectator"] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`settings.modes.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("settings.difficulty")}
            <select id="set-diff" value={props.difficulty} onChange={(e) => set("difficulty", e.target.value as Properties["difficulty"])}>
              {(["peaceful", "easy", "normal", "hard"] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`settings.difficulties.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("settings.maxPlayers")}
            <input id="set-max" type="number" min={1} max={500} value={props.maxPlayers} onChange={(e) => set("maxPlayers", Number(e.target.value))} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={props.pvp} onChange={(e) => set("pvp", e.target.checked)} />
          {t("settings.pvp")}
        </label>
        <label className="check">
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
          {t("settings.autoStart")}
        </label>
      </div>

      <div className="panel stack">
        <h2>{t("settings.performance")}</h2>
        <label className="field">
          <span className="row">
            {t("server.memory")} <span className="spacer" />
            <span className="num">{formatMB(memoryMB)}</span>
          </span>
          <input id="set-mem" type="range" min={1024} max={Math.max(maxMem, memoryMB)} step={512} value={memoryMB} onChange={(e) => setMemoryMB(Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="row">
            {t("server.cpu")} <span className="spacer" />
            <span className="num">{t("limits.cores", { count: cpus })}</span>
          </span>
          <input id="set-cpu" type="range" min={0.5} max={Math.max(maxCpu, cpus)} step={0.5} value={cpus} onChange={(e) => setCpus(Number(e.target.value))} />
        </label>
        <p className="hint">{t("settings.performanceHint")}</p>
      </div>

      <StoragePanel server={server} reload={reload} />

      <Expert>
        <div className="grid2">
          <label className="field">
            {t("server.port")}
            <input id="set-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label className="field">
            {t("settings.viewDistance")}
            <input id="set-view" type="number" min={3} max={32} value={props.viewDistance} onChange={(e) => set("viewDistance", Number(e.target.value))} />
          </label>
          <label className="field">
            {t("settings.version")}
            <select id="set-version" value={version} onChange={(e) => setVersion(e.target.value)}>
              {[...new Set([server.version, ...versions])].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("settings.java")}
            <select id="set-java" value={javaTag} onChange={(e) => setJavaTag(e.target.value)}>
              <option value="">{t("settings.javaAuto")}</option>
              {["java8", "java11", "java17", "java21", "java25"].map((j) => (
                <option key={j} value={j}>
                  {j}
                </option>
              ))}
            </select>
          </label>
        </div>
        {version !== server.version && <div className="notice warn">{t("settings.versionWarn")}</div>}
        <label className="check">
          <input type="checkbox" checked={props.onlineMode} onChange={(e) => set("onlineMode", e.target.checked)} />
          {t("settings.onlineMode")}
        </label>
        {!props.onlineMode && <div className="notice warn">{t("settings.offlineWarn")}</div>}
        <label className="field">
          {t("settings.jvmFlags")}
          <input id="set-jvm" className="mono" value={jvmFlags} placeholder="-XX:+UseG1GC" onChange={(e) => setJvmFlags(e.target.value)} />
        </label>
        <label className="field">
          {t("settings.extraEnv")}
          <textarea id="set-env" rows={4} value={extraEnv} placeholder={"SPAWN_PROTECTION=0\nALLOW_FLIGHT=true"} onChange={(e) => setExtraEnv(e.target.value)} />
        </label>
        <p className="hint">
          {t("settings.extraEnvHint")}{" "}
          <a href="https://docker-minecraft-server.readthedocs.io/en/latest/configuration/server-properties/" target="_blank" rel="noreferrer">
            {t("settings.docs")}
          </a>
        </p>
        <PortsEditor server={server} onSaved={reload} />
      </Expert>

      <div className="row">
        <button className="btn danger" onClick={() => setDeleting(true)}>
          {t("settings.delete")}
        </button>
        <div className="spacer" />
        <button className="btn big" disabled={busy} onClick={save}>
          {t("common.save")}
        </button>
      </div>

      {deleting && (
        <Confirm
          title={t("settings.deleteTitle", { name: server.name })}
          text={t("settings.deleteText")}
          confirmLabel={t("settings.deleteConfirm")}
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const r = await run(() => del(`/api/servers/${server.id}?deleteFiles=${!keepFiles}`));
            if (r) nav("/");
          }}
        >
          <label className="check">
            <input type="checkbox" checked={keepFiles} onChange={(e) => setKeepFiles(e.target.checked)} />
            {t("settings.keepFiles")}
          </label>
        </Confirm>
      )}
    </div>
  );
}
