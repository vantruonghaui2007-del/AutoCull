import { useEffect, useState } from 'react';
import { api } from '../lib';
import { Icon } from './Icon';

export function LocalAnalysisControls(props: { projectId: string; disabled: boolean; onStarted(id: string): void; onError(message: string): void }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api().getLocalAnalysisSettings().then((r) => { if (r.ok) setAvailable(r.value.available); }); }, []);
  return <span className="local-controls" data-testid="local-analysis-controls" title="Prototype: xử lý trên máy, không gửi ảnh lên AWS. Mắt/biểu cảm là ước lượng; bố cục chỉ kiểm tra vị trí mặt sát mép.">
    <button data-testid="select-local-model" className={`ghost model-btn${available ? ' model-ready' : ''}`} disabled={busy || props.disabled} onClick={() => {
      setBusy(true);
      void api().selectLocalModel().then((r) => {
        if (r.ok) setAvailable(r.value.available); else props.onError(r.message);
      }).finally(() => setBusy(false));
    }}><Icon name={available ? 'check' : 'cpu'} />{busy ? 'Đang nạp model…' : available ? 'Model local đã sẵn sàng' : 'Chọn model local…'}</button>{' '}
    <button data-testid="start-local-autocull" className="accent" disabled={!available || busy || props.disabled} onClick={() => {
      setBusy(true);
      void api().startAutoCull(props.projectId, 'local').then((r) => {
        if (r.ok) props.onStarted(r.value); else props.onError(r.message);
      }).finally(() => setBusy(false));
    }}><Icon name="sparkle" />AutoCull local (thử nghiệm)</button>
    <span className="local-hint dim small"> Không gửi ảnh lên mạng · cần kiểm tra lại gợi ý</span>
  </span>;
}
