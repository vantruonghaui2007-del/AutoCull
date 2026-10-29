import { describe, expect, it } from 'vitest';
import { assessFace, EYE_RULES, type ProviderFaceInput } from '../../src/culling/faces';

const face = (o: Partial<ProviderFaceInput> = {}): ProviderFaceInput => ({
  boundingBox: { left: 0.4, top: 0.3, width: 0.05, height: 0.08 },
  confidence: 99.8,
  pose: { yaw: 5, pitch: -3, roll: 0 },
  quality: { sharpness: 70, brightness: 60 },
  eyesOpen: { value: false, confidence: 96 },
  smile: { value: false, confidence: 90 },
  mouthOpen: { value: true, confidence: 90 },
  sunglasses: { value: false, confidence: 99 },
  eyeglasses: { value: false, confidence: 99 },
  faceOccluded: { value: false, confidence: 99 },
  eyeDirection: null,
  emotions: [{ type: 'CALM', confidence: 70 }],
  ...o,
});
// 3840x2560 image: width ratio 0.05 → 192 px, height 0.08 → 205 px; short side 192.
const W = 3840;
const H = 2560;

describe('assessFace (eye rule thresholds)', () => {
  it('uses the plan thresholds', () => {
    expect(EYE_RULES).toEqual({ minFaceConfidence: 99, minShortSidePx: 80, minEyeConfidence: 90, maxAbsYaw: 35, maxAbsPitch: 25 });
  });

  it('concludes closed or open eyes only when every condition holds', () => {
    expect(assessFace(face(), W, H)).toMatchObject({ eyes: 'closed', eyesConfidence: 96, shortSidePx: 192, unknownReasons: [] });
    expect(assessFace(face({ eyesOpen: { value: true, confidence: 99 } }), W, H).eyes).toBe('open');
  });

  it('returns unknown with reasons for small, turned, low-confidence, occluded or sunglasses faces', () => {
    const small = assessFace(face({ boundingBox: { left: 0, top: 0, width: 0.015, height: 0.03 } }), W, H);
    expect(small).toMatchObject({ eyes: 'unknown', unknownReasons: ['small-face'] });
    expect(assessFace(face({ pose: { yaw: 40, pitch: 0, roll: 0 } }), W, H).unknownReasons).toContain('pose');
    expect(assessFace(face({ pose: { yaw: 0, pitch: -30, roll: 0 } }), W, H).unknownReasons).toContain('pose');
    expect(assessFace(face({ confidence: 98 }), W, H).unknownReasons).toContain('low-face-confidence');
    expect(assessFace(face({ eyesOpen: { value: false, confidence: 85 } }), W, H).unknownReasons).toContain('low-eye-confidence');
    expect(assessFace(face({ faceOccluded: { value: true, confidence: 95 } }), W, H).unknownReasons).toContain('occluded');
    expect(assessFace(face({ sunglasses: { value: true, confidence: 95 } }), W, H).unknownReasons).toContain('sunglasses');
    expect(assessFace(face({ eyesOpen: null }), W, H).unknownReasons).toContain('no-eye-data');
  });

  it('keeps an open mouth or a serious face as plain observations, not errors', () => {
    const a = assessFace(face(), W, H);
    expect(a.mouthOpen).toBe(true);
    expect(a.smile).toBe(false);
    expect(a.expressions).toEqual([{ type: 'CALM', confidence: 70 }]);
  });
});
