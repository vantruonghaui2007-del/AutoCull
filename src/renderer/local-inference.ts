import { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { LocalInference } from '../shared/local-analysis';

let task: FaceLandmarker | null = null;
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const runner = {
  async initialize(model: string, loader: string, wasm: string): Promise<void> {
    task?.close();
    task = null;
    const script = URL.createObjectURL(new Blob([bytes(loader)], { type: 'text/javascript' }));
    const binary = URL.createObjectURL(new Blob([bytes(wasm)], { type: 'application/wasm' }));
    try {
      task = await FaceLandmarker.createFromOptions({ wasmLoaderPath: script, wasmBinaryPath: binary }, {
        baseOptions: { modelAssetBuffer: bytes(model), delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 20, minFaceDetectionConfidence: 0.6, minFacePresenceConfidence: 0.6,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
    } finally {
      URL.revokeObjectURL(script);
      URL.revokeObjectURL(binary);
    }
  },
  async detect(jpeg: string): Promise<LocalInference> {
    if (!task) throw new Error('LOCAL_NOT_READY');
    const image = await createImageBitmap(new Blob([bytes(jpeg)], { type: 'image/jpeg' }));
    try {
      const out: LocalInference = { width: image.width, height: image.height, landmarks: [], blendshapes: [], matrices: [] };
      const box = (points: LocalInference['landmarks'][number]) => ({
        l: Math.min(...points.map((p) => p.x)), t: Math.min(...points.map((p) => p.y)),
        r: Math.max(...points.map((p) => p.x)), b: Math.max(...points.map((p) => p.y)),
      });
      // The bundled detector is short-range: overlapping local crops preserve smaller event faces.
      // Always scan tiles, even when the full frame already found one prominent person.
      const tileW = Math.round(image.width * 0.6);
      const tileH = Math.round(image.height * 0.6);
      const regions = [{ x: 0, y: 0, w: image.width, h: image.height },
        ...[0, image.width - tileW].flatMap((x) => [0, image.height - tileH].map((y) => ({ x, y, w: tileW, h: tileH })))];
      for (const region of regions) {
        const tile = await createImageBitmap(image, region.x, region.y, region.w, region.h);
        try {
          const r = task.detect(tile);
          for (let i = 0; i < r.faceLandmarks.length; i++) {
            const localBox = box(r.faceLandmarks[i]!);
            if (region.w !== image.width && (localBox.l < 0.02 || localBox.t < 0.02 || localBox.r > 0.98 || localBox.b > 0.98)) continue;
            const points = r.faceLandmarks[i]!.map((p) => ({ x: (p.x * region.w + region.x) / image.width,
              y: (p.y * region.h + region.y) / image.height, z: p.z * region.w / image.width }));
            const a = box(points);
            const duplicate = out.landmarks.some((existing) => {
              const b = box(existing);
              const intersection = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
              const union = (a.r - a.l) * (a.b - a.t) + (b.r - b.l) * (b.b - b.t) - intersection;
              return union > 0 && intersection / union > 0.35;
            });
            if (duplicate) continue;
            out.landmarks.push(points);
            out.blendshapes.push((r.faceBlendshapes[i]?.categories ?? []).map(({ categoryName, score }) => ({ categoryName, score })));
            out.matrices.push([...(r.facialTransformationMatrixes[i]?.data ?? [])]);
          }
        } finally { tile.close(); }
      }
      return out;
    } finally { image.close(); }
  },
};
Object.assign(window, { localRunner: runner });
