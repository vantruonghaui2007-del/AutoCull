import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPathInside, resolveAllowedPath } from '../../src/main/paths';
import { makeTempDir } from '../helpers/fs';

let base: string;
let root: string;

beforeAll(async () => {
  base = await makeTempDir('paths');
  root = path.join(base, 'source');
  await mkdir(path.join(root, 'Thẻ nhớ 01'), { recursive: true });
  await writeFile(path.join(root, 'Thẻ nhớ 01', 'ảnh cưới #1 (copy).ARW'), 'x');
  await mkdir(path.join(base, 'source-other'), { recursive: true });
  await writeFile(path.join(base, 'source-other', 'secret.txt'), 'y');
  await mkdir(path.join(base, 'outside'), { recursive: true });
  await writeFile(path.join(base, 'outside', 'target.txt'), 'z');
  await symlink(path.join(base, 'outside'), path.join(root, 'junction-out'), 'junction');
});

describe('resolveAllowedPath', () => {
  it('accepts a file inside the root, including Vietnamese and special characters', async () => {
    const candidate = path.join(root, 'Thẻ nhớ 01', 'ảnh cưới #1 (copy).ARW');
    const result = await resolveAllowedPath(root, candidate);
    expect(result.ok).toBe(true);
  });

  it('rejects a sibling directory that shares the root as a string prefix', async () => {
    const siblingWithSamePrefix = path.join(base, 'source-other', 'secret.txt');
    expect(await resolveAllowedPath(root, siblingWithSamePrefix)).toMatchObject({ ok: false });
  });

  it('rejects a junction that leads out of the root', async () => {
    const junctionOutOfRoot = path.join(root, 'junction-out', 'target.txt');
    expect(await resolveAllowedPath(root, junctionOutOfRoot)).toMatchObject({ ok: false });
  });

  it('rejects dot-dot traversal', async () => {
    const traversal = `${root}${path.sep}..${path.sep}outside${path.sep}target.txt`;
    expect(await resolveAllowedPath(root, traversal)).toMatchObject({ ok: false });
  });

  it('allows a not-yet-existing path whose existing ancestor is inside the root', async () => {
    const result = await resolveAllowedPath(root, path.join(root, 'new-folder', 'file.jpg'));
    expect(result.ok).toBe(true);
  });
});

describe('isPathInside', () => {
  it('compares by segment, not by string prefix', () => {
    expect(isPathInside('C:\\data\\src', 'C:\\data\\src-2\\a', 'win32')).toBe(false);
    expect(isPathInside('C:\\data\\src', 'C:\\data\\src\\a', 'win32')).toBe(true);
  });

  it('folds case on Windows and macOS but not on Linux', () => {
    expect(isPathInside('C:\\Data\\SRC', 'c:\\data\\src\\x', 'win32')).toBe(true);
    expect(isPathInside('/Users/a/SRC', '/Users/a/src/x', 'darwin')).toBe(true);
    expect(isPathInside('/home/a/SRC', '/home/a/src/x', 'linux')).toBe(false);
  });

  it('treats NFC and NFD spellings of Vietnamese names as the same folder', () => {
    const nfc = '/Users/a/Ảnh'.normalize('NFC');
    const nfd = '/Users/a/Ảnh/x'.normalize('NFD');
    expect(isPathInside(nfc, nfd, 'darwin')).toBe(true);
  });

  it('counts the root itself as inside', () => {
    expect(isPathInside('/a/b', '/a/b', 'linux')).toBe(true);
  });
});
