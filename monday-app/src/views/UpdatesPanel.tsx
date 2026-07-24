import { useEffect, useState } from "react";
import { getUpdates, postUpdate } from "../monday-client";

export default function UpdatesPanel({ itemId }: { itemId: string }) {
  const [list, setList] = useState<{ id: string; body: string; creator?: { name: string } }[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() { setList(await getUpdates(itemId)); }
  useEffect(() => { void load(); }, [itemId]);

  async function post() {
    if (!text.trim()) return;
    setBusy(true);
    try { await postUpdate(itemId, text.trim()); setText(""); await load(); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="dc-section-title">Updates</div>
      <textarea className="dc-field-input" rows={3} placeholder="Write an update…" value={text} onChange={e => setText(e.target.value)} />
      <div style={{ marginTop: 8 }}>
        <button className="dc-btn dc-btn-sm dc-btn-primary" disabled={busy} onClick={() => void post()}>
          {busy ? "Posting…" : "Post update"}
        </button>
      </div>
      <div style={{ marginTop: 6 }}>
        {list.map(u => (
          <div key={u.id} className="dc-upd"><b>{u.creator?.name ?? "User"}</b>&nbsp; {u.body.replace(/<[^>]+>/g, "")}</div>
        ))}
      </div>
    </div>
  );
}
