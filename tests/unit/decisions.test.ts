import { describe, expect, it } from 'vitest';
import {
  applyReviewCommand,
  emptyReviewModel,
  findPairCandidates,
  keptMembers,
  undoReview,
  type PairFileInput,
  type ReviewModel,
} from '../../src/culling/decisions';
import type { Group } from '../../src/shared/contracts';

const A = 'a_00000000-0000-4000-8000-00000000000a';
const B = 'a_00000000-0000-4000-8000-00000000000b';
const C = 'a_00000000-0000-4000-8000-00000000000c';
const T1 = 't_00000000-0000-4000-8000-000000000001';

const model = (): ReviewModel => emptyReviewModel([A, B, C]);

describe('applyReviewCommand / undoReview', () => {
  it('keeps several frames of one group', () => {
    let s = model();
    s = applyReviewCommand(s, { type: 'set-review', assetIds: [A, B], state: 'keep' });
    s = applyReviewCommand(s, { type: 'set-review', assetIds: [C], state: 'pass' });
    const group: Group = { id: 'g_00000000-0000-4000-8000-000000000001', assetIds: [A, B, C], confidence: 'high', manual: false };
    const keepTwoInOneGroup = keptMembers(group, s);
    expect(keepTwoInOneGroup.members).toEqual([A, B]);
  });

  it('undo restores the exact previous state', () => {
    const beforeRating = applyReviewCommand(model(), { type: 'set-review', assetIds: [A], state: 'keep' });
    const afterRating = applyReviewCommand(beforeRating, { type: 'set-rating', assetIds: [A, B], rating: 4 });
    expect(afterRating.decisions[A]!.rating).toBe(4);
    expect(undoReview(afterRating)).toEqual(beforeRating);
  });

  it('undo with an empty journal is a no-op', () => {
    const s = model();
    expect(undoReview(s)).toEqual(s);
  });

  it('assigns targets and consent independently of review state', () => {
    let s = applyReviewCommand(model(), {
      type: 'upsert-target',
      target: { id: T1, label: 'Trao giải', required: true, requiresConsent: true, minCount: 1 },
    });
    s = applyReviewCommand(s, { type: 'assign-target', assetIds: [A], targetId: T1, assigned: true });
    s = applyReviewCommand(s, { type: 'set-consent', assetIds: [A], consent: 'allowed' });
    expect(s.decisions[A]).toMatchObject({ targetIds: [T1], consent: 'allowed', state: 'unreviewed' });
    s = applyReviewCommand(s, { type: 'remove-target', targetId: T1 });
    expect(s.decisions[A]!.targetIds).toEqual([]);
    expect(s.targets).toEqual([]);
  });

  it('pinning to a pack also confirms keep, and both packs stay independent', () => {
    let s = applyReviewCommand(model(), { type: 'pin', packId: 'quick', assetIds: [A], pinned: true });
    expect(s.decisions[A]!.state).toBe('keep');
    expect(s.members).toContainEqual({ packId: 'quick', assetId: A, pinned: true });
    const quickBefore = s.members.filter((m) => m.packId === 'quick');
    s = applyReviewCommand(s, { type: 'set-pack-member', packId: 'edit', assetIds: [A, B], member: true });
    s = applyReviewCommand(s, { type: 'set-pack-member', packId: 'edit', assetIds: [A], member: false });
    expect(s.members.filter((m) => m.packId === 'quick')).toEqual(quickBefore);
  });

  it('rejects nothing silently: rating values are already validated, unknown assets are ignored', () => {
    const s = applyReviewCommand(model(), { type: 'set-rating', assetIds: ['a_00000000-0000-4000-8000-0000000000ff'], rating: 3 });
    expect(s.decisions['a_00000000-0000-4000-8000-0000000000ff']).toBeUndefined();
  });
});

describe('findPairCandidates', () => {
  const f = (id: string, rel: string, kind: 'raw' | 'jpeg', meta: Partial<PairFileInput> = {}): PairFileInput => ({
    fileId: `f_00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    assetId: `a_00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    sourceId: 's_1',
    relativePath: rel,
    kind,
    model: 'ILCE-7C',
    serial: null,
    capturedLocal: '2026-09-29T14:54:04.695',
    metadataRead: true,
    paired: false,
    ...meta,
  });

  it('proposes a 1:1 RAW+JPEG with matching camera and time, unconfirmed', () => {
    const c = findPairCandidates([f('1', 'DCIM/A.ARW', 'raw'), f('2', 'DCIM/A.JPG', 'jpeg')]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ ambiguous: false, confirmed: false });
  });

  it('marks same-basename files in different folders, different cameras or extra JPEGs as ambiguous or unrelated', () => {
    const files = [
      f('1', 'Card A/B.ARW', 'raw'),
      f('2', 'Card B/B.JPG', 'jpeg'), // different folder: not a candidate at all
      f('3', 'X/C.ARW', 'raw'),
      f('4', 'X/C.JPG', 'jpeg', { model: 'NIKON D750' }), // camera mismatch
      f('5', 'Y/D.ARW', 'raw'),
      f('6', 'Y/D.JPG', 'jpeg'),
      f('7', 'Y/D.jpeg', 'jpeg'), // two JPEGs for one RAW
      f('8', 'Z/E.ARW', 'raw'),
      f('9', 'Z/E.JPG', 'jpeg', { capturedLocal: '2026-09-29T15:00:00' }), // time mismatch
    ];
    const ambiguousCandidates = findPairCandidates(files);
    expect(ambiguousCandidates.some((x) => x.rawId.endsWith('000000000001'))).toBe(false);
    expect(ambiguousCandidates.length).toBeGreaterThanOrEqual(4);
    expect(ambiguousCandidates.every((x) => x.ambiguous)).toBe(true);
    expect(ambiguousCandidates.every((x) => !x.confirmed)).toBe(true);
  });

  it('ignores files that are already paired', () => {
    expect(findPairCandidates([f('1', 'A.ARW', 'raw', { paired: true }), f('2', 'A.JPG', 'jpeg', { paired: true })])).toEqual([]);
  });
});
