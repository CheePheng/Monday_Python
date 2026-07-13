import { useEffect, useState } from "react";
import { Button, TextArea } from "@vibe/core";
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
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <strong>Updates</strong>
      <TextArea placeholder="Write an update…" value={text} onChange={e => setText(e.target.value)} />
      <div><Button size="small" loading={busy} disabled={busy} onClick={() => void post()}>Post update</Button></div>
      {list.map(u => (
        <div key={u.id} style={{ fontSize: 13 }}>
          <b>{u.creator?.name ?? "User"}:</b> {u.body.replace(/<[^>]+>/g, "")}
        </div>
      ))}
    </div>
  );
}
