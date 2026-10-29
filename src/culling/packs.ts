import type { AssetId, CoverageEntry, CoverageTarget, Decision, Group, PackMember, PackRule, PackSuggestion } from '../shared/contracts';

export interface PackInput {
  rule: PackRule;
  /** Members of both packs; only this rule's pack is used. */
  members: PackMember[];
  decisions: Record<AssetId, Decision>;
  groups: Group[];
  targets: CoverageTarget[];
  /** Relative technical signals from previews, used only to break ties. */
  signals: Record<AssetId, { laplacianVariance: number; clippedFraction: number } | undefined>;
}

/** A photo is evidence for a target only if the photographer kept it, tagged it, and (when needed) consent is "allowed". */
export function isEvidence(d: Decision | undefined, t: CoverageTarget): boolean {
  return !!d && d.state === 'keep' && d.targetIds.includes(t.id) && (!t.requiresConsent || d.consent === 'allowed');
}

function waitingForConsent(d: Decision | undefined, t: CoverageTarget): boolean {
  return !!d && d.state === 'keep' && d.targetIds.includes(t.id) && t.requiresConsent && d.consent === 'unknown';
}

/** Coverage of a set of photos against targets: enough / missing / unknown (only consent pending). */
export function computeCoverage(assetIds: AssetId[], decisions: Record<AssetId, Decision>, targets: CoverageTarget[], pool: AssetId[] = assetIds): CoverageEntry[] {
  return targets.map((t) => {
    const evidenceIds = assetIds.filter((id) => isEvidence(decisions[id], t));
    let status: CoverageEntry['status'] = 'missing';
    if (evidenceIds.length >= t.minCount) status = 'enough';
    else if (pool.some((id) => waitingForConsent(decisions[id], t))) status = 'unknown';
    return { targetId: t.id, status, evidenceIds };
  });
}

/**
 * Deterministic pack suggestion. Starts from pins (never dropped, even over quota), adds kept
 * photos that close required targets, then fills the quota spreading across groups before
 * repeating one. Rating, then relative preview sharpness/clipping, then assetId break ties.
 * The suggestion does not change membership; the user accepts it with a separate command.
 */
export function suggestPack(input: PackInput): PackSuggestion {
  const { rule, decisions } = input;
  const conflicts: string[] = [];
  const reasons: Record<AssetId, string[]> = {};
  const addReason = (id: AssetId, r: string) => (reasons[id] ??= []).push(r);

  const groupOf = new Map<AssetId, string>();
  for (const g of input.groups) for (const id of g.assetIds) groupOf.set(id, g.id);
  const groupKey = (id: AssetId) => groupOf.get(id) ?? `single:${id}`;

  const pinned = input.members
    .filter((m) => m.packId === rule.id && m.pinned && decisions[m.assetId])
    .map((m) => m.assetId)
    .sort();
  const suggested: AssetId[] = [];
  const inSet = new Set<AssetId>();
  const represented = new Map<string, number>();
  const add = (id: AssetId, reason: string) => {
    if (!inSet.has(id)) {
      suggested.push(id);
      inSet.add(id);
      represented.set(groupKey(id), (represented.get(groupKey(id)) ?? 0) + 1);
    }
    addReason(id, reason);
  };
  for (const id of pinned) {
    add(id, 'PINNED');
    if (decisions[id]!.state !== 'keep') conflicts.push(`PINNED_NOT_KEPT:${id}`);
  }
  if (rule.limit !== null && pinned.length > rule.limit) conflicts.push('PINNED_OVER_LIMIT');
  const room = () => (rule.limit === null ? Infinity : rule.limit - suggested.length);

  // Sharpness is compared within a group: a rank, not an absolute score.
  const sharpRank = new Map<AssetId, number>();
  for (const g of input.groups) {
    const ordered = [...g.assetIds].sort(
      (a, b) => (input.signals[b]?.laplacianVariance ?? -1) - (input.signals[a]?.laplacianVariance ?? -1) || a.localeCompare(b),
    );
    ordered.forEach((id, i) => sharpRank.set(id, i));
  }
  // Static preference, computed once: rating, then relative sharpness in its group, then clipping, then ID.
  const staticOrder = (a: AssetId, b: AssetId): number =>
    decisions[b]!.rating - decisions[a]!.rating ||
    (sharpRank.get(a) ?? 0) - (sharpRank.get(b) ?? 0) ||
    (input.signals[a]?.clippedFraction ?? 0) - (input.signals[b]?.clippedFraction ?? 0) ||
    (a < b ? -1 : a > b ? 1 : 0);
  const kept = Object.values(decisions)
    .filter((d) => d.state === 'keep')
    .map((d) => d.assetId)
    .sort(staticOrder);
  const reps = (id: AssetId) => represented.get(groupKey(id)) ?? 0;
  /** Best remaining candidate by (fewest picks from its group, static preference). `pool` is in static order. */
  const pickBest = (pool: AssetId[]): AssetId | undefined => {
    let best: AssetId | undefined;
    let bestReps = Infinity;
    for (const id of pool) {
      if (inSet.has(id)) continue;
      const r = reps(id);
      if (r < bestReps) {
        best = id;
        bestReps = r;
        if (r === 0) break;
      }
    }
    return best;
  };

  const packTargets = rule.targetIds
    .map((id) => input.targets.find((t) => t.id === id))
    .filter((t): t is CoverageTarget => !!t)
    .sort((a, b) => Number(b.required) - Number(a.required));

  let quotaBlockedTarget = false;
  for (const t of packTargets) {
    for (;;) {
      const have = suggested.filter((id) => isEvidence(decisions[id], t)).length;
      if (have >= t.minCount) break;
      if (room() <= 0) {
        quotaBlockedTarget = true;
        break;
      }
      const pick = pickBest(kept.filter((id) => isEvidence(decisions[id], t)));
      if (!pick) break;
      add(pick, `TARGET:${t.id}`);
    }
  }

  // Fill in rounds: round r takes, in static order, photos whose group has r picks so far.
  // Equivalent to repeatedly taking the best (fewest picks from its group, static preference).
  for (let round = 0; room() > 0 && inSet.size < kept.length + pinned.length; round++) {
    let progressed = false;
    let remaining = false;
    for (const id of kept) {
      if (room() <= 0) break;
      if (inSet.has(id)) continue;
      remaining = true;
      if (reps(id) !== round) continue;
      add(id, round === 0 ? 'KEEP_NEW_GROUP' : 'KEEP_REPEAT_GROUP');
      progressed = true;
    }
    if (!remaining) break;
    if (!progressed && round > kept.length) break;
  }

  const coverage = computeCoverage(suggested, decisions, packTargets, kept);
  for (const c of coverage) {
    const t = packTargets.find((x) => x.id === c.targetId)!;
    if (c.status === 'enough' || !t.required) continue;
    conflicts.push(c.status === 'unknown' ? `TARGET_CONSENT_UNKNOWN:${t.id}` : `TARGET_MISSING:${t.id}`);
  }
  if (quotaBlockedTarget) conflicts.push('QUOTA_TOO_SMALL_FOR_TARGETS');
  for (const [g, n] of represented) if (n >= 3 && !g.startsWith('single:')) conflicts.push(`GROUP_REPEAT:${g}:${n}`);

  return { packId: rule.id, suggestedIds: suggested, reasons, coverage, conflicts };
}
