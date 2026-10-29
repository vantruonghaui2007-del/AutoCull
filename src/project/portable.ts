import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Group, Result } from '../shared/contracts';
import {
  AssetIdSchema,
  CameraIdSchema,
  ConsentSchema,
  CoverageTargetSchema,
  DeliveryIdSchema,
  err,
  FileIdSchema,
  GroupIdSchema,
  ok,
  PackIdSchema,
  ReviewStateSchema,
  SourceIdSchema,
  TargetIdSchema,
} from '../shared/schemas';
import { ProjectStore } from './store';

export const PORTABLE_FORMAT = 'eventstory-session';
export const PORTABLE_VERSION = 1;

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const PortableSchema = z.object({
  format: z.literal(PORTABLE_FORMAT),
  schemaVersion: z.literal(PORTABLE_VERSION),
  exportedAt: z.string(),
  project: z.object({ name: z.string().min(1).max(120) }),
  sources: z.array(z.object({ id: SourceIdSchema, label: z.string().max(260) })),
  files: z.array(
    z.object({
      id: FileIdSchema,
      sourceId: SourceIdSchema,
      relativePath: z.string().min(1).max(4096),
      bytes: z.number().int().min(0),
      sampledHash: Sha,
      kind: z.enum(['raw', 'jpeg', 'xmp']),
      sidecarOf: FileIdSchema.nullable(),
    }),
  ),
  assets: z.array(
    z.object({
      id: AssetIdSchema,
      primaryFileId: FileIdSchema,
      companionJpegId: FileIdSchema.nullable(),
      pairConfirmed: z.boolean(),
      seq: z.number().int(),
    }),
  ),
  decisions: z.array(
    z.object({
      assetId: AssetIdSchema,
      state: ReviewStateSchema,
      rating: z.number().int().min(0).max(5),
      consent: ConsentSchema,
      targetIds: z.array(TargetIdSchema),
    }),
  ),
  targets: z.array(CoverageTargetSchema),
  packRules: z.array(z.object({ id: PackIdSchema, limit: z.number().int().min(0).nullable(), targetIds: z.array(TargetIdSchema) })),
  packMembers: z.array(z.object({ packId: PackIdSchema, assetId: AssetIdSchema, pinned: z.boolean() })),
  manualGroups: z.array(z.object({ id: GroupIdSchema, assetIds: z.array(AssetIdSchema), confidence: z.enum(['high', 'low']) })),
  cameras: z.array(z.object({ cameraId: CameraIdSchema, offsetSeconds: z.number().int(), label: z.string().nullable() })),
  cameraOverrides: z.array(z.object({ assetId: AssetIdSchema, cameraId: CameraIdSchema })),
  deliveries: z.array(
    z.object({
      id: DeliveryIdSchema,
      at: z.string(),
      packId: PackIdSchema,
      assetIds: z.array(AssetIdSchema),
      fileFingerprints: z.record(z.string(), z.string()),
      correctsEventId: DeliveryIdSchema.nullable(),
    }),
  ),
});
export type Portable = z.infer<typeof PortableSchema>;

/**
 * Writes the hand-made part of a project (decisions, packs, targets, manual groups, offsets,
 * deliveries) plus file identities for relinking. No image data, no preview cache and no
 * absolute paths of the source folders.
 */
export async function exportPortable(store: ProjectStore, groups: Group[], destination: string): Promise<Result<void>> {
  const db = store.db;
  const files = store.allFiles();
  const sidecars = new Map((db.prepare('SELECT id, sidecar_of FROM file').all() as { id: string; sidecar_of: string | null }[]).map((r) => [r.id, r.sidecar_of]));
  const data: Portable = {
    format: PORTABLE_FORMAT,
    schemaVersion: PORTABLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { name: store.name },
    sources: store.sources().map((s) => ({ id: s.id, label: s.label })),
    files: files.map((f) => ({ id: f.id, sourceId: f.sourceId, relativePath: f.relativePath, bytes: f.bytes, sampledHash: f.sampledHash, kind: f.kind, sidecarOf: sidecars.get(f.id) ?? null })),
    assets: store.allAssets().map((a) => ({ id: a.id, primaryFileId: a.primaryFileId, companionJpegId: a.companionJpegId, pairConfirmed: a.pairConfirmed, seq: a.seq })),
    decisions: [...store.allDecisions().values()],
    targets: store.targets(),
    packRules: store.packRules(),
    packMembers: store.packMembers(),
    manualGroups: groups.filter((g) => g.manual).map((g) => ({ id: g.id, assetIds: g.assetIds, confidence: g.confidence })),
    cameras: (db.prepare('SELECT camera_id, offset_seconds, label FROM camera').all() as { camera_id: string; offset_seconds: number; label: string | null }[]).map((r) => ({
      cameraId: r.camera_id,
      offsetSeconds: r.offset_seconds,
      label: r.label,
    })),
    cameraOverrides: (db.prepare('SELECT asset_id, camera_id FROM camera_override').all() as { asset_id: string; camera_id: string }[]).map((r) => ({
      assetId: r.asset_id,
      cameraId: r.camera_id,
    })),
    deliveries: store.deliveries(),
  };
  const tmp = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    await rename(tmp, destination);
    return ok(undefined);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    return err('WRITE_FAILED', (e as Error).message);
  }
}

export async function readPortable(filePath: string): Promise<Result<Portable>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return err('INVALID_PORTABLE', 'Tệp phiên không đọc được (không phải JSON hợp lệ).');
  }
  const head = raw as { format?: unknown; schemaVersion?: unknown };
  if (head?.format !== PORTABLE_FORMAT) return err('INVALID_PORTABLE', 'Đây không phải tệp phiên EventStory.');
  if (typeof head.schemaVersion !== 'number' || head.schemaVersion > PORTABLE_VERSION) {
    return err('UNSUPPORTED_SCHEMA', `Tệp phiên dùng phiên bản ${String(head.schemaVersion)} mới hơn ứng dụng (hỗ trợ ${PORTABLE_VERSION}). Hãy cập nhật ứng dụng.`);
  }
  const parsed = PortableSchema.safeParse(raw);
  if (!parsed.success) return err('INVALID_PORTABLE', `Tệp phiên không hợp lệ: ${parsed.error.issues[0]?.message ?? ''}`);
  return ok(parsed.data);
}

/** Creates a new project from a session file. Sources start offline until relinked. */
export async function importPortable(filePath: string, projectDir: string): Promise<Result<{ store: ProjectStore; manualGroups: Group[] }>> {
  const data = await readPortable(filePath);
  if (!data.ok) return data;
  const p = data.value;
  const created = ProjectStore.create(projectDir, p.project.name);
  if (!created.ok) return created;
  const store = created.value;
  const db = store.db;
  try {
    store.tx(() => {
      // Portable v1 has no grouping preset field; preserve v0.1 semantics until explicitly switched.
      store.setMeta('grouping_preset', 'group-v1');
      const ins = (sql: string) => db.prepare(sql);
      const src = ins("INSERT INTO source (id, label, root_path, added_at, online) VALUES (?, ?, '', ?, 0)");
      for (const s of p.sources) src.run(s.id, s.label, p.exportedAt);
      const file = ins('INSERT INTO file (id, source_id, relative_path, rel_key, kind, bytes, mtime_ms, sampled_hash, missing) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)');
      for (const f of p.files) file.run(f.id, f.sourceId, f.relativePath, f.relativePath.normalize('NFC'), f.kind, f.bytes, f.sampledHash);
      const side = ins('UPDATE file SET sidecar_of = ? WHERE id = ?');
      for (const f of p.files) if (f.sidecarOf) side.run(f.sidecarOf, f.id);
      const asset = ins("INSERT INTO asset (id, primary_file_id, companion_jpeg_id, pair_confirmed, media_status, seq) VALUES (?, ?, ?, ?, 'queued', ?)");
      for (const a of p.assets) asset.run(a.id, a.primaryFileId, a.companionJpegId, a.pairConfirmed ? 1 : 0, a.seq);
      for (const d of p.decisions) store.saveDecision({ ...d, rating: d.rating as 0 | 1 | 2 | 3 | 4 | 5 });
      store.replaceTargets(p.targets);
      for (const r of p.packRules) store.savePackRule(r);
      store.replacePackMembers(p.packMembers);
      const cam = ins('INSERT INTO camera (camera_id, offset_seconds, label) VALUES (?, ?, ?)');
      for (const c of p.cameras) cam.run(c.cameraId, c.offsetSeconds, c.label);
      const ov = ins('INSERT INTO camera_override (asset_id, camera_id) VALUES (?, ?)');
      for (const o of p.cameraOverrides) ov.run(o.assetId, o.cameraId);
      for (const e of p.deliveries) store.insertDelivery(e);
      store.replaceGroups(
        p.manualGroups.map((g) => ({ ...g, manual: true })),
        'imported',
      );
    });
  } catch (e) {
    store.close();
    return err('INVALID_PORTABLE', `Không nhập được tệp phiên: ${(e as Error).message}`);
  }
  return ok({ store, manualGroups: p.manualGroups.map((g) => ({ ...g, manual: true })) });
}
