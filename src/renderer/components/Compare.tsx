import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { AssetView, FaceAssessment } from '../../shared/contracts';
import { reasonText } from '../../shared/reasons';
import { LIST_LABEL, SOURCE_LABEL } from './CullPanel';

const EYE_LABEL: Record<FaceAssessment['eyes'], string> = { open: 'mắt mở', closed: 'nhắm mắt', unknown: 'mắt chưa rõ' };

/** A face cut from the preview with CSS only (no extra decoding). */
function FaceCrop(props: { url: string; face: FaceAssessment; aspect: number }) {
  const b = props.face.bbox;
  const h = 72;
  const w = Math.max(24, Math.min(144, Math.round((h * b.width * props.aspect) / Math.max(b.height, 1e-3))));
  const pos = (start: number, size: number) => (size >= 1 ? 0 : (start / (1 - size)) * 100);
  return (
    <figure className={`facecrop eyes-${props.face.eyes}`} data-testid="face-crop">
      <div
        style={{
          width: w,
          height: h,
          backgroundImage: `url("${props.url}")`,
          backgroundSize: `${100 / Math.max(b.width, 1e-3)}% ${100 / Math.max(b.height, 1e-3)}%`,
          backgroundPosition: `${pos(b.left, b.width)}% ${pos(b.top, b.height)}%`,
        }}
      />
      <figcaption>{EYE_LABEL[props.face.eyes]}</figcaption>
    </figure>
  );
}
import { basename, previewSourceLabel, STATE_LABEL } from '../lib';

interface View {
  zoom: number; // 1 = fit to pane
  cx: number; // centre of the viewport in normalised image coordinates
  cy: number;
}

function Pane(props: {
  index: number;
  asset: AssetView;
  view: View;
  onPan: (dx: number, dy: number) => void;
  onWheel: (e: WheelEvent) => void;
  onScale: (index: number, s: number) => void;
  showFaces: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const p = props.asset.preview;
  const w = p?.width ?? 1;
  const h = p?.height ?? 1;
  const fit = Math.min(size.w / w, size.h / h);
  const scale = fit * props.view.zoom;
  const { onScale, index } = props;
  useLayoutEffect(() => {
    onScale(index, scale);
  }, [scale, index, onScale]);
  const left = size.w / 2 - props.view.cx * w * scale;
  const top = size.h / 2 - props.view.cy * h * scale;
  const down = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!drag.current) return;
    const dx = (e.clientX - drag.current.x) / (w * scale);
    const dy = (e.clientY - drag.current.y) / (h * scale);
    drag.current = { x: e.clientX, y: e.clientY };
    props.onPan(-dx, -dy);
  };
  return (
    <div className="pane" data-testid="compare-pane" data-zoom={props.view.zoom.toFixed(3)}>
      <div className="pane-view" ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} onWheel={props.onWheel}>
        {p ? (
          <>
            <img src={p.url} alt="" draggable={false} style={{ left, top, width: w * scale, height: h * scale }} />
            {props.showFaces &&
              (props.asset.analysis?.faces ?? []).map((f, i) => (
                <div
                  key={i}
                  className={`facebox eyes-${f.eyes}`}
                  data-testid="face-box"
                  style={{ left: left + f.bbox.left * w * scale, top: top + f.bbox.top * h * scale, width: f.bbox.width * w * scale, height: f.bbox.height * h * scale }}
                >
                  <span>{EYE_LABEL[f.eyes]}</span>
                </div>
              ))}
          </>
        ) : (
          <span className="noimg">Không có preview</span>
        )}
      </div>
      <div className="pane-info">
        <strong>{basename(props.asset.primary.relativePath)}</strong> · {STATE_LABEL[props.asset.decision.state]} · {props.asset.decision.rating}★
        <br />
        <span className="dim">{previewSourceLabel(props.asset)}</span>
        <br />
        <span className={`listtag list-${props.asset.cull.list}`}>{LIST_LABEL[props.asset.cull.list]}</span> <span className="dim">{SOURCE_LABEL[props.asset.cull.source]}</span>
        {props.asset.cull.reasons.length > 0 && <span className="dim"> · {props.asset.cull.reasons.map(reasonText).join(' · ')}</span>}
        {p && (props.asset.analysis?.faces?.length ?? 0) > 0 && (
          <div className="facecrops">
            {props.asset.analysis!.faces!.slice(0, 12).map((f, i) => (
              <FaceCrop key={i} url={p.url} face={f} aspect={w / h} />
            ))}
          </div>
        )}
        {props.asset.analysis?.faces?.some((f) => f.eyes === 'unknown') && (
          <div className="dim small">Mắt chưa rõ: mặt nhỏ, nghiêng, bị che, kính râm hoặc tín hiệu chưa chắc — không bị tính như nhắm mắt.</div>
        )}
      </div>
    </div>
  );
}

/** Side-by-side (or single, for the loupe) view with zoom and pan shared in image-relative coordinates. */
export function Compare(props: { assets: AssetView[]; onClose: () => void }) {
  const [view, setView] = useState<View>({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [showFaces, setShowFaces] = useState(true);
  const scales = useRef<number[]>([]);
  const [maxScale, setMaxScale] = useState(0);
  const dpr = window.devicePixelRatio || 1;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const zoomBy = (f: number) => setView((v) => ({ ...v, zoom: Math.min(40, Math.max(1, v.zoom * f)) }));
  const count = props.assets.length;
  const onScale = useCallback(
    (i: number, s: number) => {
      scales.current[i] = s;
      setMaxScale(Math.max(...scales.current.slice(0, count).map((x) => x ?? 0)));
    },
    [count],
  );
  const over = maxScale * dpr > 1.01;
  const smallest = props.assets.reduce((m, a) => Math.min(m, a.preview ? Math.max(a.preview.width, a.preview.height) : Infinity), Infinity);
  return (
    <div className="compare" data-testid="compare" role="dialog" aria-label="So sánh ảnh">
      <div className="compare-bar">
        <button data-testid="zoom-out" onClick={() => zoomBy(1 / 1.5)}>−</button>
        <span>{Math.round(view.zoom * 100)}% so với vừa khung</span>
        <button data-testid="zoom-in" onClick={() => zoomBy(1.5)}>+</button>
        <label className="small">
          <input type="checkbox" checked={showFaces} onChange={(e) => setShowFaces(e.target.checked)} /> Khung mặt
        </label>
        <button onClick={() => setView({ zoom: 1, cx: 0.5, cy: 0.5 })}>Vừa khung</button>
        {over && (
          <span className="warn" data-testid="zoom-warning">
            Đang phóng vượt độ phân giải preview (cạnh dài {Number.isFinite(smallest) ? smallest : '?'} px) — ảnh vỡ hạt ở đây không phản ánh độ nét của RAW.
          </span>
        )}
        <span className="spacer" />
        <button onClick={props.onClose}>Đóng (Esc)</button>
      </div>
      <div className={`compare-panes n${props.assets.length}`}>
        {props.assets.map((a, i) => (
          <Pane
            key={a.id}
            asset={a}
            view={view}
            index={i}
            onScale={onScale}
            showFaces={showFaces}
            onPan={(dx, dy) => setView((v) => ({ ...v, cx: clamp(v.cx + dx), cy: clamp(v.cy + dy) }))}
            onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2)}
          />
        ))}
      </div>
    </div>
  );
}
