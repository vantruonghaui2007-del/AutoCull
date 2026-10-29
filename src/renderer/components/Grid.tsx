import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { AssetView, Group } from '../../shared/contracts';
import { basename, STATE_LABEL, STATUS_LABEL } from '../lib';

const CELL_W = 196;
const CELL_H = 176;
const GROUP_ROW_H = 214;

export const AssetCell = memo(function AssetCell(props: {
  view: AssetView | undefined;
  focused: boolean;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
  onDoubleClick?: () => void;
}) {
  const v = props.view;
  if (!v) return <div className="cell cell--loading" aria-hidden />;
  const d = v.decision;
  const issue = v.status !== 'ready' ? STATUS_LABEL[v.status] : null;
  return (
    <div
      className={`cell state-${d.state} cull-${v.cull.list}${v.cull.selected ? ' picked' : ''}${props.focused ? ' focused' : ''}${props.selected ? ' selected' : ''}`}
      data-testid="asset-cell"
      data-asset-id={v.id}
      data-state={d.state}
      data-cull-list={v.cull.list}
      data-picked={v.cull.selected ? 'true' : 'false'}
      role="button"
      aria-label={`${basename(v.primary.relativePath)} — ${STATE_LABEL[d.state]}`}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
    >
      <div className="thumb">
        {v.preview ? <img src={v.preview.thumbUrl} alt="" loading="lazy" draggable={false} /> : <span className="noimg">Không có preview</span>}
        {issue && <span className={`badge badge-status status-${v.status}`}>{issue}</span>}
        {v.cull.selected && (
          <span className={`badge badge-pick${v.cull.source === 'manual-keep' ? ' manual' : ''}`} title={v.cull.source === 'manual-keep' ? 'Giữ thủ công' : 'Tự động chọn'}>
            ✓
          </span>
        )}
        <span className="packs">
          {v.packs.quick.member && <span className={`pk${v.packs.quick.pinned ? ' pinned' : ''}`} title="Trả nhanh">N</span>}
          {v.packs.edit.member && <span className={`pk${v.packs.edit.pinned ? ' pinned' : ''}`} title="Hậu kỳ">H</span>}
        </span>
      </div>
      <div className="meta">
        <span className="name" title={v.primary.relativePath}>
          {basename(v.primary.relativePath)}
          {v.companion ? ' +JPG' : ''}
        </span>
        <span className="stars" aria-label={`${d.rating} sao`}>
          {'★'.repeat(d.rating)}
          <span className="dim">{'★'.repeat(5 - d.rating)}</span>
        </span>
      </div>
    </div>
  );
});

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

export function AllGrid(props: {
  total: number | null;
  at: (i: number) => AssetView | undefined;
  focus: number;
  selected: Set<string>;
  onPick: (index: number, e: MouseEvent) => void;
  onOpen: (index: number) => void;
  onColumns: (cols: number) => void;
}) {
  const { ref, size } = useSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const cols = Math.max(1, Math.floor(size.w / CELL_W));
  const total = props.total ?? 0;
  const rows = Math.ceil(total / cols);
  const { onColumns } = props;
  useEffect(() => {
    onColumns(cols);
  }, [cols, onColumns]);

  useEffect(() => {
    const el = ref.current;
    if (!el || total === 0) return;
    const row = Math.floor(props.focus / cols);
    const top = row * CELL_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + CELL_H > el.scrollTop + el.clientHeight) el.scrollTop = top + CELL_H - el.clientHeight;
  }, [props.focus, cols, total, ref]);

  const first = Math.max(0, Math.floor(scrollTop / CELL_H) - 2);
  const last = Math.min(rows, Math.ceil((scrollTop + size.h) / CELL_H) + 2);
  const cells = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= total) break;
      const v = props.at(i);
      cells.push(
        <div key={i} className="slot" style={{ top: r * CELL_H, left: c * CELL_W }}>
          <AssetCell
            view={v}
            focused={i === props.focus}
            selected={!!v && props.selected.has(v.id)}
            onClick={(e) => props.onPick(i, e)}
            onDoubleClick={() => props.onOpen(i)}
          />
        </div>,
      );
    }
  }
  return (
    <div className="grid-scroll" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="grid">
      {props.total === 0 && <p className="empty">Chưa có ảnh. Hãy thêm thư mục nguồn.</p>}
      <div className="grid-canvas" style={{ height: rows * CELL_H }}>
        {cells}
      </div>
    </div>
  );
}

export function GroupList(props: {
  groups: Group[];
  views: (id: string) => AssetView | undefined;
  /** Loads every member of the group (paged) for the current data version. */
  requestGroup: (groupId: string) => void;
  focusId: string | null;
  selected: Set<string>;
  onPick: (assetId: string, e: MouseEvent) => void;
  onOpen: (assetId: string) => void;
}) {
  const { ref, size } = useSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const { groups, requestGroup, focusId } = props;

  useEffect(() => {
    const el = ref.current;
    if (!el || !focusId) return;
    const gi = groups.findIndex((g) => g.assetIds.includes(focusId));
    if (gi < 0) return;
    const top = gi * GROUP_ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + GROUP_ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + GROUP_ROW_H - el.clientHeight;
  }, [focusId, groups, ref]);

  const first = Math.max(0, Math.floor(scrollTop / GROUP_ROW_H) - 1);
  const last = Math.min(groups.length, Math.ceil((scrollTop + size.h) / GROUP_ROW_H) + 1);
  // Visible groups are (re)loaded once per data version: no request loop, and labels follow changes.
  useEffect(() => {
    for (const g of groups.slice(first, last)) requestGroup(g.id);
  }, [groups, first, last, requestGroup]);
  const visible = groups.slice(first, last);

  return (
    <div className="grid-scroll" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="group-list">
      {groups.length === 0 && <p className="empty">Chưa có cụm.</p>}
      <div className="grid-canvas" style={{ height: groups.length * GROUP_ROW_H }}>
        {visible.map((g, k) => (
          <div key={g.id} className="group-row" style={{ top: (first + k) * GROUP_ROW_H }} data-testid="group-row">
            <div className="group-head">
              {g.assetIds.length > 1 ? `Cụm ${g.assetIds.length} ảnh` : 'Ảnh đơn'}
              {g.manual && <span className="tag">đã chỉnh tay</span>}
              {g.confidence === 'low' && g.assetIds.length > 1 && <span className="tag warn">độ tin cậy thấp (thiếu giờ/đặc trưng)</span>}
              <span className="dim" data-testid="group-picked"> · chọn {g.assetIds.filter((id) => props.views(id)?.cull.selected).length}</span>
            </div>
            <div className="group-strip">
              {g.assetIds.map((id) => (
                <AssetCell
                  key={id}
                  view={props.views(id)}
                  focused={id === focusId}
                  selected={props.selected.has(id)}
                  onClick={(e) => props.onPick(id, e)}
                  onDoubleClick={() => props.onOpen(id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
