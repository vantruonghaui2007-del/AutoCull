import { describe, expect, it } from 'vitest';
import { mapFace } from '../src/rekognition';

describe('mapFace', () => {
  it('keeps observable attributes and drops age/gender', () => {
    const f = mapFace({
      BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.4 },
      Confidence: 99.5,
      Pose: { Yaw: 10, Pitch: -5, Roll: 2 },
      Quality: { Sharpness: 70, Brightness: 55 },
      EyesOpen: { Value: false, Confidence: 96 },
      Smile: { Value: true, Confidence: 80 },
      AgeRange: { Low: 20, High: 30 },
      Gender: { Value: 'Male', Confidence: 99 },
      Emotions: [
        { Type: 'CALM', Confidence: 10 },
        { Type: 'HAPPY', Confidence: 85 },
        { Type: 'SAD', Confidence: 2 },
        { Type: 'ANGRY', Confidence: 1 },
      ],
    });
    expect(f.eyesOpen).toEqual({ value: false, confidence: 96 });
    expect(f.mouthOpen).toBeNull();
    expect(f.emotions.map((e) => e.type)).toEqual(['HAPPY', 'CALM', 'SAD']);
    expect(JSON.stringify(f)).not.toMatch(/Age|Gender|Male/);
  });
});
