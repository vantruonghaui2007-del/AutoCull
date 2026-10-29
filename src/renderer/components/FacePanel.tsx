import type { AssetView, FaceAssessment } from '../../shared/contracts';

const SOURCE_LABEL: Record<string, string> = {
  'companion-jpeg': 'JPEG đi kèm',
  'jpeg-original': 'JPEG gốc',
  embedded: 'ảnh nhúng trong RAW',
  'embedded-small': 'ảnh nhúng nhỏ trong RAW',
  libraw: 'giải mã RAW (LibRaw)',
};
const REASON_LABEL: Record<FaceAssessment['unknownReasons'][number], string> = {
  'low-face-confidence': 'nhận diện mặt chưa chắc',
  'small-face': 'mặt quá nhỏ',
  'low-eye-confidence': 'tín hiệu mắt chưa chắc',
  pose: 'mặt nghiêng/ngửa nhiều',
  occluded: 'mặt bị che',
  sunglasses: 'kính râm',
  'no-eye-data': 'không có dữ liệu mắt',
};
const EXPRESSION_LABEL: Record<string, string> = {
  HAPPY: 'vui',
  CALM: 'bình thản',
  SAD: 'buồn',
  ANGRY: 'cau có',
  CONFUSED: 'bối rối',
  DISGUSTED: 'nhăn mặt',
  SURPRISED: 'ngạc nhiên',
  FEAR: 'hoảng',
};

function eyeText(f: FaceAssessment): string {
  if (f.eyes === 'open') return 'Mắt: mở';
  if (f.eyes === 'closed') return 'Mắt: nhắm';
  return `Mắt: chưa rõ (${f.unknownReasons.map((r) => REASON_LABEL[r]).join(', ')})`;
}

export function FacePanel(props: { view: AssetView; onAnalyze: (retryFailed?: boolean) => void; busy: boolean; count: number }) {
  const a = props.view.analysis;
  let body: React.ReactNode;
  if (!a) body = <span>Chưa phân tích khuôn mặt.</span>;
  else if (a.status === 'pending') body = <span>Đang chờ kết quả (sẽ đọc lại ở lần chạy sau nếu mất mạng).</span>;
  else if (a.status === 'failed') body = <span className="warn">Phân tích lỗi: {a.error}</span>;
  else if (a.status === 'stale') body = <span className="warn">Kết quả cũ không còn khớp ảnh (tệp/cặp đã đổi) — cần phân tích lại.</span>;
  else if (!a.faces || a.faces.length === 0) body = <span>Không phát hiện khuôn mặt (không có nghĩa là chắc chắn không có người).</span>;
  else
    body = (
      <ol className="faces">
        {a.faces.map((f, i) => (
          <li key={i}>
            <strong>{eyeText(f)}</strong>
            {f.smile !== null && <> · {f.smile ? 'cười' : 'không cười'}</>}
            {f.mouthOpen && <> · miệng mở</>}
            {f.expressions[0] && <> · biểu cảm dự đoán: {EXPRESSION_LABEL[f.expressions[0].type] ?? f.expressions[0].type}</>}
            <span className="dim">
              {' '}
              · mặt {f.shortSidePx}px{f.sharpness !== null ? ` · nét mặt ${Math.round(f.sharpness)}` : ''}
              {f.pose ? ` · nghiêng ${Math.round(f.pose.yaw)}°` : ''}
            </span>
          </li>
        ))}
      </ol>
    );
  return (
    <section className="facepanel rb-card" data-testid="face-summary">
      <div className="row">
        <span className="label">Khuôn mặt:</span>
        {a?.provider?.startsWith('mediapipe-') && <span className="dim small">MediaPipe local · ước lượng thử nghiệm</span>}
        {a?.sourceKind && <span className="dim small">phân tích từ {SOURCE_LABEL[a.sourceKind] ?? a.sourceKind} {a.imageWidth}×{a.imageHeight}</span>}
      </div>
      {body}
      <div className="row buttons">
        {a?.status === 'failed' && (
          <button data-testid="retry-analysis" onClick={() => props.onAnalyze(true)} disabled={props.busy} title="Gửi lại tới AWS (tính thêm một lượt). Với local, hãy chạy AutoCull local để thử lại.">
            Thử lại qua AWS
          </button>
        )}
        <button data-testid="analyze-faces" onClick={() => props.onAnalyze()} disabled={props.busy}>
          Phân tích qua AWS{props.count > 1 ? ` (${props.count} ảnh)` : ''}
        </button>
      </div>
    </section>
  );
}
