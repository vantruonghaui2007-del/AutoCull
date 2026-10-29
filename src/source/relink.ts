import type { FileRecord } from '../shared/contracts';

export interface RelinkResult {
  matched: { record: FileRecord; candidate: FileRecord }[];
  missing: FileRecord[];
  ambiguous: { record: FileRecord; candidates: FileRecord[] }[];
}

const identity = (f: Pick<FileRecord, 'bytes' | 'sampledHash' | 'kind'>) => `${f.kind}|${f.bytes}|${f.sampledHash}`;
const pathKey = (p: string) => p.normalize('NFC');

/**
 * Re-associates indexed files with files found at a new location, by size + sampled content
 * hash (never by modification time). The same relative path is preferred; otherwise a unique
 * identity match is accepted. Several candidates, or several records competing for one
 * candidate, are ambiguous and are never resolved by guessing.
 */
export function relinkAssets(records: FileRecord[], candidates: FileRecord[]): RelinkResult {
  const byIdentity = new Map<string, FileRecord[]>();
  for (const c of candidates) {
    const k = identity(c);
    byIdentity.set(k, [...(byIdentity.get(k) ?? []), c]);
  }
  const proposals = new Map<FileRecord, FileRecord[]>();
  for (const r of records) {
    const same = byIdentity.get(identity(r)) ?? [];
    const exact = same.filter((c) => pathKey(c.relativePath) === pathKey(r.relativePath));
    proposals.set(r, exact.length === 1 ? exact : same);
  }
  // A candidate claimed by more than one record cannot be assigned to any of them.
  const claims = new Map<FileRecord, number>();
  for (const list of proposals.values()) if (list.length === 1) claims.set(list[0]!, (claims.get(list[0]!) ?? 0) + 1);

  const result: RelinkResult = { matched: [], missing: [], ambiguous: [] };
  for (const [record, list] of proposals) {
    if (list.length === 0) result.missing.push(record);
    else if (list.length === 1 && claims.get(list[0]!) === 1) result.matched.push({ record, candidate: list[0]! });
    else result.ambiguous.push({ record, candidates: list });
  }
  return result;
}
