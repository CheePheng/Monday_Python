import { useEffect, useRef, useState } from "react";

interface Props { onNewDeal: () => void; onNewContact: () => void; onNewCompany: () => void }

/** Header creation actions. Wide screens: three inline buttons. Narrow screens (CSS): a single "＋ Create"
 * split button with a dropdown. Creation is an action, never a permanent tab. */
export default function CreateMenu({ onNewDeal, onNewContact, onNewCompany }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div className="dc-create" ref={ref}>
      <div className="dc-create-inline">
        <button className="dc-btn" onClick={onNewCompany}>＋ New Company</button>
        <button className="dc-btn" onClick={onNewContact}>＋ New Contact</button>
        <button className="dc-btn dc-btn-primary" onClick={onNewDeal}>＋ New Deal</button>
      </div>
      <div className="dc-create-compact">
        <button className="dc-btn dc-btn-primary" onClick={() => setOpen(o => !o)}>＋ Create ▾</button>
        {open && (
          <div className="dc-create-dropdown">
            <button className="dc-create-item" onClick={() => pick(onNewDeal)}>New Deal</button>
            <button className="dc-create-item" onClick={() => pick(onNewContact)}>New Contact</button>
            <button className="dc-create-item" onClick={() => pick(onNewCompany)}>New Company</button>
          </div>
        )}
      </div>
    </div>
  );
}
