import { describe, expect, it } from 'vitest';
import { defaultDecision } from '../../src/culling/decisions';
import { listOf, listsFor, resolveSelection, type RecInfo } from '../../src/culling/selection';
import type { Decision, Group } from '../../src/shared/contracts';

const A = 'a_00000000-0000-4000-8000-00000000000a';
const B = 'a_00000000-0000-4000-8000-00000000000b';
const C = 'a_00000000-0000-4000-8000-00000000000c';
const G: Group = { id: 'g_00000000-0000-4000-8000-000000000001', assetIds: [A, B, C], confidence: 'high', manual: false };
const recs = new Map<string, RecInfo>([
  [A, { assetId: A, label: 'keep', rank: 1, acceptable: true }],
  [B, { assetId: B, label: 'better-option', rank: 2, acceptable: true }],
  [C, { assetId: C, label: 'better-option', rank: 3, acceptable: false }],
]);
const dec = (o: Record<string, Partial<Decision>> = {}) =>
  Object.fromEntries([A, B, C].map((id) => [id, { ...defaultDecision(id), ...(o[id] ?? {}) }]));

describe('resolveSelection', () => {
  it('manual review stays in review even with another pick; a manual pass never asks for review', () => {
    const decisions = dec({ [B]: { state: 'review' }, [C]: { state: 'pass' } });
    const s = resolveSelection([G], decisions, recs);
    expect(listsFor([G], s, recs, decisions).get(B)).toBe('review');
    const single = dec({ [A]: { state: 'pass' }, [B]: { state: 'pass' }, [C]: { state: 'pass' } });
    const excluded = resolveSelection([G], single, new Map());
    expect([...listsFor([G], excluded, new Map(), single).values()]).toEqual(['better-option', 'better-option', 'better-option']);
  });
  it('with no manual decisions, the automatic pick is selected', () => {
    const s = resolveSelection([G], dec(), recs);
    expect(s.get(A)).toMatchObject({ selected: true, source: 'auto' });
    expect(s.get(B)).toMatchObject({ selected: false, source: 'not-recommended' });
    expect(listOf(s.get(B)!, recs.get(B))).toBe('better-option');
  });

  it('manual keeps replace the automatic pick, and several can be kept', () => {
    const s = resolveSelection([G], dec({ [B]: { state: 'keep' }, [C]: { state: 'keep' } }), recs);
    expect([...s.values()].filter((x) => x.selected).map((x) => x.assetId).sort()).toEqual([B, C].sort());
    expect(s.get(A)).toMatchObject({ selected: false });
  });

  it('a manual pass on the automatic pick promotes the next acceptable shot', () => {
    const s = resolveSelection([G], dec({ [A]: { state: 'pass' } }), recs);
    expect(s.get(A)).toMatchObject({ selected: false, source: 'manual-excluded' });
    expect(s.get(B)).toMatchObject({ selected: true, source: 'auto' });
  });

  it('marking something "xem lại" also excludes it from the automatic pick', () => {
    const s = resolveSelection([G], dec({ [A]: { state: 'review' }, [B]: { state: 'pass' } }), recs);
    expect([...s.values()].some((x) => x.selected)).toBe(false); // C is not acceptable
    expect(listOf(s.get(C)!, recs.get(C), false)).toBe('review');
    expect(listsFor([G], s, recs).get(C)).toBe('review');
  });

  it('resetting a manual choice to unreviewed brings back the automatic pick', () => {
    const before = resolveSelection([G], dec({ [B]: { state: 'keep' } }), recs);
    expect(before.get(A)!.selected).toBe(false);
    const after = resolveSelection([G], dec({ [B]: { state: 'unreviewed' } }), recs);
    expect(after.get(A)!.selected).toBe(true);
  });

  it('photos without a recommendation are not selected automatically', () => {
    const s = resolveSelection([G], dec(), new Map());
    expect([...s.values()].every((x) => !x.selected && x.source === 'no-analysis')).toBe(true);
    expect(listOf(s.get(A)!, undefined)).toBe('review');
  });

  it('assets outside any group are resolved as their own group', () => {
    const s = resolveSelection([], dec(), recs);
    expect(s.get(A)).toMatchObject({ selected: true });
  });
});
