import { findPairCandidates, isDefaultDecision, type PairFileInput, type ReviewModel } from '../culling/decisions';
import type { ProjectStore } from '../project/store';
import type { PackMember, PairCandidate, Result } from '../shared/contracts';
import { err, ok } from '../shared/schemas';
import { computeAssetFeatures, regroup, setGroups, type GroupState } from './grouping';
import type { MediaQueue } from './queue';

export function loadReviewModel(store: ProjectStore): ReviewModel {
  return {
    decisions: Object.fromEntries(store.allDecisions()),
    members: store.packMembers(),
    targets: store.targets(),
    rules: store.packRules(),
    journal: [],
  };
}

/** Writes only what changed between two review models. Call inside a transaction. */
export function persistReviewModel(store: ProjectStore, prev: ReviewModel, next: ReviewModel): void {
  for (const [id, d] of Object.entries(next.decisions)) {
    const old = prev.decisions[id];
    if (!old || JSON.stringify(old) !== JSON.stringify(d)) store.saveDecision(d);
  }
  if (next.members !== prev.members) store.replacePackMembers(next.members);
  if (next.targets !== prev.targets) store.replaceTargets(next.targets);
  if (next.rules !== prev.rules) for (const r of next.rules) store.savePackRule(r);
}

export function pairCandidatesOf(store: ProjectStore): PairCandidate[] {
  const inputs: PairFileInput[] = store.pairInputs().map((r) => ({
    fileId: r.fileId,
    assetId: r.assetId,
    sourceId: r.sourceId,
    relativePath: r.relativePath,
    kind: r.kind,
    model: r.model,
    serial: r.serial,
    capturedLocal: r.capturedLocal,
    metadataRead: r.readHash !== null && r.readHash === r.sampledHash,
    paired: r.paired,
  }));
  return findPairCandidates(inputs);
}

let pairRun = 0;

/**
 * Confirms a batch of 1:1 RAW+JPEG pairs chosen by the user. Each pair must be a current,
 * unambiguous candidate. The JPEG becomes the companion of the RAW asset (one logical photo,
 * both files kept); the JPEG's own decision carries over only when the RAW has none yet.
 */
export async function confirmPairs(
  p: GroupState,
  queue: MediaQueue,
  pairs: { rawId: string; jpegId: string }[],
): Promise<Result<{ confirmed: number }>> {
  const store = p.store;
  const candidates = pairCandidatesOf(store);
  const seenRaw = new Set<string>();
  const seenJpeg = new Set<string>();
  const chosen: PairCandidate[] = [];
  for (const pair of pairs) {
    if (seenRaw.has(pair.rawId) || seenJpeg.has(pair.jpegId)) return err('INVALID_COMMAND', 'Một tệp chỉ được ghép một lần.');
    seenRaw.add(pair.rawId);
    seenJpeg.add(pair.jpegId);
    const c = candidates.find((x) => x.rawId === pair.rawId && x.jpegId === pair.jpegId);
    if (!c) return err('PAIR_NOT_CANDIDATE', 'Hai tệp này không phải cặp RAW+JPEG được đề xuất.');
    if (c.ambiguous) return err('PAIR_AMBIGUOUS', `Không ghép cặp mơ hồ (${c.reason}): ${c.relativeStem}`);
    chosen.push(c);
  }
  const removed = new Set<string>();
  store.tx(() => {
    const members = store.packMembers();
    let nextMembers: PackMember[] = members;
    for (const c of chosen) {
      const rawDecision = store.decision(c.rawAssetId);
      const jpegDecision = store.decision(c.jpegAssetId);
      if (isDefaultDecision(rawDecision) && !isDefaultDecision(jpegDecision)) {
        store.saveDecision({ ...jpegDecision, assetId: c.rawAssetId });
      }
      nextMembers = nextMembers.flatMap((m) => {
        if (m.assetId !== c.jpegAssetId) return [m];
        const existing = nextMembers.find((x) => x.packId === m.packId && x.assetId === c.rawAssetId);
        if (existing) {
          existing.pinned = existing.pinned || m.pinned;
          return [];
        }
        return [{ ...m, assetId: c.rawAssetId }];
      });
      store.replacePackMembers(nextMembers);
      store.deleteAsset(c.jpegAssetId);
      store.setCompanion(c.rawAssetId, c.jpegId, true);
      store.refreshAssetDerived(c.rawAssetId);
      const a = store.asset(c.rawAssetId)!;
      const dp = store.displayPreview(a);
      if (dp) store.setMediaStatus(a.id, dp.insufficientForFocus ? 'preview-small' : 'ready');
      removed.add(c.jpegAssetId);
    }
  });
  setGroups(
    p,
    p.groups.map((g) => ({ ...g, assetIds: g.assetIds.filter((id) => !removed.has(id)) })).filter((g) => g.assetIds.length > 0),
  );
  const token = `pairs#${++pairRun}`;
  await Promise.all(chosen.map((c) => computeAssetFeatures(store, queue, token, c.rawAssetId)));
  regroup(p);
  return ok({ confirmed: chosen.length });
}
