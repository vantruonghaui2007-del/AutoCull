/** Pinned prototype, not bundled in installers pending artifact-specific licence review. */
export const LOCAL_PROVIDER = 'mediapipe-face-landmarker-v1:64184e22:rules-v1';
export const LOCAL_MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
export interface LocalAnalysisSettings {
  available: boolean;
  modelName: string | null;
}
export interface LocalInference {
  landmarks: { x: number; y: number; z: number }[][];
  blendshapes: { categoryName: string; score: number }[][];
  matrices: number[][];
  width: number;
  height: number;
}
