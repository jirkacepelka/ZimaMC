import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, get, type ServerType } from "../api";

interface Estimate {
  ready: boolean;
  chunksPerSecond?: number;
  bytesPerChunk?: number;
  freeBytes?: number;
}

export const RADIUS_PRESETS = [1000, 2500, 5000];
export const chunksFor = (radius: number) => Math.ceil((2 * radius) / 16) ** 2;

/** "about 25 min", "about 1 h 40 min" */
export function useDuration() {
  const { t } = useTranslation();
  return (seconds: number) => {
    const min = Math.round(seconds / 60);
    if (min < 1) return t("time.underMinute");
    if (min < 60) return t("time.minutes", { count: min });
    return t("time.hours", { h: Math.floor(min / 60), m: min % 60 });
  };
}

/**
 * Pick how far around spawn Chunky pre-generates. Estimates come from a silent
 * benchmark in the background; until it is done the numbers show as loading.
 */
export function ChunkyPlanner({
  type,
  cpus,
  storage,
  radius,
  onChange,
}: {
  type: ServerType;
  cpus: number;
  storage: string;
  radius: number | null;
  onChange: (radius: number) => void;
}) {
  const { t } = useTranslation();
  const duration = useDuration();
  const [est, setEst] = useState<Estimate>({ ready: false });
  const [touched, setTouched] = useState(false);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const q = new URLSearchParams({ type, cpus: String(cpus), storage });
        const r = await get<Estimate>(`/api/pregen/estimate?${q}`);
        if (!alive) return;
        setEst(r);
        if (!r.ready) timer = setTimeout(poll, 1000);
      } catch {
        if (alive) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [type, cpus, storage]);

  const bytes = (r: number) => chunksFor(r) * (est.bytesPerChunk ?? 0);
  const seconds = (r: number) => chunksFor(r) / Math.max(1, est.chunksPerSecond ?? 1);
  const fits = (r: number) => est.freeBytes === undefined || bytes(r) < est.freeBytes * 0.9;

  // Suggest the biggest preset that takes about an hour at most and fits on the disk.
  const recommended = est.ready ? ([...RADIUS_PRESETS].reverse().find((r) => seconds(r) <= 3600 && fits(r)) ?? RADIUS_PRESETS[0]) : null;
  useEffect(() => {
    if (recommended && !touched) onChange(recommended);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommended, touched]);

  const pick = (r: number) => {
    setTouched(true);
    onChange(r);
  };

  const loading = <span className="loading-text">{t("chunky.calculating")}</span>;

  return (
    <div className="stack">
      <div className="choices">
        {RADIUS_PRESETS.map((r) => (
          <button key={r} type="button" className="choice" aria-pressed={radius === r} onClick={() => pick(r)}>
            <b>{t("chunky.blocks", { radius: r.toLocaleString() })}</b>
            <small>{t("chunky.area", { size: (2 * r).toLocaleString() })}</small>
            <small>{est.ready ? t("chunky.estimate", { size: formatBytes(bytes(r)), time: duration(seconds(r)) }) : loading}</small>
            {recommended === r && <small style={{ color: "var(--green-hi)" }}>{t("chunky.recommended")}</small>}
            {est.ready && !fits(r) && <small style={{ color: "var(--gold)" }}>{t("chunky.noSpace")}</small>}
          </button>
        ))}
      </div>
      <label className="field">
        {t("chunky.custom")}
        <input
          id="chunky-radius"
          type="number"
          inputMode="numeric"
          min={100}
          max={30000}
          step={100}
          placeholder={t("chunky.customPlaceholder")}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            const n = Math.round(Number(e.target.value));
            if (n >= 100 && n <= 30000) pick(n);
          }}
        />
      </label>
      {radius && (
        <div className={`notice${est.ready && !fits(radius) ? " warn" : ""}`}>
          {est.ready
            ? t("chunky.summary", {
                chunks: chunksFor(radius).toLocaleString(),
                size: formatBytes(bytes(radius)),
                time: duration(seconds(radius)),
                free: formatBytes(est.freeBytes ?? 0),
              })
            : loading}
        </div>
      )}
      <p className="hint">{t("chunky.estimateHint")}</p>
    </div>
  );
}
