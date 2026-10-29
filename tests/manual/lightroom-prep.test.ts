// Prepares a folder for the manual Lightroom Classic acceptance check (docs/LIGHTROOM_ACCEPTANCE.md).
// npx vitest run --project manual tests/manual/lightroom-prep.test.ts
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { PairCandidate } from '../../src/shared/contracts';
import { newId } from '../../src/shared/schemas';
import { fixturePath, loadFixtures, requireVerifiedFixtures } from '../helpers/fixtures';
import { makeTempDir, workRoot } from '../helpers/fs';
import { makeService, unwrap } from '../helpers/service';

const DEVELOP_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Version="15.0" crs:ProcessVersion="11.0" crs:Exposure2012="+1.00" crs:Temperature="3200" crs:WhiteBalance="Custom" crs:HasSettings="True"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

it('builds the Lightroom acceptance export', async () => {
  await requireVerifiedFixtures();
  const fx = (id: string) => fixturePath(loadFixtures().find((e) => e.id === id)!);
  const base = await makeTempDir('lr-prep');
  const card = path.join(base, 'card');
  await mkdir(card, { recursive: true });
  const files: [string, string][] = [
    ['arw-sony-a7c-1', 'ACH07358.ARW'],
    ['jpeg-sony-a7c-1', 'ACH07358.JPG'],
    ['arw-sony-a7c-portrait', 'ACH07383.ARW'],
    ['cr2-canon-5d3', '5G4A9394.CR2'],
    ['cr3-canon-r6-craw', 'R6_0001.CR3'],
    ['nef-nikon-d750', 'D750_0001.NEF'],
    ['raf-fuji-xt3', 'AFXT2720.RAF'],
    ['dng-adobe-5d3', '5G4A9394-lossless.DNG'],
    ['jpeg-sony-a7c-2', 'ACH07359.JPG'],
  ];
  for (const [id, name] of files) await copyFile(fx(id), path.join(card, name));
  await writeFile(path.join(card, 'ACH07358.xmp'), DEVELOP_XMP);
  const dir = path.join(base, 'project');
  await mkdir(dir);
  const t = makeService();
  const pid = unwrap(await t.service.createProject(dir, 'Lightroom acceptance')).id;
  await t.waitForJob(unwrap(await t.service.addSources(pid, [card])));
  const clean = (unwrap(await t.service.listPairCandidates(pid)) as PairCandidate[]).filter((c) => !c.ambiguous);
  unwrap(await t.service.applyCommand(pid, { type: 'confirm-pairs', pairs: clean.map((c) => ({ rawId: c.rawId, jpegId: c.jpegId })) }));
  const assets = unwrap(await t.service.queryAssets(pid, { offset: 0, limit: 200 })).items;
  const target = { id: newId('t'), label: 'Trao giải', required: true, requiresConsent: false, minCount: 1 };
  unwrap(await t.service.applyCommand(pid, { type: 'upsert-target', target }));
  const expected: string[] = ['| Tệp xuất | Sao kỳ vọng | Từ khóa kỳ vọng | Ghi chú |', '|---|---|---|---|'];
  for (const [i, a] of assets.entries()) {
    const rating = (i % 5) + 1;
    unwrap(await t.service.applyCommand(pid, { type: 'set-rating', assetIds: [a.id], rating }));
    if (i % 2 === 0) unwrap(await t.service.applyCommand(pid, { type: 'assign-target', assetIds: [a.id], targetId: target.id, assigned: true }));
  }
  unwrap(await t.service.applyCommand(pid, { type: 'set-pack-member', packId: 'edit', assetIds: assets.map((a) => a.id), member: true }));
  const out = path.join(workRoot, 'lightroom-acceptance');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const plan = unwrap(await t.service.planExport(pid, 'edit', out, 'copy-originals'))!;
  const jobId = unwrap(await t.service.executeExport(plan.planId));
  await t.waitForJob(jobId);
  const report = unwrap(await t.service.getExportReport(jobId))!;
  expect(report.status).toBe('verified');
  const after = unwrap(await t.service.queryAssets(pid, { offset: 0, limit: 200 })).items;
  for (const a of after) {
    const name = path.posix.basename(a.primary.relativePath);
    const ext = path.extname(name).toLowerCase();
    const proprietary = ['.cr2', '.cr3', '.nef', '.arw', '.raf'].includes(ext);
    const hadSidecar = name === 'ACH07358.ARW';
    const kw = a.decision.targetIds.length ? 'EventStory: Hậu kỳ, Trao giải' : 'EventStory: Hậu kỳ';
    let note = proprietary ? 'XMP mới do EventStory tạo' : 'DNG/JPEG: không có XMP riêng; sao/từ khóa chỉ trong manifest';
    if (hadSidecar) note = 'XMP Develop cũ được giữ nguyên (Exposure +1.00, 3200K); sao/từ khóa KHÔNG áp vào XMP';
    if (a.companion) note += ' · cặp RAW+JPEG';
    const showRating = proprietary && !hadSidecar ? String(a.decision.rating) : '— (không kỳ vọng)';
    const showKw = proprietary && !hadSidecar ? kw : '—';
    expected.push(`| ${name} | ${showRating} | ${showKw} | ${note} |`);
  }
  await writeFile(path.join(out, 'EXPECTED.md'), `# Kỳ vọng khi import vào Lightroom Classic\n\nThư mục: ${report.outputFolderName}\n\n${expected.join('\n')}\n`);
  await t.service.shutdown();
}, 600_000);
