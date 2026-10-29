import { DetectFacesCommand, RekognitionClient, type FaceDetail } from '@aws-sdk/client-rekognition';
import type { FaceProvider, ProviderFace } from './app';

// Observable facial attributes only: no age range, gender or identity.
const ATTRIBUTES = ['DEFAULT', 'EYES_OPEN', 'SMILE', 'MOUTH_OPEN', 'EMOTIONS', 'EYE_DIRECTION', 'FACE_OCCLUDED', 'SUNGLASSES', 'EYEGLASSES'] as const;

const flag = (a?: { Value?: boolean; Confidence?: number }) =>
  a && typeof a.Value === 'boolean' ? { value: a.Value, confidence: Number(a.Confidence ?? 0) } : null;

export function mapFace(f: FaceDetail): ProviderFace {
  const b = f.BoundingBox ?? {};
  return {
    boundingBox: { left: Number(b.Left ?? 0), top: Number(b.Top ?? 0), width: Number(b.Width ?? 0), height: Number(b.Height ?? 0) },
    confidence: Number(f.Confidence ?? 0),
    pose: f.Pose ? { yaw: Number(f.Pose.Yaw ?? 0), pitch: Number(f.Pose.Pitch ?? 0), roll: Number(f.Pose.Roll ?? 0) } : null,
    quality: f.Quality ? { sharpness: Number(f.Quality.Sharpness ?? 0), brightness: Number(f.Quality.Brightness ?? 0) } : null,
    eyesOpen: flag(f.EyesOpen),
    smile: flag(f.Smile),
    mouthOpen: flag(f.MouthOpen),
    sunglasses: flag(f.Sunglasses),
    eyeglasses: flag(f.Eyeglasses),
    faceOccluded: flag(f.FaceOccluded),
    eyeDirection: f.EyeDirection
      ? { yaw: Number(f.EyeDirection.Yaw ?? 0), pitch: Number(f.EyeDirection.Pitch ?? 0), confidence: Number(f.EyeDirection.Confidence ?? 0) }
      : null,
    emotions: (f.Emotions ?? [])
      .map((e) => ({ type: String(e.Type), confidence: Number(e.Confidence ?? 0) }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3),
  };
}

export class RekognitionProvider implements FaceProvider {
  // One attempt only: every call must correspond to exactly one reserved quota unit.
  private readonly client = new RekognitionClient({ maxAttempts: 1 });
  async detectFaces(jpeg: Uint8Array): Promise<ProviderFace[]> {
    const r = await this.client.send(new DetectFacesCommand({ Image: { Bytes: jpeg }, Attributes: [...ATTRIBUTES] }));
    return (r.FaceDetails ?? []).map(mapFace);
  }
}
