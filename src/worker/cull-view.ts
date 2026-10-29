import { defaultDecision } from '../culling/decisions';
import { acceptableFrom } from '../culling/ranking';
import { listsFor, resolveSelection, type RecInfo } from '../culling/selection';
import type { ProjectStore } from '../project/store';
import type { AssetCullView, AssetId, CullLabel, Decision, Group } from '../shared/contracts';
import { groupRevision, revisionContext } from './revision';

export interface CullIndex {
  views: Map<AssetId, AssetCullView>;
  counts: Record<CullLabel, number>;
}

/**
 * Effective AutoCull state of the whole album: stored recommendations of the latest ranked run
 * combined with the current manual decisions and groups (manual always wins). A recommendation
 * whose group revision no longer matches the current data (file replaced, pair confirmed, group
 * merged/split/regrouped, analysis changed) is stale: it no longer picks anything and the photo
 * goes to review until AutoCull runs again. `revision` in each view is the live revision.
 */
export function buildCullIndex(store: ProjectStore, groups: Group[]): CullIndex {
  const recs = store.recommendations();
  const ctx = revisionContext(store);
  const grouped = new Set(groups.flatMap((g) => g.assetIds));
  const live = new Map<AssetId, string>();
  for (const g of groups) {
    const rev = groupRevision(ctx, g.assetIds);
    for (const id of g.assetIds) live.set(id, rev);
  }
  for (const id of ctx.assets.keys()) if (!grouped.has(id)) live.set(id, groupRevision(ctx, [id]));

  const info = new Map<AssetId, RecInfo>();
  const stale = new Set<AssetId>();
  for (const r of recs.values()) {
    if (r.revision !== live.get(r.assetId)) {
      stale.add(r.assetId);
      continue;
    }
    info.set(r.assetId, { assetId: r.assetId, label: r.label, rank: r.rank, acceptable: r.label !== 'review' && acceptableFrom(r.reasons) });
  }
  const stored = store.allDecisions();
  const decisions: Record<AssetId, Decision> = {};
  for (const id of ctx.assets.keys()) decisions[id] = stored.get(id) ?? defaultDecision(id);
  const selection = resolveSelection(groups, decisions, info);
  const lists = listsFor(groups, selection, info, decisions);
  const views = new Map<AssetId, AssetCullView>();
  const counts: Record<CullLabel, number> = { keep: 0, 'better-option': 0, review: 0 };
  for (const [id, sel] of selection) {
    const rec = recs.get(id);
    const list = lists.get(id) ?? 'review';
    counts[list]++;
    views.set(id, {
      selected: sel.selected,
      source: sel.source,
      list,
      label: rec?.label ?? null,
      rank: rec?.rank ?? null,
      bestAssetId: rec && !stale.has(id) ? rec.bestAssetId : null,
      reasons: rec ? (stale.has(id) ? ['RESULT_STALE', ...rec.reasons] : rec.reasons) : [],
      quality: rec?.quality ?? null,
      runId: rec?.runId ?? null,
      revision: live.get(id) ?? null,
    });
  }
  return { views, counts };
}

/** Effectively selected assets (manual keeps or automatic picks). */
export function selectedOf(index: CullIndex): AssetId[] {
  return [...index.views].filter(([, v]) => v.selected).map(([id]) => id);
}

/**
 * Per-project cache keyed by the connection's change counter. Callers that only touch preview
 * access times afterwards may re-key it with `rekey` (those writes do not affect AutoCull state).
 */
export class CullIndexCache {
  private key = -1;
  private index: CullIndex | null = null;
  get(store: ProjectStore, groups: Group[]): CullIndex {
    const k = store.totalChanges();
    if (!this.index || k !== this.key || this.groups !== groups) {
      this.index = buildCullIndex(store, groups);
      this.key = k;
      this.groups = groups;
    }
    return this.index;
  }
  rekey(store: ProjectStore): void {
    if (this.index) this.key = store.totalChanges();
  }
  private groups: Group[] | null = null;
}
