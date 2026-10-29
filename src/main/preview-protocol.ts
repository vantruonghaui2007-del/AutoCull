import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAllowedPath } from './paths';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' es-preview: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'es-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
};

async function serveFile(root: string, relative: string, extraHeaders: Record<string, string>): Promise<Response> {
  const candidate = path.join(root, ...relative.split('/').filter(Boolean));
  const allowed = await resolveAllowedPath(root, candidate);
  if (!allowed.ok) return new Response('Forbidden', { status: 403 });
  try {
    // Read directly: going through net.fetch(file://) would hit the session's network block.
    const body = await readFile(allowed.value);
    const type = MIME[path.extname(allowed.value).toLowerCase()] ?? 'application/octet-stream';
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type, ...extraHeaders } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** app://bundle/... serves only the packaged renderer directory, with a CSP that blocks network and remote code. */
export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'bundle') return new Response('Forbidden', { status: 403 });
    const rel = decodeURIComponent(url.pathname) || '/index.html';
    return serveFile(rendererRoot, rel === '/' ? '/index.html' : rel, {
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
    });
  });
}

const CACHE_FILE = /^[0-9a-f]{64}-(t|p)\.jpg$/;

/**
 * es-preview://<projectId>/<cacheFile> maps only to that project's preview cache.
 * It is not a general file reader: the file name must be a cache ID.
 */
export function registerPreviewProtocol(
  cacheRootFor: (projectId: string) => string | null,
  restore: (projectId: string, cacheFile: string) => Promise<boolean>,
): void {
  protocol.handle('es-preview', async (request) => {
    const url = new URL(request.url);
    const root = cacheRootFor(url.host);
    const name = url.pathname.replace(/^\//, '');
    if (!root || !CACHE_FILE.test(name)) return new Response('Forbidden', { status: 403 });
    const headers = { 'cache-control': 'private, max-age=31536000, immutable' };
    const first = await serveFile(root, name, headers);
    if (first.status !== 404) return first;
    // Evicted from the disk cache: ask the worker to re-extract it from the source.
    return (await restore(url.host, name)) ? serveFile(root, name, headers) : first;
  });
}
