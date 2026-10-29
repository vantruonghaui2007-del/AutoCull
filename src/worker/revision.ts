import { createHash } from 'node:crypto';
import { groupingPreset } from '../culling/groups';
import { QUALITY_CONFIG } from '../culling/ranking';
import { analysisInputKey } from '../media/analysis-image';
import { FEATURE_ALGORITHM } from '../media/features';
import type { AssetCore, FileRow, ProjectStore } from '../project/store';
import type { AssetId } from '../shared/contracts';

export interface RevisionContext {
  preset: string;
  assets: Map<AssetId, AssetCore>;
  files: Map<string, FileRow>;
  analysis: Map<AssetId, { inputKey: string; status: string; updatedAt: string }>;
  features: Map<AssetId, { algorithmVersion: string; json: string }>;
}

/** One snapshot of everything a recommendation depends on (few queries, no result payloads). */
export function revisionContext(store: ProjectStore): RevisionContext {
  return {
    preset: groupingPreset(store.meta('grouping_preset')).version,
    assets: new Map(store.allAssets().map((a) => [a.id, a])),
    files: new Map(store.allFiles().map((f) => [f.id, f])),
    analysis: store.faceAnalysisMeta(),
    features: store.features(),
  };
}

/**
 * Revision of one group's recommendation: quality config, grouping preset, exact membership, and per
 * member its current analysis input (file role + content sample + preprocessing), the stored analysis
 * (input, status, time) and whether features exist. Any change — file replaced, pair confirmed,
 * group merged/split/regrouped, analysis redone — gives a different revision, so the stored
 * recommendation is recognised as stale.
 */
export function groupRevision(ctx: RevisionContext, memberIds: readonly AssetId[]): string {
  const parts: string[] = [QUALITY_CONFIG.version, ctx.preset];
  for (const id of [...memberIds].sort()) {
    const a = ctx.assets.get(id);
    if (!a) {
      parts.push(`${id}:gone`);
      continue;
    }
    const companion = a.companionJpegId && a.pairConfirmed;
    const f = ctx.files.get(companion ? a.companionJpegId! : a.primaryFileId);
    const expected = f ? analysisInputKey(companion ? 'companion' : 'primary', f.id, f.sampledHash) : '-';
    const row = ctx.analysis.get(id);
    const feature = ctx.features.get(id);
    const feat = feature?.algorithmVersion === FEATURE_ALGORITHM ? feature.json : '-';
    parts.push(`${id}:${expected}:${row?.inputKey ?? '-'}:${row?.status ?? 'none'}:${row?.updatedAt ?? '-'}:${feat}`);
    for (const fid of [a.primaryFileId, a.pairConfirmed ? a.companionJpegId : null]) {
      const file = fid ? ctx.files.get(fid) : undefined;
      if (file) parts.push(`${file.id}:${file.bytes}:${file.mtimeMs}:${file.sampledHash}:${file.stale}:${file.missing}`);
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}
