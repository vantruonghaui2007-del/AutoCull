import path from 'node:path';
import { groupAssets, groupingPreset, mergeExactDuplicates, reconcileGroups, type GroupingInput } from '../culling/groups';
import { computeFeatures, FEATURE_ALGORITHM } from '../media/features';
import type { FileRow, ProjectStore } from '../project/store';
import type { FeatureVector, Group } from '../shared/contracts';
import { localToMillis } from '../shared/time';
import type { MediaQueue } from './queue';

export interface GroupState {
  store: ProjectStore;
  groups: Group[];
  groupIndex: Map<string, string>;
}

export function setGroups(p: GroupState, groups: Group[]): void {
  p.groups = groups;
  p.groupIndex = new Map();
  for (const g of groups) for (const id of g.assetIds) p.groupIndex.set(id, g.id);
}

export function loadGroups(p: GroupState): void {
  setGroups(
    p,
    p.store.groups().map(({ configVersion: _v, ...g }) => g),
  );
}

/** Computes features for an asset from its display preview (image lane). Missing/undecodable preview: no features. */
export async function computeAssetFeatures(store: ProjectStore, queue: MediaQueue, token: string, assetId: string): Promise<void> {
  const a = store.asset(assetId);
  if (!a) return;
  const p = store.displayPreview(a);
  if (!p) return;
  const r = await queue.run('image', token, () => computeFeatures(path.join(store.cacheRoot, p.cacheId)));
  // The asset may have been merged into a RAW+JPEG pair while features were computed.
  if (r.ok && r.value.ok && store.asset(assetId)) store.saveFeature(assetId, FEATURE_ALGORITHM, JSON.stringify(r.value.value));
}

export function regroup(p: GroupState): Group[] {
  const store = p.store;
  const features = store.features();
  const assets = store.allAssets();
  const paths = new Map(store.allFiles().map((f) => [f.id, f.relativePath]));
  const ordered = [...assets].sort((x, y) => (paths.get(x.primaryFileId) ?? '').localeCompare(paths.get(y.primaryFileId) ?? '') || x.seq - y.seq);
  const order = new Map(ordered.map((a, i) => [a.id, i]));
  const inputs: GroupingInput[] = assets.map((a) => {
    const f = features.get(a.id);
    const vec = f && f.algorithmVersion === FEATURE_ALGORITHM ? (JSON.parse(f.json) as FeatureVector) : null;
    return {
      assetId: a.id,
      sourceId: store.file(a.primaryFileId)?.sourceId ?? '',
      cameraId: a.cameraId,
      adjustedTime: localToMillis(a.sortTime),
      order: order.get(a.id) ?? 0,
      features: vec,
    };
  });
  const known = p.groups.map((g) => ({ ...g, assetIds: g.assetIds.filter((id) => order.has(id)) }));
  const preset = groupingPreset(store.meta('grouping_preset'));
  const groups = mergeExactDuplicates(reconcileGroups(known, groupAssets(inputs, preset)), exactDuplicateSets(store));
  // Keep a stable display order: by the first member's position in time/path order.
  const pos = new Map(
    [...assets].sort((x, y) => (x.sortTime ?? '\uffff').localeCompare(y.sortTime ?? '\uffff') || (order.get(x.id)! - order.get(y.id)!)).map((a, i) => [a.id, i]),
  );
  groups.sort((g, h) => Math.min(...g.assetIds.map((id) => pos.get(id)!)) - Math.min(...h.assetIds.map((id) => pos.get(id)!)));
  store.tx(() => store.replaceGroups(groups, preset.version));
  setGroups(p, groups);
  return groups;
}

/**
 * Assets whose primary files are byte-identical, from full SHA-256 values computed by AutoCull.
 * A stored hash counts only while the file's content sample still matches.
 */
export function exactDuplicateSets(store: ProjectStore): string[][] {
  const bySha = new Map<string, string[]>();
  for (const a of store.allAssets()) {
    const f = store.file(a.primaryFileId);
    if (!f || f.missing || f.stale) continue;
    const h = store.contentHash(f.id);
    if (!h || h.sampledHash !== contentHashIdentity(f)) continue;
    const list = bySha.get(h.sha256);
    if (list) list.push(a.id);
    else bySha.set(h.sha256, [a.id]);
  }
  return [...bySha.values()].filter((l) => l.length > 1);
}

/** v2 cache identity; old sample-only entries deliberately miss and are recomputed. */
export function contentHashIdentity(f: Pick<FileRow, 'bytes' | 'mtimeMs' | 'sampledHash'>): string {
  return `sha-cache-v2:${f.bytes}:${f.mtimeMs}:${f.sampledHash}`;
}
