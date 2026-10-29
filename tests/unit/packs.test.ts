import { describe, expect, it } from 'vitest';
import { applyReviewCommand, emptyReviewModel } from '../../src/culling/decisions';
import { buildDeliveryEvent, deliveredAssetIds } from '../../src/culling/delivery';
import { computeCoverage, suggestPack, type PackInput } from '../../src/culling/packs';
import type { CoverageTarget, Decision, Group, PackMember } from '../../src/shared/contracts';

const aid = (n: number) => `a_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = (n: number) => `t_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gid = (n: number) => `g_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const STAGE: CoverageTarget = { id: tid(1), label: 'Sân khấu', required: true, requiresConsent: false, minCount: 1 };
const AWARD: CoverageTarget = { id: tid(2), label: 'Trao giải', required: true, requiresConsent: false, minCount: 2 };
const GROUP_PHOTO: CoverageTarget = { id: tid(3), label: 'Ảnh tập thể', required: true, requiresConsent: true, minCount: 1 };
const SPONSOR: CoverageTarget = { id: tid(4), label: 'Nhà tài trợ', required: true, requiresConsent: false, minCount: 1 };

function dec(n: number, o: Partial<Decision> = {}): Decision {
  return { assetId: aid(n), state: 'keep', rating: 3, consent: 'unknown', targetIds: [], ...o };
}

function input(o: Partial<Omit<PackInput, 'decisions'>> & { decisions: Decision[] }): PackInput {
  return {
    rule: o.rule ?? { id: 'quick', limit: 12, targetIds: [] },
    members: o.members ?? [],
    decisions: Object.fromEntries(o.decisions.map((d) => [d.assetId, d])),
    groups: o.groups ?? o.decisions.map((d, i) => ({ id: gid(1000 + i), assetIds: [d.assetId], confidence: 'high', manual: false })),
    targets: o.targets ?? [],
    signals: o.signals ?? {},
  };
}

describe('suggestPack', () => {
  it('keeps every pin even when pins exceed the quota, and reports the conflict', () => {
    const decisions = Array.from({ length: 5 }, (_, i) => dec(i + 1));
    const pinnedIds = decisions.slice(0, 4).map((d) => d.assetId);
    const members: PackMember[] = pinnedIds.map((assetId) => ({ packId: 'quick', assetId, pinned: true }));
    const overQuotaSuggestion = suggestPack(input({ decisions, members, rule: { id: 'quick', limit: 3, targetIds: [] } }));
    expect(overQuotaSuggestion.conflicts).toContain('PINNED_OVER_LIMIT');
    expect(overQuotaSuggestion.suggestedIds).toEqual(expect.arrayContaining(pinnedIds));
    expect(overQuotaSuggestion.suggestedIds).toHaveLength(4);
  });

  it('does not count a photo with unknown consent toward a target that needs consent', () => {
    const decisions = [dec(1, { targetIds: [GROUP_PHOTO.id], consent: 'unknown' })];
    const s = suggestPack(input({ decisions, targets: [GROUP_PHOTO], rule: { id: 'quick', limit: 12, targetIds: [GROUP_PHOTO.id] } }));
    const unknownConsentCoverage = s.coverage.find((c) => c.targetId === GROUP_PHOTO.id)!;
    expect(unknownConsentCoverage.status).not.toBe('enough');
    expect(unknownConsentCoverage.status).toBe('unknown');
  });

  it('reports a required target with no approved photo as missing and never substitutes a look-alike', () => {
    const decisions = [dec(1, { targetIds: [STAGE.id] }), dec(2), dec(3, { state: 'review', targetIds: [SPONSOR.id] })];
    const s = suggestPack(input({ decisions, targets: [STAGE, SPONSOR], rule: { id: 'quick', limit: 12, targetIds: [STAGE.id, SPONSOR.id] } }));
    const requiredTargetWithNoApprovedImage = s.coverage.find((c) => c.targetId === SPONSOR.id)!;
    expect(requiredTargetWithNoApprovedImage.status).toBe('missing');
    expect(requiredTargetWithNoApprovedImage.evidenceIds).toEqual([]);
    expect(s.conflicts).toContain(`TARGET_MISSING:${SPONSOR.id}`);
    expect(s.suggestedIds).not.toContain(aid(3)); // not approved
  });

  it('only suggests photos the photographer kept', () => {
    const decisions = [dec(1), dec(2, { state: 'pass' }), dec(3, { state: 'unreviewed' }), dec(4, { state: 'review' })];
    expect(suggestPack(input({ decisions })).suggestedIds).toEqual([aid(1)]);
  });

  it('prefers covering targets, then spreads across groups before repeating one', () => {
    const big: Group = { id: gid(1), assetIds: [aid(1), aid(2), aid(3), aid(4)], confidence: 'high', manual: false };
    const other: Group = { id: gid(2), assetIds: [aid(5)], confidence: 'high', manual: false };
    const decisions = [dec(1, { rating: 5 }), dec(2, { rating: 5 }), dec(3, { rating: 5 }), dec(4, { rating: 5 }), dec(5, { rating: 1 })];
    const s = suggestPack(input({ decisions, groups: [big, other], rule: { id: 'quick', limit: 2, targetIds: [] } }));
    expect(s.suggestedIds).toContain(aid(5));
    expect(s.suggestedIds).toHaveLength(2);
  });

  it('breaks ties deterministically', () => {
    const decisions = [dec(3), dec(1), dec(2)];
    const a = suggestPack(input({ decisions, rule: { id: 'quick', limit: 2, targetIds: [] } }));
    const b = suggestPack(input({ decisions: [...decisions].reverse(), rule: { id: 'quick', limit: 2, targetIds: [] } }));
    expect(a.suggestedIds).toEqual(b.suggestedIds);
  });

  it('makes no coverage claims when the pack has no targets', () => {
    const s = suggestPack(input({ decisions: [dec(1)] }));
    expect(s.coverage).toEqual([]);
  });

  it('scenario: 12 quick / 120 edit with pins, unknown consent, a missing target and a large burst', () => {
    const decisions: Decision[] = [];
    const burst: Group = { id: gid(1), assetIds: [], confidence: 'high', manual: false };
    for (let i = 1; i <= 150; i++) {
      const d = dec(i, { rating: (i % 5) as Decision['rating'] });
      if (i <= 40) burst.assetIds.push(d.assetId);
      if (i === 41 || i === 42) d.targetIds = [STAGE.id];
      if (i === 43 || i === 44 || i === 45) d.targetIds = [AWARD.id];
      if (i === 46) d.targetIds = [GROUP_PHOTO.id]; // consent unknown
      decisions.push(d);
    }
    const groups: Group[] = [burst, ...decisions.slice(40).map((d, i) => ({ id: gid(100 + i), assetIds: [d.assetId], confidence: 'high' as const, manual: false }))];
    const targets = [STAGE, AWARD, GROUP_PHOTO, SPONSOR];
    const members: PackMember[] = [{ packId: 'quick', assetId: aid(7), pinned: true }];
    const quick = suggestPack(input({ decisions, groups, targets, members, rule: { id: 'quick', limit: 12, targetIds: targets.map((t) => t.id) } }));
    expect(quick.suggestedIds).toHaveLength(12);
    expect(quick.suggestedIds).toContain(aid(7));
    const cov = Object.fromEntries(quick.coverage.map((c) => [c.targetId, c.status]));
    expect(cov).toEqual({ [STAGE.id]: 'enough', [AWARD.id]: 'enough', [GROUP_PHOTO.id]: 'unknown', [SPONSOR.id]: 'missing' });
    expect(quick.suggestedIds.filter((id) => burst.assetIds.includes(id)).length).toBeLessThanOrEqual(2);

    const edit = suggestPack(input({ decisions, groups, targets, rule: { id: 'edit', limit: 120, targetIds: [] } }));
    expect(edit.suggestedIds).toHaveLength(120);
    const unlimited = suggestPack(input({ decisions, groups, rule: { id: 'edit', limit: null, targetIds: [] } }));
    expect(unlimited.suggestedIds).toHaveLength(150);
  });
});

describe('suggestPack performance', () => {
  it('handles an unlimited pack with 6,000 kept photos quickly', () => {
    const decisions = Array.from({ length: 6000 }, (_, i) => dec(i + 1, { rating: (i % 6) as Decision['rating'] }));
    const groups: Group[] = Array.from({ length: 1500 }, (_, g) => ({
      id: gid(g),
      assetIds: decisions.slice(g * 4, g * 4 + 4).map((d) => d.assetId),
      confidence: 'high' as const,
      manual: false,
    }));
    const started = performance.now();
    const s = suggestPack(input({ decisions, groups, rule: { id: 'edit', limit: null, targetIds: [] } }));
    const ms = performance.now() - started;
    expect(s.suggestedIds).toHaveLength(6000);
    expect(ms).toBeLessThan(1500);
  });
});

describe('computeCoverage', () => {
  it('counts only kept photos with the target and the needed consent', () => {
    const decisions = Object.fromEntries(
      [dec(1, { targetIds: [GROUP_PHOTO.id], consent: 'allowed' }), dec(2, { targetIds: [GROUP_PHOTO.id], consent: 'blocked' })].map((d) => [d.assetId, d]),
    );
    const [c] = computeCoverage([aid(1), aid(2)], decisions, [GROUP_PHOTO]);
    expect(c).toMatchObject({ status: 'enough', evidenceIds: [aid(1)] });
  });
});

describe('packs stay independent', () => {
  it('editing the edit pack never changes the quick pack', () => {
    let s = emptyReviewModel([aid(1), aid(2), aid(3)]);
    s = applyReviewCommand(s, { type: 'accept-suggestion', packId: 'quick', assetIds: [aid(1), aid(2)] });
    s = applyReviewCommand(s, { type: 'pin', packId: 'quick', assetIds: [aid(2)], pinned: true });
    const quickMembershipBefore = s.members.filter((m) => m.packId === 'quick');
    s = applyReviewCommand(s, { type: 'accept-suggestion', packId: 'edit', assetIds: [aid(1), aid(2), aid(3)] });
    s = applyReviewCommand(s, { type: 'set-pack-member', packId: 'edit', assetIds: [aid(2)], member: false });
    s = applyReviewCommand(s, { type: 'pin', packId: 'edit', assetIds: [aid(3)], pinned: true });
    const quickMembershipAfterEditingEditPack = s.members.filter((m) => m.packId === 'quick');
    expect(quickMembershipAfterEditingEditPack).toEqual(quickMembershipBefore);
  });

  it('accepting a suggestion keeps pins that the suggestion did not list', () => {
    let s = emptyReviewModel([aid(1), aid(2)]);
    s = applyReviewCommand(s, { type: 'pin', packId: 'quick', assetIds: [aid(1)], pinned: true });
    s = applyReviewCommand(s, { type: 'accept-suggestion', packId: 'quick', assetIds: [aid(2)] });
    expect(s.members.filter((m) => m.packId === 'quick').map((m) => m.assetId).sort()).toEqual([aid(1), aid(2)].sort());
  });
});

describe('delivery events', () => {
  it('snapshots asset IDs and fingerprints, and corrections supersede without deleting', () => {
    const original = buildDeliveryEvent({ packId: 'quick', assetIds: [aid(1), aid(2)], fingerprints: { f_1: 'h1' }, correctsEventId: null, at: '2026-10-28T10:00:00Z' });
    const correction = buildDeliveryEvent({ packId: 'quick', assetIds: [aid(1)], fingerprints: { f_1: 'h1' }, correctsEventId: original.id, at: '2026-10-28T11:00:00Z' });
    expect(correction.correctsEventId).toBe(original.id);
    expect([...deliveredAssetIds([original, correction])]).toEqual([aid(1)]);
    expect(original.assetIds).toEqual([aid(1), aid(2)]);
  });
});
