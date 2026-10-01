import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, type ServerStatus, type SystemInfo } from "./api";

// ---------- app-wide context ----------

export interface AppCtx {
  system: SystemInfo | null;
  reloadSystem: () => Promise<void>;
  advanced: boolean;
}
export const AppContext = createContext<AppCtx>({ system: null, reloadSystem: async () => {}, advanced: false });
export const useApp = () => useContext(AppContext);

// ---------- errors ----------

/** Turn an API error into a sentence in the current language. */
export function useErrorText() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const key = `errors.${e.code}`;
        const params = { ...e.params } as Record<string, unknown>;
        for (const k of ["need", "free"]) {
          if (typeof params[k] === "number" && e.code === "limit_memory") params[k] = `${((params[k] as number) / 1024).toFixed(1)} GB`;
        }
        return i18n.exists(key) ? t(key, params) : t("errors.internal", { message: e.code });
      }
      return t("errors.internal", { message: String((e as Error)?.message ?? e) });
    },
    [t, i18n],
  );
}

// ---------- toasts ----------

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, error }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), error ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Run an async action, showing errors as a toast. Returns [run, busy]. */
export function useAction() {
  const toast = useToast();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast(errorText(e), true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast, errorText],
  );
  return [run, busy] as const;
}

// ---------- modal ----------

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <h2 style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p>{text}</p>
      {children}
      <div className="row">
        <div className="spacer" />
        <button className="btn stone" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          className={`btn${danger ? " danger" : ""}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- small pieces ----------

export function StatusPill({ status, progress }: { status: ServerStatus; progress?: number }) {
  const { t } = useTranslation();
  return (
    <span className={`pill ${status}`}>
      {t(`status.${status}`)}
      {status === "downloading" && progress !== undefined ? ` ${progress} %` : ""}
    </span>
  );
}

export function Meter({ value, max, reserve }: { value: number; max: number; reserve?: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const rpct = max > 0 && reserve ? Math.min(100, (reserve / max) * 100) : 0;
  const cls = pct > 90 ? " bad" : pct > 75 ? " warn" : "";
  return (
    <div className={`meter${cls}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      {rpct > 0 && <span className="reserve" style={{ width: `${rpct}%` }} />}
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Copy text to the clipboard. The modern API only works on https or localhost,
 * and ZimaOS is usually opened over plain http, so fall back to the classic
 * select-and-copy way.
 */
export async function copyText(text: string) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export function CopyAddress({ value, open }: { value: string; open?: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const text = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className={`addr${state === "copied" ? " flash" : ""}`}>
      <span ref={text}>{value}</span>
      <span className="addr-actions">
        {open && (
          <a href={open} target="_blank" rel="noreferrer">
            {t("common.open")}
          </a>
        )}
        <button
          type="button"
          className={state === "copied" ? "copied" : ""}
          onClick={async () => {
            const ok = await copyText(value);
            if (!ok && text.current) {
              // Copying is blocked: select the text so Ctrl+C works.
              const range = document.createRange();
              range.selectNodeContents(text.current);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }
            setState(ok ? "copied" : "failed");
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setState("idle"), ok ? 1600 : 4000);
          }}
        >
          {state === "copied" ? `✓ ${t("common.copied")}` : state === "failed" ? t("common.pressCtrlC") : t("common.copy")}
        </button>
      </span>
    </div>
  );
}

/** Call `fn` now and every `ms` while the component is mounted and the tab is visible. */
export function usePoll(fn: () => Promise<unknown> | void, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && document.visibilityState === "visible") void ref.current();
    };
    tick();
    const h = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

export function Expert({ title, children, open }: { title?: string; children: ReactNode; open?: boolean }) {
  const { t } = useTranslation();
  const { advanced } = useApp();
  return (
    <details className="expert" open={open ?? advanced}>
      <summary>{title ?? t("common.expertSettings")}</summary>
      <div>{children}</div>
    </details>
  );
}
