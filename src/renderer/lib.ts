import type { AssetView, MediaStatus, ProjectCommand, ReviewState, Result } from '../shared/contracts';

export const api = () => window.eventstory;

export const STATE_LABEL: Record<ReviewState, string> = {
  unreviewed: 'Chưa duyệt',
  keep: 'Giữ',
  pass: 'Bỏ qua',
  review: 'Xem lại',
};

export const STATUS_LABEL: Record<MediaStatus, string> = {
  queued: 'Đang chờ xử lý',
  ready: 'Sẵn sàng',
  'preview-small': 'Preview nhỏ',
  'no-preview': 'Không có preview',
  unsupported: 'Không hỗ trợ',
  error: 'Lỗi đọc tệp',
  missing: 'Thiếu nguồn',
  stale: 'Tệp đã thay đổi',
};

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatLocal(local: string | null): string {
  if (!local) return '—';
  return local.replace('T', ' ').replace(/\.\d+$/, '');
}

export function previewSourceLabel(v: AssetView): string {
  if (!v.preview) return 'Không có preview';
  const origin =
    v.preview.origin === 'embedded' ? `Preview nhúng trong RAW (${v.preview.sourceTag})` : v.preview.origin === 'libraw' ? `Giải mã từ RAW (${v.preview.sourceTag})` : 'JPEG gốc';
  return `${origin} · ${v.preview.width}×${v.preview.height}`;
}

export function message(r: Result<unknown>): string | null {
  return r.ok ? null : r.message;
}

export type RunCommand = (command: ProjectCommand) => Promise<boolean>;

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
