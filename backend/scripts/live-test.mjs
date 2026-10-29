#!/usr/bin/env node
// Checks the DEPLOYED backend against real AWS. Costs a few Rekognition calls (counted in quota).
// Usage: node scripts/live-test.mjs --url <FunctionUrl> --token-file <file with pilot token> --image <face JPEG ≤2.5 MiB> [--out report.json]
// The token is read from a file so it never appears in shell history or process listings.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : null;
};
const base = (opt('url') ?? '').replace(/\/$/, '');
const token = readFileSync(opt('token-file'), 'utf8').trim();
const image = readFileSync(opt('image'));
const report = { at: new Date().toISOString(), url: base, imageBytes: image.length, imageSha256: createHash('sha256').update(image).digest('hex'), checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
};
const call = async (path, { method = 'GET', body, key, auth = token } = {}) => {
  const headers = { authorization: `Bearer ${auth}` };
  if (key) headers['idempotency-key'] = key;
  if (body) headers['content-type'] = 'image/jpeg';
  const r = await fetch(`${base}${path}`, { method, headers, body });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const q0 = await call('/v1/quota');
check('quota readable', q0.status === 200, q0.json);

const bad = await call('/v1/face-analysis', { method: 'POST', body: image, key: randomBytes(12).toString('hex'), auth: 'x'.repeat(43) });
check('wrong token → 401', bad.status === 401);

const big = Buffer.alloc(2.5 * 1024 * 1024 + 10);
big.set([0xff, 0xd8, 0xff]);
const tooBig = await call('/v1/face-analysis', { method: 'POST', body: big, key: randomBytes(12).toString('hex') });
check('oversized image → 413 (or platform limit)', tooBig.status === 413 || tooBig.status === 400, { status: tooBig.status });

const q1 = await call('/v1/quota');
check('rejected requests used no quota', q1.json?.user?.used === q0.json?.user?.used, { before: q0.json?.user?.used, after: q1.json?.user?.used });

const key = `live-${randomBytes(12).toString('hex')}`;
const [a, b] = await Promise.all([
  call('/v1/face-analysis', { method: 'POST', body: image, key }),
  call('/v1/face-analysis', { method: 'POST', body: image, key }),
]);
check('concurrent same key → one 200 + one 202/200', [a.status, b.status].includes(200), { statuses: [a.status, b.status] });
const done = a.status === 200 ? a.json : b.json;
const faces = done?.faces ?? [];
check('real DetectFaces result with eye/smile attributes', done?.status === 'done' && Array.isArray(faces), {
  faces: faces.length,
  first: faces[0] ? { eyesOpen: faces[0].eyesOpen, smile: faces[0].smile, pose: faces[0].pose, quality: faces[0].quality } : null,
});
const q2 = await call('/v1/quota');
check('concurrent pair counted exactly one quota unit', q2.json?.user?.used === (q1.json?.user?.used ?? 0) + 1, { before: q1.json?.user?.used, after: q2.json?.user?.used });

const replay = await call('/v1/face-analysis', { method: 'POST', body: image, key });
const q3 = await call('/v1/quota');
check('replay returns stored result, no new AWS call', replay.status === 200 && q3.json?.user?.used === q2.json?.user?.used, { status: replay.status });

const other = Buffer.from(image);
other[other.length - 3] ^= 0x01;
const conflict = await call('/v1/face-analysis', { method: 'POST', body: other, key });
check('same key + different image → 409', conflict.status === 409);

const rid = done?.requestId;
const read = await call(`/v1/requests/${rid}`);
check('GET request reads stored result', read.status === 200 && read.json?.status === 'done');

report.passed = report.checks.every((c) => c.ok);
if (opt('out')) writeFileSync(opt('out'), `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
