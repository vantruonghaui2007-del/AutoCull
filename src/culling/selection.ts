import type { AssetId, CullLabel, Decision, EffectiveSelection, Group } from '../shared/contracts';

export interface RecInfo {
  assetId: AssetId;
  label: CullLabel;
  rank: number;
  acceptable: boolean;
}

/**
 * Which photos are actually chosen, combining manual decisions with automatic recommendations.
 * Manual always wins:
 *  - a group with manual "keep" photos selects exactly those (several allowed);
 *  - otherwise manual "pass"/"xem lại" photos are excluded and the automatic pick applies; if the
 *    automatic pick was excluded, the next acceptable shot (by rank) is promoted.
 * Pure: resetting a decision to "unreviewed" restores the automatic result, and re-analysis never
 * touches decisions.
 */
export function resolveSelection(groups: Group[], decisions: Record<AssetId, Decision>, recs: Map<AssetId, RecInfo>): Map<AssetId, EffectiveSelection> {
  const out = new Map<AssetId, EffectiveSelection>();
  const grouped = new Set(groups.flatMap((g) => g.assetIds));
  const all: AssetId[][] = [...groups.map((g) => g.assetIds), ...Object.keys(decisions).filter((id) => !grouped.has(id)).map((id) => [id])];
  for (const members of all) {
    const state = (id: AssetId) => decisions[id]?.state ?? 'unreviewed';
    const manualKeeps = members.filter((id) => state(id) === 'keep');
    if (manualKeeps.length) {
      for (const id of members) {
        if (state(id) === 'keep') out.set(id, { assetId: id, selected: true, source: 'manual-keep' });
        else out.set(id, { assetId: id, selected: false, source: state(id) === 'unreviewed' ? 'not-recommended' : 'manual-excluded' });
      }
      continue;
    }
    const excluded = (id: AssetId) => state(id) === 'pass' || state(id) === 'review';
    const candidates = members.filter((id) => !excluded(id) && recs.has(id));
    let picks = candidates.filter((id) => recs.get(id)!.label === 'keep');
    if (!picks.length) {
      const promoted = candidates.filter((id) => recs.get(id)!.acceptable && recs.get(id)!.label !== 'review').sort((a, b) => recs.get(a)!.rank - recs.get(b)!.rank)[0];
      picks = promoted ? [promoted] : [];
    }
    const pickSet = new Set(picks);
    for (const id of members) {
      if (pickSet.has(id)) out.set(id, { assetId: id, selected: true, source: 'auto' });
      else if (excluded(id)) out.set(id, { assetId: id, selected: false, source: 'manual-excluded' });
      else if (!recs.has(id)) out.set(id, { assetId: id, selected: false, source: 'no-analysis' });
      else out.set(id, { assetId: id, selected: false, source: 'not-recommended' });
    }
  }
  return out;
}

export type CullList = 'keep' | 'better-option' | 'review';

/**
 * The three result lists: chosen / a better option exists / needs a human look. A photo is only
 * in "better option" when its group actually has a chosen photo; otherwise someone must look.
 */
export function listOf(sel: EffectiveSelection, rec: RecInfo | undefined, groupHasSelection = true, state?: Decision['state']): CullList {
  if (sel.selected) return 'keep';
  if (state === 'review') return 'review';
  if (state === 'pass') return 'better-option'; // Explicitly dismissed, not an unresolved photo.
  if (sel.source === 'manual-excluded') return groupHasSelection ? 'better-option' : 'review';
  if (!rec || rec.label === 'review' || !groupHasSelection) return 'review';
  return 'better-option';
}

/** List of every asset, with group context. */
export function listsFor(groups: Group[], selection: Map<AssetId, EffectiveSelection>, recs: Map<AssetId, RecInfo>, decisions: Record<AssetId, Decision> = {}): Map<AssetId, CullList> {
  const out = new Map<AssetId, CullList>();
  const grouped = new Set<AssetId>();
  for (const g of groups) {
    const has = g.assetIds.some((id) => selection.get(id)?.selected);
    for (const id of g.assetIds) {
      grouped.add(id);
      const s = selection.get(id);
      if (s) out.set(id, listOf(s, recs.get(id), has, decisions[id]?.state));
    }
  }
  for (const [id, s] of selection) if (!grouped.has(id)) out.set(id, listOf(s, recs.get(id), s.selected, decisions[id]?.state));
  return out;
}
