import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { post } from "../../api";
import { useAction } from "../../ui";
import type { ServerTabProps } from "../ServerPage";

const MAX_LINES = 1000;

function lineClass(l: string) {
  if (/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(l)) return "l-err";
  if (/\bWARN(ING)?\b/.test(l)) return "l-warn";
  if (l.startsWith("> ")) return "l-cmd";
  return "l-info";
}

export default function Console({ server }: ServerTabProps) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [run, busy] = useAction();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let buf = "";
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/servers/${server.id}/console`);
      ws.onopen = () => setLines([]);
      ws.onmessage = (ev) => {
        buf += String(ev.data);
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        // Strip ANSI colour codes from the log.
        const clean = parts
          .map((p) =>
            p
              .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
              .replace(/§x(§[0-9a-f]){6}/gi, "")
              .replace(/§[0-9a-fk-orx]/gi, "")
              .replace(/\r$/, ""),
          )
          // ZimaMC's own RCON connections (one per command) are just noise.
          .filter((p) => !/Thread RCON Client .* (started|shutting down)/.test(p) && !/^\s*(started|shutting down)\s*$/.test(p));
        setLines((ls) => [...ls, ...clean].slice(-MAX_LINES));
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [server.id]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHIdx(-1);
    setCmd("");
    const r = await run(() => post<{ output: string }>(`/api/servers/${server.id}/command`, { command: c }));
    setLines((ls) => [...ls, `> ${c}`, ...(r?.output ? r.output.split("\n") : [])].slice(-MAX_LINES));
  };

  const online = server.status === "online";

  return (
    <div className="stack">
      <div
        className="console"
        role="log"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 && <span className="muted">{server.status === "offline" ? t("console.offline") : t("console.waiting")}</span>}
        {lines.map((l, i) => (
          <div key={i} className={lineClass(l)}>
            {l}
          </div>
        ))}
      </div>
      <form
        className="cmd"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          id="console-cmd"
          value={cmd}
          disabled={!online}
          placeholder={online ? t("console.placeholder") : t("console.needsOnline")}
          aria-label={t("console.command")}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const i = Math.min(history.length - 1, hIdx + 1);
              setHIdx(i);
              setCmd(history[i]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(Math.max(-1, i));
              setCmd(i >= 0 ? history[i] : "");
            }
          }}
        />
        <button className="btn" disabled={!online || busy}>
          {t("console.send")}
        </button>
      </form>
      <p className="hint">{t("console.hint")}</p>
    </div>
  );
}
