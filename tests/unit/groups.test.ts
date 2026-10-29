import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUPING, EVENT_GROUPING, groupAssets, groupingPreset, hamming, histogramIntersection, mergeExactDuplicates, reconcileGroups, type GroupingInput } from '../../src/culling/groups';
import type { FeatureVector, Group } from '../../src/shared/contracts';

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const hist = (shift = 0): number[] => {
  const h = Array.from({ length: 32 }, (_, i) => Math.exp(-((i - 16 - shift) ** 2) / 20));
  const s = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / s);
};
/** 64-bit hash as hex with the first `flip` bits set. */
const hashWithBits = (flip: number): string => {
  let v = 0n;
  for (let i = 0; i < flip; i++) v |= 1n << BigInt(63 - i);
  return v.toString(16).padStart(16, '0');
};
const feat = (flip: number, histShift = 0): FeatureVector => ({
  hash: hashWithBits(flip),
  histogram: hist(histShift),
  laplacianVariance: 100,
  clippedFraction: 0,
  width: 512,
  height: 341,
  algorithmVersion: 'test',
});
let n = 0;
const id = () => `a_00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const item = (o: Partial<GroupingInput> & { sec: number | null; flip?: number }): GroupingInput => ({
  assetId: o.assetId ?? id(),
  sourceId: o.sourceId ?? 's_1',
  cameraId: o.cameraId === undefined ? 'c_aaaaaaaaaaaaaaaa' : o.cameraId,
  adjustedTime: o.sec === null ? null : T0 + o.sec * 1000,
  order: o.order ?? n,
  features: o.features === undefined ? feat(o.flip ?? 0) : o.features,
});

describe('similarity helpers', () => {
  it('measures Hamming distance and histogram intersection', () => {
    expect(hamming(hashWithBits(0), hashWithBits(10))).toBe(10);
    expect(histogramIntersection(hist(), hist())).toBeCloseTo(1, 6);
    expect(histogramIntersection(hist(0), hist(8))).toBeLessThan(0.85);
  });
});

describe('groupAssets', () => {
  it('puts three near frames from one camera into one group', () => {
    const items = [item({ sec: 0 }), item({ sec: 1, flip: 2 }), item({ sec: 2, flip: 3 })];
    const groupsWithThreeNearFrames = groupAssets(items, DEFAULT_GROUPING).filter((g) => g.assetIds.length > 1);
    expect(groupsWithThreeNearFrames).toHaveLength(1);
    expect(groupsWithThreeNearFrames[0]!.assetIds).toHaveLength(3);
    expect(groupsWithThreeNearFrames[0]!.confidence).toBe('high');
  });

  it('never mixes two cameras in one group', () => {
    const a = item({ sec: 0, cameraId: 'c_aaaaaaaaaaaaaaaa' });
    const b = item({ sec: 0, cameraId: 'c_bbbbbbbbbbbbbbbb' });
    const groups = groupAssets([a, b], DEFAULT_GROUPING);
    const groupContainsBothCameraIds = groups.some((g) => g.assetIds.includes(a.assetId) && g.assetIds.includes(b.assetId));
    expect(groupContainsBothCameraIds).toBe(false);
  });

  it('compares to the anchor, so A-B-C chains do not pull A and C together', () => {
    const A = item({ sec: 0, flip: 0 });
    const B = item({ sec: 1, flip: 8 });
    const C = item({ sec: 2, flip: 16 });
    const groups = groupAssets([A, B, C], DEFAULT_GROUPING);
    const chainGroupContainingAandC = groups.some((g) => g.assetIds.includes(A.assetId) && g.assetIds.includes(C.assetId));
    expect(chainGroupContainingAandC).toBe(false);
  });

  it('splits on a time gap over 2 s and on a span over 10 s', () => {
    const gap = groupAssets([item({ sec: 0 }), item({ sec: 3 })], DEFAULT_GROUPING);
    expect(gap.every((g) => g.assetIds.length === 1)).toBe(true);
    const burst = Array.from({ length: 13 }, (_, i) => item({ sec: i }));
    const spanned = groupAssets(burst, DEFAULT_GROUPING);
    expect(Math.max(...spanned.map((g) => g.assetIds.length))).toBeLessThanOrEqual(11);
  });

  it('groups frames without capture time conservatively, with low confidence', () => {
    const items = [item({ sec: null, flip: 0 }), item({ sec: null, flip: 4 }), item({ sec: null, flip: 9 })];
    const groups = groupAssets(items, DEFAULT_GROUPING);
    const missingTimeGroup = groups.find((g) => g.assetIds.length > 1)!;
    expect(missingTimeGroup.confidence).toBe('low');
    expect(missingTimeGroup.assetIds).toHaveLength(2); // flip 9 exceeds the stricter no-time threshold of 6
  });

  it('keeps assets without features as their own rows', () => {
    const noFeat = item({ sec: 0, features: null });
    const groups = groupAssets([noFeat, item({ sec: 0.5 })], DEFAULT_GROUPING);
    expect(groups.find((g) => g.assetIds.includes(noFeat.assetId))!.assetIds).toEqual([noFeat.assetId]);
  });

  it('is deterministic', () => {
    const items = [item({ sec: 0 }), item({ sec: 1, flip: 1 }), item({ sec: 5 })];
    expect(groupAssets(items, DEFAULT_GROUPING)).toEqual(groupAssets([...items].reverse(), DEFAULT_GROUPING));
  });
});

describe('reconcileGroups', () => {
  it('keeps manual groups exactly and removes their members from computed groups', () => {
    const [a, b, c, d] = [id(), id(), id(), id()];
    const manualGroup: Group = { id: 'g_00000000-0000-4000-8000-000000000001', assetIds: [a, c], confidence: 'high', manual: true };
    const computed: Group[] = [
      { id: 'g_00000000-0000-4000-8000-000000000002', assetIds: [a, b], confidence: 'high', manual: false },
      { id: 'g_00000000-0000-4000-8000-000000000003', assetIds: [c], confidence: 'high', manual: false },
      { id: 'g_00000000-0000-4000-8000-000000000004', assetIds: [d], confidence: 'low', manual: false },
    ];
    const groupsAfterRegroup = reconcileGroups([manualGroup], computed);
    expect(groupsAfterRegroup.find((g) => g.id === manualGroup.id)).toEqual(manualGroup);
    const all = groupsAfterRegroup.flatMap((g) => g.assetIds).sort();
    expect(all).toEqual([a, b, c, d].sort());
  });
});

describe('event-v2 preset and exact duplicates', () => {
  it('event-v2 joins frames up to 4 s apart, keeps the 10 s span and similarity thresholds', () => {
    expect(EVENT_GROUPING).toMatchObject({ version: 'event-v2', maxGapMs: 4000, maxSpanMs: 10_000, maxHamming: 10, minHistogram: 0.85 });
    expect(groupingPreset('group-v1')).toBe(DEFAULT_GROUPING);
    expect(groupingPreset('event-v2')).toBe(EVENT_GROUPING);
    expect(groupingPreset('unknown')).toBe(DEFAULT_GROUPING);
    const burst = [item({ sec: 0 }), item({ sec: 3 }), item({ sec: 6 })];
    expect(groupAssets(burst, DEFAULT_GROUPING)).toHaveLength(3);
    expect(groupAssets(burst, EVENT_GROUPING)).toHaveLength(1);
    expect(groupAssets([item({ sec: 0 }), item({ sec: 4 }), item({ sec: 8 }), item({ sec: 12 })], EVENT_GROUPING).map((g) => g.assetIds.length)).toEqual([3, 1]);
  });

  it('merges computed groups that hold byte-identical copies, never manual groups', () => {
    const [a, b, c, d] = [id(), id(), id(), id()];
    const groups: Group[] = [
      { id: 'g_00000000-0000-4000-8000-000000000001', assetIds: [a], confidence: 'high', manual: false },
      { id: 'g_00000000-0000-4000-8000-000000000002', assetIds: [b, c], confidence: 'high', manual: false },
      { id: 'g_00000000-0000-4000-8000-000000000003', assetIds: [d], confidence: 'high', manual: true },
    ];
    const merged = mergeExactDuplicates(groups, [[a, b], [c, d]]);
    expect(merged).toHaveLength(2);
    expect(merged.find((g) => g.assetIds.includes(a))!.assetIds.sort()).toEqual([a, b, c].sort());
    expect(merged.find((g) => g.manual)!.assetIds).toEqual([d]);
    expect(mergeExactDuplicates(groups, [])).toEqual(groups);
  });
});