import { describe, expect, it } from 'vitest';
import { acceptableFrom, assessQuality, QUALITY_CONFIG, rankGroup, type RankInput } from '../../src/culling/ranking';
import type { FaceAssessment } from '../../src/shared/contracts';

const face = (o: Partial<FaceAssessment> = {}): FaceAssessment => ({
  bbox: { left: 0.4, top: 0.3, width: 0.1, height: 0.15 },
  shortSidePx: 300,
  confidence: 99.9,
  pose: { yaw: 0, pitch: 0, roll: 0 },
  eyes: 'open',
  eyesConfidence: 98,
  smile: false,
  mouthOpen: false,
  expressions: [{ type: 'CALM', confidence: 80 }],
  sharpness: 80,
  brightness: 60,
  occluded: false,
  sunglasses: false,
  unknownReasons: [],
  ...o,
});
let n = 0;
const shot = (o: Partial<RankInput> = {}): RankInput => ({
  assetId: `a_00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  analysis: 'done',
  faces: [face()],
  faceCropSharpness: [100],
  wholeImageSharpness: 300,
  clippedFraction: 0.002,
  ...o,
});
const labels = (r: ReturnType<typeof rankGroup>) => Object.fromEntries(r.map((x) => [x.assetId, x.label]));

describe('assessQuality', () => {
  it('uses the plan weights, versioned', () => {
    expect(QUALITY_CONFIG.weights).toEqual({ sharpness: 0.4, eyes: 0.3, lighting: 0.15, composition: 0.1, expression: 0.05 });
    expect(QUALITY_CONFIG.version).toMatch(/^quality-v\d+/);
  });

  it('marks eyes/composition/expression not applicable without faces and falls back to whole-image sharpness', () => {
    const q = assessQuality(shot({ faces: [], faceCropSharpness: [] }), { maxFaceCrop: 0, maxWhole: 300 });
    expect(q.eyes.state).toBe('not-applicable');
    expect(q.expression.state).toBe('not-applicable');
    expect(q.sharpness).toMatchObject({ state: 'known', note: expect.stringContaining('toàn ảnh') });
  });

  it('treats unknown eyes (sunglasses, small face) as unknown, not as closed', () => {
    const q = assessQuality(shot({ faces: [face({ eyes: 'unknown', unknownReasons: ['sunglasses'] })] }), { maxFaceCrop: 100, maxWhole: 300 });
    expect(q.eyes.state).toBe('unknown');
    expect(q.eyes.score).toBeNull();
    expect(q.total).not.toBeNull();
  });

  it('does not reward brightness by itself', () => {
    const normal = assessQuality(shot({ faces: [face({ brightness: 55 })] }), { maxFaceCrop: 100, maxWhole: 300 });
    const brighter = assessQuality(shot({ faces: [face({ brightness: 85 })] }), { maxFaceCrop: 100, maxWhole: 300 });
    expect(brighter.lighting.score!).toBeLessThanOrEqual(normal.lighting.score!);
  });
});

describe('rankGroup', () => {
  it('local faces with near-flat crops cannot win just by being the best in a blurred group', () => {
    const local = face({ sharpness: null, confidence: null, observedBlendshapes: {} });
    const r = rankGroup([shot({ faces: [local], faceCropSharpness: [0.1] }), shot({ faces: [local], faceCropSharpness: [0.2] })]);
    expect(r.every((x) => x.label === 'review' && x.reasons.includes('BLURRY'))).toBe(true);
    expect(r[0]!.quality.sharpness.score).toBeLessThan(20);
  });
  it('an intentionally blurred small background face does not reject the sharp main subject', () => {
    const subject = face({ sharpness: 85 });
    const background = face({ bbox: { left: 0.8, top: 0.2, width: 0.01, height: 0.02 }, shortSidePx: 25, sharpness: 5, eyes: 'unknown', unknownReasons: ['small-face'] });
    const r = rankGroup([shot({ faces: [subject, background], faceCropSharpness: [100, 2] })]);
    expect(r[0]).toMatchObject({ label: 'keep', acceptable: true });
    expect(r[0]!.reasons).not.toContain('BLURRY');
    expect(r[0]!.quality.sharpness.score!).toBeGreaterThan(80);
  });
  it('a blurry face cannot pass merely because it is the best or only shot', () => {
    const blurry = () => shot({ faces: [face({ sharpness: 8 })] });
    expect(rankGroup([blurry()])[0]).toMatchObject({ label: 'review', reasons: expect.arrayContaining(['BLURRY']) });
    expect(rankGroup([blurry(), blurry()]).every((r) => r.label === 'review')).toBe(true);
  });

  it('flat no-face frames and missing face sharpness are not judged sharp from the background', () => {
    expect(rankGroup([shot({ faces: [], faceCropSharpness: [], wholeImageSharpness: 0.1 })])[0]!.label).toBe('review');
    const unknown = shot({ faces: [face({ sharpness: null })], faceCropSharpness: [], wholeImageSharpness: 900 });
    expect(rankGroup([unknown])[0]).toMatchObject({ label: 'review', reasons: expect.arrayContaining(['SHARPNESS_UNKNOWN']) });
  });

  it('no-face shots need review even when they are the majority of the group', () => {
    const missing = () => shot({ faces: [], faceCropSharpness: [] });
    const a = missing();
    const b = missing();
    const r = rankGroup([a, b, shot()]);
    for (const id of [a.assetId, b.assetId]) {
      expect(r.find((x) => x.assetId === id)).toMatchObject({ label: 'review', reasons: expect.arrayContaining(['FACE_COUNT_CHANGED']) });
    }
  });
  it('prefers the sharp face over a sharp background with a blurry face', () => {
    const bgSharp = shot({ faceCropSharpness: [20], wholeImageSharpness: 900 });
    const faceSharp = shot({ faceCropSharpness: [100], wholeImageSharpness: 300 });
    const r = rankGroup([bgSharp, faceSharp]);
    expect(r[0]!.assetId).toBe(faceSharp.assetId);
    expect(labels(r)[faceSharp.assetId]).toBe('keep');
    expect(labels(r)[bgSharp.assetId]).toBe('better-option');
  });

  it('a clearly closed-eye shot never wins over an open, sharp alternative, even with a nicer smile', () => {
    const closedSmiling = shot({ faces: [face({ eyes: 'closed', smile: true })] });
    const open = shot({ faces: [face({ smile: false })], faceCropSharpness: [90] });
    const r = rankGroup([closedSmiling, open]);
    expect(r[0]!.assetId).toBe(open.assetId);
    expect(r.find((x) => x.assetId === closedSmiling.assetId)!.reasons).toContain('EYES_CLOSED');
  });

  it('with several people, one closed pair of eyes loses to all-open', () => {
    const group = [face(), face(), face(), face({ eyes: 'closed' }), face()];
    const allOpen = [face(), face(), face(), face(), face()];
    const a = shot({ faces: group, faceCropSharpness: [100, 100, 100, 100, 100] });
    const b = shot({ faces: allOpen, faceCropSharpness: [95, 95, 95, 95, 95] });
    expect(rankGroup([a, b])[0]!.assetId).toBe(b.assetId);
  });

  it('a single acceptable shot is kept; a single closed-eye shot goes to review', () => {
    expect(rankGroup([shot()])[0]!.label).toBe('keep');
    const r = rankGroup([shot({ faces: [face({ eyes: 'closed' })] })]);
    expect(r[0]!.label).toBe('review');
  });

  it('equivalent shots: deterministic winner, the other flagged as a near-equal option', () => {
    const a = shot();
    const b = shot();
    const r1 = rankGroup([a, b]);
    const r2 = rankGroup([b, a]);
    expect(r1[0]!.assetId).toBe(r2[0]!.assetId);
    expect(r1[1]!.reasons).toContain('NEAR_EQUAL');
    expect(r1[1]!.label).toBe('better-option');
  });

  it('a group where every shot fails goes to review', () => {
    const r = rankGroup([shot({ faces: [face({ eyes: 'closed' })] }), shot({ faces: [face({ eyes: 'closed' })] })]);
    expect(r.every((x) => x.label === 'review')).toBe(true);
    expect(r[0]!.reasons).toContain('GROUP_NO_ACCEPTABLE_SHOT');
  });

  it('a shot where faces disappear while the others have them goes to review', () => {
    const missing = shot({ faces: [], faceCropSharpness: [], wholeImageSharpness: 999 });
    const others = [shot({ faces: [face(), face()], faceCropSharpness: [90, 90] }), shot({ faces: [face(), face()], faceCropSharpness: [80, 80] })];
    const r = rankGroup([missing, ...others]);
    expect(r.find((x) => x.assetId === missing.assetId)).toMatchObject({ label: 'review', reasons: expect.arrayContaining(['FACE_COUNT_CHANGED']) });
  });

  it('a small face or sunglasses gives unknown eyes, which is not penalised like closed eyes', () => {
    const shades = shot({ faces: [face({ eyes: 'unknown', unknownReasons: ['sunglasses'] })], faceCropSharpness: [100] });
    const closed = shot({ faces: [face({ eyes: 'closed' })], faceCropSharpness: [100] });
    const r = rankGroup([shades, closed]);
    expect(r[0]!.assetId).toBe(shades.assetId);
    expect(r[0]!.reasons).toContain('EYES_UNKNOWN');
  });

  it('a small face (eyes unknown) with a sharp crop beats a closed-eye frame and is still kept', () => {
    const small = shot({ faces: [face({ eyes: 'unknown', shortSidePx: 50, unknownReasons: ['small-face'] })] });
    const closed = shot({ faces: [face({ eyes: 'closed' })] });
    const r = rankGroup([closed, small]);
    expect(r[0]).toMatchObject({ assetId: small.assetId, label: 'keep' });
    expect(r[0]!.quality.eyes.state).toBe('unknown');
  });

  it('photos not analysed yet are listed for review, not ranked as if they were', () => {
    const r = rankGroup([shot({ analysis: 'none', faces: null, faceCropSharpness: [] }), shot({ analysis: 'none', faces: null, faceCropSharpness: [] })]);
    expect(r.every((x) => x.label === 'review' && x.reasons.includes('NOT_ANALYZED'))).toBe(true);
  });

  it('stored reasons alone tell whether a shot was acceptable', () => {
    const r = rankGroup([shot(), shot({ faces: [face({ eyes: 'closed' })] }), shot({ faceCropSharpness: [5] }), shot({ analysis: 'failed', faces: null, faceCropSharpness: [] })]);
    for (const x of r) expect(acceptableFrom(x.reasons), x.reasons.join()).toBe(x.acceptable);
  });

  it('marks the best shot of the group on every member', () => {
    const r = rankGroup([shot(), shot({ faceCropSharpness: [10] })]);
    expect(new Set(r.map((x) => x.bestAssetId))).toEqual(new Set([r[0]!.assetId]));
  });
});
