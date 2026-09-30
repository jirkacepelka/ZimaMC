import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, del, formatBytes, get, post, put } from "../../api";
import { Confirm, Modal, useAction, useErrorText, useToast } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

interface Entry {
  name: string;
  dir: boolean;
  size: number;
  modified: string;
}

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

export default function Files({ server }: ServerTabProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const errorText = useErrorText();
  const [run, busy] = useAction();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [renaming, setRenaming] = useState<{ entry: Entry; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const base = `/api/servers/${server.id}/files`;

  const load = async (p = path) => {
    try {
      setEntries((await get<{ entries: Entry[] }>(`${base}?path=${encodeURIComponent(p)}`)).entries);
    } catch (e) {
      setEntries([]);
      toast(errorText(e), true);
    }
  };
  useEffect(() => {
    void load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, server.id]);

  const open = async (e: Entry) => {
    const p = join(path, e.name);
    if (e.dir) return setPath(p);
    try {
      const r = await get<{ content: string }>(`${base}/content?path=${encodeURIComponent(p)}`);
      setEditing({ path: p, content: r.content });
    } catch (err) {
      // Binary or huge files can't be edited here; offer a download instead.
      if (err instanceof ApiError && ["binary_file", "file_too_large"].includes(err.code)) {
        window.location.href = `${base}/download?path=${encodeURIComponent(p)}`;
      } else toast(errorText(err), true);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const form = new FormData();
    for (const f of Array.from(files)) form.append("file", f, f.name);
    try {
      const res = await fetch(`${base}/upload?path=${encodeURIComponent(path)}`, { method: "POST", body: form });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new ApiError(d.error ?? "internal", d.params ?? {});
      }
      toast(t("files.uploaded", { count: files.length }));
      await load();
    } catch (e) {
      toast(errorText(e), true);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const crumbs = path ? path.split("/") : [];

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row">
          <nav className="row" style={{ gap: 6 }} aria-label={t("files.location")}>
            <button className="link" onClick={() => setPath("")}>
              {server.name}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="row" style={{ gap: 6 }}>
                <span className="muted">/</span>
                <button className="link" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <div className="spacer" />
          <button className="btn small stone" onClick={() => setNewFolder("")}>
            {t("files.newFolder")}
          </button>
          <button className="btn small" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? t("files.uploading") : t("files.upload")}
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>
        <p className="hint">{t("files.hint")}</p>
        {entries && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("files.name")}</th>
                  <th>{t("files.size")}</th>
                  <th>{t("files.modified")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {path && (
                  <tr className="clickable" onClick={() => setPath(crumbs.slice(0, -1).join("/"))}>
                    <td className="name">↩ ..</td>
                    <td />
                    <td />
                    <td />
                  </tr>
                )}
                {entries.map((e) => (
                  <tr key={e.name} className="clickable" onClick={() => open(e)}>
                    <td className="name">
                      {e.dir ? "📁 " : ""}
                      {e.name}
                    </td>
                    <td className="num">{e.dir ? "" : formatBytes(e.size)}</td>
                    <td className="num">{new Date(e.modified).toLocaleString()}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                        {!e.dir && (
                          <a className="btn small stone" href={`${base}/download?path=${encodeURIComponent(join(path, e.name))}`}>
                            {t("common.download")}
                          </a>
                        )}
                        <button className="btn small stone" onClick={() => setRenaming({ entry: e, name: e.name })}>
                          {t("files.rename")}
                        </button>
                        <button className="btn small danger" onClick={() => setDeleting(e)}>
                          {t("common.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {t("files.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal title={editing.path} wide onClose={() => setEditing(null)}>
          <textarea
            id="file-editor"
            rows={22}
            spellCheck={false}
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
          />
          <p className="hint">{t("files.restartHint")}</p>
          <div className="row">
            <div className="spacer" />
            <button className="btn stone" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                const r = await run(() => put(`${base}/content`, editing), t("common.saved"));
                if (r) {
                  setEditing(null);
                  await load();
                }
              }}
            >
              {t("common.save")}
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm
          title={t("files.deleteTitle", { name: deleting.name })}
          text={deleting.dir ? t("files.deleteFolderText") : t("files.deleteText")}
          confirmLabel={t("common.delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await run(() => del(`${base}?path=${encodeURIComponent(join(path, deleting.name))}`));
            await load();
          }}
        />
      )}

      {renaming && (
        <Modal title={t("files.rename")} onClose={() => setRenaming(null)}>
          <input id="rename-input" autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
          <div className="row">
            <div className="spacer" />
            <button className="btn stone" onClick={() => setRenaming(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn"
              onClick={async () => {
                await run(() => post(`${base}/rename`, { from: join(path, renaming.entry.name), to: join(path, renaming.name) }));
                setRenaming(null);
                await load();
              }}
            >
              {t("common.save")}
            </button>
          </div>
        </Modal>
      )}

      {newFolder !== null && (
        <Modal title={t("files.newFolder")} onClose={() => setNewFolder(null)}>
          <input id="folder-input" autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
          <div className="row">
            <div className="spacer" />
            <button className="btn stone" onClick={() => setNewFolder(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn"
              disabled={!newFolder.trim()}
              onClick={async () => {
                await run(() => post(`${base}/mkdir`, { path: join(path, newFolder.trim()) }));
                setNewFolder(null);
                await load();
              }}
            >
              {t("common.create")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
