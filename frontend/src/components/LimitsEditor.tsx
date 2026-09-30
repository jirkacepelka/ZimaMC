import { useTranslation } from "react-i18next";
import { formatMB } from "../api";

/** Sliders for the global limit: how much of the machine all servers together may use. */
export function LimitsEditor({
  host,
  value,
  onChange,
}: {
  host: { memoryMB: number; cpus: number };
  value: { memoryMB: number; cpus: number };
  onChange: (v: { memoryMB: number; cpus: number }) => void;
}) {
  const { t } = useTranslation();
  const memPct = host.memoryMB ? Math.round((value.memoryMB / host.memoryMB) * 100) : 0;
  const cpuPct = host.cpus ? Math.round((value.cpus / host.cpus) * 100) : 0;
  return (
    <div className="stack">
      <label className="field">
        <span className="row">
          {t("limits.memory")}
          <span className="spacer" />
          <span className="num">
            {formatMB(value.memoryMB)} / {formatMB(host.memoryMB)} ({memPct} %)
          </span>
        </span>
        <input
          id="limit-mem"
          type="range"
          min={1024}
          max={host.memoryMB}
          step={256}
          value={value.memoryMB}
          onChange={(e) => onChange({ ...value, memoryMB: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span className="row">
          {t("limits.cpu")}
          <span className="spacer" />
          <span className="num">
            {t("limits.cores", { count: value.cpus })} / {host.cpus} ({cpuPct} %)
          </span>
        </span>
        <input
          id="limit-cpu"
          type="range"
          min={0.5}
          max={host.cpus}
          step={0.5}
          value={value.cpus}
          onChange={(e) => onChange({ ...value, cpus: Number(e.target.value) })}
        />
      </label>
      <p className="hint">{t("limits.explain")}</p>
    </div>
  );
}
