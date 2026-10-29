import type {
  AssetId,
  CoverageTarget,
  Decision,
  FileId,
  Group,
  PackId,
  PackMember,
  PackRule,
  PairCandidate,
  ProjectCommand,
} from '../shared/contracts';
import { localToMillis } from '../shared/time';

/** The part of a project the photographer edits by hand. Independent of analysis results. */
export interface ReviewModel {
  decisions: Record<AssetId, Decision>;
  members: PackMember[];
  targets: CoverageTarget[];
  rules: PackRule[];
  journal: JournalEntry[];
}

/** Values that a command replaced, so it can be undone exactly. */
export interface UndoSnapshot {
  decisions?: Record<AssetId, Decision>;
  members?: PackMember[];
  targets?: CoverageTarget[];
  rules?: PackRule[];
}

export interface JournalEntry {
  command: ProjectCommand;
  before: UndoSnapshot;
}

export function defaultDecision(assetId: AssetId): Decision {
  return { assetId, state: 'unreviewed', rating: 0, consent: 'unknown', targetIds: [] };
}

export function isDefaultDecision(d: Decision): boolean {
  return d.state === 'unreviewed' && d.rating === 0 && d.consent === 'unknown' && d.targetIds.length === 0;
}

export function emptyReviewModel(assetIds: AssetId[]): ReviewModel {
  return {
    decisions: Object.fromEntries(assetIds.map((id) => [id, defaultDecision(id)])),
    members: [],
    targets: [],
    rules: [
      { id: 'quick', limit: 12, targetIds: [] },
      { id: 'edit', limit: 120, targetIds: [] },
    ],
    journal: [],
  };
}

/** Commands handled by the review core (and therefore undoable). */
export const REVIEW_COMMANDS = new Set<ProjectCommand['type']>([
  'set-review',
  'set-rating',
  'set-consent',
  'assign-target',
  'upsert-target',
  'remove-target',
  'set-pack-rule',
  'set-pack-member',
  'pin',
  'accept-suggestion',
]);

function cloneDecision(d: Decision): Decision {
  return { ...d, targetIds: [...d.targetIds] };
}

function known(state: ReviewModel, ids: readonly AssetId[]): AssetId[] {
  return ids.filter((id) => state.decisions[id] !== undefined);
}

function withPack(members: PackMember[], packId: PackId, update: (current: PackMember[]) => PackMember[]): PackMember[] {
  const others = members.filter((m) => m.packId !== packId);
  return [...others, ...update(members.filter((m) => m.packId === packId))];
}

/** Pure review transition. The previous values of everything it touches go on the journal. */
export function applyReviewCommand(state: ReviewModel, command: ProjectCommand): ReviewModel {
  if (!REVIEW_COMMANDS.has(command.type)) return state;
  const before: UndoSnapshot = {};
  const decisions = { ...state.decisions };
  let members = state.members;
  let targets = state.targets;
  let rules = state.rules;

  const editDecisions = (ids: readonly AssetId[], fn: (d: Decision) => void) => {
    before.decisions ??= {};
    for (const id of known(state, ids)) {
      before.decisions[id] ??= cloneDecision(state.decisions[id]!);
      const d = cloneDecision(decisions[id]!);
      fn(d);
      decisions[id] = d;
    }
  };
  const editMembers = (packId: PackId, fn: (current: PackMember[]) => PackMember[]) => {
    before.members ??= state.members.map((m) => ({ ...m }));
    members = withPack(members, packId, fn);
  };

  switch (command.type) {
    case 'set-review':
      editDecisions(command.assetIds, (d) => (d.state = command.state));
      break;
    case 'set-rating':
      editDecisions(command.assetIds, (d) => (d.rating = command.rating as Decision['rating']));
      break;
    case 'set-consent':
      editDecisions(command.assetIds, (d) => (d.consent = command.consent));
      break;
    case 'assign-target':
      editDecisions(command.assetIds, (d) => {
        const has = d.targetIds.includes(command.targetId);
        if (command.assigned && !has) d.targetIds = [...d.targetIds, command.targetId];
        if (!command.assigned && has) d.targetIds = d.targetIds.filter((t) => t !== command.targetId);
      });
      break;
    case 'upsert-target': {
      before.targets = state.targets.map((t) => ({ ...t }));
      const i = targets.findIndex((t) => t.id === command.target.id);
      targets = i >= 0 ? targets.map((t, j) => (j === i ? { ...command.target } : t)) : [...targets, { ...command.target }];
      break;
    }
    case 'remove-target': {
      before.targets = state.targets.map((t) => ({ ...t }));
      before.rules = state.rules.map((r) => ({ ...r, targetIds: [...r.targetIds] }));
      targets = targets.filter((t) => t.id !== command.targetId);
      rules = rules.map((r) => ({ ...r, targetIds: r.targetIds.filter((t) => t !== command.targetId) }));
      const holders = Object.values(state.decisions)
        .filter((d) => d.targetIds.includes(command.targetId))
        .map((d) => d.assetId);
      editDecisions(holders, (d) => (d.targetIds = d.targetIds.filter((t) => t !== command.targetId)));
      break;
    }
    case 'set-pack-rule':
      before.rules = state.rules.map((r) => ({ ...r, targetIds: [...r.targetIds] }));
      rules = [...rules.filter((r) => r.id !== command.packId), { id: command.packId, limit: command.limit, targetIds: [...command.targetIds] }].sort(
        (a, b) => (a.id === 'quick' ? -1 : b.id === 'quick' ? 1 : 0),
      );
      break;
    case 'set-pack-member': {
      const ids = new Set(known(state, command.assetIds));
      editMembers(command.packId, (cur) =>
        command.member
          ? [...cur, ...[...ids].filter((id) => !cur.some((m) => m.assetId === id)).map((assetId) => ({ packId: command.packId, assetId, pinned: false }))]
          : cur.filter((m) => !ids.has(m.assetId)),
      );
      break;
    }
    case 'pin': {
      const ids = known(state, command.assetIds);
      const set = new Set(ids);
      editMembers(command.packId, (cur) => {
        if (!command.pinned) return cur.map((m) => (set.has(m.assetId) ? { ...m, pinned: false } : m));
        const kept = cur.map((m) => (set.has(m.assetId) ? { ...m, pinned: true } : m));
        const added = ids.filter((id) => !cur.some((m) => m.assetId === id)).map((assetId) => ({ packId: command.packId, assetId, pinned: true }));
        return [...kept, ...added];
      });
      // A pin is an explicit choice: it also confirms "keep".
      if (command.pinned) editDecisions(ids, (d) => (d.state = 'keep'));
      break;
    }
    case 'accept-suggestion': {
      const ids = known(state, command.assetIds);
      editMembers(command.packId, (cur) => {
        const pinned = cur.filter((m) => m.pinned);
        const pinnedIds = new Set(pinned.map((m) => m.assetId));
        return [...pinned, ...ids.filter((id) => !pinnedIds.has(id)).map((assetId) => ({ packId: command.packId, assetId, pinned: false }))];
      });
      break;
    }
    default:
      return state;
  }
  if (before.decisions && Object.keys(before.decisions).length === 0) delete before.decisions;
  return { decisions, members, targets, rules, journal: [...state.journal, { command, before }] };
}

/** Restores the values recorded in an undo snapshot (unknown assets are skipped). */
export function restoreSnapshot(state: Omit<ReviewModel, 'journal'>, before: UndoSnapshot): Omit<ReviewModel, 'journal'> {
  const decisions = { ...state.decisions };
  for (const [id, d] of Object.entries(before.decisions ?? {})) if (decisions[id]) decisions[id] = cloneDecision(d);
  const live = new Set(Object.keys(decisions));
  return {
    decisions,
    members: before.members ? before.members.filter((m) => live.has(m.assetId)).map((m) => ({ ...m })) : state.members,
    targets: before.targets ? before.targets.map((t) => ({ ...t })) : state.targets,
    rules: before.rules ? before.rules.map((r) => ({ ...r, targetIds: [...r.targetIds] })) : state.rules,
  };
}

export function undoReview(state: ReviewModel): ReviewModel {
  const last = state.journal[state.journal.length - 1];
  if (!last) return state;
  return { ...restoreSnapshot(state, last.before), journal: state.journal.slice(0, -1) };
}

export function keptMembers(group: Group, state: Pick<ReviewModel, 'decisions'>): { members: AssetId[] } {
  return { members: group.assetIds.filter((id) => state.decisions[id]?.state === 'keep') };
}

// ---------- RAW + JPEG pairing ----------

export interface PairFileInput {
  fileId: FileId;
  assetId: AssetId;
  sourceId: string;
  relativePath: string;
  kind: 'raw' | 'jpeg';
  model: string | null;
  serial: string | null;
  capturedLocal: string | null;
  /** False until the file's metadata has been read. */
  metadataRead: boolean;
  /** Already part of a confirmed pair. */
  paired: boolean;
}

const PAIR_TIME_TOLERANCE_MS = 2000;

function pairKey(f: PairFileInput): string {
  const p = f.relativePath.normalize('NFC');
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash) : '';
  const base = (slash >= 0 ? p.slice(slash + 1) : p).replace(/\.[^.]+$/, '');
  return `${f.sourceId}|${dir.toLowerCase()}|${base.toLowerCase()}`;
}

function stemLabel(f: PairFileInput): string {
  return f.relativePath.replace(/\.[^./]+$/, '');
}

/**
 * Proposes RAW+JPEG pairs in the same folder with the same stem. Nothing is ever confirmed here.
 * More than one RAW or JPEG for a stem, metadata not yet read or missing camera/time, a camera or
 * serial mismatch, or a capture-time mismatch makes the candidate ambiguous; ambiguous candidates cannot be confirmed in a batch.
 */
export function findPairCandidates(files: PairFileInput[]): PairCandidate[] {
  const byKey = new Map<string, PairFileInput[]>();
  for (const f of files) {
    if (f.paired) continue;
    const k = pairKey(f);
    const list = byKey.get(k);
    if (list) list.push(f);
    else byKey.set(k, [f]);
  }
  const out: PairCandidate[] = [];
  for (const list of byKey.values()) {
    const raws = list.filter((f) => f.kind === 'raw');
    const jpegs = list.filter((f) => f.kind === 'jpeg');
    if (!raws.length || !jpegs.length) continue;
    const multi = raws.length > 1 || jpegs.length > 1;
    for (const r of raws) {
      for (const j of jpegs) {
        let reason: string | null = null;
        const tr = localToMillis(r.capturedLocal);
        const tj = localToMillis(j.capturedLocal);
        if (multi) reason = raws.length > 1 ? 'Nhiều RAW cùng tên' : 'Nhiều JPEG cùng tên';
        else if (!r.metadataRead || !j.metadataRead) reason = 'Chưa đọc xong metadata';
        else if (!r.model || !j.model || tr === null || tj === null) reason = 'Thiếu thông tin máy/giờ để đối chiếu';
        else if (r.model !== j.model) reason = 'Khác máy ảnh';
        else if (r.serial && j.serial && r.serial !== j.serial) reason = 'Khác số máy';
        else if (Math.abs(tr - tj) > PAIR_TIME_TOLERANCE_MS) reason = 'Lệch giờ chụp';
        out.push({
          rawId: r.fileId,
          jpegId: j.fileId,
          rawAssetId: r.assetId,
          jpegAssetId: j.assetId,
          relativeStem: stemLabel(r),
          confirmed: false,
          ambiguous: reason !== null,
          reason,
        });
      }
    }
  }
  return out.sort((a, b) => a.relativeStem.localeCompare(b.relativeStem) || a.jpegId.localeCompare(b.jpegId));
}
