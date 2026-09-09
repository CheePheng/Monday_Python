import { describe, it, expect } from "vitest";
import {
  formatValue, buildColumnValues, itemName, expectedText, phoneStorable, PHONE_MAX_DIGITS, domainStem,
} from "../src/mapping";
import type { Ctx, FieldSpec, ObjectSpec } from "../src/types";

const ctx: Ctx = {
  labels: {
    stage: { appointmentscheduled: "Appointment Scheduled" },
    dealtype: { existingbusiness: "Existing Business", newbusiness: "New Business" },
    pipeline: { default: "Sales Pipeline" },
  },
  ownersById: { "555": { name: "Myla Mestiola", email: "myla@x.com" } },
  mondayUsersByEmail: { "myla@x.com": "1001" },
  mondayEmailByUserId: { "1001": "myla@x.com" }, ownerIdByEmail: { "myla@x.com": "555" },
  portalId: 39939588,
};

const f = (over: Partial<FieldSpec>): FieldSpec => ({ hs: "p", col: "c", type: "text", ...over });

describe("expectedText phone (digits-normalized so monday's formatted echo round-trips)", () => {
  const ph = f({ type: "phone" });
  it("strips punctuation/spaces to bare digits", () => {
    expect(expectedText(ph, "+1 (234) 567-8900", ctx)).toBe("12345678900");
    expect(expectedText(ph, "234-567-8900", ctx)).toBe("2345678900");
  });
  it("empty -> ''", () => expect(expectedText(ph, "", ctx)).toBe(""));
});

describe("formatValue", () => {
  it("status uses the label dictionary", () =>
    expect(formatValue(f({ type: "status", labels: "stage" }), "appointmentscheduled", ctx))
      .toEqual({ label: "Appointment Scheduled" }));
  it("dropdown splits multi values and maps each", () =>
    expect(formatValue(f({ type: "dropdown", labels: "dealtype" }), "existingbusiness;newbusiness", ctx))
      .toEqual({ labels: ["Existing Business", "New Business"] }));
  it("date truncates to YYYY-MM-DD", () =>
    expect(formatValue(f({ type: "date" }), "2026-06-26T02:22:45Z", ctx)).toEqual({ date: "2026-06-26" }));
  it("people resolves owner -> monday user", () =>
    expect(formatValue(f({ type: "people" }), "555", ctx))
      .toEqual({ personsAndTeams: [{ id: 1001, kind: "person" }] }));
  it("numbers becomes a string", () =>
    expect(formatValue(f({ type: "numbers" }), "5000", ctx)).toBe("5000"));
  it("null/empty is skipped", () => {
    expect(formatValue(f({}), null, ctx)).toBeNull();
    expect(formatValue(f({}), "", ctx)).toBeNull();
  });
  it("phone: international + is kept, no forced country", () =>
    expect(formatValue(f({ type: "phone" }), "+60 12-345 6789", ctx)).toEqual({ phone: "+60123456789" }));
  it("phone: local number -> raw digits, no country", () =>
    expect(formatValue(f({ type: "phone" }), "012-345 6789", ctx)).toEqual({ phone: "0123456789" }));
  it("phone: strips formatting from an international number", () =>
    expect(formatValue(f({ type: "phone" }), "+1 (555) 123-4567", ctx)).toEqual({ phone: "+15551234567" }));
});

const spec: ObjectSpec = {
  object: "deals", objectTypeId: "0-3", searchFilters: [], modifiedProp: "hs_lastmodifieddate",
  nameProps: ["dealname"], boardId: "B", idCol: "c_id", syncStateCol: "c_sync", linkCol: "c_link",
  groupBy: { singleGroup: "g" }, createFromMonday: false,
  fields: [{ hs: "dealtype", col: "c_type", type: "dropdown", labels: "dealtype" }],
};

describe("buildColumnValues / itemName", () => {
  it("includes id, mapped fields, and deep link", () => {
    const cv = buildColumnValues({ id: "9001", properties: { dealtype: "existingbusiness" } }, spec, ctx);
    expect(cv.c_id).toBe("9001");
    expect(cv.c_type).toEqual({ labels: ["Existing Business"] });
    expect(cv.c_link).toEqual({
      url: "https://app.hubspot.com/contacts/39939588/record/0-3/9001", text: "Open in HubSpot" });
  });
  it("itemName joins nameProps and falls back", () => {
    expect(itemName({ id: "1", properties: { dealname: "Acme" } }, spec)).toBe("Acme");
    expect(itemName({ id: "1", properties: {} }, spec)).toBe("deals 1");
  });

  /**
   * nameFallbackProps, added 2026-09-09 for the historical import. 3,841 of 94,318 Contacts have
   * neither firstname nor lastname and would otherwise each read "contacts <hubspot id>" — traceable
   * but unsearchable, on a board whose whole purpose is finding a contact. 3,598 of them carry an
   * email, so one fallback property recovers 94%.
   */
  describe("nameFallbackProps", () => {
    const withFallback: ObjectSpec = { ...spec, nameFallbackProps: ["email", "phone"] };

    it("is not consulted while a nameProp has a value", () =>
      expect(itemName({ id: "1", properties: { dealname: "Acme", email: "a@x.com" } }, withFallback))
        .toBe("Acme"));

    it("is used when every nameProp is empty", () =>
      expect(itemName({ id: "1", properties: { email: "a@x.com" } }, withFallback)).toBe("a@x.com"));

    it("tries fallbacks IN ORDER, so a later one only applies when the earlier is empty", () => {
      expect(itemName({ id: "1", properties: { email: "", phone: "+60123" } }, withFallback)).toBe("+60123");
      expect(itemName({ id: "1", properties: { email: "a@x.com", phone: "+60123" } }, withFallback)).toBe("a@x.com");
    });

    it("treats whitespace-only as empty, or the card gets a blank name monday would reject", () =>
      expect(itemName({ id: "1", properties: { email: "   " } }, withFallback)).toBe("deals 1"));

    it("still reaches the id when every fallback is empty too", () =>
      expect(itemName({ id: "77", properties: {} }, withFallback)).toBe("deals 77"));

    // THE REGRESSION THAT MATTERS: the live Work-Management specs declare no fallback, so their card
    // names must be byte-for-byte what they were. A rename would churn every card on those boards.
    it("changes NOTHING for a spec that does not declare it", () => {
      expect(spec.nameFallbackProps).toBeUndefined();
      expect(itemName({ id: "1", properties: { email: "a@x.com" } }, spec)).toBe("deals 1");
    });
  });

  /**
   * nameFallbackTransform: "emailLocalPart" — matthew.ng@gmail.com labels the card "matthew.ng".
   *
   * The full address is untouched in the Email column, so this only changes the label. Measured cost
   * before adopting it: of the 3,598 nameless Contacts carrying an email, 221 (6.1%) have a local part
   * that is not unique (16 "info", 9 "support", 5 "sales") where the full address collides 0 times.
   * Taken deliberately — 3,377 cards gain a readable name and the ambiguous ones stay separable by the
   * Email column — and recorded here so the trade is not rediscovered as a surprise.
   */
  describe("nameFallbackTransform: emailLocalPart", () => {
    const s: ObjectSpec = {
      ...spec, nameFallbackProps: ["email"], nameFallbackTransform: "emailLocalPart",
    };
    const name = (email: string) => itemName({ id: "42", properties: { email } }, s);

    it("takes the part before the @", () => {
      expect(name("matthew.ng@gmail.com")).toBe("matthew.ng");
      expect(name("info@acme.com.my")).toBe("info");
    });

    it("does NOT rewrite characters or guess at a human name", () => {
      // sales.apac_01 may well not be a person; inventing "Sales Apac 01" would fabricate information.
      expect(name("sales.apac_01@x.com")).toBe("sales.apac_01");
      expect(name("a-b_c.d@x.com")).toBe("a-b_c.d");
    });

    it("splits on the FIRST @, so a stray second one cannot truncate differently", () =>
      expect(name("weird@@x.com")).toBe("weird"));

    // "use the full value if it cannot be parsed normally" — a malformed address is still a better
    // card name than a bare id.
    it("uses the whole value when there is no @ at all", () =>
      expect(name("not-an-email")).toBe("not-an-email"));

    it("uses the whole value when the local part is empty", () =>
      expect(name("@x.com")).toBe("@x.com"));

    it("still falls through to the id for whitespace or a missing email", () => {
      expect(name("   ")).toBe("deals 42");
      expect(itemName({ id: "42", properties: {} }, s)).toBe("deals 42");
    });

    it("never touches a real name — the transform applies only to fallbacks", () =>
      expect(itemName({ id: "42", properties: { dealname: "Acme Bhd", email: "info@acme.com" } }, s))
        .toBe("Acme Bhd"));

    it("is inert without the transform, so declaring a fallback alone keeps the full value", () => {
      const noTransform: ObjectSpec = { ...spec, nameFallbackProps: ["email"] };
      expect(itemName({ id: "42", properties: { email: "matthew.ng@gmail.com" } }, noTransform))
        .toBe("matthew.ng@gmail.com");
    });
  });

  it("stamps the all-members team on the Shared column when the deal has NO sales_user", () => {
    const shared: ObjectSpec = { ...spec, unassignedShared: { col: "c_shared", teamId: "999" } };
    expect(buildColumnValues({ id: "1", properties: {} }, shared, ctx).c_shared)
      .toEqual({ personsAndTeams: [{ id: 999, kind: "team" }] });
    // has a sales_user -> Shared is left empty (only the salesperson can view it)
    expect(buildColumnValues({ id: "1", properties: { sales_user: "555" } }, shared, ctx).c_shared)
      .toBeUndefined();
    // disabled when teamId is "" (team not created yet)
    const off: ObjectSpec = { ...spec, unassignedShared: { col: "c_shared", teamId: "" } };
    expect(buildColumnValues({ id: "1", properties: {} }, off, ctx).c_shared).toBeUndefined();
  });
});

describe("expectedText (canonical comparison value)", () => {
  it("maps enum values to labels for status/dropdown", () => {
    expect(expectedText(f({ type: "status", labels: "stage" }), "appointmentscheduled", ctx))
      .toBe("Appointment Scheduled");
    expect(expectedText(f({ type: "date" }), "2026-06-26T02:22:45Z", ctx)).toBe("2026-06-26");
    expect(expectedText(f({ type: "people" }), "555", ctx)).toBeNull(); // not diffable
  });
  it("trims text and number-normalizes so it round-trips against monday", () => {
    expect(expectedText(f({ type: "text" }), "Austin ", ctx)).toBe("Austin");
    expect(expectedText(f({ type: "numbers" }), "1500000.50", ctx)).toBe("1500000.5");
  });
});

/**
 * OVER-LENGTH PHONE NUMBERS, found by the live Contacts import on 2026-09-09.
 *
 * 14 of the first 10,100 contacts failed with monday's "invalid value ... for this column", and the
 * cause was phone strings holding TWO numbers concatenated: "+8522713691235547427415" (23 digits,
 * plainly +85223506974 then 85290675945), "8522382645695287557558" (22), "+656880519571223742" (18).
 * monday's phone column enforces E.164's 15-digit maximum.
 *
 * The severity is the point. A create sends every column in ONE mutation, so monday rejecting one
 * cell failed the ENTIRE card — all 30 other fields lost, not just the phone. At that rate about 130
 * of 94,318 contacts would have been dropped completely, and the only evidence would have been a
 * failure count.
 */
describe("phone values monday cannot store", () => {
  const phone: FieldSpec = { hs: "phone", col: "c_phone", type: "phone" };

  it("the limit is E.164's 15 digits", () => expect(PHONE_MAX_DIGITS).toBe(15));

  it.each([
    ["+60123456789", true],
    ["+601234567890123", true],      // exactly 15
    ["+6012345678901234", false],    // 16
    ["+8522713691235547427415", false],
    ["8522382645695287557558", false],
    ["+656880519571223742", false],
    ["", false],
    ["no digits at all", false],
  ])("phoneStorable(%s) === %s", (v, want) => expect(phoneStorable(v)).toBe(want));

  it("OMITS the column rather than failing the whole card", () => {
    expect(formatValue(phone, "+8522713691235547427415", ctx)).toBeNull();
    expect(formatValue(phone, "+60123456789", ctx)).toEqual({ phone: "+60123456789" });
  });

  /**
   * THE INVARIANT THAT KEEPS THIS FROM BECOMING A CHURN BUG. Omitting the write is only half a fix: if
   * expectedText still predicted the digits, fieldDiffs would raise a diff on a value the cell can
   * never hold, and the card would be rewritten on every webhook forever. Both sides must agree that
   * an unstorable number is simply absent.
   */
  it("expectedText agrees, so no diff is ever raised for a value the cell cannot hold", () => {
    expect(expectedText(phone, "+8522713691235547427415", ctx)).toBe("");
    expect(formatValue(phone, "+8522713691235547427415", ctx)).toBeNull();
    // And a storable number still round-trips as digits on both sides.
    expect(expectedText(phone, "+60 12-345 6789", ctx)).toBe("60123456789");
  });

  it("leaves the rest of the card intact when the phone is dropped", () => {
    const s: ObjectSpec = {
      ...spec,
      fields: [{ hs: "dealtype", col: "c_type", type: "dropdown", labels: "dealtype" }, phone],
    };
    const cv = buildColumnValues(
      { id: "1", properties: { dealtype: "newbusiness", phone: "+8522713691235547427415" } }, s, ctx);
    expect(cv.c_phone).toBeUndefined();          // dropped
    expect(cv.c_type).toEqual({ labels: ["New Business"] });  // everything else survives
    expect(cv.c_id).toBe("1");
  });
});

/**
 * domainStem — the registrable stem of a domain, used to label a Company card that HubSpot has no name
 * for. 4,315 of 26,206 companies (16.5%) have no name and 4,237 of those carry a domain, so this is
 * what stands between a salesperson and 4,237 cards reading "companies 37108192909".
 *
 * The multi-part public suffix is the case that actually matters here and is easy to get wrong: 698 of
 * those 4,237 domains end in com.cn / co.uk / com.sg / edu.cn style suffixes, so a naive "label before
 * the last dot" would have labelled 698 cards "com".
 */
describe("domainStem", () => {
  it.each([
    ["hubspot.com", "hubspot"],
    ["example.com", "example"],
    ["ukmarketreport.com", "ukmarketreport"],
  ])("plain TLD: %s -> %s", (d, want) => expect(domainStem(d)).toBe(want));

  // The 698-record case. Two-letter ccTLD behind a generic SLD means the last TWO labels are suffix.
  it.each([
    ["jsgjjn.com.cn", "jsgjjn"],
    ["mhllp.co.uk", "mhllp"],
    ["tathong.com.sg", "tathong"],
    ["starrail.co.jp", "starrail"],
    ["gench.edu.cn", "gench"],
    ["seedtech.net.cn", "seedtech"],
  ])("multi-part suffix: %s -> %s", (d, want) => expect(domainStem(d)).toBe(want));

  // Subdomains are dropped in favour of the registrable name, with or without a multi-part suffix.
  it.each([
    ["h.axhome.com.cn", "axhome"],
    ["ihpc.astar.edu.sg", "astar"],
    ["mail.example.com", "example"],
    ["qk.ilongyu.com.cn", "ilongyu"],
    ["reversetest-company.example.com", "example"],
  ])("subdomain dropped: %s -> %s", (d, want) => expect(domainStem(d)).toBe(want));

  it("strips scheme, www and path first", () => {
    expect(domainStem("https://www.acme.com/path?q=1")).toBe("acme");
    expect(domainStem("HTTP://ACME.COM")).toBe("acme");
  });

  it("never rewrites characters or title-cases — jsgjjn is not a word to prettify", () => {
    expect(domainStem("hong-yin.com.cn")).toBe("hong-yin");
    expect(domainStem("idea-link.com.cn")).toBe("idea-link");
  });

  it.each(["", "   ", null, undefined])("unusable input %s -> empty", (d) =>
    expect(domainStem(d as string)).toBe(""));

  it("degenerates safely on a bare suffix or single label", () => {
    expect(domainStem("localhost")).toBe("localhost");
    expect(domainStem("com.cn")).toBe("com");
  });
});

describe("Company cards named from their domain", () => {
  const s: ObjectSpec = {
    ...spec, object: "companies", nameProps: ["name"],
    nameFallbackProps: ["domain"], nameFallbackTransform: "domainStem",
  };

  it("uses the HubSpot company name when there is one", () =>
    expect(itemName({ id: "1", properties: { name: "HubSpot", domain: "hubspot.com" } }, s)).toBe("HubSpot"));

  it("falls back to the domain stem when the name is blank", () =>
    expect(itemName({ id: "37108192909", properties: { domain: "example.com" } }, s)).toBe("example"));

  it("reaches the id ONLY when name and domain are both blank (78 such companies)", () =>
    expect(itemName({ id: "37108192909", properties: {} }, s)).toBe("companies 37108192909"));

  it("an unusable domain falls through to the raw value rather than the id", () =>
    expect(itemName({ id: "1", properties: { domain: "???" } }, s)).toBe("???"));
});
