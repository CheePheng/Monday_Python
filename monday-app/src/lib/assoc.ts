import { recordFormToProperties, type RecordKind, type RecordFormValues } from "./record-form";

/** A staged deal↔record (or record↔record) link. Existing records carry a hubspotId; a NEW record staged
 * for create-on-save carries a `create` payload instead. `itemId` (the monday card) is filled on resolve. */
export interface Assoc {
  label: string;
  hubspotId?: string;
  itemId?: string;
  create?: { properties: Record<string, string>; key: string }; // pending create-on-save (Phase A endpoint)
}

/** A staged create that hasn't been turned into a real record yet. */
export function isPendingCreate(a: Assoc): boolean { return !!a.create && !a.hubspotId; }

/** Build a pending-create Assoc from a filled record form + a stable idempotency key. */
export function buildCreateAssoc(kind: RecordKind, values: RecordFormValues, key: string): Assoc {
  const properties = recordFormToProperties(kind, values);
  const label = kind === "contact"
    ? ([values.firstname, values.lastname].map(s => s?.trim()).filter(Boolean).join(" ") || values.email?.trim() || "New contact")
    : (values.name?.trim() || values.domain?.trim() || "New company");
  return { label, create: { key, properties } };
}
