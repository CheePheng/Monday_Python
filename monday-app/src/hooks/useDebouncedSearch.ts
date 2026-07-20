import { useEffect, useRef, useState } from "react";

/** Debounce that runs only the latest call after `ms`, aborts the previous in-flight request, and can be
 * cancelled (clears the timer AND aborts any in-flight request). Pure/testable. */
export function debounceLatest(run: (q: string, signal: AbortSignal) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  return {
    trigger(q: string) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        controller?.abort();
        controller = new AbortController();
        run(q, controller.signal);
      }, ms);
    },
    cancel() { if (timer) clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; },
  };
}

export interface SearchResponse<T> { items: T[]; total: number }

/** Debounced, cancellable search. Stale-proof two ways: AbortController cancels the network request, and a
 * monotonic sequence id ensures a late older response can never overwrite a newer one or a cleared box. */
export function useDebouncedSearch<T>(fetcher: (q: string, signal: AbortSignal) => Promise<SearchResponse<T>>, ms = 300) {
  const [hits, setHits] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const seq = useRef(0);
  // Consumers pass an inline `fetcher` that is a NEW function every render. Read it through a ref so the
  // debounce is built ONCE — depending on `fetcher` would rebuild it (and the cleanup would abort the
  // in-flight search) on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const debounced = useRef<ReturnType<typeof debounceLatest>>();

  useEffect(() => {
    debounced.current = debounceLatest(async (q, signal) => {
      const mySeq = ++seq.current;
      setLoading(true); setError(false);
      try {
        const r = await fetcherRef.current(q, signal);
        if (signal.aborted || mySeq !== seq.current) return;   // stale -> ignore
        setHits(r.items); setTotal(r.total); setLoading(false);
      } catch (e: any) {
        if (e?.name === "AbortError" || mySeq !== seq.current) return;
        setError(true); setLoading(false); setHits([]); setTotal(0);
      }
    }, ms);
    return () => debounced.current?.cancel();
  }, [ms]);   // stable — the fetcher is read via a ref (see above)

  // Bumping seq invalidates any in-flight response so it can't land after a clear / sub-2-char reset.
  function reset() { seq.current++; setHits([]); setTotal(0); setLoading(false); }
  function query(q: string) {
    if (q.trim().length < 2) { debounced.current?.cancel(); reset(); return; }
    debounced.current?.trigger(q);
  }
  function clear() { debounced.current?.cancel(); reset(); setError(false); }

  return { hits, total, loading, error, query, clear };
}
