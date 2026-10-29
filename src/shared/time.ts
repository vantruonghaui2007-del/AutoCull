const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;

/** Naive local capture time ("YYYY-MM-DDTHH:mm:ss[.fff]") as milliseconds on a zone-less axis. */
export function localToMillis(local: string | null): number | null {
  if (!local) return null;
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const ms = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
}

export function millisToLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const frac = d.getUTCMilliseconds() ? `.${p(d.getUTCMilliseconds(), 3)}` : '';
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${frac}`;
}

/** Applies a project-level camera clock offset. The original EXIF value is never changed. */
export function effectiveLocal(capturedLocal: string | null, offsetSeconds: number): string | null {
  const ms = localToMillis(capturedLocal);
  return ms === null ? null : millisToLocal(ms + offsetSeconds * 1000);
}

export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
