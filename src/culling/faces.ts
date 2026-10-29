import type { FaceAssessment } from '../shared/contracts';

/** Face as returned by the pilot backend (mirrors backend/src/app.ts ProviderFace). */
export interface ProviderFaceInput {
  boundingBox: { left: number; top: number; width: number; height: number };
  confidence: number;
  pose: { yaw: number; pitch: number; roll: number } | null;
  quality: { sharpness: number; brightness: number } | null;
  eyesOpen: { value: boolean; confidence: number } | null;
  smile: { value: boolean; confidence: number } | null;
  mouthOpen: { value: boolean; confidence: number } | null;
  sunglasses: { value: boolean; confidence: number } | null;
  eyeglasses: { value: boolean; confidence: number } | null;
  faceOccluded: { value: boolean; confidence: number } | null;
  eyeDirection: { yaw: number; pitch: number; confidence: number } | null;
  emotions: { type: string; confidence: number }[];
}

/** Trial defaults from the v0.2 plan; not an accuracy promise. */
export const EYE_RULES = { minFaceConfidence: 99, minShortSidePx: 80, minEyeConfidence: 90, maxAbsYaw: 35, maxAbsPitch: 25 } as const;

/**
 * Reads one provider face. Eye state is concluded only when the face is confidently detected,
 * large enough in the analysed image, roughly frontal, not occluded and without sunglasses, and
 * the eye signal itself is confident; otherwise it is "unknown" with the reasons.
 */
export function assessFace(f: ProviderFaceInput, imageWidth: number, imageHeight: number): FaceAssessment {
  const shortSidePx = Math.round(Math.min(f.boundingBox.width * imageWidth, f.boundingBox.height * imageHeight));
  const reasons: FaceAssessment['unknownReasons'] = [];
  if (f.confidence < EYE_RULES.minFaceConfidence) reasons.push('low-face-confidence');
  if (shortSidePx < EYE_RULES.minShortSidePx) reasons.push('small-face');
  if (!f.pose || Math.abs(f.pose.yaw) > EYE_RULES.maxAbsYaw || Math.abs(f.pose.pitch) > EYE_RULES.maxAbsPitch) reasons.push('pose');
  if (f.faceOccluded?.value) reasons.push('occluded');
  if (f.sunglasses?.value) reasons.push('sunglasses');
  if (!f.eyesOpen) reasons.push('no-eye-data');
  else if (f.eyesOpen.confidence < EYE_RULES.minEyeConfidence) reasons.push('low-eye-confidence');
  return {
    bbox: f.boundingBox,
    shortSidePx,
    confidence: f.confidence,
    pose: f.pose,
    eyes: reasons.length ? 'unknown' : f.eyesOpen!.value ? 'open' : 'closed',
    eyesConfidence: f.eyesOpen?.confidence ?? null,
    smile: f.smile ? f.smile.value : null,
    mouthOpen: f.mouthOpen ? f.mouthOpen.value : null,
    expressions: f.emotions,
    sharpness: f.quality?.sharpness ?? null,
    brightness: f.quality?.brightness ?? null,
    occluded: f.faceOccluded ? f.faceOccluded.value : null,
    sunglasses: f.sunglasses ? f.sunglasses.value : null,
    unknownReasons: reasons,
  };
}
