/**
 * One-shot source edit applying the reviewed mapping sheet to the CRM Contacts spec.
 * Run once with `node scripts/apply-mapping-sheet.mjs`; it is idempotent and prints what it changed.
 * Kept as a script rather than a hand edit so the exact transformation is reviewable in git.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const f = (...p) => join(here, "..", ...p);

function edit(path, pairs) {
  let s = readFileSync(path, "utf8");
  let n = 0;
  for (const [old, next] of pairs) {
    if (s.includes(next.trimStart().split("\n")[0]) && !s.includes(old)) continue; // already applied
    if (!s.includes(old)) throw new Error(`anchor not found in ${path}: ${old.slice(0, 70)}`);
    s = s.replace(old, next);
    n++;
  }
  writeFileSync(path, s);
  return n;
}

// 1. A new label dictionary for HubSpot's contact priority enum.
let n = edit(f("src", "types.ts"), [[
  `  | "contactSource" | "contactVendor" | "partnerWith";`,
  `  | "contactSource" | "contactVendor" | "partnerWith" | "contactPriority";`,
]]);

// 2. Tell the spec-driven context loader where it comes from.
n += edit(f("src", "sync.ts"), [[
  `  contactVendor: { object: "contacts", prop: "manufacturer__c" },`,
  `  contactVendor: { object: "contacts", prop: "manufacturer__c" },
  contactPriority: { object: "contacts", prop: "priority__c" },`,
]]);

// 3. The new field mappings.
n += edit(f("src", "config", "crm.ts"), [[
  `    { hs: "createdate", col: "date_mm6z33nk", type: "date", oneWay: true },
  ],
};`,
  `    { hs: "createdate", col: "date_mm6z33nk", type: "date", oneWay: true },
    // --- added 2026-09-08 from the reviewed mapping sheet ---
    // Owner assigned date. HubSpot RESETS this on reassignment, which is exactly the semantics the
    // future 24-hour follow-up reminder needs, so it is the trigger field rather than a custom counter.
    { hs: "hubspot_owner_assigneddate", col: "date_mm70pa4c", type: "date", oneWay: true },
    // Last Activity Date into a real DATE column. HubSpot sets notes_last_updated automatically from
    // calls/chats/LinkedIn/mail/meetings/notes/email/SMS/WhatsApp, so monday must never write it back.
    { hs: "notes_last_updated", col: "date_mm7054jz", type: "date", oneWay: true },
    // HubSpot priority in its OWN status column, labels seeded from the exact 4 SLA options. The board's
    // native Priority (High/Medium/Low) stays UNMAPPED — same concept name, different meaning.
    { hs: "priority__c", col: "color_mm70ahh7", type: "status", labels: "contactPriority" },
    // Sales User, DISPLAY-ONLY. \`labels: "salesUser"\` resolves the raw owner id to the person's name.
    // This does NOT reintroduce sales_user into SCOPE — scope is includeAll + mayCreateCrmCard, and
    // recInScope still ignores it for CRM. Forward-only, so a monday edit can never reassign it.
    { hs: "sales_user", col: "text_mm6sakj3", type: "text", labels: "salesUser" },
    // Vendors. manufacturer__c is MULTI-VALUE (a live record holds "49HubSpot;55Aircall") across 89
    // options, so this is interim: forward-only into the existing TEXT column, which shows the raw
    // semicolon-joined value. A seeded multi-select dropdown is the proper form and the prerequisite
    // for ever making it two-way — until then a monday edit must not reach the HubSpot enum.
    { hs: "manufacturer__c", col: "text_mm6s40ew", type: "text", labels: "contactVendor" },
  ],
};`,
]]);

console.log(`applied ${n} edit group(s)`);
