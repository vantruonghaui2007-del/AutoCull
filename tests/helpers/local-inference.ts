import type { LocalInference } from '../../src/shared/local-analysis';

/** Synthetic landmarks for adapter/flow tests only, never an AI accuracy benchmark. */
export function fakeLocalInference(width = 640, height = 427, closed = false): LocalInference {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[10] = { x: 0.35, y: 0.2, z: 0 };
  points[152] = { x: 0.65, y: 0.8, z: 0 };
  for (const [outer, inner, upper, lower, x] of [[33, 133, 159, 145, 0.43], [362, 263, 386, 374, 0.57]]) {
    points[outer!] = { x: x! - 0.035, y: 0.4, z: 0 };
    points[inner!] = { x: x! + 0.035, y: 0.4, z: 0 };
    points[upper!] = { x: x!, y: 0.4 - (closed ? 0.002 : 0.02), z: 0 };
    points[lower!] = { x: x!, y: 0.4 + (closed ? 0.002 : 0.02), z: 0 };
  }
  return { width, height, landmarks: [points], matrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
    blendshapes: [[{ categoryName: 'eyeBlinkLeft', score: closed ? 0.9 : 0.05 }, { categoryName: 'eyeBlinkRight', score: closed ? 0.9 : 0.05 },
      { categoryName: 'mouthSmileLeft', score: 0.8 }, { categoryName: 'mouthSmileRight', score: 0.8 }]] };
}
