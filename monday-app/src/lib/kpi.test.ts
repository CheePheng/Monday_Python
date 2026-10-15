import { describe, it, expect } from "vitest";
import { computeKpis } from "./kpi";
import type { DealRow } from "./filter";

const R = (o: Partial<DealRow>): DealRow => ({ id: "x", name: "", stage: "", salesUserIds: [], ...o });

describe("computeKpis", () => {
  const rows = [
    R({ stage: "Contract Sent", amount: "1000", currency: "USD" }),
    R({ stage: "Qualified To Buy", amount: "500", currency: "USD" }),
    R({ stage: "Appointment", amount: "300", currency: "CNY" }),
    R({ stage: "Closed Won", amount: "9", currency: "USD" }),
    R({ stage: "Closed Lost", amount: "9", currency: "USD" }),
  ];

  it("groups open pipeline by currency (desc), counts active, won, win rate", () => {
    const k = computeKpis(rows);
    expect(k.pipeline).toEqual([{ currency: "USD", total: 1500 }, { currency: "CNY", total: 300 }]);
    expect(k.active).toBe(3);
    expect(k.won).toBe(1);
    expect(k.winRate).toBe(50);
  });
});
