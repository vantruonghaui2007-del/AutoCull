import { useCallback, useEffect, useState } from 'react';
import { computeCoverage } from '../../culling/packs';
import type { AssetView, CoverageEntry, CoverageTarget, DeliveryEvent, PackId, PackSuggestion } from '../../shared/contracts';
import { newId } from '../../shared/schemas';
import type { PanelContext } from '../App';
import { api, formatLocal } from '../lib';

export const PACK_LABEL: Record<PackId, string> = { quick: 'Trả nhanh', edit: 'Hậu kỳ' };
const COVERAGE_LABEL: Record<CoverageEntry['status'], string> = {
  enough: 'Đủ',
  missing: 'Thiếu',
  unknown: 'Chưa rõ (chờ đồng ý)',
};

function conflictLabel(c: string, targets: CoverageTarget[]): string {
  const [code, a, b] = c.split(':');
  const t = (id?: string) => targets.find((x) => x.id === id)?.label ?? id;
  switch (code) {
    case 'PINNED_OVER_LIMIT':
      return 'Số ảnh đã ghim vượt giới hạn của bộ — vẫn giữ toàn bộ ảnh ghim.';
    case 'PINNED_NOT_KEPT':
      return 'Có ảnh đã ghim nhưng hiện không ở trạng thái "Giữ".';
    case 'TARGET_MISSING':
      return `Thiếu ảnh đã duyệt cho mục tiêu bắt buộc "${t(a)}".`;
    case 'TARGET_CONSENT_UNKNOWN':
      return `Mục tiêu "${t(a)}" có ảnh nhưng chưa xác nhận đồng ý — chưa tính là đủ.`;
    case 'QUOTA_TOO_SMALL_FOR_TARGETS':
      return 'Giới hạn số ảnh quá nhỏ để đáp ứng các mục tiêu.';
    case 'GROUP_REPEAT':
      return `Một cụm có ${b} ảnh trong bộ — có thể đang lặp cảnh.`;
    default:
      return c;
  }
}

async function packMembers(projectId: string, packId: PackId): Promise<AssetView[]> {
  const out: AssetView[] = [];
  for (let offset = 0; ; offset += 200) {
    const r = await api().queryAssets(projectId, { offset, limit: 200, packId });
    if (!r.ok) return out;
    out.push(...r.value.items);
    if (out.length >= r.value.total || r.value.items.length === 0) return out;
  }
}

function TargetEditor(props: { ctx: PanelContext }) {
  const { ctx } = props;
  const [label, setLabel] = useState('');
  const [required, setRequired] = useState(true);
  const [consent, setConsent] = useState(false);
  const [min, setMin] = useState(1);
  return (
    <details className="targets-editor">
      <summary>Mục tiêu bàn giao ({ctx.state.targets.length})</summary>
      <p className="dim small">Tùy chọn. Bạn tự đặt và tự gắn ảnh vào mục tiêu; ứng dụng không tự nhận diện nội dung, người hay sự đồng ý.</p>
      <ul>
        {ctx.state.targets.map((t) => (
          <li key={t.id}>
            {t.label} · tối thiểu {t.minCount}
            {t.required ? ' · bắt buộc' : ''}
            {t.requiresConsent ? ' · cần đồng ý' : ''}{' '}
            <button className="link" onClick={() => void ctx.run({ type: 'remove-target', targetId: t.id })}>
              Xóa
            </button>
          </li>
        ))}
      </ul>
      <form
        className="target-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!label.trim()) return;
          void ctx
            .run({ type: 'upsert-target', target: { id: newId('t'), label: label.trim(), required, requiresConsent: consent, minCount: Math.max(1, min) } })
            .then((okd) => okd && setLabel(''));
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="VD: Trao giải, Ảnh tập thể" aria-label="Tên mục tiêu" data-testid="target-label" />
        <label>
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Bắt buộc
        </label>
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Cần đồng ý
        </label>
        <label>
          Tối thiểu <input type="number" min={1} value={min} onChange={(e) => setMin(Number(e.target.value))} style={{ width: 56 }} />
        </label>
        <button type="submit" data-testid="add-target">
          Thêm
        </button>
      </form>
    </details>
  );
}

export function PackPanel(props: { ctx: PanelContext; packFilter: PackId | null; setPackFilter: (p: PackId | null) => void; onExport: (p: PackId) => void }) {
  const { ctx } = props;
  const [pack, setPack] = useState<PackId>('quick');
  const [suggestion, setSuggestion] = useState<PackSuggestion | null>(null);
  const [members, setMembers] = useState<AssetView[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryEvent[]>([]);
  const [confirming, setConfirming] = useState(false);
  const rule = ctx.state.packRules.find((r) => r.id === pack)!;
  const [limitText, setLimitText] = useState(rule.limit === null ? '' : String(rule.limit));
  useEffect(() => setLimitText(rule.limit === null ? '' : String(rule.limit)), [rule.limit, pack]);

  const load = useCallback(async () => {
    setMembers(await packMembers(ctx.projectId, pack));
    const d = await api().listDeliveries(ctx.projectId);
    if (d.ok) setDeliveries(d.value);
  }, [ctx.projectId, pack]);
  useEffect(() => {
    void load();
  }, [load, ctx.version]);
  useEffect(() => setSuggestion(null), [pack]);

  const packTargets = rule.targetIds.map((id) => ctx.state.targets.find((t) => t.id === id)).filter((t): t is CoverageTarget => !!t);
  const decisions = Object.fromEntries(members.map((m) => [m.id, m.decision]));
  const coverage = computeCoverage(
    members.map((m) => m.id),
    decisions,
    packTargets,
  );
  const counts = ctx.state.packCounts[pack];

  const saveRule = (limit: number | null, targetIds: string[]) => void ctx.run({ type: 'set-pack-rule', packId: pack, limit, targetIds });

  const suggest = async () => {
    const r = await api().suggestPack(ctx.projectId, pack);
    if (r.ok) setSuggestion(r.value);
    else ctx.onError(r.message);
  };
  const memberIds = new Set(members.map((m) => m.id));
  const added = suggestion ? suggestion.suggestedIds.filter((id) => !memberIds.has(id)).length : 0;
  const removed = suggestion ? members.filter((m) => !m.packs[pack].pinned && !suggestion.suggestedIds.includes(m.id)).length : 0;

  return (
    <section className="panel packpanel" aria-label="Bộ chọn">
      <div className="seg">
        {(['quick', 'edit'] as const).map((p) => (
          <button key={p} className={pack === p ? 'on' : ''} onClick={() => setPack(p)} data-testid={`pack-tab-${p}`}>
            {PACK_LABEL[p]} ({ctx.state.packCounts[p].members})
          </button>
        ))}
      </div>
      <div className="row">
        <span className="label">Giới hạn:</span>
        <input
          type="number"
          min={0}
          value={limitText}
          placeholder="không giới hạn"
          onChange={(e) => setLimitText(e.target.value)}
          onBlur={() => saveRule(limitText.trim() === '' ? null : Math.max(0, Math.floor(Number(limitText))), rule.targetIds)}
          style={{ width: 110 }}
          data-testid="pack-limit"
        />
        <span className="dim small">
          {counts.members} ảnh, {counts.pinned} ghim
        </span>
      </div>
      {ctx.state.targets.length > 0 && (
        <div className="row small">
          <span className="label">Mục tiêu:</span>
          {ctx.state.targets.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={rule.targetIds.includes(t.id)}
                onChange={(e) => saveRule(rule.limit, e.target.checked ? [...rule.targetIds, t.id] : rule.targetIds.filter((x) => x !== t.id))}
              />
              {t.label}
            </label>
          ))}
        </div>
      )}
      {packTargets.length === 0 ? (
        <p className="dim small">Bộ này chưa gắn mục tiêu: chỉ đếm số lượng và cụm, không đánh giá đã đủ câu chuyện sự kiện.</p>
      ) : (
        <ul className="coverage" data-testid="coverage">
          {coverage.map((c) => {
            const t = packTargets.find((x) => x.id === c.targetId)!;
            return (
              <li key={c.targetId} className={`cov-${c.status}`}>
                {t.label}: <strong>{COVERAGE_LABEL[c.status]}</strong> ({c.evidenceIds.length}/{t.minCount})
              </li>
            );
          })}
        </ul>
      )}
      <div className="row buttons">
        <button onClick={() => void suggest()} data-testid="suggest">
          Gợi ý bộ {PACK_LABEL[pack]}
        </button>
        <button className={props.packFilter === pack ? 'on' : ''} onClick={() => props.setPackFilter(props.packFilter === pack ? null : pack)}>
          {props.packFilter === pack ? 'Đang xem bộ này' : 'Xem bộ trong lưới'}
        </button>
        <button onClick={() => props.onExport(pack)} data-testid="open-export" disabled={counts.members === 0}>
          Xuất…
        </button>
      </div>
      {suggestion && (
        <div className="suggestion" data-testid="suggestion">
          <p>
            Gợi ý {suggestion.suggestedIds.length} ảnh (thêm {added}, bỏ {removed}). Chỉ chọn từ ảnh bạn đã "Giữ"; ảnh ghim luôn được giữ.
          </p>
          {suggestion.conflicts.length > 0 && (
            <ul className="warn small">
              {suggestion.conflicts.map((c) => (
                <li key={c}>{conflictLabel(c, ctx.state.targets)}</li>
              ))}
            </ul>
          )}
          <div className="row buttons">
            <button
              data-testid="accept-suggestion"
              onClick={() => void ctx.run({ type: 'accept-suggestion', packId: pack, assetIds: suggestion.suggestedIds }).then((okd) => okd && setSuggestion(null))}
            >
              Áp dụng gợi ý
            </button>
            <button onClick={() => setSuggestion(null)}>Bỏ qua</button>
          </div>
        </div>
      )}
      <div className="delivery">
        <h4>Bàn giao</h4>
        {confirming ? (
          <div className="confirm">
            <p className="small">
              Ghi nhận rằng bạn <strong>đã gửi</strong> {members.length} ảnh của bộ {PACK_LABEL[pack]} cho khách. Đây là ghi chú của bạn — ứng dụng không gửi ảnh.
            </p>
            <button
              data-testid="confirm-delivery"
              onClick={() =>
                void ctx.run({ type: 'confirm-delivery', packId: pack, assetIds: members.map((m) => m.id) }).then(() => {
                  setConfirming(false);
                  void load();
                })
              }
            >
              Xác nhận đã bàn giao
            </button>{' '}
            <button onClick={() => setConfirming(false)}>Hủy</button>
          </div>
        ) : (
          <button disabled={members.length === 0} onClick={() => setConfirming(true)} data-testid="mark-delivered">
            Đánh dấu đã bàn giao…
          </button>
        )}
        {deliveries.length > 0 && (
          <ul className="history small">
            {deliveries.map((e) => {
              const corrected = deliveries.some((x) => x.correctsEventId === e.id);
              return (
                <li key={e.id} className={corrected ? 'superseded' : ''}>
                  {formatLocal(e.at.slice(0, 19))} · {PACK_LABEL[e.packId]} · {e.assetIds.length} ảnh
                  {e.correctsEventId && ' · đính chính'}
                  {corrected && ' · đã được đính chính'}
                  {!corrected && (
                    <>
                      {' '}
                      <button
                        className="link"
                        onClick={() => void ctx.run({ type: 'correct-delivery', eventId: e.id, assetIds: [] }).then(() => void load())}
                        title="Tạo một ghi nhận mới cho biết lần này đánh dấu nhầm; lịch sử cũ vẫn giữ nguyên"
                      >
                        Đánh dấu nhầm
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <TargetEditor ctx={ctx} />
    </section>
  );
}
