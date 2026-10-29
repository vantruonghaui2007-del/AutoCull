import { useState } from 'react';
import type { CameraView, PairCandidate, ProjectState } from '../../shared/contracts';
import { formatOffset, localToMillis } from '../../shared/time';
import { api, formatLocal, type RunCommand } from '../lib';

function CameraRow(props: { cam: CameraView; projectId: string; run: RunCommand; onError: (m: string) => void }) {
  const { cam } = props;
  const [open, setOpen] = useState(false);
  const [correct, setCorrect] = useState('');
  const [label, setLabel] = useState('');
  const sample = cam.sampleCapturedLocal;

  const applyReference = async () => {
    const exif = localToMillis(sample);
    const target = localToMillis(correct.length === 16 ? `${correct}:00` : correct);
    if (exif === null || target === null) return props.onError('Nhập giờ đúng của ảnh mẫu (ngày giờ đầy đủ).');
    const offsetSeconds = Math.round((target - Math.floor(exif / 1000) * 1000) / 1000);
    if (await props.run({ type: 'set-camera-offset', cameraId: cam.cameraId, offsetSeconds })) setOpen(false);
  };

  const applyIdentity = async () => {
    if (!label.trim()) return;
    const ids: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const r = await api().queryAssets(props.projectId, { offset, limit: 200, cameraId: cam.cameraId });
      if (!r.ok) return props.onError(r.message);
      ids.push(...r.value.items.map((a) => a.id));
      if (ids.length >= r.value.total || r.value.items.length === 0) break;
    }
    if (ids.length) await props.run({ type: 'set-camera-identity', assetIds: ids, label: label.trim() });
  };

  return (
    <li className="camera">
      <div>
        <strong>{cam.label}</strong> <span className="dim">· {cam.assetCount} ảnh</span>
      </div>
      <div className="dim">
        Lệch giờ trong dự án: {cam.offsetSeconds === 0 ? 'không' : formatOffset(cam.offsetSeconds)} (không ghi vào tệp)
      </div>
      {cam.needsIdentity && (
        <div className="note">
          Máy không có số seri: đang tách theo nguồn. Nếu nhiều nguồn là cùng một máy, đặt cùng một tên:
          <div className="inline">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="VD: Máy A" aria-label="Tên máy" />
            <button onClick={() => void applyIdentity()}>Đặt tên</button>
          </div>
        </div>
      )}
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? 'Đóng' : 'Chỉnh lệch giờ'}
      </button>
      {open && (
        <div className="offset-editor">
          <div>
            Ảnh mẫu (sớm nhất) — giờ EXIF gốc: <strong>{formatLocal(sample)}</strong>
          </div>
          <label>
            Giờ đúng của ảnh này:
            <input type="datetime-local" step={1} value={correct} onChange={(e) => setCorrect(e.target.value)} />
          </label>
          <div className="inline">
            <button onClick={() => void applyReference()}>Áp dụng</button>
            <button onClick={() => void props.run({ type: 'set-camera-offset', cameraId: cam.cameraId, offsetSeconds: 0 })}>Bỏ lệch giờ</button>
          </div>
        </div>
      )}
    </li>
  );
}

export function SourcePanel(props: {
  projectId: string;
  state: ProjectState;
  pairs: PairCandidate[];
  scanning: boolean;
  run: RunCommand;
  onAddSource: () => void;
  onRelink: (sourceId: string) => void;
  onError: (m: string) => void;
}) {
  const clean = props.pairs.filter((p) => !p.ambiguous);
  const ambiguous = props.pairs.filter((p) => p.ambiguous);
  const [showAmb, setShowAmb] = useState(false);
  return (
    <nav className="sourcepanel" aria-label="Nguồn và máy ảnh">
      <section>
        <h4>Nguồn ảnh (chỉ đọc)</h4>
        <ul className="sources">
          {props.state.sources.map((s) => (
            <li key={s.id} className={s.online ? '' : 'offline'}>
              <span>{s.label}</span> <span className="dim">· {s.fileCount} tệp</span>
              {!s.online && (
                <div>
                  <span className="warn">Không truy cập được (ổ đã tháo?)</span>{' '}
                  <button className="link" onClick={() => props.onRelink(s.id)}>
                    Liên kết lại
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <button data-testid="add-source" onClick={props.onAddSource}>
          + Thêm thư mục nguồn
        </button>
      </section>

      <section>
        <h4>Cặp RAW + JPEG</h4>
        {props.pairs.length === 0 ? (
          <p className="dim">Không có cặp nào chờ xác nhận.</p>
        ) : (
          <>
            <p>
              {clean.length} cặp rõ ràng (cùng thư mục, cùng tên, cùng máy, cùng giờ).
              {ambiguous.length > 0 && ` ${ambiguous.length} trường hợp mơ hồ không được ghép.`}
            </p>
            {clean.length > 0 && (
              <button
                data-testid="confirm-pairs"
                disabled={props.scanning}
                title={props.scanning ? 'Chờ quét xong để đối chiếu đủ metadata' : undefined}
                onClick={() => void props.run({ type: 'confirm-pairs', pairs: clean.map((p) => ({ rawId: p.rawId, jpegId: p.jpegId })) })}
              >
                Xác nhận {clean.length} cặp
              </button>
            )}
            {ambiguous.length > 0 && (
              <button className="link" onClick={() => setShowAmb(!showAmb)}>
                {showAmb ? 'Ẩn' : 'Xem'} trường hợp mơ hồ
              </button>
            )}
            {showAmb && (
              <ul className="dim small">
                {ambiguous.map((p) => (
                  <li key={`${p.rawId}-${p.jpegId}`}>
                    {p.relativeStem}: {p.reason}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section>
        <h4>Máy ảnh</h4>
        <ul className="cameras">
          {props.state.cameras.map((c) => (
            <CameraRow key={c.cameraId} cam={c} projectId={props.projectId} run={props.run} onError={props.onError} />
          ))}
        </ul>
        {props.state.cameras.length === 0 && <p className="dim">Chưa có dữ liệu máy ảnh.</p>}
      </section>
    </nav>
  );
}
