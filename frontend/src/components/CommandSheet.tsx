import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { get, type CommandInfo } from "../api";
import { Modal } from "../ui";

interface Live {
  usage: string;
  description?: string;
}
interface Data {
  plugins: { name: string; commands: CommandInfo[] }[];
  live: Live[] | null;
  /** Add-ons with their own section below, e.g. "chunky". */
  known?: string[];
}

/** Everyday commands every Minecraft server knows. The texts live in the language files under console.basic. */
const BASIC: [string, string][] = [
  ["list", "list"],
  ["say", "say Hello everyone"],
  ["op", "op <player>"],
  ["whitelist", "whitelist add <player>"],
  ["gamemode", "gamemode creative <player>"],
  ["tp", "tp <player> <player>"],
  ["give", "give <player> diamond 64"],
  ["time", "time set day"],
  ["weather", "weather clear"],
  ["difficulty", "difficulty normal"],
  ["gamerule", "gamerule keepInventory true"],
  ["kick", "kick <player>"],
  ["ban", "ban <player>"],
  ["seed", "seed"],
  ["save", "save-all"],
  ["stop", "stop"],
];

/** Chunky, the world pre-generator: set the area first (radius, center, shape), then start. */
const CHUNKY: [string, string][] = [
  ["start", "chunky start"],
  ["pause", "chunky pause"],
  ["continue", "chunky continue"],
  ["cancel", "chunky cancel"],
  ["progress", "chunky progress"],
  ["radius", "chunky radius 2500"],
  ["center", "chunky center 0 0"],
  ["spawn", "chunky spawn"],
  ["world", "chunky world world"],
  ["shape", "chunky shape circle"],
  ["selection", "chunky selection"],
  ["trim", "chunky trim"],
  ["confirm", "chunky confirm"],
  ["help", "chunky help"],
];

export default function CommandSheet({ serverId, online, onPick, onClose }: { serverId: string; online: boolean; onPick: (cmd: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    get<Data>(`/api/servers/${serverId}/commands`)
      .then(setData)
      .catch(() => setData({ plugins: [], live: null, known: [] }))
      .finally(() => setLoading(false));
  }, [serverId]);

  const needle = q.trim().toLowerCase().replace(/^\//, "");
  const match = (...s: (string | undefined)[]) => !needle || s.some((x) => x?.toLowerCase().includes(needle));
  const strip = (s: string) => s.replace(/^\//, "");

  const basic = BASIC.filter(([k, ex]) => match(k, ex, t(`console.basic.${k}`)));
  const plugins = useMemo(
    () =>
      (data?.plugins ?? [])
        .map((p) => ({ ...p, commands: p.commands.filter((c) => match(c.name, c.description, c.aliases?.join(" "))) }))
        .filter((p) => p.commands.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, needle],
  );
  const live = (data?.live ?? []).filter((c) => match(c.usage, c.description));
  const chunky = data?.known?.includes("chunky") ? CHUNKY.filter(([k, ex]) => match(k, ex, t(`console.chunky.${k}`))) : [];

  const row = (key: string, cmd: string, label: string, desc?: string, extra?: string) => (
    <button key={key} className="cmd-row" onClick={() => onPick(cmd)} title={t("console.insert")}>
      <code className="mono">{label}</code>
      <span className="hint">{desc}</span>
      {extra && <span className="hint">{extra}</span>}
    </button>
  );

  return (
    <Modal title={t("console.cheatTitle")} wide onClose={onClose}>
      <div className="stack">
        <input type="search" autoFocus placeholder={t("console.cheatSearch")} value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="hint">{t("console.cheatHint")}</p>

        {chunky.length > 0 && (
          <section className="stack-sm">
            <h3>{t("console.chunkyTitle")}</h3>
            <p className="hint">{t("console.chunkyHint")}</p>
            <div className="cmd-list">{chunky.map(([k, ex]) => row(`chunky-${k}`, ex, `/${ex}`, t(`console.chunky.${k}`)))}</div>
          </section>
        )}

        {basic.length > 0 && (
          <section className="stack-sm">
            <h3>{t("console.cheatBasic")}</h3>
            <div className="cmd-list">{basic.map(([k, ex]) => row(k, ex, `/${ex}`, t(`console.basic.${k}`)))}</div>
          </section>
        )}

        {plugins.filter((p) => !(chunky.length > 0 && p.name.toLowerCase() === "chunky")).map((p) => (
          <section key={p.name} className="stack-sm">
            <h3>{p.name}</h3>
            <div className="cmd-list">
              {p.commands.map((c) =>
                row(p.name + c.name, c.name, c.usage ?? `/${c.name}`, c.description, c.aliases?.length ? t("console.aliases", { list: c.aliases.map((a) => `/${a}`).join(", ") }) : undefined),
              )}
            </div>
          </section>
        ))}

        <section className="stack-sm">
          <h3>{t("console.cheatLive")}</h3>
          {loading ? (
            <p className="muted">{t("common.loading")}</p>
          ) : !online ? (
            <p className="muted">{t("console.cheatLiveOffline")}</p>
          ) : live.length === 0 ? (
            <p className="muted">{needle ? t("plugins.noResults") : t("console.cheatLiveEmpty")}</p>
          ) : (
            <div className="cmd-list">{live.map((c) => row(c.usage, strip(c.usage).replace(/\s*[<[(].*$/, "") + " ", c.usage, c.description))}</div>
          )}
          {!loading && online && <p className="hint">{t("console.cheatLiveNote")}</p>}
        </section>
      </div>
    </Modal>
  );
}
