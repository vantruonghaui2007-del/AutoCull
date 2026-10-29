import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fingerprint } from '../source/fingerprint';
import type { ExportFileResult, ExportReport, FileId } from '../shared/contracts';
import { PACK_NAME, type ExportPlan, type PlannedFile } from './plan';
import { reasonText } from '../shared/reasons';
import type { EffectiveSelection } from '../shared/contracts';

const SELECTED_BY: Record<EffectiveSelection['source'], string> = {
  'manual-keep': 'manual',
  'manual-excluded': 'manual-excluded',
  auto: 'auto',
  'not-recommended': 'not-selected',
  'no-analysis': 'not-selected',
};

export interface ExportProgress {
  phase: 'copying' | 'copied' | 'verified' | 'failed' | 'cancelled';
  fileId: FileId | null;
  outputName: string;
  done: number;
  total: number;
  message?: string;
}

class CopyFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

function ioCode(e: unknown, fallback: string): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC') return 'DISK_FULL';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'DEST_NOT_WRITABLE';
  if (code === 'ENOENT') return 'SOURCE_MISSING';
  if (code === 'EIO' || code === 'ENODEV' || code === 'ENXIO') return 'SOURCE_UNAVAILABLE';
  if ((e as Error)?.name === 'AbortError') return 'CANCELLED';
  return fallback;
}

/** Moves a verified temp file to its final name without ever overwriting an existing file. */
async function publishNoOverwrite(tmp: string, final: string): Promise<void> {
  try {
    await link(tmp, final); // atomic: fails with EEXIST when the name is taken
    await unlink(tmp);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new CopyFailure('DEST_EXISTS', 'Tệp đích đã tồn tại; không ghi đè.');
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EINVAL' && code !== 'ENOSYS') throw e;
  }
  // File systems without hard links (FAT/exFAT): check, then rename.
  try {
    await lstat(final);
    throw new CopyFailure('DEST_EXISTS', 'Tệp đích đã tồn tại; không ghi đè.');
  } catch (e) {
    if (e instanceof CopyFailure) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await rename(tmp, final);
}

async function makeOutputFolder(parent: string, base: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    try {
      await mkdir(path.join(parent, name)); // non-recursive: never reuses an existing folder
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Không tạo được thư mục xuất mới.');
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Copies the plan's originals into a new folder. Each file: source identity re-checked against
 * the index, stream-copied into an exclusive temp file owned by this job while hashing (SHA-256),
 * source re-checked after the copy, destination re-read and hashed, then published without
 * overwrite. Yields progress; returns a report that separates verified/skipped/failed/cancelled.
 * Sources are only ever opened for reading.
 */
export async function* executeExport(plan: ExportPlan, signal: AbortSignal): AsyncGenerator<ExportProgress, ExportReport> {
  const folderName = await makeOutputFolder(plan.destinationParent, plan.outputFolderBase);
  const outDir = path.join(plan.destinationParent, folderName);
  const jobTag = randomBytes(4).toString('hex');
  const work = plan.mode === 'copy-originals' ? plan.files : [];
  const results = new Map<PlannedFile, ExportFileResult & { sha256?: string }>();
  const total = work.length;
  let done = 0;

  for (const f of work) {
    const base = { fileId: f.fileId, outputName: f.outputName };
    if (signal.aborted) {
      results.set(f, { ...base, status: 'cancelled' });
      continue;
    }
    yield { phase: 'copying', ...base, done, total };
    const final = path.join(outDir, f.outputName);
    const tmp = path.join(outDir, `.${f.outputName}.${jobTag}.part`);
    try {
      if (f.role === 'generated-xmp') {
        await writeFile(tmp, f.content!, { flag: 'wx' });
        if ((await readFile(tmp, 'utf8')) !== f.content) throw new CopyFailure('VERIFY_FAILED', 'XMP ghi ra không khớp.');
        await publishNoOverwrite(tmp, final);
        results.set(f, { ...base, status: 'verified', sha256: await sha256File(final) });
      } else {
        const src = f.sourcePath!;
        let before;
        try {
          before = await stat(src);
        } catch (e) {
          throw new CopyFailure(ioCode(e, 'SOURCE_UNAVAILABLE'), 'Không đọc được tệp nguồn (thẻ/ổ đã tháo?).');
        }
        const fp = await fingerprint(src);
        if (fp.bytes !== f.bytes || fp.sampledHash !== f.sampledHash) {
          throw new CopyFailure('SOURCE_CHANGED', 'Tệp nguồn đã thay đổi kể từ khi quét; hãy quét lại trước khi xuất.');
        }
        const hash = createHash('sha256');
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(createReadStream(src, { flags: 'r' }), tap, createWriteStream(tmp, { flags: 'wx' }), { signal });
        const sourceSha = hash.digest('hex');
        yield { phase: 'copied', ...base, done, total };
        let after;
        try {
          after = await stat(src);
        } catch (e) {
          throw new CopyFailure(ioCode(e, 'SOURCE_UNAVAILABLE'), 'Mất tệp nguồn trong lúc sao chép.');
        }
        const fp2 = await fingerprint(src);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || fp2.sampledHash !== f.sampledHash) {
          throw new CopyFailure('SOURCE_CHANGED_DURING_COPY', 'Tệp nguồn thay đổi trong lúc sao chép; bản sao không được công nhận.');
        }
        const destSha = await sha256File(tmp);
        if (destSha !== sourceSha) throw new CopyFailure('VERIFY_FAILED', 'SHA-256 của bản sao không khớp tệp nguồn.');
        await publishNoOverwrite(tmp, final);
        results.set(f, { ...base, status: 'verified', sha256: destSha });
      }
      done++;
      yield { phase: 'verified', ...base, done, total };
    } catch (e) {
      await unlink(tmp).catch(() => {});
      const cancelled = signal.aborted && (e as Error)?.name === 'AbortError';
      if (cancelled) {
        results.set(f, { ...base, status: 'cancelled' });
        yield { phase: 'cancelled', ...base, done, total };
      } else {
        const code = e instanceof CopyFailure ? e.code : ioCode(e, 'COPY_FAILED');
        results.set(f, { ...base, status: 'failed', code, message: (e as Error).message });
        yield { phase: 'failed', ...base, done, total, message: (e as Error).message };
      }
    }
  }

  const list = [...results.values()];
  const copiedVerified = list.filter((r) => r.status === 'verified');
  const failed = list.filter((r) => r.status === 'failed');
  const cancelled = list.filter((r) => r.status === 'cancelled');
  let status: ExportReport['status'] = 'verified';
  if (cancelled.length) status = 'cancelled';
  else if (failed.length && copiedVerified.length) status = 'partial';
  else if (failed.length) status = 'failed';

  // Manifest: decisions for every asset plus the per-file outcome.
  const manifest = {
    format: 'eventstory-export-manifest',
    version: 1,
    project: plan.projectName,
    pack: PACK_NAME[plan.packId],
    mode: plan.mode,
    exportedAt: new Date().toISOString(),
    status,
    note: 'Ảnh gốc không bị thay đổi. Sao/từ khóa cho DNG/JPEG và cho RAW đã có XMP cũ chỉ có trong tệp này.',
    assets: plan.assets.map((a) => ({
      assetId: a.assetId,
      source: a.sourceLabel,
      primary: a.primaryRelativePath,
      companionJpeg: a.companionRelativePath,
      state: a.decision.state,
      rating: a.decision.rating,
      consent: a.decision.consent,
      targets: a.targetLabels,
      packs: a.packs.map((p) => PACK_NAME[p]),
      cull: a.cull
        ? {
            selectedBy: SELECTED_BY[a.cull.source],
            list: a.cull.list,
            recommendation: a.cull.label,
            rank: a.cull.rank,
            score: a.cull.quality?.total ?? null,
            criteria: a.cull.quality
              ? {
                  sharpness: a.cull.quality.sharpness.score,
                  eyes: a.cull.quality.eyes.score,
                  lighting: a.cull.quality.lighting.score,
                  composition: a.cull.quality.composition.score,
                  expression: a.cull.quality.expression.score,
                }
              : null,
            qualityConfig: a.cull.quality?.configVersion ?? null,
            reasons: a.cull.reasons,
            reasonText: a.cull.reasons.map(reasonText),
            revision: a.cull.revision,
          }
        : null,
    })),
    files: plan.files.map((f) => {
      const r = results.get(f);
      return {
        assetId: f.assetId,
        role: f.role,
        source: f.sourceLabel,
        relativePath: f.relativePath,
        outputName: f.outputName,
        status: r?.status ?? (plan.mode === 'manifest' ? 'skipped' : 'skipped'),
        sha256: r?.sha256,
        code: r?.code,
        message: r?.message,
      };
    }),
  };
  const rows = [
    ['asset_id', 'role', 'source', 'relative_path', 'output_name', 'state', 'rating', 'consent', 'targets', 'packs', 'selected_by', 'cull_list', 'score', 'sharpness', 'eyes', 'lighting', 'composition', 'expression', 'cull_reasons', 'status', 'sha256', 'error'],
    ...manifest.files.map((f) => {
      const a = manifest.assets.find((x) => x.assetId === f.assetId)!;
      const c = a.cull;
      return [
        f.assetId, f.role, f.source, f.relativePath, f.outputName, a.state, a.rating, a.consent, a.targets.join('; '), a.packs.join('; '),
        c?.selectedBy, c?.list, c?.score, c?.criteria?.sharpness, c?.criteria?.eyes, c?.criteria?.lighting, c?.criteria?.composition, c?.criteria?.expression,
        c?.reasonText.join('; '), f.status, f.sha256, f.message,
      ];
    }),
  ];
  await writeFile(path.join(outDir, 'eventstory-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(outDir, 'eventstory-manifest.csv'), `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`, { flag: 'wx' });

  const skipped: ExportFileResult[] =
    plan.mode === 'manifest' ? plan.files.map((f) => ({ fileId: f.fileId, outputName: f.outputName, status: 'skipped' as const })) : [];
  const strip = (r: ExportFileResult & { sha256?: string }): ExportFileResult => ({ fileId: r.fileId, outputName: r.outputName, status: r.status, code: r.code, message: r.message });
  return {
    planId: plan.planId,
    status: plan.mode === 'manifest' && status === 'verified' ? 'verified' : status,
    copiedVerified: copiedVerified.map(strip),
    skipped,
    failed: failed.map(strip),
    cancelled: cancelled.map(strip),
    outputFolderName: folderName,
  };
}
