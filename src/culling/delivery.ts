import type { AssetId, DeliveryEvent, FileId, PackId } from '../shared/contracts';
import { newId } from '../shared/schemas';

/**
 * A delivery event is the photographer's own record that a set was handed over. It is written
 * only by an explicit confirmation, never by export, and is immutable once stored. A mistake is
 * fixed by a new event that corrects (supersedes) an earlier one.
 */
export function buildDeliveryEvent(input: {
  packId: PackId;
  assetIds: AssetId[];
  fingerprints: Record<FileId, string>;
  correctsEventId: string | null;
  at?: string;
}): DeliveryEvent {
  return {
    id: newId('d'),
    at: input.at ?? new Date().toISOString(),
    packId: input.packId,
    assetIds: [...input.assetIds],
    fileFingerprints: { ...input.fingerprints },
    correctsEventId: input.correctsEventId,
  };
}

/** Assets currently recorded as delivered: each correction replaces the event it corrects. */
export function deliveredAssetIds(events: DeliveryEvent[]): Set<AssetId> {
  const superseded = new Set(events.map((e) => e.correctsEventId).filter((x): x is string => !!x));
  const out = new Set<AssetId>();
  for (const e of events) if (!superseded.has(e.id)) for (const id of e.assetIds) out.add(id);
  return out;
}
