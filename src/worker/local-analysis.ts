import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { assessLocalFaces } from '../culling/local-faces';
import { LOCAL_PROVIDER, type LocalInference } from '../shared/local-analysis';
import type { ProgressEvent } from '../shared/contracts';
import type { ProjectStore } from '../project/store';
import { PREP_VERSION } from '../media/analysis-image';
import { expectedInputKey, prepareAnalysisImage, saveLibrawPreview, type AnalysisRun, type AnalysisOutcome } from './ai';
import type { MediaQueue } from './queue';

export type LocalDetect = (jpeg: Uint8Array, signal: AbortSignal) => Promise<LocalInference>;

/** No HTTP client, cloud fallback or consent dependency. Save only against the same source identity. */
export async function runLocalAnalysis(ctx: { store: ProjectStore; queue: MediaQueue; detect: LocalDetect; emit(e: ProgressEvent): void }, run: AnalysisRun, ids: string[]): Promise<AnalysisOutcome> {
  let done = 0;
  let failures = 0;
  const signal = run.controller?.signal ?? new AbortController().signal;
  const emit = (phase: 'progress' | 'complete' | 'cancelled' | 'stopped', message?: string, assetId?: string) =>
    ctx.emit({ kind: 'analysis', projectId: run.projectId, jobId: run.jobId, phase, done, total: ids.length, assetId, message });
  for (const id of ids) {
    if (run.cancelled || signal.aborted) { emit('cancelled'); return { status: 'cancelled', networkErrors: 0 }; }
    const a = ctx.store.asset(id);
    const key = a ? expectedInputKey(ctx.store, a) : null;
    if (!a || !key) { done++; continue; }
    const row = ctx.store.faceAnalysis(id);
    if (row?.inputKey === key && row.provider === LOCAL_PROVIDER && row.status === 'done') { done++; emit('progress', undefined, id); continue; }
    const prep = await ctx.queue.run('image', run.jobId, async (s) => {
      const image = await prepareAnalysisImage(ctx.store, a, s);
      if (image.libraw) await saveLibrawPreview(ctx.store, a, image.libraw);
      return { ...image, libraw: undefined };
    });
    let error: string | null = prep.ok ? null : prep.message;
    let resultJson: string | null = null;
    if (prep.ok && !signal.aborted && !run.cancelled) {
      try {
        const result = await ctx.detect(prep.value.jpeg, signal);
        if (result.width !== prep.value.width || result.height !== prep.value.height) throw new Error('LOCAL_IMAGE_SIZE_MISMATCH');
        const faces = assessLocalFaces(result);
        // Measured crop luminance, not a fabricated provider brightness score.
        for (const face of faces) {
          const box = face.bbox;
          const left = Math.min(result.width - 1, Math.floor(box.left * result.width));
          const top = Math.min(result.height - 1, Math.floor(box.top * result.height));
          const crop = await sharp(prep.value.jpeg).extract({ left, top, width: Math.max(1, Math.min(result.width - left, Math.floor(box.width * result.width))), height: Math.max(1, Math.min(result.height - top, Math.floor(box.height * result.height))) }).greyscale().stats();
          face.brightness = (crop.channels[0]!.mean / 255) * 100;
        }
        resultJson = JSON.stringify(faces);
      } catch (e) { error = (e as Error).message; }
    }
    if (run.cancelled || signal.aborted) { emit('cancelled'); return { status: 'cancelled', networkErrors: 0 }; }
    const still = ctx.store.asset(id);
    if (!still || expectedInputKey(ctx.store, still) !== key) { done++; continue; }
    ctx.store.upsertFaceAnalysis({ assetId: id, inputKey: key, provider: LOCAL_PROVIDER, prepVersion: PREP_VERSION,
      sourceKind: prep.ok ? prep.value.kind : 'embedded', sourceFileId: prep.ok ? prep.value.fileId : a.primaryFileId,
      idempotencyKey: createHash('sha256').update(`${key}|${LOCAL_PROVIDER}`).digest('hex'), requestId: null,
      imageWidth: prep.ok ? prep.value.width : null, imageHeight: prep.ok ? prep.value.height : null,
      uploadBytes: 0, status: error ? 'failed' : 'done', resultJson, error, updatedAt: new Date().toISOString() });
    done++;
    if (error) failures++;
    emit('progress', error ?? undefined, id);
    // Runtime failures should not loop through an entire album; image preparation errors may be isolated.
    if (error && prep.ok) {
      emit('stopped', error);
      return { status: 'stopped', networkErrors: 0, message: `Phân tích local dừng: ${error}. Không gửi ảnh lên cloud.` };
    }
  }
  const message = failures ? `${failures} ảnh không chuẩn bị được; xem lại các ảnh báo lỗi.` : undefined;
  emit(failures ? 'stopped' : 'complete', message);
  return { status: failures ? 'stopped' : 'complete', networkErrors: 0, message };
}
