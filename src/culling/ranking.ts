import type { AssetId, CullLabel, Criterion, FaceAssessment, QualityAssessment } from '../shared/contracts';

/** Inputs for one shot. Sharpness values are relative signals, comparable only inside a group. */
export interface RankInput {
  assetId: AssetId;
  analysis: 'done' | 'none' | 'pending' | 'failed' | 'stale';
  /** null = not analysed; [] = analysed, no face found. */
  faces: FaceAssessment[] | null;
  /** Laplacian variance of each face crop resized to the same size (same order as faces). */
  faceCropSharpness: (number | null)[];
  wholeImageSharpness: number | null;
  clippedFraction: number | null;
}

/** Trial defaults (plan v0.2). Versioned so results can be traced and re-run. */
export const QUALITY_CONFIG = {
  version: 'quality-v3',
  weights: { sharpness: 0.4, eyes: 0.3, lighting: 0.15, composition: 0.1, expression: 0.05 },
  nearEqualPoints: 3,
  minAcceptableSharpness: 35,
  // Experimental absolute floors: do not let the best of an entirely blurred group score 100.
  minProviderFaceSharpness: 20,
  minWholeImageVariance: 2,
  minLocalFaceCropVariance: 2,
  mainFaceAreaRatio: 0.4,
  faceBrightness: { low: 25, high: 90 },
  clipWarn: 0.02,
  edgeMargin: 0.01,
} as const;

const known = (score: number, note: string | null = null): Criterion => ({ score: Math.round(Math.max(0, Math.min(100, score))), state: 'known', note });
const unknown = (note: string): Criterion => ({ score: null, state: 'unknown', note });
const na = (note: string): Criterion => ({ score: null, state: 'not-applicable', note });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Main subjects for sharpness only; small background faces still appear in eye/face-count reporting. */
function mainFaceIndices(faces: FaceAssessment[]): number[] {
  const areas = faces.map((f) => Math.max(0, f.bbox.width * f.bbox.height));
  const max = Math.max(0, ...areas);
  return areas.flatMap((area, i) => area >= max * QUALITY_CONFIG.mainFaceAreaRatio ? [i] : []);
}

function mainCropScores(s: RankInput): number[] {
  return mainFaceIndices(s.faces ?? []).map((i) => s.faceCropSharpness[i]).filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
}

export function assessQuality(s: RankInput, group: { maxFaceCrop: number; maxWhole: number }): QualityAssessment {
  const faces = s.faces;
  let sharpness: Criterion;
  if (faces && faces.length) {
    const provider = mainFaceIndices(faces).map((i) => faces[i]!.sharpness).filter((x): x is number => x !== null && Number.isFinite(x));
    const absolute = provider.length ? Math.min(...provider) : null;
    const crops = mainCropScores(s);
    const relative = crops.length && group.maxFaceCrop > 0 ? 100 * Math.sqrt(mean(crops) / group.maxFaceCrop) : null;
    sharpness = absolute !== null
      ? known(relative === null ? absolute : 0.7 * relative + 0.3 * absolute, 'chất lượng mặt + crop mặt (so trong nhóm)')
      : relative !== null ? known(faces.some((f) => f.observedBlendshapes !== undefined)
        ? Math.min(relative, 100 * Math.min(...crops) / QUALITY_CONFIG.minLocalFaceCropVariance) : relative,
        'theo vùng mặt (so trong nhóm)') : unknown('chưa đo được độ nét mặt');
  } else if (s.wholeImageSharpness !== null && group.maxWhole > 0) {
    sharpness = known(Math.min(100 * Math.sqrt(s.wholeImageSharpness / group.maxWhole), 100 * s.wholeImageSharpness / QUALITY_CONFIG.minWholeImageVariance), 'toàn ảnh (không có mặt để đo), so trong nhóm');
  } else sharpness = unknown('chưa đo được độ nét');

  let eyes: Criterion;
  let composition: Criterion;
  let expression: Criterion;
  if (faces === null) {
    eyes = unknown('chưa phân tích khuôn mặt');
    composition = unknown('chưa phân tích khuôn mặt');
    expression = unknown('chưa phân tích khuôn mặt');
  } else if (faces.length === 0) {
    eyes = na('không phát hiện khuôn mặt');
    composition = na('không phát hiện khuôn mặt');
    expression = na('không phát hiện khuôn mặt');
  } else {
    const k = faces.filter((f) => f.eyes !== 'unknown');
    const closed = k.filter((f) => f.eyes === 'closed').length;
    const unknownCount = faces.length - k.length;
    if (k.length === 0) eyes = unknown('không đủ dữ kiện kết luận mắt');
    else if (closed > 0) eyes = known(Math.max(0, 40 - 20 * (closed - 1)), `${closed} người nhắm mắt`);
    else eyes = known(100, unknownCount ? `${unknownCount} mặt chưa rõ mắt` : null);
    const m = QUALITY_CONFIG.edgeMargin;
    const atEdge = faces.filter((f) => f.bbox.left < m || f.bbox.top < m || f.bbox.left + f.bbox.width > 1 - m || f.bbox.top + f.bbox.height > 1 - m).length;
    composition = known(100 - Math.min(75, atEdge * 25), atEdge ? `${atEdge} mặt sát/cắt mép khung` : null);
    const smiles = faces.filter((f) => f.smile !== null);
    expression = smiles.length ? known(60 + (40 * smiles.filter((f) => f.smile).length) / smiles.length, 'nụ cười chỉ là ưu tiên nhẹ') : unknown('không rõ biểu cảm');
  }

  let lighting: Criterion;
  if (s.clippedFraction === null && !(faces && faces.some((f) => f.brightness !== null))) lighting = unknown('chưa đo được ánh sáng');
  else {
    const clip = s.clippedFraction ?? 0;
    const clipPenalty = Math.min(60, clip * 1000);
    const fb = (faces ?? []).map((f) => f.brightness).filter((b): b is number => b !== null);
    const { low, high } = QUALITY_CONFIG.faceBrightness;
    const facePenalty = fb.length ? mean(fb.map((b) => (b < low ? (low - b) * 1.5 : b > high ? (b - high) * 2 : 0))) : 0;
    lighting = known(100 - clipPenalty - facePenalty, clip > QUALITY_CONFIG.clipWarn ? 'có vùng cháy/bết' : null);
  }

  const w = QUALITY_CONFIG.weights;
  const parts: [Criterion, number][] = [
    [sharpness, w.sharpness],
    [eyes, w.eyes],
    [lighting, w.lighting],
    [composition, w.composition],
    [expression, w.expression],
  ];
  const usable = parts.filter(([c]) => c.state === 'known');
  const weight = usable.reduce((a, [, x]) => a + x, 0);
  const total = weight ? Math.round((10 * usable.reduce((a, [c, x]) => a + c.score! * x, 0)) / weight) / 10 : null;
  return { sharpness, eyes, lighting, composition, expression, total, configVersion: QUALITY_CONFIG.version };
}

/** Reasons that make a shot unacceptable as the group's pick (or mean it was not ranked at all). */
const BLOCKING = new Set(['EYES_CLOSED', 'FACE_COUNT_CHANGED', 'BLURRY', 'SHARPNESS_UNKNOWN', 'NOT_ANALYZED', 'ANALYSIS_FAILED', 'ANALYSIS_STALE']);

/** Whether a stored recommendation was an acceptable shot (same rule rankGroup applies). */
export function acceptableFrom(reasons: readonly string[]): boolean {
  return !reasons.some((r) => BLOCKING.has(r));
}

export interface RankedShot {
  assetId: AssetId;
  rank: number;
  label: CullLabel;
  bestAssetId: AssetId | null;
  acceptable: boolean;
  reasons: string[];
  quality: QualityAssessment;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Ranks the shots of one group. A clearly closed-eye shot, a shot whose faces disappear while the
 * others have them, or a clearly blurred face is not acceptable, so it can never win over an
 * acceptable alternative. A group with no acceptable shot, a failed analysis or no analysis at all
 * goes to review. Ties are broken by asset ID so results are deterministic.
 */
export function rankGroup(shots: RankInput[]): RankedShot[] {
  const analysed = shots.filter((s) => s.analysis === 'done');
  const pending = shots.filter((s) => s.analysis !== 'done');
  const maxFaceCrop = Math.max(0, ...analysed.map(mainCropScores).filter((xs) => xs.length).map(mean));
  const maxWhole = Math.max(0, ...shots.map((s) => s.wholeImageSharpness ?? 0));
  const counts = analysed.map((s) => s.faces?.length ?? 0);
  const med = median(counts);

  const rows = analysed.map((s) => {
    const quality = assessQuality(s, { maxFaceCrop, maxWhole });
    const faces = s.faces ?? [];
    const reasons: string[] = [];
    const closed = faces.some((f) => f.eyes === 'closed');
    if (closed) reasons.push('EYES_CLOSED');
    else if (faces.some((f) => f.eyes === 'unknown')) reasons.push('EYES_UNKNOWN');
    if (faces.length === 0) reasons.push('NO_FACES');
    const countChanged = analysed.length >= 2 && (faces.length === 0 && counts.some((n) => n > 0) || med >= 1 && Math.abs(faces.length - med) >= Math.max(1, Math.round(med * 0.5)));
    if (countChanged) reasons.push('FACE_COUNT_CHANGED');
    const localBlur = faces.some((f) => f.observedBlendshapes !== undefined) && mainCropScores(s).some((v) => v < QUALITY_CONFIG.minLocalFaceCropVariance);
    const absoluteBlur = localBlur || (faces.length
      ? mainFaceIndices(faces).some((i) => faces[i]!.sharpness !== null && faces[i]!.sharpness! < QUALITY_CONFIG.minProviderFaceSharpness)
      : s.wholeImageSharpness !== null && s.wholeImageSharpness < QUALITY_CONFIG.minWholeImageVariance);
    const blurry = absoluteBlur || quality.sharpness.state === 'known' && quality.sharpness.score! < QUALITY_CONFIG.minAcceptableSharpness;
    const unknownSharpness = quality.sharpness.state === 'unknown';
    if (unknownSharpness) reasons.push('SHARPNESS_UNKNOWN');
    if (blurry) reasons.push('BLURRY');
    if (quality.lighting.note === 'có vùng cháy/bết') reasons.push('CLIPPING');
    if (quality.composition.note?.includes('mép')) reasons.push('FACE_AT_EDGE');
    return { s, quality, reasons, acceptable: !closed && !countChanged && !blurry && !unknownSharpness };
  });

  rows.sort(
    (a, b) =>
      Number(b.acceptable) - Number(a.acceptable) ||
      (b.quality.total ?? -1) - (a.quality.total ?? -1) ||
      (a.s.assetId < b.s.assetId ? -1 : a.s.assetId > b.s.assetId ? 1 : 0),
  );

  const out: RankedShot[] = [];
  const anyAcceptable = rows.some((r) => r.acceptable);
  const best = anyAcceptable ? rows[0]! : null;
  rows.forEach((r, i) => {
    let label: CullLabel;
    if (!anyAcceptable) {
      label = 'review';
      r.reasons.push('GROUP_NO_ACCEPTABLE_SHOT');
    } else if (r === best) {
      label = 'keep';
      r.reasons.push('BEST_IN_GROUP');
    } else if (r.reasons.includes('FACE_COUNT_CHANGED')) label = 'review';
    else {
      label = 'better-option';
      if (r.acceptable && (best!.quality.total ?? 0) - (r.quality.total ?? 0) <= QUALITY_CONFIG.nearEqualPoints) r.reasons.push('NEAR_EQUAL');
    }
    out.push({ assetId: r.s.assetId, rank: i + 1, label, bestAssetId: best?.s.assetId ?? null, acceptable: r.acceptable, reasons: r.reasons, quality: r.quality });
  });
  for (const s of [...pending].sort((a, b) => (a.assetId < b.assetId ? -1 : 1))) {
    out.push({
      assetId: s.assetId,
      rank: out.length + 1,
      label: 'review',
      bestAssetId: best?.s.assetId ?? null,
      acceptable: false,
      reasons: [s.analysis === 'failed' ? 'ANALYSIS_FAILED' : s.analysis === 'stale' ? 'ANALYSIS_STALE' : 'NOT_ANALYZED'],
      quality: assessQuality(s, { maxFaceCrop, maxWhole }),
    });
  }
  return out;
}
