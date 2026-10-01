import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { del, get, post, type InstalledProject } from "../../api";
import { Confirm, useAction, useErrorText, useToast } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

interface Hit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl?: string;
  downloads: number;
  author: string;
  installed: boolean;
}

const Icon = ({ url }: { url?: string }) => (url ? <img src={url} alt="" loading="lazy" /> : <span className="noicon" />);

function compact(n: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

export default function Plugins({ server, reload }: ServerTabProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const errorText = useErrorText();
  const [run, busy] = useAction();
  const word = server.type === "PAPER" || server.type === "FOLIA" ? "plugins" : "mods";

  const [installed, setInstalled] = useState<InstalledProject[]>(server.projects);
  const [manual, setManual] = useState<string[]>([]);
  const [updates, setUpdates] = useState<{ projectId: string; latestName: string }[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [searchError, setSearchError] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstalledProject | null>(null);

  const loadInstalled = async () => {
    const r = await get<{ installed: InstalledProject[]; manual: string[] }>(`/api/servers/${server.id}/projects`);
    setInstalled(r.installed);
    setManual(r.manual);
  };

  const search = async (query: string, offset = 0) => {
    setSearchError("");
    try {
      const r = await get<{ hits: Hit[]; total: number }>(`/api/servers/${server.id}/projects/search?q=${encodeURIComponent(query)}&offset=${offset}`);
      setHits((h) => (offset ? [...(h ?? []), ...r.hits] : r.hits));
      setTotal(r.total);
    } catch (e) {
      setSearchError(errorText(e));
    }
  };

  useEffect(() => {
    void loadInstalled();
    void search("");
    get<{ updates: { projectId: string; latestName: string }[] }>(`/api/servers/${server.id}/projects/updates`)
      .then((r) => setUpdates(r.updates))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  useEffect(() => {
    const h = setTimeout(() => void search(q), 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const afterChange = (restartNeeded?: boolean) => {
    if (restartNeeded) toast(t("plugins.restartNeeded"));
    void loadInstalled();
    void reload();
  };

  const install = async (h: Hit) => {
    setInstalling(h.projectId);
    const r = await run(() => post<{ installed: InstalledProject[]; restartNeeded: boolean }>(`/api/servers/${server.id}/projects`, { projectId: h.projectId }));
    setInstalling(null);
    if (r) {
      const extra = r.installed.length - 1;
      toast(extra > 0 ? t("plugins.installedWithDeps", { name: h.title, count: extra }) : t("plugins.installed", { name: h.title }));
      setHits((hs) => hs?.map((x) => (r.installed.some((i) => i.projectId === x.projectId) ? { ...x, installed: true } : x)) ?? null);
      afterChange(r.restartNeeded);
    }
  };

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row">
          <h2>{t(`plugins.installedTitle.${word}`)}</h2>
          <div className="spacer" />
          {updates.length > 0 && (
            <button
              className="btn small"
              disabled={busy}
              onClick={async () => {
                const r = await run(() => post<{ updated: number; restartNeeded: boolean }>(`/api/servers/${server.id}/projects/update-all`));
                if (r) {
                  toast(t("plugins.updated", { count: r.updated }));
                  setUpdates([]);
                  afterChange(r.restartNeeded);
                }
              }}
            >
              {t("plugins.updateAll", { count: updates.length })}
            </button>
          )}
        </div>
        {installed.length === 0 && manual.length === 0 ? (
          <p className="muted">{t(`plugins.none.${word}`)}</p>
        ) : (
          <div className="list">
            {installed.map((p) => {
              const up = updates.find((u) => u.projectId === p.projectId);
              return (
                <div className="item" key={p.projectId}>
                  <Icon url={p.iconUrl} />
                  <div className="grow">
                    <b>{p.title}</b>
                    <div className="hint mono">{p.fileName}</div>
                    {up && <div className="hint" style={{ color: "var(--gold)" }}>{t("plugins.updateAvailable", { version: up.latestName })}</div>}
                  </div>
                  <button className="btn small danger" onClick={() => setRemoving(p)}>
                    {t("common.remove")}
                  </button>
                </div>
              );
            })}
            {manual.map((f) => (
              <div className="item" key={f}>
                <span className="noicon" />
                <div className="grow">
                  <b className="mono">{f}</b>
                  <div className="hint">{t("plugins.manual")}</div>
                </div>
                <button
                  className="btn small danger"
                  onClick={() => run(() => del(`/api/servers/${server.id}/projects-manual?file=${encodeURIComponent(f)}`)).then(() => afterChange(server.status === "online"))}
                >
                  {t("common.remove")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel stack">
        <h2>{t(`plugins.findTitle.${word}`)}</h2>
        <input id="plugin-search" type="search" placeholder={t(`plugins.searchPlaceholder.${word}`)} value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="hint">{t("plugins.source", { version: server.version })}</p>
        {searchError && <p className="error-text">{searchError}</p>}
        {hits && hits.length === 0 && <p className="muted">{t("plugins.noResults")}</p>}
        {hits && hits.length > 0 && (
          <div className="list">
            {hits.map((h) => (
              <div className="item" key={h.projectId}>
                <Icon url={h.iconUrl} />
                <div className="grow">
                  <b>{h.title}</b> <span className="hint">{t("plugins.by", { author: h.author })}</span>
                  <div className="hint">{h.description}</div>
                  <div className="hint">{t("plugins.downloads", { n: compact(h.downloads) })}</div>
                </div>
                {h.installed ? (
                  <span className="pill online">{t("plugins.isInstalled")}</span>
                ) : (
                  <button className="btn small" disabled={installing !== null} onClick={() => install(h)}>
                    {installing === h.projectId ? t("plugins.installing") : t("plugins.install")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {hits && hits.length < total && (
          <button className="btn stone" onClick={() => search(q, hits.length)}>
            {t("plugins.more")}
          </button>
        )}
      </div>

      {removing && (
        <Confirm
          title={t("plugins.removeTitle", { name: removing.title })}
          text={t("plugins.removeText")}
          confirmLabel={t("common.remove")}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const r = await run(() => del<{ restartNeeded: boolean }>(`/api/servers/${server.id}/projects/${removing.projectId}`));
            if (r) afterChange(r.restartNeeded);
          }}
        />
      )}
    </div>
  );
}
