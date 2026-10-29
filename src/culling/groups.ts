import { createHash } from 'node:crypto';
import type { AssetId, FeatureVector, Group } from '../shared/contracts';

export interface GroupingInput {
  assetId: AssetId;
  sourceId: string;
  cameraId: string | null;
  /** Capture time after the project's camera offset, ms on a zone-less axis; null when unknown. */
  adjustedTime: number | null;
  /** Stable file order (path order) used when time is missing. */
  order: number;
  features: FeatureVector | null;
}

export interface GroupingConfig {
  version: string;
  maxHamming: number;
  minHistogram: number;
  maxGapMs: number;
  maxSpanMs: number;
  noTime: { maxHamming: number; minHistogram: number };
}

export const DEFAULT_GROUPING: GroupingConfig = {
  version: 'group-v1',
  maxHamming: 10,
  minHistogram: 0.85,
  maxGapMs: 2000,
  maxSpanMs: 10_000,
  noTime: { maxHamming: 6, minHistogram: 0.92 },
};

/** Event preset (v0.2, new projects): bursts with up to 4 s between frames. */
export const EVENT_GROUPING: GroupingConfig = { ...DEFAULT_GROUPING, version: 'event-v2', maxGapMs: 4000 };

const PRESETS: Record<string, GroupingConfig> = { [DEFAULT_GROUPING.version]: DEFAULT_GROUPING, [EVENT_GROUPING.version]: EVENT_GROUPING };

/** Preset by its stored name; unknown names fall back to the conservative v1 preset. */
export function groupingPreset(name: string | null | undefined): GroupingConfig {
  return (name && PRESETS[name]) || DEFAULT_GROUPING;
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export function histogramIntersection(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.min(a[i]!, b[i]!);
  return s;
}

function stableGroupId(anchor: AssetId, version: string): string {
  const h = createHash('sha256').update(`grp|${version}|${anchor}`).digest('hex');
  return `g_${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function similar(a: FeatureVector, b: FeatureVector, maxHamming: number, minHistogram: number): boolean {
  return hamming(a.hash, b.hash) <= maxHamming && histogramIntersection(a.histogram, b.histogram) >= minHistogram;
}

/**
 * Conservative grouping inside one camera (or one source when the camera is unknown).
 * Each candidate is compared with the group's anchor (its first frame), never chained
 * through the previous member, and a group may not span more than maxSpanMs.
 */
export function groupAssets(items: GroupingInput[], config: GroupingConfig): Group[] {
  const partitions = new Map<string, GroupingInput[]>();
  for (const it of items) {
    const key = it.cameraId ?? `source:${it.sourceId}`;
    const list = partitions.get(key);
    if (list) list.push(it);
    else partitions.set(key, [it]);
  }
  const out: Group[] = [];
  for (const key of [...partitions.keys()].sort()) {
    const list = partitions.get(key)!;
    const timed = list
      .filter((x) => x.adjustedTime !== null)
      .sort((a, b) => a.adjustedTime! - b.adjustedTime! || a.order - b.order || a.assetId.localeCompare(b.assetId));
    const untimed = list.filter((x) => x.adjustedTime === null).sort((a, b) => a.order - b.order || a.assetId.localeCompare(b.assetId));

    let current: GroupingInput[] = [];
    const flush = (confidence: Group['confidence']) => {
      if (!current.length) return;
      const allFeatures = current.every((c) => c.features);
      out.push({
        id: stableGroupId(current[0]!.assetId, config.version),
        assetIds: current.map((c) => c.assetId),
        confidence: allFeatures ? confidence : 'low',
        manual: false,
      });
      current = [];
    };

    for (const it of timed) {
      const anchor = current[0];
      const prev = current[current.length - 1];
      const fits =
        anchor &&
        prev &&
        anchor.features &&
        it.features &&
        it.adjustedTime! - prev.adjustedTime! <= config.maxGapMs &&
        it.adjustedTime! - anchor.adjustedTime! <= config.maxSpanMs &&
        similar(anchor.features, it.features, config.maxHamming, config.minHistogram);
      if (!fits) flush('high');
      current.push(it);
    }
    flush('high');

    for (const it of untimed) {
      const anchor = current[0];
      const fits = anchor && anchor.features && it.features && similar(anchor.features, it.features, config.noTime.maxHamming, config.noTime.minHistogram);
      if (!fits) flush('low');
      current.push(it);
    }
    flush('low');
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Manual groups survive unchanged; their members are removed from computed groups. Decisions are untouched. */
export function reconcileGroups(previous: Group[], computed: Group[]): Group[] {
  const manual = previous.filter((g) => g.manual && g.assetIds.length > 0);
  const taken = new Set(manual.flatMap((g) => g.assetIds));
  const rest: Group[] = [];
  for (const g of computed) {
    const ids = g.assetIds.filter((id) => !taken.has(id));
    if (ids.length) rest.push(ids.length === g.assetIds.length ? g : { ...g, assetIds: ids });
  }
  return [...manual, ...rest];
}

/**
 * Puts byte-identical copies (confirmed by full SHA-256) in the same group by merging the computed
 * groups that hold them. Manual groups are never changed. The merged group keeps the first group's
 * ID and position.
 */
export function mergeExactDuplicates(groups: Group[], duplicateSets: AssetId[][]): Group[] {
  if (!duplicateSets.length) return groups;
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const indexOf = new Map<AssetId, number>();
  groups.forEach((g, i) => g.assetIds.forEach((id) => indexOf.set(id, i)));
  for (const set of duplicateSets) {
    const idx = set.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined && !groups[i]!.manual);
    for (const i of idx.slice(1)) {
      const a = find(idx[0]!);
      const b = find(i);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const out: Group[] = [];
  const byRoot = new Map<number, Group>();
  groups.forEach((g, i) => {
    const r = find(i);
    const existing = byRoot.get(r);
    if (!existing) {
      const copy = { ...g, assetIds: [...g.assetIds] };
      byRoot.set(r, copy);
      out.push(copy);
    } else {
      existing.assetIds.push(...g.assetIds);
      if (g.confidence === 'low') existing.confidence = 'low';
    }
  });
  return out;
}