import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { applyOrientation } from '../../src/media/previews';

// An asymmetric 3x2 test image so every mirror/rotation is distinguishable.
const W = 3;
const H = 2;
const pixels = Buffer.from([10, 40, 70, 100, 130, 160]);

async function viaExplicit(o: number) {
  return applyOrientation(sharp(pixels, { raw: { width: W, height: H, channels: 1 } }), o)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function viaSharpAutoRotate(o: number) {
  const tagged = await sharp(pixels, { raw: { width: W, height: H, channels: 1 } })
    .png()
    .withMetadata({ orientation: o })
    .toBuffer();
  return sharp(tagged).rotate().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
}

describe('applyOrientation', () => {
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`matches Sharp's EXIF auto-rotation for orientation ${o}`, async () => {
      const a = await viaExplicit(o);
      const b = await viaSharpAutoRotate(o);
      expect([a.info.width, a.info.height]).toEqual([b.info.width, b.info.height]);
      expect([...a.data]).toEqual([...b.data]);
    });
  }
});
