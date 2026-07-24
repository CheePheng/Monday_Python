import { progressSteps, isComplete } from "../lib/create-progress";
import type { CreateResult } from "../worker-client";

interface Props {
  result: CreateResult | null;   // null while the create request is in flight
  inFlight: boolean;
  canRetry: boolean;             // a failed result OR a thrown error (not in-flight, not completed)
  onRetry: () => void;
  onOpenMonday: () => void;
  onOpenHubspot: () => void;
}

function icon(status: "done" | "failed" | "pending", inFlight: boolean): string {
  if (status === "done") return "✓";
  if (status === "failed") return "⚠";
  return inFlight ? "…" : "•";
}

/** Stepwise create progress. While in flight all steps read pending with a running hint; on the result
 * each step is done / failed. Failed => Retry (re-POST with the same idempotency key). Completed => links. */
export default function CreateProgress({ result, inFlight, canRetry, onRetry, onOpenMonday, onOpenHubspot }: Props) {
  const steps = progressSteps(result);
  return (
    <div className="dc-progress">
      {steps.map(s => (
        <div key={s.key} className={"dc-progress-step " + s.status}>
          <span className="dc-progress-icon">{icon(s.status, inFlight)}</span>
          <span>{s.label}</span>
        </div>
      ))}
      {result?.existing && <div className="dc-mut" style={{ marginTop: 4 }}>Matched an existing record — reusing it (no duplicate created).</div>}
      {result?.unassigned && result.ownerMessage && <div className="dc-mut" style={{ marginTop: 4 }}>{result.ownerMessage}</div>}
      {canRetry && (
        <div style={{ marginTop: 10 }}>
          <button className="dc-btn dc-btn-sm" onClick={onRetry}>Retry</button>
        </div>
      )}
      {isComplete(result) && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="dc-btn dc-btn-sm" onClick={onOpenMonday}>Open in monday</button>
          {result?.hubspotLink && <button className="dc-btn dc-btn-sm" onClick={onOpenHubspot}>↗ Open in HubSpot</button>}
        </div>
      )}
    </div>
  );
}
