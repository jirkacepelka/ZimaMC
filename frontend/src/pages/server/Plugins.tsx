import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { del, get, post, type InstalledProject } from "../../api";
import { ProjectDetails, compact, useTagLabel } from "../../components/ProjectDetails";
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
  tags: string[];
  clientRequired: boolean;
  installed: boolean;
}

const Icon = ({ url }: { url?: string }) => (url ? <img src={url} alt="" loading="lazy" /> : <span className="noicon" />);

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
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const tagLabel = useTagLabel();

  const loadInstalled = async () => {
    const r = await get<{ installed: InstalledProject[]; manual: string[] }>(`/api/servers/${server.id}/projects`);
    setInstalled(r.installed);
    setManual(r.manual);
  };

  const search = async (query: string, offset = 0, cat = category) => {
    setSearchError("");
    try {
      const params = new URLSearchParams({ q: query, offset: String(offset), category: cat });
      const r = await get<{ hits: Hit[]; total: number }>(`/api/servers/${server.id}/projects/search?${params}`);
      setHits((h) => (offset ? [...(h ?? []), ...r.hits] : r.hits));
      setTotal(r.total);
    } catch (e) {
      setSearchError(errorText(e));
    }
  };

  useEffect(() => {
    void loadInstalled();
    get<{ categories: string[] }>(`/api/servers/${server.id}/projects/categories`)
      .then((r) => setCategories(r.categories))
      .catch(() => {});
    get<{ updates: { projectId: string; latestName: string }[] }>(`/api/servers/${server.id}/projects/updates`)
      .then((r) => setUpdates(r.updates))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  useEffect(() => {
    const h = setTimeout(() => void search(q, 0, category), 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category]);

  const afterChange = (restartNeeded?: boolean) => {
    if (restartNeeded) toast(t("plugins.restartNeeded"));
    void loadInstalled();
    void reload();
  };

  const install = async (h: { projectId: string; title: string }) => {
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
                <div className="item clickable" key={p.projectId} onClick={() => setOpen(p.projectId)}>
                  <Icon url={p.iconUrl} />
                  <div className="grow">
                    <b>{p.title}</b>
                    <div className="hint mono">{p.fileName}</div>
                    {up && <div className="hint" style={{ color: "var(--gold)" }}>{t("plugins.updateAvailable", { version: up.latestName })}</div>}
                  </div>
                  <button
                    className="btn small danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRemoving(p);
                    }}
                  >
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
        {categories.length > 0 && (
          <div className="chips" role="group" aria-label={t("plugins.categories")}>
            <button className={`tag filter${category === "" ? " on" : ""}`} onClick={() => setCategory("")}>
              {t("plugins.allCategories")}
            </button>
            {categories.map((c) => (
              <button key={c} className={`tag filter${category === c ? " on" : ""}`} onClick={() => setCategory(category === c ? "" : c)}>
                {tagLabel(c)}
              </button>
            ))}
          </div>
        )}
        <p className="hint">{t("plugins.source", { version: server.version })}</p>
        {searchError && <p className="error-text">{searchError}</p>}
        {hits && hits.length === 0 && <p className="muted">{t("plugins.noResults")}</p>}
        {hits && hits.length > 0 && (
          <div className="list">
            {hits.map((h) => (
              <div className="item clickable" key={h.projectId} onClick={() => setOpen(h.projectId)}>
                <Icon url={h.iconUrl} />
                <div className="grow stack-sm" style={{ gap: 4 }}>
                  <div>
                    <b>{h.title}</b> <span className="hint">{t("plugins.by", { author: h.author })}</span>
                  </div>
                  <div className="hint">{h.description}</div>
                  <div className="chips" style={{ gap: 6 }}>
                    {h.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="tag small">
                        {tagLabel(tag)}
                      </span>
                    ))}
                    {h.clientRequired && <span className="tag small warn">{t("plugins.clientToo")}</span>}
                    <span className="hint">{t("plugins.downloads", { n: compact(h.downloads) })}</span>
                  </div>
                </div>
                {h.installed ? (
                  <span className="pill online">{t("plugins.isInstalled")}</span>
                ) : (
                  <button
                    className="btn small"
                    disabled={installing !== null}
                    onClick={(e) => {
                      e.stopPropagation();
                      void install(h);
                    }}
                  >
                    {installing === h.projectId ? t("plugins.installing") : t("plugins.install")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {hits && hits.length < total && (
          <button className="btn stone" onClick={() => search(q, hits.length, category)}>
            {t("plugins.more")}
          </button>
        )}
      </div>

      {open && (
        <ProjectDetails
          serverId={server.id}
          projectId={open}
          onClose={() => setOpen(null)}
          action={(info) => {
            const inst = installed.find((p) => p.projectId === info.projectId);
            if (inst)
              return (
                <button className="btn danger" onClick={() => setRemoving(inst)}>
                  {t("common.remove")}
                </button>
              );
            if (!info.compatible) return null;
            return (
              <button className="btn" disabled={installing !== null} onClick={() => install(info)}>
                {installing === info.projectId ? t("plugins.installing") : t("plugins.install")}
              </button>
            );
          }}
        />
      )}

      {removing && (
        <Confirm
          title={t("plugins.removeTitle", { name: removing.title })}
          text={t("plugins.removeText")}
          confirmLabel={t("common.remove")}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const r = await run(() => del<{ restartNeeded: boolean }>(`/api/servers/${server.id}/projects/${removing.projectId}`));
            if (r) {
              setHits((hs) => hs?.map((x) => (x.projectId === removing.projectId ? { ...x, installed: false } : x)) ?? null);
              afterChange(r.restartNeeded);
            }
          }}
        />
      )}
    </div>
  );
}
