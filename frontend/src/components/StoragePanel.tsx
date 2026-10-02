import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, post, put, type Server } from "../api";
import { Modal, useAction } from "../ui";
import { MoveProgress, StoragePicker, useLocationLabel, useStorage } from "./StoragePicker";

/** Where a server lives, and moving it to another disk. */
export function StoragePanel({ server, reload }: { server: Server; reload: () => Promise<void> }) {
  const { t } = useTranslation();
  const label = useLocationLabel();
  const [info, reloadInfo] = useStorage();
  const [run, busy] = useAction();
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState("");
  const here = info?.locations.find((l) => l.path === server.storagePath);
  const stopped = server.status === "offline" || server.status === "crashed";
  const copying = server.move?.state === "copying";

  return (
    <div className="panel stack">
      <h2>{t("storage.title")}</h2>
      <p>
        <b>{here ? label(here) : server.storagePath}</b>{" "}
        {here && <span className="hint">{t("storage.free", { free: formatBytes(here.freeBytes), total: here.totalBytes ? formatBytes(here.totalBytes) : "?" })}</span>}
      </p>
      <p className="hint mono" style={{ overflowWrap: "anywhere" }}>
        {server.storagePath}
      </p>
      {server.move && server.move.state !== "done" && <MoveProgress job={server.move} />}
      <div className="row">
        <span className="hint">{stopped ? t("storage.moveHint") : t("storage.stopFirst")}</span>
        <div className="spacer" />
        <button
          className="btn stone"
          disabled={!stopped || copying}
          onClick={() => {
            setTarget(server.storagePath);
            void reloadInfo();
            setMoving(true);
          }}
        >
          {t("storage.move")}
        </button>
      </div>

      {moving && info && (
        <Modal title={t("storage.moveTitle", { name: server.name })} wide onClose={() => setMoving(false)}>
          <div className="stack">
            <StoragePicker info={info} value={target} onChange={setTarget} />
            <p className="hint">{t("storage.moveText")}</p>
            <div className="row">
              <div className="spacer" />
              <button className="btn stone" onClick={() => setMoving(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn"
                disabled={busy || target === server.storagePath}
                onClick={async () => {
                  const r = await run(() => post(`/api/servers/${server.id}/move`, { storage: target }));
                  if (r) {
                    setMoving(false);
                    await reload();
                  }
                }}
              >
                {t("storage.moveConfirm")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Where backups are kept; moving them copies all existing backups too. */
export function BackupsStoragePanel() {
  const { t } = useTranslation();
  const [info, reloadInfo] = useStorage();
  const [run, busy] = useAction();
  const [target, setTarget] = useState<string | null>(null);
  const copying = info?.backupsMove?.state === "copying";
  useEffect(() => {
    if (!copying) return;
    const h = setTimeout(() => void reloadInfo(), 1000);
    return () => clearTimeout(h);
  }, [info, copying, reloadInfo]);
  if (!info) return null;
  const value = target ?? info.backups;

  return (
    <div className="panel stack">
      <h2>{t("storage.backupsTitle")}</h2>
      <p className="muted">{t("storage.backupsText")}</p>
      <StoragePicker info={info} value={value} onChange={setTarget} />
      {info.backupsMove && info.backupsMove.state !== "done" && <MoveProgress job={info.backupsMove} />}
      <div className="row">
        <div className="spacer" />
        <button
          className="btn"
          disabled={busy || copying || value === info.backups}
          onClick={async () => {
            const r = await run(() => put("/api/storage/backups", { storage: value }));
            if (r) {
              setTarget(null);
              await reloadInfo();
            }
          }}
        >
          {t("storage.moveBackups")}
        </button>
      </div>
    </div>
  );
}
