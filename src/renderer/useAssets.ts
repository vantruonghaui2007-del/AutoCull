import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetQuery, AssetView } from '../shared/contracts';
import { api } from './lib';

const PAGE = 200;
type Filter = Omit<AssetQuery, 'offset' | 'limit'>;

/**
 * Paged, cached access to the project's assets in display order. Pages are fetched on demand
 * (never more than 200 per request). When `version` changes, cached pages are kept on screen
 * but marked stale and refetched, so the grid does not flash.
 */
export function useAssetPages(projectId: string, filter: Filter, version: number, onViews: (views: AssetView[]) => void) {
  const pages = useRef(new Map<number, AssetView[]>());
  const stale = useRef(new Set<number>());
  const inflight = useRef(new Set<number>());
  const accessed = useRef(new Map<number, number>());
  const gen = useRef(0);
  const [total, setTotal] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const key = JSON.stringify(filter);

  const fetchPage = useCallback(
    (pi: number) => {
      if (inflight.current.has(pi)) return;
      if (pages.current.has(pi) && !stale.current.has(pi)) return;
      inflight.current.add(pi);
      const g = gen.current;
      void api()
        .queryAssets(projectId, { ...filter, offset: pi * PAGE, limit: PAGE })
        .then((r) => {
          inflight.current.delete(pi);
          if (g !== gen.current || !r.ok) return;
          pages.current.set(pi, r.value.items);
          stale.current.delete(pi);
          setTotal(r.value.total);
          onViews(r.value.items);
          setTick((x) => x + 1);
        });
    },
    [projectId, key],
  );

  // New filter: drop everything.
  useEffect(() => {
    gen.current++;
    pages.current.clear();
    stale.current.clear();
    inflight.current.clear();
    accessed.current.clear();
    setTotal(null);
    fetchPage(0);
  }, [projectId, key, fetchPage]);

  // New data version: refetch only pages looked at recently (on screen); drop the rest, they reload on demand.
  useEffect(() => {
    if (version === 0) return;
    gen.current++;
    inflight.current.clear();
    const now = Date.now();
    for (const pi of [...pages.current.keys()]) {
      if (now - (accessed.current.get(pi) ?? 0) < 3000) {
        stale.current.add(pi);
        fetchPage(pi);
      } else {
        pages.current.delete(pi);
        stale.current.delete(pi);
        accessed.current.delete(pi);
      }
    }
    if (pages.current.size === 0) fetchPage(0);
  }, [version, fetchPage]);

  const at = useCallback(
    (i: number): AssetView | undefined => {
      const pi = Math.floor(i / PAGE);
      accessed.current.set(pi, Date.now());
      const page = pages.current.get(pi);
      if (!page || stale.current.has(pi)) fetchPage(pi);
      return page?.[i - pi * PAGE];
    },
    [fetchPage],
  );

  return { total, at };
}
