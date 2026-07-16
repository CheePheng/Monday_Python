import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounceLatest } from "./useDebouncedSearch";
describe("debounceLatest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("only runs the last call within the window, and aborts the prior signal", async () => {
    const runs: string[] = [];
    const aborted: string[] = [];
    const run = (q: string, signal: AbortSignal) => { signal.addEventListener("abort", () => aborted.push(q)); runs.push(q); };
    const d = debounceLatest(run, 300);
    d("a"); d("ab"); d("abc");
    vi.advanceTimersByTime(299); expect(runs).toEqual([]);
    vi.advanceTimersByTime(1); expect(runs).toEqual(["abc"]);
    d("abcd"); vi.advanceTimersByTime(300);
    expect(runs).toEqual(["abc", "abcd"]);
    expect(aborted).toEqual(["abc"]); // starting the next run aborts the previous request
  });
});
