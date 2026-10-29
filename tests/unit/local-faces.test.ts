import { describe, expect, it } from 'vitest';
import { assessLocalFaces } from '../../src/culling/local-faces';
import { fakeLocalInference } from '../helpers/local-inference';

describe('local observable face signals (not calibrated probabilities)', () => {
  it('maps open/closed using agreement between geometry and blendshapes', () => {
    expect(assessLocalFaces(fakeLocalInference())[0]).toMatchObject({ eyes: 'open', smile: true, confidence: null, eyesConfidence: null, sharpness: null, sunglasses: null, expressions: [] });
    expect(assessLocalFaces(fakeLocalInference(640, 427, true))[0]!.eyes).toBe('closed');
  });
  it('refuses contradictory signals, missing blendshapes and small faces', () => {
    const r = fakeLocalInference();
    r.blendshapes[0]![0]!.score = 0.95;
    expect(assessLocalFaces(r)[0]!.eyes).toBe('unknown');
    r.blendshapes = [];
    expect(assessLocalFaces(r)[0]!.unknownReasons).toContain('no-eye-data');
    expect(assessLocalFaces(fakeLocalInference(100, 100))[0]!.unknownReasons).toContain('small-face');
  });
  it('refuses unknown/extreme pose and invalid landmark output', () => {
    const r = fakeLocalInference();
    r.matrices = [];
    expect(assessLocalFaces(r)[0]!.unknownReasons).toContain('pose');
    r.landmarks[0]![0]!.x = NaN;
    expect(() => assessLocalFaces(r)).toThrow('LOCAL_INVALID_LANDMARKS');
  });
  it('distinguishes no face found from invalid output', () => {
    expect(assessLocalFaces({ width: 640, height: 427, landmarks: [], blendshapes: [], matrices: [] })).toEqual([]);
    expect(() => assessLocalFaces(fakeLocalInference(0, 0))).toThrow('LOCAL_INVALID_DIMENSIONS');
  });
});
