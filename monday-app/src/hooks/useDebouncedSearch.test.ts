import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounceLatest } from "./useDebouncedSearch";

describe("debounceLatest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only runs the last call within the window, and aborts the prior signal", () => {
    const runs: string[] = [], aborted: string[] = [];
    const run = (q: string, s: AbortSignal) => { s.addEventListener("abort", () => aborted.push(q)); runs.push(q); };
    const d = debounceLatest(run, 300);
    d.trigger("a"); d.trigger("ab"); d.trigger("abc");
    vi.advanceTimersByTime(299); expect(runs).toEqual([]);
    vi.advanceTimersByTime(1); expect(runs).toEqual(["abc"]);
    d.trigger("abcd"); vi.advanceTimersByTime(300);
    expect(runs).toEqual(["abc", "abcd"]);
    expect(aborted).toEqual(["abc"]);
  });

  it("cancel() clears a pending timer so nothing runs", () => {
    const runs: string[] = [];
    const d = debounceLatest((q) => runs.push(q), 300);
    d.trigger("abc"); d.cancel();
    vi.advanceTimersByTime(500); expect(runs).toEqual([]);
  });

  it("cancel() aborts an in-flight request", () => {
    const aborted: string[] = [];
    const d = debounceLatest((q, s) => s.addEventListener("abort", () => aborted.push(q)), 300);
    d.trigger("abc"); vi.advanceTimersByTime(300);
    d.cancel(); expect(aborted).toEqual(["abc"]);
  });
});
