import { DATE_PRESETS, type DatePreset } from "../lib/date-range";

export interface DateFilterValue { preset: DatePreset | ""; custom?: { from?: string; to?: string } }

/** A `dc-select`-styled date-range dropdown ("<label>: all time" cleared + presets). Selecting "Custom
 * range" reveals two date inputs. Pure control — all range math lives in lib/date-range. */
export default function DateRangeFilter({ label, value, onChange }: {
  label: string; value: DateFilterValue; onChange: (v: DateFilterValue) => void;
}) {
  return (
    <div className="dc-datefilter">
      <select className="dc-select" value={value.preset}
        onChange={e => {
          const preset = e.target.value as DatePreset | "";
          onChange({ preset, custom: preset === "custom" ? (value.custom ?? {}) : undefined });
        }}>
        <option value="">{label}: all time</option>
        {DATE_PRESETS.map(p => <option key={p.value} value={p.value}>{label}: {p.label}</option>)}
      </select>
      {value.preset === "custom" && (
        <span className="dc-daterange-custom">
          <input type="date" className="dc-input" value={value.custom?.from ?? ""}
            onChange={e => onChange({ preset: "custom", custom: { ...value.custom, from: e.target.value } })} />
          <span className="dc-mut">→</span>
          <input type="date" className="dc-input" value={value.custom?.to ?? ""}
            onChange={e => onChange({ preset: "custom", custom: { ...value.custom, to: e.target.value } })} />
        </span>
      )}
    </div>
  );
}
