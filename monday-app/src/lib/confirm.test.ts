import { describe, it, expect } from "vitest";
import { resolveConfirm, TONES } from "./confirm";

describe("resolveConfirm", () => {
  it("defaults to the warning tone", () => {
    expect(resolveConfirm({ title: "t", message: "m" }).tone).toBe("warning");
  });

  it("uses the tone's verb unless the caller supplies one", () => {
    expect(resolveConfirm({ title: "t", message: "m", tone: "danger" }).confirmLabel).toBe("Delete");
    expect(resolveConfirm({ title: "t", message: "m", tone: "danger", confirmLabel: "Remove line item" }).confirmLabel)
      .toBe("Remove line item");
  });

  it("focuses Cancel on danger so a stray Enter cannot delete", () => {
    expect(resolveConfirm({ title: "t", message: "m", tone: "danger" }).focus).toBe("cancel");
    expect(resolveConfirm({ title: "t", message: "m", tone: "warning" }).focus).toBe("confirm");
    expect(resolveConfirm({ title: "t", message: "m", tone: "caution" }).focus).toBe("confirm");
  });

  it("gives every tone a distinct style so they are never visually ambiguous", () => {
    const tones = Object.values(TONES);
    expect(new Set(tones.map(t => t.cls)).size).toBe(tones.length);
    expect(new Set(tones.map(t => t.confirmCls)).size).toBe(tones.length);
  });
});
