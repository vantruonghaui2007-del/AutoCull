#!/usr/bin/env node
// Lists the production packages bundled into the Lambda (backend/THIRD_PARTY.md).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 1 << 26 }));
const seen = new Map();
const walk = (deps) => {
  for (const [name, d] of Object.entries(deps ?? {})) {
    if (d.path && !seen.has(`${name}@${d.version}`)) {
      let license = d.license;
      try {
        license = JSON.parse(readFileSync(path.join(d.path, 'package.json'), 'utf8')).license ?? license;
      } catch {
        /* keep npm's value */
      }
      seen.set(`${name}@${d.version}`, { name, version: d.version, license });
    }
    walk(d.dependencies);
  }
};
walk(tree.dependencies);
const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const counts = {};
for (const r of rows) counts[r.license] = (counts[r.license] ?? 0) + 1;
const md = `# Backend (Lambda) — third-party packages

Generated ${new Date().toISOString().slice(0, 10)} by \`node scripts/third-party.mjs\` from \`npm ls --omit=dev\` in \`backend/\`.
These packages are bundled by esbuild into the Lambda that you deploy to **your own** AWS account; they are not shipped
inside the desktop app. Licenses: ${Object.entries(counts).map(([l, n]) => `${l} ×${n}`).join(', ')}.

| Package | Version | License |
|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} |`).join('\n')}

AWS SDK for JavaScript v3 — Copyright Amazon.com, Inc. or its affiliates — Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0; the LICENSE file is in each package under \`node_modules/@aws-sdk/*\`).
`;
writeFileSync(path.join(root, 'THIRD_PARTY.md'), md);
console.log(counts);
