import { describe, expect, it } from 'vitest';
import { AiEndpointSchema, parseProjectCommand, validateRating, newId } from '../../src/shared/schemas';

const assetA = newId('a');

it('AI endpoints require HTTPS except loopback; URL credentials are never accepted', () => {
  for (const url of ['https://pilot.example/', 'http://127.0.0.1:1000/', 'http://localhost:1000/']) expect(AiEndpointSchema.safeParse(url).success).toBe(true);
  for (const url of ['http://pilot.example/', 'ftp://pilot.example/', 'https://user:secret@pilot.example/']) expect(AiEndpointSchema.safeParse(url).success).toBe(false);
});

describe('validateRating', () => {
  it('accepts 0..5 and rejects anything else', () => {
    expect(validateRating(0).ok).toBe(true);
    expect(validateRating(5).ok).toBe(true);
    expect(validateRating(6).ok).toBe(false);
    expect(validateRating(-1).ok).toBe(false);
    expect(validateRating(2.5).ok).toBe(false);
  });
});

describe('parseProjectCommand', () => {
  it('accepts a valid rating command', () => {
    const r = parseProjectCommand({ type: 'set-rating', assetIds: [assetA], rating: 3 });
    expect(r.ok).toBe(true);
  });

  it('rejects rating outside 0..5', () => {
    const r = parseProjectCommand({ type: 'set-rating', assetIds: [assetA], rating: 6 });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  });

  it('rejects a negative or fractional pack quota', () => {
    expect(parseProjectCommand({ type: 'set-pack-rule', packId: 'quick', limit: -1, targetIds: [] }).ok).toBe(false);
    expect(parseProjectCommand({ type: 'set-pack-rule', packId: 'quick', limit: 1.5, targetIds: [] }).ok).toBe(false);
    expect(parseProjectCommand({ type: 'set-pack-rule', packId: 'quick', limit: null, targetIds: [] }).ok).toBe(true);
  });

  it('rejects IDs that look like paths (path injection)', () => {
    const r = parseProjectCommand({ type: 'set-rating', assetIds: ['..\\..\\Windows\\win.ini'], rating: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown pack ids and unknown command types', () => {
    expect(parseProjectCommand({ type: 'pin', packId: 'social', assetIds: [assetA], pinned: true }).ok).toBe(false);
    expect(parseProjectCommand({ type: 'delete-file', assetIds: [assetA] }).ok).toBe(false);
  });

  it('rejects extra properties so renderer cannot smuggle paths', () => {
    const r = parseProjectCommand({ type: 'undo', path: 'C:\\x' });
    expect(r.ok).toBe(false);
  });
});
