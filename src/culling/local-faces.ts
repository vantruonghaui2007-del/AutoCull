import type { FaceAssessment } from '../shared/contracts';
import type { LocalInference } from '../shared/local-analysis';

const clamp = (v: number) => Math.max(0, Math.min(1, v));
type Point = { x: number; y: number; z: number };
/** Uncalibrated prototype thresholds: blendshape and eye geometry must agree. */
export function assessLocalFaces(r: LocalInference): FaceAssessment[] {
  if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width <= 0 || r.height <= 0) throw new Error('LOCAL_INVALID_DIMENSIONS');
  return r.landmarks.map((points, i) => {
    if (points.length !== 478 || points.some((p) => ![p.x, p.y, p.z].every(Number.isFinite))) throw new Error('LOCAL_INVALID_LANDMARKS');
    const left = clamp(Math.min(...points.map((p) => p.x)));
    const top = clamp(Math.min(...points.map((p) => p.y)));
    const width = clamp(Math.max(...points.map((p) => p.x))) - left;
    const height = clamp(Math.max(...points.map((p) => p.y))) - top;
    const shortSidePx = Math.min(width * r.width, height * r.height);
    if (width <= 0 || height <= 0) throw new Error('LOCAL_INVALID_FACE_BOX');
    const b: Record<string, number> = {};
    for (const c of r.blendshapes[i] ?? []) if (Number.isFinite(c.score) && c.score >= 0 && c.score <= 1) b[c.categoryName] = c.score;
    const m = r.matrices[i];
    // MediaPipe's transformation matrix is column-major. Angles are geometry, not confidence.
    const pose = m?.length === 16 && m.every(Number.isFinite) ? {
      yaw: Math.asin(Math.max(-1, Math.min(1, -m[2]!))) * 180 / Math.PI,
      pitch: Math.atan2(m[6]!, m[10]!) * 180 / Math.PI,
      roll: Math.atan2(m[1]!, m[0]!) * 180 / Math.PI,
    } : null;
    const reasons: FaceAssessment['unknownReasons'] = [];
    const dist = (a: Point, z: Point) => Math.hypot((a.x - z.x) * r.width, (a.y - z.y) * r.height);
    const eye = (outer: number, inner: number, upper: number, lower: number, blink: number | undefined): 'open' | 'closed' | 'unknown' => {
      const span = dist(points[outer]!, points[inner]!);
      if (span < 16 || blink === undefined) return 'unknown';
      const aperture = dist(points[upper]!, points[lower]!) / span;
      if (blink >= 0.65 && aperture <= 0.16) return 'closed';
      if (blink <= 0.2 && aperture >= 0.18) return 'open';
      return 'unknown';
    };
    if (shortSidePx < 80) reasons.push('small-face');
    if (!pose || Math.abs(pose.yaw) > 30 || Math.abs(pose.pitch) > 25 || Math.abs(pose.roll) > 35) reasons.push('pose');
    // Cropped faces can hallucinate landmarks beyond the frame: do not conclude eye state.
    if (points.some((p) => p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1)) reasons.push('occluded');
    const le = eye(362, 263, 386, 374, b.eyeBlinkLeft);
    const re = eye(33, 133, 159, 145, b.eyeBlinkRight);
    if (b.eyeBlinkLeft === undefined || b.eyeBlinkRight === undefined) reasons.push('no-eye-data');
    else if (le === 'unknown' || re === 'unknown') reasons.push('low-eye-confidence');
    const smileL = b.mouthSmileLeft;
    const smileR = b.mouthSmileRight;
    const smile = reasons.some((r) => r === 'small-face' || r === 'pose' || r === 'occluded') || smileL === undefined || smileR === undefined ? null : smileL > 0.55 && smileR > 0.55 ? true : smileL < 0.25 && smileR < 0.25 ? false : null;
    return {
      bbox: { left, top, width, height }, shortSidePx: Math.round(shortSidePx), confidence: null, pose,
      eyes: reasons.length ? 'unknown' : le === 'closed' || re === 'closed' ? 'closed' : 'open',
      eyesConfidence: null, smile, mouthOpen: b.jawOpen === undefined ? null : b.jawOpen > 0.5 ? true : b.jawOpen < 0.15 ? false : null,
      expressions: [], sharpness: null, brightness: null, occluded: null, sunglasses: null,
      unknownReasons: reasons, observedBlendshapes: b,
    };
  });
}
