import { useEffect, useRef, useState } from "react";
import { resolveConfirm, type ConfirmOptions } from "../lib/confirm";

interface Props { opts: ConfirmOptions; onDone: (ok: boolean) => void }

/** The in-app replacement for window.confirm(): tone-coded, styled like the rest of the app, and able to
 * show context (e.g. existing records you might be duplicating) that a native dialog cannot. */
export default function ConfirmDialog({ opts, onDone }: Props) {
  const { style, confirmLabel, cancelLabel, focus } = resolveConfirm(opts);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [hints, setHints] = useState<string[] | null>(null);
  const [hintsLoading, setHintsLoading] = useState(false);

  // Focus a button on open and hand focus back to whatever the rep was on when the dialog closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (focus === "cancel" ? cancelRef : confirmRef).current?.focus();
    return () => prev?.focus?.();
  }, [focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopPropagation: Escape must close only this dialog, not the drawer behind it.
      if (e.key === "Escape") { e.stopPropagation(); onDone(false); return; }
      // Trap Tab between the two buttons so focus can't wander into the drawer underneath.
      if (e.key === "Tab") {
        const a = cancelRef.current, b = confirmRef.current;
        if (!a || !b) return;
        e.preventDefault();
        (document.activeElement === a ? b : a).focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  // Hints load after the dialog is already on screen, so a slow search never delays the question itself.
  useEffect(() => {
    if (!opts.loadHints) return;
    let alive = true;
    setHintsLoading(true);
    opts.loadHints()
      .then(h => { if (alive) setHints(h); })
      .catch(() => { if (alive) setHints([]); })   // a failed lookup must not block the decision
      .finally(() => { if (alive) setHintsLoading(false); });
    return () => { alive = false; };
  }, [opts]);

  return (
    <div className="dc-confirm-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onDone(false); }}>
      <div className={`dc-confirm ${style.cls}`} role="alertdialog" aria-modal="true" aria-label={opts.title}>
        <div className="dc-confirm-body">
          <div className="dc-confirm-icon" aria-hidden="true">{style.icon}</div>
          <div style={{ minWidth: 0 }}>
            <h3 className="dc-confirm-title">{opts.title}</h3>
            <p className="dc-confirm-msg">{opts.message}</p>
            {hintsLoading && <p className="dc-mut" style={{ margin: "10px 0 0" }}>Checking for existing records…</p>}
            {hints && hints.length > 0 && (
              <div className="dc-confirm-hints">
                <div className="dc-confirm-hints-label">{opts.hintsLabel ?? "Possible matches already in HubSpot"}</div>
                <ul>{hints.map((h, i) => <li key={i}>{h}</li>)}</ul>
              </div>
            )}
          </div>
        </div>
        <div className="dc-confirm-foot">
          <button type="button" ref={cancelRef} className="dc-btn" onClick={() => onDone(false)}>{cancelLabel}</button>
          <button type="button" ref={confirmRef} className={`dc-btn ${style.confirmCls}`} onClick={() => onDone(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
