import { useEffect, useState } from 'react';
import { api } from '../lib';

export function LocalAnalysisControls(props: { projectId: string; disabled: boolean; onStarted(id: string): void; onError(message: string): void }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api().getLocalAnalysisSettings().then((r) => { if (r.ok) setAvailable(r.value.available); }); }, []);
  return <span data-testid="local-analysis-controls" title="Prototype: xử lý trên máy, không gửi ảnh lên AWS. Mắt/biểu cảm là ước lượng; bố cục chỉ kiểm tra vị trí mặt sát mép.">
    <button data-testid="select-local-model" disabled={busy || props.disabled} onClick={() => {
      setBusy(true);
      void api().selectLocalModel().then((r) => {
        if (r.ok) setAvailable(r.value.available); else props.onError(r.message);
      }).finally(() => setBusy(false));
    }}>{busy ? 'Đang nạp model…' : available ? 'Model local đã sẵn sàng' : 'Chọn model local…'}</button>{' '}
    <button data-testid="start-local-autocull" disabled={!available || busy || props.disabled} onClick={() => {
      setBusy(true);
      void api().startAutoCull(props.projectId, 'local').then((r) => {
        if (r.ok) props.onStarted(r.value); else props.onError(r.message);
      }).finally(() => setBusy(false));
    }}>AutoCull local (thử nghiệm)</button>
    <span className="dim small"> Không gửi ảnh lên mạng · cần kiểm tra lại gợi ý</span>
  </span>;
}
