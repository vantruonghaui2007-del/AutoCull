import { copyFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fingerprint, SAMPLE_BYTES } from '../../src/source/fingerprint';
import { makeTempDir } from '../helpers/fs';

let dir: string;
const big = Buffer.alloc(SAMPLE_BYTES * 4, 7);
beforeAll(async () => {
  dir = await makeTempDir('fingerprint');
  for (let i = 0; i < big.length; i += 997) big[i] = i % 251;
});

describe('fingerprint', () => {
  it('does not change when only the modification time changes', async () => {
    const a = path.join(dir, 'a.ARW');
    await writeFile(a, big);
    const hashBeforeCopy = await fingerprint(a);
    await utimes(a, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const hashAfterMtimeOnlyChange = await fingerprint(a);
    expect(hashBeforeCopy.sampledHash).toBe(hashAfterMtimeOnlyChange.sampledHash);
    expect(hashBeforeCopy.bytes).toBe(big.length);
  });

  it('is equal for byte-identical copies under another name', async () => {
    const a = path.join(dir, 'b1.ARW');
    const b = path.join(dir, 'b2.ARW');
    await writeFile(a, big);
    await copyFile(a, b);
    expect((await fingerprint(a)).sampledHash).toBe((await fingerprint(b)).sampledHash);
  });

  it('changes when the head, tail or size changes', async () => {
    const base = await fingerprint(path.join(dir, 'b1.ARW'));
    const head = Buffer.from(big);
    head[10] = head[10]! ^ 0xff;
    const tail = Buffer.from(big);
    tail[tail.length - 10] = tail[tail.length - 10]! ^ 0xff;
    await writeFile(path.join(dir, 'head.ARW'), head);
    await writeFile(path.join(dir, 'tail.ARW'), tail);
    await writeFile(path.join(dir, 'size.ARW'), Buffer.concat([big, Buffer.from([1])]));
    for (const f of ['head.ARW', 'tail.ARW', 'size.ARW']) {
      expect((await fingerprint(path.join(dir, f))).sampledHash, f).not.toBe(base.sampledHash);
    }
  });

  it('is a sample, not an integrity hash: a change in the middle of a large file is not seen', async () => {
    const mid = Buffer.from(big);
    const m = Math.floor(mid.length / 2);
    mid[m] = mid[m]! ^ 0xff;
    await writeFile(path.join(dir, 'mid.ARW'), mid);
    const base = await fingerprint(path.join(dir, 'b1.ARW'));
    expect((await fingerprint(path.join(dir, 'mid.ARW'))).sampledHash).toBe(base.sampledHash);
  });

  it('hashes small files over their whole content', async () => {
    const small = Buffer.alloc(1000, 3);
    const changed = Buffer.from(small);
    changed[500] = 9;
    await writeFile(path.join(dir, 's1.jpg'), small);
    await writeFile(path.join(dir, 's2.jpg'), changed);
    expect((await fingerprint(path.join(dir, 's1.jpg'))).sampledHash).not.toBe(
      (await fingerprint(path.join(dir, 's2.jpg'))).sampledHash,
    );
  });
});
