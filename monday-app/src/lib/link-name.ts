// Friendly display name for a linked contact/company card. The worker names a card by its primary field
// (contact firstname / company domain); when that's empty the card name is the fallback `contacts <id>` /
// `companies <id>`. That string encodes the type, so one function cascades correctly for both boards.
//   c1 = text_mm4scke9  (contact: lastname · company: name)
//   c2 = text_mm4p2bvb  (contact: email   · company: city — deliberately NOT used for companies)
const FALLBACK_RE = /^(contacts|companies) \d+$/;

export function linkDisplayName(name: string, c1: string, c2: string): string {
  const m = FALLBACK_RE.exec(name.trim());
  if (!m) return name;                                              // a real firstname / domain
  if (m[1] === "contacts") return c1.trim() || c2.trim() || name;  // lastname -> email -> keep id
  return c1.trim() || name;                                        // company: name -> keep id (never city)
}
