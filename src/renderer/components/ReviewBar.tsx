import type { AssetView, ConsentState, CoverageTarget, PackId, ReviewState } from '../../shared/contracts';
import { CullPanel } from './CullPanel';
import { FacePanel } from './FacePanel';
import { basename, formatBytes, formatLocal, previewSourceLabel, STATE_LABEL, STATUS_LABEL, type RunCommand } from '../lib';

const STATES: { s: ReviewState; key: string }[] = [
  { s: 'keep', key: 'K' },
  { s: 'pass', key: 'X' },
  { s: 'review', key: 'R' },
  { s: 'unreviewed', key: 'U' },
];
const CONSENT: { c: ConsentState; label: string }[] = [
  { c: 'unknown', label: 'Chưa rõ' },
  { c: 'allowed', label: 'Đồng ý' },
  { c: 'blocked', label: 'Không đồng ý' },
];
const PACK_LABEL: Record<PackId, string> = { quick: 'Trả nhanh', edit: 'Hậu kỳ' };

export function ReviewBar(props: {
  view: AssetView | undefined;
  selectionIds: string[];
  targets: CoverageTarget[];
  run: RunCommand;
  onOpenLoupe: () => void;
  onAnalyze: (ids: string[], retryFailed?: boolean) => void;
  analyzing: boolean;
  onCompareBest: (() => void) | null;
}) {
  const v = props.view;
  if (!v) return <aside className="reviewbar empty-bar">Chọn một ảnh để duyệt. Phím: ← → di chuyển, 1–5 sao, 0 xóa sao, K giữ, X bỏ qua, R xem lại, U chưa duyệt, C so sánh, Ctrl/⌘+Z hoàn tác.</aside>;
  const ids = props.selectionIds.length ? props.selectionIds : [v.id];
  const multi = ids.length > 1;
  const d = v.decision;
  return (
    <aside className="reviewbar" aria-label="Duyệt ảnh">
      <div className="big" onClick={props.onOpenLoupe} title="Bấm để xem lớn">
        <span className="big-hint" aria-hidden="true">Space · xem lớn</span>
        {v.preview ? <img src={v.preview.url} alt={basename(v.primary.relativePath)} /> : <span className="noimg">Không có preview dùng được</span>}
      </div>
      {multi && <p className="multi">Đang chọn {ids.length} ảnh — thao tác áp cho tất cả.</p>}
      <h3 title={v.primary.relativePath}>{basename(v.primary.relativePath)}</h3>
      <CullPanel view={v} ids={ids} run={props.run} onCompareBest={props.onCompareBest} />
      <dl className="facts rb-card">
        <dt>Tệp</dt>
        <dd>
          {v.primary.relativePath} ({formatBytes(v.primary.bytes)})
          {v.companion && (
            <>
              <br />+ {v.companion.relativePath} ({formatBytes(v.companion.bytes)}) <span className="tag">cặp đã xác nhận</span>
            </>
          )}
        </dd>
        <dt>Trạng thái</dt>
        <dd className={`status-${v.status}`}>{STATUS_LABEL[v.status]}{v.error ? ` — ${v.error}` : ''}</dd>
        <dt>Preview</dt>
        <dd>
          {previewSourceLabel(v)}
          {v.preview?.insufficientForFocus && <span className="warn"> · chưa đủ để soi nét</span>}
        </dd>
        <dt>Máy</dt>
        <dd>{v.cameraLabel ?? 'Không rõ'}</dd>
        <dt>Giờ EXIF gốc</dt>
        <dd>{formatLocal(v.capturedLocal)}</dd>
        <dt>Giờ dùng để xếp</dt>
        <dd>
          {formatLocal(v.effectiveLocal)}
          {v.timeNote && <div className="dim">{v.timeNote}</div>}
        </dd>
        {v.signals && (
          <>
            <dt>Tín hiệu kỹ thuật</dt>
            <dd className="dim">
              Độ nét tương đối của preview {v.signals.laplacianVariance.toFixed(0)} · vùng cháy/bết {(v.signals.clippedFraction * 100).toFixed(1)}%
              <br />
              (chỉ để so các khung với nhau, không phải chấm điểm ảnh)
            </dd>
          </>
        )}
      </dl>

      <FacePanel view={v} busy={props.analyzing} count={ids.length} onAnalyze={(retry) => props.onAnalyze(ids, retry)} />

      <div className="decide rb-card">
      <div className="row" role="group" aria-label="Quyết định">
        <span className="label">Quyết định:</span>
        <strong data-testid="review-state">{STATE_LABEL[d.state]}</strong>
      </div>
      <div className="row buttons">
        {STATES.map(({ s, key }) => (
          <button key={s} data-tone={s} className={d.state === s ? 'on' : ''} onClick={() => void props.run({ type: 'set-review', assetIds: ids, state: s })}>
            {STATE_LABEL[s]} <kbd>{key}</kbd>
          </button>
        ))}
      </div>
      <div className="row buttons" aria-label="Số sao">
        <span className="label">
          Sao: <strong data-testid="rating-value">{d.rating}</strong>
        </span>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={`star-btn${d.rating === n ? ' on' : ''}`} onClick={() => void props.run({ type: 'set-rating', assetIds: ids, rating: n })}>
            {n === 0 ? '0' : '★'.repeat(n)}
          </button>
        ))}
      </div>
      <div className="row buttons" aria-label="Đồng ý của người trong ảnh">
        <span className="label">Đồng ý:</span>
        {CONSENT.map(({ c, label }) => (
          <button key={c} className={d.consent === c ? 'on' : ''} onClick={() => void props.run({ type: 'set-consent', assetIds: ids, consent: c })}>
            {label}
          </button>
        ))}
      </div>
      </div>
      <details className="legacy small" data-testid="legacy-review">
        <summary>Dữ liệu cũ (v0.1): mục tiêu và bộ chọn</summary>
      {props.targets.length > 0 && (
        <fieldset className="targets">
          <legend>Mục tiêu bàn giao (do bạn gắn)</legend>
          {props.targets.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={d.targetIds.includes(t.id)}
                onChange={(e) => void props.run({ type: 'assign-target', assetIds: ids, targetId: t.id, assigned: e.target.checked })}
              />
              {t.label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="packs-ctl">
        {(['quick', 'edit'] as const).map((p) => (
          <div key={p} className="row buttons">
            <span className="label">{PACK_LABEL[p]}:</span>
            <button
              className={v.packs[p].member ? 'on' : ''}
              data-testid={`pack-${p}`}
              onClick={() => void props.run({ type: 'set-pack-member', packId: p, assetIds: ids, member: !v.packs[p].member })}
            >
              {v.packs[p].member ? 'Trong bộ' : 'Thêm vào bộ'} <kbd>{p === 'quick' ? 'Q' : 'E'}</kbd>
            </button>
            <button
              className={v.packs[p].pinned ? 'on' : ''}
              data-testid={`pin-${p}`}
              title="Ghim: luôn giữ trong bộ này, không bị gợi ý loại ra"
              onClick={() => void props.run({ type: 'pin', packId: p, assetIds: ids, pinned: !v.packs[p].pinned })}
            >
              {v.packs[p].pinned ? 'Đã ghim' : 'Ghim'}
            </button>
          </div>
        ))}
      </div>
      </details>
    </aside>
  );
}
