import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SerialGate } from './serial-gate';

// Shared by scan fallback and AI preparation: never two helpers, regardless of queue budgets.
const decodeGate = new SerialGate();

/** Plan limits for the RAW helper. */
export const LIBRAW_LIMITS = { maxMegapixels: 60, timeoutMs: 60_000, maxRssMiB: 1536 } as const;

const exe = process.platform === 'win32' ? 'eventstory-raw.exe' : 'eventstory-raw';

/** Packaged: <resources>/bin/<exe>. Development: native/bin/<platform>-<arch>/<exe>. */
export function librawHelperPath(): string | null {
  const resources = process.env.EVENTSTORY_RESOURCES;
  const candidates = [
    resources ? path.join(resources, 'bin', exe) : null,
    path.resolve(__dirname, '..', '..', 'native', 'bin', `${process.platform}-${process.arch}`, exe),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function librawVersion(): Promise<string | null> {
  const helper = librawHelperPath();
  if (!helper) return null;
  return new Promise((resolve) => {
    execFile(helper, ['--version'], { windowsHide: true, timeout: 10_000 }, (e, stdout) => {
      if (e) return resolve(null);
      try {
        resolve(String((JSON.parse(stdout) as { libraw: string }).libraw).replace(/-.*$/, ''));
      } catch {
        resolve(null);
      }
    });
  });
}

export type DecodeResult =
  | { ok: true; value: { rgb: Buffer; width: number; height: number; make: string; model: string } }
  | { ok: false; code: string; message: string; exited: boolean };

/**
 * Decodes a RAW file with the LibRaw helper in a separate process: read-only, camera white balance,
 * no auto-brightness, no sharpening; output is 8-bit sRGB already rotated by the RAW orientation.
 * Cancel or timeout kills the helper and this promise settles only after the process has exited,
 * so a caller that frees a work slot on settlement never overlaps two decodes.
 */
export function decodeRaw(file: string, signal: AbortSignal, opts: { timeoutMs?: number } = {}): Promise<DecodeResult> {
  return decodeGate.run(() => decodeRawNow(file, signal, opts));
}

function decodeRawNow(file: string, signal: AbortSignal, opts: { timeoutMs?: number }): Promise<DecodeResult> {
  const helper = librawHelperPath();
  if (!helper) return Promise.resolve({ ok: false, code: 'RAW_HELPER_MISSING', message: 'Thiếu công cụ giải mã RAW đi kèm ứng dụng.', exited: true });
  if (signal.aborted) return Promise.resolve({ ok: false, code: 'CANCELLED', message: 'Đã hủy.', exited: true });
  return new Promise((resolve) => {
    const child = spawn(helper, [file, '--max-mp', String(LIBRAW_LIMITS.maxMegapixels), '--mem-mib', String(LIBRAW_LIMITS.maxRssMiB)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let header: { ok: boolean; width?: number; height?: number; bytes?: number; code?: string; message?: string; make?: string; model?: string } | null = null;
    let headerBuf = Buffer.alloc(0);
    let data: Buffer | null = null;
    let filled = 0;
    let stopped: { code: string; message: string } | null = null;

    const stop = (code: string, message: string) => {
      if (stopped) return;
      stopped = { code, message };
      child.kill();
    };
    const timer = setTimeout(() => stop('RAW_TIMEOUT', `Giải mã RAW quá ${opts.timeoutMs ?? LIBRAW_LIMITS.timeoutMs} ms.`), opts.timeoutMs ?? LIBRAW_LIMITS.timeoutMs);
    const onAbort = () => stop('CANCELLED', 'Đã hủy.');
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      let c = chunk;
      if (!header) {
        headerBuf = Buffer.concat([headerBuf, c]);
        const nl = headerBuf.indexOf(0x0a);
        if (nl < 0) return;
        try {
          header = JSON.parse(headerBuf.subarray(0, nl).toString('utf8'));
        } catch {
          stop('RAW_PROTOCOL', 'Đầu ra của công cụ giải mã không hợp lệ.');
          return;
        }
        c = headerBuf.subarray(nl + 1);
        if (header!.ok) data = Buffer.allocUnsafe(header!.bytes!);
      }
      if (data && c.length) {
        c.copy(data, filled, 0, Math.min(c.length, data.length - filled));
        filled += c.length;
      }
    });

    child.on('error', (e) => stop('RAW_HELPER_FAILED', e.message));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (stopped) return resolve({ ok: false, ...stopped, exited: true });
      if (header && !header.ok) return resolve({ ok: false, code: header.code ?? 'RAW_CORRUPT', message: header.message ?? 'Không giải mã được RAW.', exited: true });
      if (!header || !data || exitCode !== 0 || filled !== data.length) {
        return resolve({ ok: false, code: 'RAW_CRASHED', message: `Công cụ giải mã dừng bất thường (mã ${exitCode}).`, exited: true });
      }
      resolve({ ok: true, value: { rgb: data, width: header.width!, height: header.height!, make: header.make ?? '', model: header.model ?? '' } });
    });
  });
}
