import { useEffect, useState } from 'react';
import type { ExportPlanView, ExportReport, ExportSet } from '../../shared/contracts';
import { api, formatBytes } from '../lib';
import { PACK_LABEL } from './PackPanel';

const CODE_LABEL: Record<string, string> = {
  SOURCE_MISSING: 'Thiếu tệp nguồn (thẻ/ổ đã tháo?)',
  SOURCE_UNAVAILABLE: 'Không đọc được tệp nguồn',
  SOURCE_CHANGED: 'Tệp nguồn đã đổi kể từ khi quét',
  SOURCE_CHANGED_DURING_COPY: 'Tệp nguồn đổi trong lúc sao chép',
  VERIFY_FAILED: 'Bản sao không khớp SHA-256',
  DISK_FULL: 'Ổ đích đầy',
  DEST_NOT_WRITABLE: 'Không ghi được vào nơi xuất',
  DEST_EXISTS: 'Tên tệp đích đã tồn tại (không ghi đè)',
  NOT_ENOUGH_SPACE: 'Ổ đích có thể không đủ dung lượng',
};

function conflictText(c: string): string {
  const i = c.indexOf(':');
  const code = i >= 0 ? c.slice(0, i) : c;
  const rest = i >= 0 ? c.slice(i + 1) : '';
  return `${CODE_LABEL[code] ?? code}${rest ? `: ${rest}` : ''}`;
}

export function ExportDialog(props: { projectId: string; packId: ExportSet; onClose: () => void; onError: (m: string) => void }) {
  const title = props.packId === 'selection' ? 'Xuất Ảnh đã chọn (tự động + thủ công)' : `Xuất bộ ${PACK_LABEL[props.packId]}`;
  const [mode, setMode] = useState<ExportPlanView['mode']>('copy-originals');
  const [plan, setPlan] = useState<ExportPlanView | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    const fetchReport = () =>
      void api()
        .getExportReport(jobId)
        .then((r) => r.ok && r.value && setReport(r.value));
    const off = api().onProgress((e) => {
      if (e.kind !== 'export' || e.jobId !== jobId) return;
      setProgress({ done: e.done, total: e.total });
      if (e.phase === 'complete' || e.phase === 'cancelled') fetchReport();
    });
    // A short export can finish before this subscription exists: ask once right away.
    fetchReport();
    return off;
  }, [jobId]);

  const preview = async () => {
    setBusy(true);
    const r = await api().previewExport(props.projectId, props.packId, mode);
    setBusy(false);
    if (!r.ok) props.onError(r.message);
    else if (r.value) setPlan(r.value);
  };

  const start = async () => {
    if (!plan) return;
    const r = await api().confirmExport(plan.planId);
    if (!r.ok) {
      props.onError(r.message);
      if (r.code.startsWith('PLAN_STALE') || r.code === 'UNKNOWN_ID') setPlan(null);
      return;
    }
    setJobId(r.value);
    setProgress({ done: 0, total: plan.outputs.length });
  };

  return (
    <div className="modal" role="dialog" aria-label="Xuất bộ chọn" data-testid="export-dialog">
      <div className="modal-card">
        <h3>{title}</h3>
        {!plan && !jobId && (
          <>
            <label className="opt">
              <input type="radio" checked={mode === 'copy-originals'} onChange={() => setMode('copy-originals')} /> Sao chép ảnh gốc (RAW, JPEG đồng hành, XMP cũ) + XMP mới cho RAW
              chưa có XMP + manifest
            </label>
            <label className="opt">
              <input type="radio" checked={mode === 'manifest'} onChange={() => setMode('manifest')} data-testid="mode-manifest" /> Chỉ manifest (CSV/JSON), không sao chép ảnh
            </label>
            <p className="dim small">Ứng dụng tạo một thư mục mới bên trong nơi bạn chọn; không ghi đè tệp có sẵn, không ghi vào thư mục nguồn hay thư mục dự án.</p>
            <div className="row buttons">
              <button onClick={() => void preview()} disabled={busy} data-testid="choose-destination">
                Chọn nơi xuất và xem trước…
              </button>
              <button onClick={props.onClose}>Đóng</button>
            </div>
          </>
        )}
        {plan && !jobId && (
          <div data-testid="export-preview">
            <p>
              Thư mục mới: <strong>{plan.destinationLabel}</strong>
            </p>
            <p>
              {plan.logicalCount} ảnh · {plan.physicalCount} tệp gốc · dự kiến {formatBytes(plan.projectedBytes)}
              {plan.mode === 'manifest' && ' (chỉ ghi manifest)'}
            </p>
            {plan.conflicts.length > 0 && (
              <ul className="warn small">
                {plan.conflicts.map((c) => (
                  <li key={c}>{conflictText(c)}</li>
                ))}
              </ul>
            )}
            {plan.omissions.length > 0 && (
              <details>
                <summary className="small">Ghi chú metadata ({plan.omissions.length})</summary>
                <ul className="small dim">
                  {plan.omissions.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              </details>
            )}
            {plan.outputs.length > 0 && (
              <details>
                <summary className="small">Tên tệp sẽ tạo ({plan.outputs.length})</summary>
                <ul className="small dim mono">
                  {plan.outputs.slice(0, 200).map((o) => (
                    <li key={o.outputName}>{o.outputName}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row buttons">
              <button onClick={() => void start()} data-testid="start-export">
                Bắt đầu xuất
              </button>
              <button onClick={() => setPlan(null)}>Quay lại</button>
            </div>
          </div>
        )}
        {jobId && !report && (
          <div data-testid="export-running">
            <p>
              Đang sao chép và kiểm tra SHA-256… {progress ? `${progress.done}/${progress.total}` : ''}
            </p>
            <button onClick={() => void api().cancelJob(jobId)}>Hủy</button>
          </div>
        )}
        {report && (
          <div data-testid="export-report">
            <p>
              Kết quả:{' '}
              <strong data-testid="export-status">
                {report.status === 'verified'
                  ? 'Hoàn tất, mọi tệp đã kiểm tra khớp'
                  : report.status === 'partial'
                    ? 'Chưa hoàn tất — có tệp lỗi'
                    : report.status === 'cancelled'
                      ? 'Đã hủy'
                      : 'Thất bại'}
              </strong>
            </p>
            <p className="small">
              {report.copiedVerified.length} tệp đã kiểm tra · {report.failed.length} lỗi · {report.cancelled.length} hủy
            </p>
            {report.failed.length > 0 && (
              <ul className="warn small">
                {report.failed.map((f) => (
                  <li key={`${f.outputName}-${f.code}`}>
                    {f.outputName}: {CODE_LABEL[f.code ?? ''] ?? f.message}
                  </li>
                ))}
              </ul>
            )}
            <p className="dim small">Xuất không tự ghi nhận là đã bàn giao. Khi đã gửi cho khách, dùng “Đánh dấu đã bàn giao”.</p>
            <div className="row buttons">
              <button onClick={() => void api().openExportFolder(jobId!)}>Mở thư mục kết quả</button>
              <button onClick={props.onClose}>Đóng</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
