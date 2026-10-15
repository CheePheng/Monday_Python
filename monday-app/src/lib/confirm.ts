// Shared vocabulary for the in-app confirmation dialog. The tone is the whole point: a rep should be able
// to tell "you'll lose typing" from "this deletes data in HubSpot" before reading a word, which a native
// window.confirm() cannot express.

export type ConfirmTone =
  | "danger"    // destroys data outside this form (HubSpot writes, deletes)
  | "warning"   // loses unsaved work, but nothing already saved
  | "caution";  // proceeding is allowed but forfeits a safety net (e.g. duplicate detection)

export interface ConfirmOptions {
  title: string;
  message: string;
  tone?: ConfirmTone;              // defaults to "warning"
  confirmLabel?: string;           // defaults per tone
  cancelLabel?: string;            // defaults to "Cancel"
  /** Optional "you may be about to duplicate one of these" list, loaded while the dialog is open so the
   * search never delays it. Resolving to [] renders nothing. */
  loadHints?: () => Promise<string[]>;
  hintsLabel?: string;
}

export interface ToneStyle { icon: string; cls: string; confirmLabel: string; confirmCls: string }

export const TONES: Record<ConfirmTone, ToneStyle> = {
  danger:  { icon: "⚠", cls: "dc-confirm-danger",  confirmLabel: "Delete",   confirmCls: "dc-btn-danger-solid" },
  warning: { icon: "!", cls: "dc-confirm-warning", confirmLabel: "Discard",  confirmCls: "dc-btn-warning-solid" },
  caution: { icon: "?", cls: "dc-confirm-caution", confirmLabel: "Continue", confirmCls: "dc-btn-primary" },
};

/** Resolve an options object to what the dialog actually renders. */
export function resolveConfirm(o: ConfirmOptions): {
  tone: ConfirmTone; style: ToneStyle; confirmLabel: string; cancelLabel: string;
  /** Danger focuses Cancel, so a stray Enter can never delete anything. */
  focus: "confirm" | "cancel";
} {
  const tone = o.tone ?? "warning";
  const style = TONES[tone];
  return {
    tone, style,
    confirmLabel: o.confirmLabel ?? style.confirmLabel,
    cancelLabel: o.cancelLabel ?? "Cancel",
    focus: tone === "danger" ? "cancel" : "confirm",
  };
}
