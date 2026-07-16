import { useEffect, useRef, useState } from "react";

/** Debounce that only fires the latest call after `ms` and aborts the previous in-flight run. Pure/testable. */
export function debounceLatest(run: (q: string, signal: AbortSignal) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  return (q: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      controller?.abort();
      controller = new AbortController();
      run(q, controller.signal);
    }, ms);
  };
}

/** React hook: debounced, cancellable search returning { hits, loading, error, query, clear }. */
export function useDebouncedSearch<T>(fetcher: (q: string, signal: AbortSignal) => Promise<T[]>, ms = 300) {
  const [hits, setHits] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const debounced = useRef<(q: string) => void>();
  useEffect(() => {
    debounced.current = debounceLatest(async (q, signal) => {
      setLoading(true); setError(false);
      try { const r = await fetcher(q, signal); if (!signal.aborted) { setHits(r); setLoading(false); } }
      catch (e: any) { if (e?.name !== "AbortError") { setError(true); setLoading(false); setHits([]); } }
    }, ms);
  }, [fetcher, ms]);
  function query(q: string) { if (q.trim().length < 2) { setHits([]); setLoading(false); return; } debounced.current?.(q); }
  function clear() { setHits([]); setLoading(false); setError(false); }
  return { hits, loading, error, query, clear };
}
