import { createHash } from 'node:crypto';
import { realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../main/paths';
import type { ProjectStore } from '../project/store';
import type { AssetCullView, AssetId, Decision, ExportPlanView, ExportSet, FileId, PackId, Result } from '../shared/contracts';
import { err, newId, ok } from '../shared/schemas';
import { absolutePathOf } from '../worker/scan';

export const PACK_NAME: Record<ExportSet, string> = {
  selection: 'Ảnh đã chọn', quick: 'Trả nhanh', edit: 'Hậu kỳ' };
const PACK_FOLDER: Record<ExportSet, string> = {
  selection: 'DaChon', quick: 'TraNhanh', edit: 'HauKy' };
const PROPRIETARY_RAW = new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf']);

export interface PlannedFile {
  assetId: AssetId;
  fileId: FileId | null;
  role: 'primary' | 'companion' | 'sidecar' | 'generated-xmp';
  sourcePath: string | null;
  relativePath: string | null;
  sourceLabel: string | null;
  outputName: string;
  bytes: number;
  sampledHash: string | null;
  content: string | null;
}

export interface PlannedAsset {
  assetId: AssetId;
  decision: Decision;
  targetLabels: string[];
  packs: PackId[];
  primaryRelativePath: string;
  companionRelativePath: string | null;
  sourceLabel: string;
  /** AutoCull state at plan time (reasons/scores go into the manifest). */
  cull: AssetCullView | null;
}

/** Immutable export plan. Holds real source paths, so it never leaves the worker; the renderer gets `view`. */
export interface ExportPlan {
  planId: string;
  projectId: string;
  projectName: string;
  packId: ExportSet;
  mode: 'manifest' | 'copy-originals';
  createdAt: string;
  destinationParent: string;
  outputFolderBase: string;
  memberKey: string;
  /** Identity (size, mtime, content sample, presence) of every planned source file. */
  metadataKey: string;
  /** AutoCull revisions of the planned assets. */
  revisionKey: string;
  assets: PlannedAsset[];
  files: PlannedFile[];
  view: ExportPlanView;
}

export function memberKeyOf(assetIds: AssetId[]): string {
  return createHash('sha256').update([...assetIds].sort().join('|')).digest('hex');
}

export function membersOfPack(store: ProjectStore, packId: PackId): AssetId[] {
  return store
    .packMembers()
    .filter((m) => m.packId === packId)
    .map((m) => m.assetId);
}

export function metadataKeyOf(store: ProjectStore, fileIds: FileId[]): string {
  const parts = [...fileIds].sort().map((id) => {
    const f = store.file(id);
    const s = f ? store.source(f.sourceId) : undefined;
    return f ? `${id}:${f.bytes}:${f.mtimeMs}:${f.sampledHash}:${f.missing ? 1 : 0}:${f.stale ? 1 : 0}:${s?.online ? 1 : 0}` : `${id}:gone`;
  });
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function revisionKeyOf(assetIds: AssetId[], cullOf: (id: AssetId) => AssetCullView | undefined): string {
  return createHash('sha256')
    .update([...assetIds].sort().map((id) => `${id}:${cullOf(id)?.revision ?? '-'}`).join('|'))
    .digest('hex');
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** New sidecar for a proprietary RAW that has none: rating + keywords only (no Develop settings). */
export function buildXmp(decision: Decision, packLabel: string, targetLabels: string[]): string {
  const subjects = [`EventStory: ${packLabel}`, ...targetLabels];
  const hier = [`EventStory|${packLabel}`, ...targetLabels.map((t) => `EventStory|Mục tiêu|${t}`)];
  const li = (xs: string[]) => xs.map((x) => `      <rdf:li>${xmlEscape(x)}</rdf:li>`).join('\n');
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="EventStory Cull">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/">
   <xmp:Rating>${decision.rating}</xmp:Rating>
   <dc:subject>
    <rdf:Bag>
${li(subjects)}
    </rdf:Bag>
   </dc:subject>
   <lr:hierarchicalSubject>
    <rdf:Bag>
${li(hier)}
    </rdf:Bag>
   </lr:hierarchicalSubject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const fold = (s: string) => s.normalize('NFC').toLowerCase();

export async function planExport(
  store: ProjectStore,
  packId: ExportSet,
  destinationParent: string,
  mode: 'manifest' | 'copy-originals',
  ctx: { selectedIds: AssetId[]; cullOf: (id: AssetId) => AssetCullView | undefined } = { selectedIds: [], cullOf: () => undefined },
): Promise<Result<ExportPlan>> {
  const memberIds = packId === 'selection' ? ctx.selectedIds : membersOfPack(store, packId);
  if (memberIds.length === 0) {
    return err('EMPTY_PACK', packId === 'selection' ? 'Chưa có ảnh nào được chọn (tự động hoặc thủ công).' : `Bộ ${PACK_NAME[packId]} chưa có ảnh.`);
  }

  let dest: string;
  try {
    dest = await realpath(destinationParent);
    if (!(await stat(dest)).isDirectory()) return err('INVALID_DESTINATION', 'Nơi xuất phải là thư mục.');
  } catch {
    return err('INVALID_DESTINATION', 'Không truy cập được thư mục xuất.');
  }
  for (const s of store.sources()) {
    let root = s.rootPath;
    try {
      root = await realpath(s.rootPath);
    } catch {
      /* offline source: compare with the recorded path */
    }
    if (isPathInside(root, dest)) return err('DESTINATION_INSIDE_SOURCE', `Không được xuất vào trong thư mục nguồn "${s.label}".`);
  }
  if (isPathInside(await realpath(store.dir), dest)) return err('DESTINATION_INSIDE_PROJECT', 'Không được xuất vào trong thư mục dự án/bộ đệm.');

  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const targets = new Map(store.targets().map((t) => [t.id, t.label]));
  const allMembers = store.packMembers();
  const ordered = memberIds
    .map((id) => store.asset(id)!)
    .sort((a, b) => (a.sortTime ?? '\uffff').localeCompare(b.sortTime ?? '\uffff') || a.seq - b.seq);

  const usedStems = new Set<string>();
  const assets: PlannedAsset[] = [];
  const files: PlannedFile[] = [];
  const conflicts: string[] = [];
  const omissions: string[] = [];
  const copying = mode === 'copy-originals';

  for (const a of ordered) {
    const primary = store.file(a.primaryFileId)!;
    const source = sources.get(primary.sourceId)!;
    const companion = a.companionJpegId && a.pairConfirmed ? store.file(a.companionJpegId) : undefined;
    const sidecar = primary.kind === 'raw' ? store.sidecarOf(primary.id) : undefined;
    const decision = store.decision(a.id);
    const targetLabels = decision.targetIds.map((t) => targets.get(t)).filter((x): x is string => !!x);
    const base = path.posix.basename(primary.relativePath);
    const ext = path.posix.extname(base);
    let stem = base.slice(0, base.length - ext.length);
    if (usedStems.has(fold(stem))) stem = `${stem}__${a.id.slice(2, 10)}`;
    usedStems.add(fold(stem));

    assets.push({
      assetId: a.id,
      decision,
      targetLabels,
      packs: allMembers.filter((m) => m.assetId === a.id).map((m) => m.packId),
      primaryRelativePath: primary.relativePath,
      companionRelativePath: companion?.relativePath ?? null,
      sourceLabel: source.label,
      cull: ctx.cullOf(a.id) ?? null,
    });

    const original = (f: NonNullable<typeof companion>, role: PlannedFile['role'], outputName: string) => {
      if (!source.online || f.missing) conflicts.push(`SOURCE_MISSING:${f.relativePath}`);
      else if (f.stale) conflicts.push(`SOURCE_CHANGED:${f.relativePath}`);
      files.push({
        assetId: a.id,
        fileId: f.id,
        role,
        sourcePath: absolutePathOf(source, f),
        relativePath: f.relativePath,
        sourceLabel: source.label,
        outputName,
        bytes: f.bytes,
        sampledHash: f.sampledHash,
        content: null,
      });
    };
    original(primary, 'primary', `${stem}${ext}`);
    if (companion) original(companion, 'companion', `${stem}${path.posix.extname(companion.relativePath)}`);
    if (sidecar) {
      const doubleExt = fold(sidecar.relativePath).endsWith(`${fold(ext)}.xmp`);
      original(sidecar, 'sidecar', doubleExt ? `${stem}${ext}.xmp` : `${stem}.xmp`);
      omissions.push(`${primary.relativePath}: đã có XMP cũ — sao chép nguyên vẹn, không ghép; sao/từ khóa của EventStory chỉ có trong manifest.`);
    } else if (primary.kind === 'raw' && PROPRIETARY_RAW.has(fold(ext))) {
      if (copying) {
        const content = buildXmp(decision, PACK_NAME[packId], targetLabels);
        files.push({
          assetId: a.id,
          fileId: null,
          role: 'generated-xmp',
          sourcePath: null,
          relativePath: null,
          sourceLabel: null,
          outputName: `${stem}.xmp`,
          bytes: Buffer.byteLength(content),
          sampledHash: null,
          content,
        });
      }
    } else {
      omissions.push(`${primary.relativePath}: DNG/JPEG giữ nguyên, không ghi XMP riêng; quyết định nằm trong manifest.`);
    }
  }

  if (!copying) omissions.unshift('Chế độ chỉ manifest: không sao chép ảnh và không tạo XMP.');
  const copied = copying ? files : [];
  const projectedBytes = copied.reduce((s, f) => s + f.bytes, 0);
  if (copying) {
    try {
      const fsInfo = await statfs(dest);
      if (Number(fsInfo.bavail) * Number(fsInfo.bsize) < projectedBytes * 1.02 + 1024 * 1024) conflicts.push('NOT_ENOUGH_SPACE');
    } catch {
      /* statfs unsupported: copy errors will report ENOSPC */
    }
  }
  const names = files.map((f) => fold(f.outputName));
  if (new Set(names).size !== names.length) return err('NAME_COLLISION', 'Không tạo được tên tệp xuất không trùng.');

  const planId = newId('x');
  const outputFolderBase = `EventStory_${PACK_FOLDER[packId]}_${stamp(new Date())}`;
  const view: ExportPlanView = {
    planId,
    packId,
    mode,
    destinationLabel: `${path.basename(dest) || dest}/${outputFolderBase}`,
    logicalCount: assets.length,
    physicalCount: files.filter((f) => f.role !== 'generated-xmp').length,
    projectedBytes,
    outputs: copied.map((f) => ({ assetId: f.assetId, fileId: f.fileId ?? '', outputName: f.outputName, kind: f.role === 'generated-xmp' ? 'generated-xmp' : (store.file(f.fileId!)?.kind ?? 'raw') })),
    conflicts,
    omissions,
  };
  return ok(
    Object.freeze({
      planId,
      projectId: store.id,
      projectName: store.name,
      packId,
      mode,
      createdAt: new Date().toISOString(),
      destinationParent: dest,
      outputFolderBase,
      memberKey: memberKeyOf(memberIds),
      metadataKey: metadataKeyOf(store, files.flatMap((f) => (f.fileId ? [f.fileId] : []))),
      revisionKey: revisionKeyOf(memberIds, ctx.cullOf),
      assets,
      files,
      view,
    }),
  );
}
