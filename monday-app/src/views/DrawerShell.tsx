import { useEffect } from "react";

interface Props {
  title: string;
  ariaLabel?: string;
  headerRight?: React.ReactNode;   // e.g. an "Open in HubSpot" button
  footer?: React.ReactNode;        // e.g. Cancel + primary buttons
  onClose: () => void;             // dirty-guarded by the parent
  children: React.ReactNode;
}

/** Right-side drawer chrome reused across create/edit surfaces (matches DealDrawer's markup). */
export default function DrawerShell({ title, ariaLabel, headerRight, footer, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dc-drawer" role="dialog" aria-label={ariaLabel ?? title}>
      <div className="dc-modal-head">
        <h2>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {headerRight}
          <button className="dc-x" onClick={onClose} aria-label="Close">×</button>
        </div>
      </div>
      <div className="dc-drawer-body">{children}</div>
      {footer && <div className="dc-modal-foot">{footer}</div>}
    </div>
  );
}
