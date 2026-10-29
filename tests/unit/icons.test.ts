import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const build = path.resolve(__dirname, '../../build');

describe('app icons', () => {
  it('ships a 1024 px PNG and a Windows ICO with a 256 px entry', () => {
    const png = readFileSync(path.join(build, 'icon.png'));
    expect(png.readUInt32BE(16)).toBe(1024); // IHDR width
    expect(png.readUInt32BE(20)).toBe(1024);
    const ico = readFileSync(path.join(build, 'icon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const widths = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16) || 256);
    expect(widths).toEqual(expect.arrayContaining([16, 32, 48, 256]));
    expect(existsSync(path.join(build, 'icon-master.png'))).toBe(true);
  });

  it('electron-builder and the window use the icon', () => {
    const yml = readFileSync(path.resolve(__dirname, '../../electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/icon: build\/icon\.ico/);
    expect(readFileSync(path.resolve(__dirname, '../../src/main/window.ts'), 'utf8')).toMatch(/icon:/);
  });
});
