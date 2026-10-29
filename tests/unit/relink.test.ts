import { describe, expect, it } from 'vitest';
import { relinkAssets } from '../../src/source/relink';
import type { FileRecord } from '../../src/shared/contracts';

const rec = (id: string, relativePath: string, sampledHash: string, bytes = 1000): FileRecord => ({
  id: `f_00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  sourceId: 's_old',
  relativePath,
  bytes,
  sampledHash,
  kind: 'raw',
});

describe('relinkAssets', () => {
  it('matches the same relative path with the same size and sample hash', () => {
    const r = relinkAssets([rec('1', 'DCIM/A.ARW', 'h1')], [rec('9', 'DCIM/A.ARW', 'h1')]);
    expect(r.matched).toHaveLength(1);
    expect(r.missing).toHaveLength(0);
  });

  it('still matches after an mtime-only change (mtime is not part of identity)', () => {
    const relinkAfterMtimeOnlyChange = relinkAssets([rec('1', 'DCIM/A.ARW', 'h1')], [{ ...rec('9', 'DCIM/A.ARW', 'h1') }]);
    expect(relinkAfterMtimeOnlyChange.matched).toHaveLength(1);
  });

  it('matches a file that moved to another folder when its identity is unique', () => {
    const r = relinkAssets([rec('1', 'DCIM/A.ARW', 'h1')], [rec('9', 'Backup/2026/A.ARW', 'h1')]);
    expect(r.matched[0]!.candidate.relativePath).toBe('Backup/2026/A.ARW');
  });

  it('never picks one of two equal candidates', () => {
    const relinkWithTwoMatchingCandidates = relinkAssets([rec('1', 'DCIM/A.ARW', 'h1')], [rec('8', 'X/A.ARW', 'h1'), rec('9', 'Y/A.ARW', 'h1')]);
    expect(relinkWithTwoMatchingCandidates.ambiguous).toHaveLength(1);
    expect(relinkWithTwoMatchingCandidates.matched).toHaveLength(0);
  });

  it('treats two records competing for one candidate as ambiguous', () => {
    const r = relinkAssets([rec('1', 'A/A.ARW', 'h1'), rec('2', 'B/A.ARW', 'h1')], [rec('9', 'C/A.ARW', 'h1')]);
    expect(r.ambiguous).toHaveLength(2);
  });

  it('reports a changed or absent file as missing', () => {
    const r = relinkAssets([rec('1', 'DCIM/A.ARW', 'h1'), rec('2', 'DCIM/B.ARW', 'h2')], [rec('9', 'DCIM/A.ARW', 'other')]);
    expect(r.missing.map((m) => m.relativePath).sort()).toEqual(['DCIM/A.ARW', 'DCIM/B.ARW']);
  });

  it('prefers the exact same path when several identical copies exist', () => {
    const r = relinkAssets([rec('1', 'DCIM/A.ARW', 'h1')], [rec('8', 'DCIM/A.ARW', 'h1'), rec('9', 'Copy/A.ARW', 'h1')]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.candidate.relativePath).toBe('DCIM/A.ARW');
  });
});
