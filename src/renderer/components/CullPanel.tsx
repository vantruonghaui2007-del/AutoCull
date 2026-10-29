import type { AssetView, Criterion, CullLabel, EffectiveSelection, QualityAssessment } from '../../shared/contracts';
import { reasonText } from '../../shared/reasons';
import type { RunCommand } from '../lib';

export const LIST_LABEL: Record<CullLabel, string> = {
  keep: 'Đề xuất giữ',
  'better-option': 'Có phương án tốt hơn',
  review: 'Cần xem lại',
};

export const SOURCE_LABEL: Record<EffectiveSelection['source'], string> = {
  'manual-keep': 'Giữ thủ công',
  'manual-excluded': 'Đã loại thủ công',
  auto: 'Tự động chọn',
  'not-recommended': 'Không được chọn',
  'no-analysis': 'Chưa có đề xuất',
};

const CRITERIA: { key: keyof Omit<QualityAssessment, 'total' | 'configVersion'>; label: string; weight: number }[] = [
  { key: 'sharpness', label: 'Độ nét', weight: 40 },
  { key: 'eyes', label: 'Mắt', weight: 30 },
  { key: 'lighting', label: 'Ánh sáng', weight: 15 },
  { key: 'composition', label: 'Bố cục', weight: 10 },
  { key: 'expression', label: 'Biểu cảm', weight: 5 },
];

function criterionText(c: Criterion): string {
  if (c.state === 'known') return String(c.score);
  return c.state === 'unknown' ? 'chưa rõ' : 'không áp dụng';
}

/** Why AutoCull put this photo where it is, and the manual overrides. */
export function CullPanel(props: { view: AssetView; ids: string[]; run: RunCommand; onCompareBest: (() => void) | null }) {
  const c = props.view.cull;
  const q = c.quality;
  return (
    <section className={`cullpanel list-${c.list}`} data-testid="cull-panel">
      <div className="row">
        <strong className={`listtag list-${c.list}`}>{LIST_LABEL[c.list]}</strong>
        <span className="dim small">
          {SOURCE_LABEL[c.source]}
          {c.rank !== null && ` · hạng ${c.rank} trong nhóm`}
          {q?.total != null && ` · điểm ${q.total}`}
        </span>
      </div>
      {c.reasons.length > 0 && (
        <ul className="reasons small">
          {c.reasons.map((r) => (
            <li key={r}>{reasonText(r)}</li>
          ))}
        </ul>
      )}
      {q ? (
        <table className="criteria small">
          <tbody>
            {CRITERIA.map(({ key, label, weight }) => (
              <tr key={key} data-testid={`criterion-${key}`} className={`crit-${q[key].state}`}>
                <td>
                  {label} <span className="dim">({weight}%)</span>
                </td>
                <td className="score">{criterionText(q[key])}</td>
                <td className="dim">{q[key].note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dim small">Chưa chạy AutoCull cho ảnh này.</p>
      )}
      <div className="row buttons">
        <button data-testid="cull-keep" className={c.source === 'manual-keep' ? 'on' : ''} onClick={() => void props.run({ type: 'set-review', assetIds: props.ids, state: 'keep' })}>
          Chọn ảnh này
        </button>
        <button data-testid="cull-pass" className={c.source === 'manual-excluded' ? 'on' : ''} onClick={() => void props.run({ type: 'set-review', assetIds: props.ids, state: 'pass' })}>
          Bỏ ảnh này
        </button>
        <button data-testid="cull-auto" onClick={() => void props.run({ type: 'set-review', assetIds: props.ids, state: 'unreviewed' })} title="Bỏ lựa chọn thủ công, dùng lại đề xuất tự động">
          Về tự động
        </button>
        {props.onCompareBest && (
          <button data-testid="compare-best" onClick={props.onCompareBest}>
            So với ảnh được chọn
          </button>
        )}
      </div>
    </section>
  );
}
