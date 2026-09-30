import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { get, patch, post } from "../../api";
import { useAction, useToast } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

type ListName = "whitelist" | "ops" | "banned";
interface Data {
  online: { online: number; max: number; names: string[] };
  whitelist: string[];
  ops: string[];
  banned: string[];
  whitelistEnabled: boolean;
}

function PlayerList({ list, names, onChange }: { list: ListName; names: string[]; onChange: (name: string, add: boolean) => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  return (
    <div className="panel stack">
      <div>
        <h2>{t(`players.${list}.title`)}</h2>
        <p className="hint">{t(`players.${list}.text`)}</p>
      </div>
      <div className="chips">
        {names.length === 0 && <span className="muted">{t("players.empty")}</span>}
        {names.map((n) => (
          <span key={n} className="chip">
            {n}
            <button aria-label={t("common.remove")} onClick={() => onChange(n, false)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        className="cmd"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await onChange(name.trim(), true);
          setName("");
        }}
      >
        <input id={`add-${list}`} value={name} maxLength={16} placeholder={t("players.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        <button className="btn">{t("common.add")}</button>
      </form>
    </div>
  );
}

export default function Players({ server, reload }: ServerTabProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [run] = useAction();
  const [data, setData] = useState<Data | null>(null);

  const load = async () => setData(await get<Data>(`/api/servers/${server.id}/players`));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, server.status]);

  const change = (list: ListName) => async (name: string, add: boolean) => {
    const r = await run(() => post<{ output: string }>(`/api/servers/${server.id}/players`, { list, name, add }));
    if (r !== undefined) {
      if (r.output) toast(r.output);
      // The server writes its files a moment after the command.
      setTimeout(() => void load(), 600);
    }
  };

  if (!data) return null;
  return (
    <div className="stack">
      <div className="panel stack">
        <h2>{t("players.onlineTitle", { online: data.online.online, max: data.online.max })}</h2>
        {data.online.names.length === 0 ? (
          <p className="muted">{server.status === "online" ? t("overview.noPlayers") : t("players.serverOffline")}</p>
        ) : (
          <div className="list">
            {data.online.names.map((n) => (
              <div className="item" key={n}>
                <b className="grow">{n}</b>
                <button className="btn small stone" onClick={() => change("ops")(n, !data.ops.includes(n))}>
                  {data.ops.includes(n) ? t("players.deop") : t("players.op")}
                </button>
                <button className="btn small stone" onClick={() => run(() => post(`/api/servers/${server.id}/players/kick`, { name: n })).then(load)}>
                  {t("players.kick")}
                </button>
                <button className="btn small danger" onClick={() => change("banned")(n, true)}>
                  {t("players.ban")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel stack">
        <label className="check">
          <input
            type="checkbox"
            checked={server.properties.whitelist}
            onChange={async (e) => {
              const on = e.target.checked;
              const r = await run(() => patch(`/api/servers/${server.id}`, { properties: { whitelist: on } }));
              if (r && server.status === "online") await run(() => post(`/api/servers/${server.id}/command`, { command: on ? "whitelist on" : "whitelist off" }));
              await reload();
            }}
          />
          {t("players.whitelistToggle")}
        </label>
        <p className="hint">{t("players.whitelistHint")}</p>
      </div>

      {server.properties.whitelist && <PlayerList list="whitelist" names={data.whitelist} onChange={change("whitelist")} />}
      <PlayerList list="ops" names={data.ops} onChange={change("ops")} />
      <PlayerList list="banned" names={data.banned} onChange={change("banned")} />
    </div>
  );
}
