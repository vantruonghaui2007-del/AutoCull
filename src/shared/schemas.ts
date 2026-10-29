import { z } from 'zod';
import type { Result } from './contracts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${UUID}$`), `ID ${prefix}_… không hợp lệ`);

export function newId(prefix: 'p' | 's' | 'f' | 'a' | 'j' | 't' | 'g' | 'd' | 'x' | 'u'): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
export function err<T = never>(code: string, message: string): Result<T> {
  return { ok: false, code, message };
}

export const ProjectIdSchema = idOf('p');
export const SourceIdSchema = idOf('s');
export const FileIdSchema = idOf('f');
export const AssetIdSchema = idOf('a');
export const JobIdSchema = idOf('j');
export const TargetIdSchema = idOf('t');
export const GroupIdSchema = idOf('g');
export const DeliveryIdSchema = idOf('d');
export const PlanIdSchema = idOf('x');
export const CameraIdSchema = z.string().regex(/^c_[0-9a-f]{16}$/, 'cameraId không hợp lệ');

export const PackIdSchema = z.enum(['quick', 'edit']);
export const ReviewStateSchema = z.enum(['unreviewed', 'keep', 'pass', 'review']);
export const ConsentSchema = z.enum(['unknown', 'allowed', 'blocked']);
export const RatingSchema = z.number().int().min(0).max(5);
const AssetIds = z.array(AssetIdSchema).min(1).max(20_000);

export const CoverageTargetSchema = z.strictObject({
  id: TargetIdSchema,
  label: z.string().trim().min(1).max(120),
  required: z.boolean(),
  requiresConsent: z.boolean(),
  minCount: z.number().int().min(1).max(10_000),
});

export const ProjectCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set-review'), assetIds: AssetIds, state: ReviewStateSchema }),
  z.strictObject({ type: z.literal('set-rating'), assetIds: AssetIds, rating: RatingSchema }),
  z.strictObject({ type: z.literal('set-consent'), assetIds: AssetIds, consent: ConsentSchema }),
  z.strictObject({ type: z.literal('assign-target'), assetIds: AssetIds, targetId: TargetIdSchema, assigned: z.boolean() }),
  z.strictObject({ type: z.literal('upsert-target'), target: CoverageTargetSchema }),
  z.strictObject({ type: z.literal('remove-target'), targetId: TargetIdSchema }),
  z.strictObject({
    type: z.literal('set-pack-rule'),
    packId: PackIdSchema,
    limit: z.number().int().min(0).max(100_000).nullable(),
    targetIds: z.array(TargetIdSchema).max(500),
  }),
  z.strictObject({ type: z.literal('set-pack-member'), packId: PackIdSchema, assetIds: AssetIds, member: z.boolean() }),
  z.strictObject({ type: z.literal('pin'), packId: PackIdSchema, assetIds: AssetIds, pinned: z.boolean() }),
  z.strictObject({ type: z.literal('accept-suggestion'), packId: PackIdSchema, assetIds: z.array(AssetIdSchema).max(20_000) }),
  z.strictObject({
    type: z.literal('set-camera-offset'),
    cameraId: CameraIdSchema,
    offsetSeconds: z.number().int().min(-7 * 24 * 3600).max(7 * 24 * 3600),
  }),
  z.strictObject({ type: z.literal('set-camera-identity'), assetIds: AssetIds, label: z.string().trim().min(1).max(80) }),
  z.strictObject({ type: z.literal('split-group'), groupId: GroupIdSchema, assetIds: AssetIds }),
  z.strictObject({ type: z.literal('merge-groups'), groupIds: z.array(GroupIdSchema).min(2).max(500) }),
  /** preset: switch the project's grouping preset (e.g. an old project moving to event-v2). */
  z.strictObject({ type: z.literal('regroup'), preset: z.enum(['group-v1', 'event-v2']).optional() }),
  z.strictObject({
    type: z.literal('confirm-pairs'),
    pairs: z.array(z.strictObject({ rawId: FileIdSchema, jpegId: FileIdSchema })).min(1).max(20_000),
  }),
  z.strictObject({ type: z.literal('undo') }),
  z.strictObject({ type: z.literal('confirm-delivery'), packId: PackIdSchema, assetIds: AssetIds }),
  z.strictObject({
    type: z.literal('correct-delivery'),
    eventId: DeliveryIdSchema,
    assetIds: z.array(AssetIdSchema).max(20_000),
  }),
]);
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;

export const AssetQuerySchema = z.strictObject({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(200),
  packId: PackIdSchema.optional(),
  groupId: GroupIdSchema.optional(),
  state: ReviewStateSchema.optional(),
  text: z.string().max(100).optional(),
  cameraId: CameraIdSchema.optional(),
  list: z.enum(['keep', 'better-option', 'review']).optional(),
});

export const ProjectNameSchema = z.string().trim().min(1).max(120);
export const ExportModeSchema = z.enum(['manifest', 'copy-originals']);

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export function validate<T>(schema: z.ZodType<T>, value: unknown, code = 'INVALID_ARGUMENT'): Result<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(code, describe(parsed.error));
}

export function validateRating(value: unknown): Result<0 | 1 | 2 | 3 | 4 | 5> {
  return validate(RatingSchema, value, 'INVALID_RATING') as Result<0 | 1 | 2 | 3 | 4 | 5>;
}

export function parseProjectCommand(value: unknown): Result<ProjectCommand> {
  return validate(ProjectCommandSchema, value, 'INVALID_COMMAND');
}

export const AiEndpointSchema = z.string().trim().max(500).url().refine((s) => {
  try {
    const u = new URL(s);
    const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    return !u.username && !u.password && (u.protocol === 'https:' || local);
  } catch {
    return false;
  }
}, 'Địa chỉ dịch vụ phải dùng HTTPS (HTTP chỉ dành cho localhost), không chứa tài khoản/mật khẩu.');
/** null = keep the stored token, '' = remove it. */
export const AiTokenInputSchema = z.union([z.null(), z.literal(''), z.string().trim().regex(/^[A-Za-z0-9._~+/=-]{20,200}$/, 'Token không đúng định dạng')]);
export const AssetIdListSchema = z.array(AssetIdSchema).min(1).max(20_000);
export const ExportSetSchema = z.union([PackIdSchema, z.literal('selection')]);
