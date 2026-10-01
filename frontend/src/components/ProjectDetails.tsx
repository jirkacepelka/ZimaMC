import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { get } from "../api";
import { Modal, useErrorText } from "../ui";

export interface ProjectInfo {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  iconUrl?: string;
  tags: string[];
  clientSide: string;
  serverSide: string;
  downloads: number;
  followers: number;
  published: string;
  updated: string;
  license?: { id: string; name: string; url?: string };
  authors: { name: string; role: string }[];
  links: { modrinth: string; source?: string; issues?: string; wiki?: string; discord?: string };
  gallery: { url: string; title?: string; description?: string }[];
  compatible: { versionId: string; name: string; number: string; type: string; published?: string; changelog: string } | null;
  installed: { versionId: string; fileName: string } | null;
}

// Links in descriptions open in a new tab, away from ZimaMC.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Render a project's Markdown description. Authors write it, so it is sanitized. */
export function renderMarkdown(md: string) {
  const html = marked.parse(md ?? "", { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "button"], FORBID_ATTR: ["style"] });
}

/** "game-mechanics" → "Game mechanics", unless the language file has a translation. */
export function useTagLabel() {
  const { t } = useTranslation();
  return (tag: string) => t(`tags.${tag}`, { defaultValue: tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ") });
}

export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);

export function ProjectDetails({
  serverId,
  projectId,
  onClose,
  action,
}: {
  serverId: string;
  projectId: string;
  onClose: () => void;
  /** Install / remove button, provided by the page that knows the current state. */
  action: (info: ProjectInfo) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const tagLabel = useTagLabel();
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"about" | "changes">("about");

  useEffect(() => {
    get<ProjectInfo>(`/api/servers/${serverId}/projects/${encodeURIComponent(projectId)}/details`)
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [serverId, projectId, errorText]);

  const body = useMemo(() => (info ? renderMarkdown(info.body) : ""), [info]);
  const changelog = useMemo(() => (info?.compatible?.changelog ? renderMarkdown(info.compatible.changelog) : ""), [info]);

  return (
    <Modal title={info?.title ?? t("common.loading")} wide onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {info && (
        <div className="stack">
          <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            {info.iconUrl ? <img className="project-icon" src={info.iconUrl} alt="" /> : <span className="project-icon" />}
            <div className="stack-sm" style={{ minWidth: 0, flex: 1 }}>
              <p>{info.description}</p>
              <p className="hint">
                {info.authors.length > 0 && <>{t("plugins.by", { author: info.authors.map((a) => a.name).join(", ") })} · </>}
                {t("plugins.downloads", { n: compact(info.downloads) })} · {t("details.updated", { date: new Date(info.updated).toLocaleDateString() })}
              </p>
            </div>
          </div>

          {info.tags.length > 0 && (
            <div className="chips">
              {info.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tagLabel(tag)}
                </span>
              ))}
            </div>
          )}

          {info.clientSide === "required" && <div className="notice warn">{t("details.clientRequired")}</div>}

          <div className="notice">
            {info.compatible ? (
              <>
                {t("details.compatible", { version: info.compatible.number })}
                {info.compatible.type !== "release" && <> · {t(`details.channel.${info.compatible.type}`)}</>}
                {info.installed && info.installed.versionId !== info.compatible.versionId && <> · {t("details.updateReady")}</>}
              </>
            ) : (
              t("details.noCompatible")
            )}
          </div>

          <div className="row">
            <div className="tabs" role="tablist">
              <button className={`tab${tab === "about" ? " active" : ""}`} role="tab" aria-selected={tab === "about"} onClick={() => setTab("about")}>
                {t("details.about")}
              </button>
              {changelog && (
                <button className={`tab${tab === "changes" ? " active" : ""}`} role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
                  {t("details.changes")}
                </button>
              )}
            </div>
            <div className="spacer" />
            {action(info)}
          </div>

          {tab === "about" && info.gallery.length > 0 && (
            <div className="gallery">
              {info.gallery.map((g) => (
                <a key={g.url} href={g.url} target="_blank" rel="noreferrer" title={g.title ?? ""}>
                  <img src={g.url} alt={g.title ?? ""} loading="lazy" />
                </a>
              ))}
            </div>
          )}

          <div className="markdown" dangerouslySetInnerHTML={{ __html: tab === "about" ? body : changelog }} />

          <div className="row hint">
            <a href={info.links.modrinth} target="_blank" rel="noreferrer">
              Modrinth
            </a>
            {info.links.source && (
              <a href={info.links.source} target="_blank" rel="noreferrer">
                {t("details.source")}
              </a>
            )}
            {info.links.wiki && (
              <a href={info.links.wiki} target="_blank" rel="noreferrer">
                {t("details.wiki")}
              </a>
            )}
            {info.links.issues && (
              <a href={info.links.issues} target="_blank" rel="noreferrer">
                {t("details.issues")}
              </a>
            )}
            {info.links.discord && (
              <a href={info.links.discord} target="_blank" rel="noreferrer">
                Discord
              </a>
            )}
            <div className="spacer" />
            {info.license && <span>{t("details.license", { name: info.license.name || info.license.id })}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
