import { useEffect, useState } from 'react';
import type { AiQuotaView, AiSettingsView } from '../../shared/contracts';
import { api } from '../lib';

export function AiSettingsDialog(props: { onClose: () => void }) {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [quota, setQuota] = useState<AiQuotaView | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const loadQuota = async () => {
    const q = await api().getAiQuota();
    if (q.ok) {
      setQuota(q.value);
      setQuotaError(null);
    } else {
      setQuota(null);
      setQuotaError(q.code === 'AI_NOT_CONFIGURED' ? null : q.message);
    }
  };

  useEffect(() => {
    void api()
      .getAiSettings()
      .then((r) => {
        if (!r.ok) return;
        setView(r.value);
        setEndpoint(r.value.endpoint ?? '');
        if (r.value.hasToken) void loadQuota();
      });
  }, []);

  const save = async () => {
    const r = await api().saveAiSettings(endpoint.trim(), token.trim() === '' ? null : token.trim());
    if (!r.ok) return setStatus(`Chưa lưu: ${r.message}`);
    setView(r.value);
    setToken('');
    setStatus(r.value.tokenPersisted ? 'Đã lưu (token được mã hóa bằng hệ điều hành).' : 'Đã lưu cho phiên này (máy không hỗ trợ mã hóa, token chỉ giữ trong bộ nhớ).');
    await loadQuota();
  };

  const consent = async (accepted: boolean) => {
    const r = await api().setAiConsent(accepted);
    if (r.ok) setView(r.value);
  };

  return (
    <div className="modal" role="dialog" aria-label="Phân tích AI" data-testid="ai-settings">
      <div className="modal-card">
        <h3>Phân tích khuôn mặt (pilot)</h3>
        <label className="field">
          Địa chỉ dịch vụ (HTTPS)
          <input data-testid="ai-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://….lambda-url.ap-southeast-1.on.aws/" />
        </label>
        <label className="field">
          Token pilot
          <input
            data-testid="ai-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={view?.hasToken ? 'Đã có token — để trống nếu không đổi' : 'Dán token được cấp'}
          />
        </label>
        <div className="row buttons">
          <button data-testid="ai-save" onClick={() => void save()} disabled={!endpoint.trim()}>
            Lưu
          </button>
          {view?.hasToken && (
            <button onClick={() => void api().saveAiSettings(endpoint.trim(), '').then((r) => r.ok && (setView(r.value), setQuota(null), setStatus('Đã xóa token.')))}>Xóa token</button>
          )}
        </div>
        {status && (
          <p className="small" data-testid="ai-status">
            {status}
          </p>
        )}
        {quota && (
          <p className="small" data-testid="ai-quota">
            Tháng {quota.month}: bạn đã dùng {quota.user.used}/{quota.user.limit} lượt · toàn pilot {quota.global.used}/{quota.global.limit} · đặt lại {new Date(quota.resetAt).toLocaleDateString('vi-VN')}
          </p>
        )}
        {quotaError && <p className="warn small">{quotaError}</p>}
        <fieldset className="consent">
          <legend>Gửi ảnh lên dịch vụ đám mây</legend>
          <p className="small">
            Khi phân tích, ứng dụng gửi <strong>ảnh xem trước JPEG đã thu nhỏ (tối đa 3.840 px), đã bỏ EXIF/GPS</strong> tới Amazon Rekognition (vùng Singapore) qua
            máy chủ pilot. <strong>Tệp RAW gốc không rời máy.</strong> Máy chủ không lưu ảnh; kết quả phân tích được giữ để tránh tính phí hai lần và không còn đọc được
            sau 24 giờ (dọn dẹp nền có thể chậm hơn). Chỉ phân tích ảnh mà bạn có quyền xử lý trên cloud và người trong ảnh đã đồng ý.
          </p>
          <label>
            <input data-testid="ai-consent" type="checkbox" checked={!!view?.consentAt} onChange={(e) => void consent(e.target.checked)} /> Tôi đã hiểu và đồng ý
          </label>
        </fieldset>
        <div className="row buttons">
          <button data-testid="ai-close" onClick={props.onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
