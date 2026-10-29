import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const SAMPLE_BYTES = 64 * 1024;

/**
 * Sampled content fingerprint: SHA-256 over the size, the first 64 KiB and the last 64 KiB.
 * Files up to 128 KiB are hashed over their whole content once. This identifies files for
 * relinking and change detection; it is NOT an integrity checksum (exports use full SHA-256).
 * The file is opened read-only.
 */
export async function fingerprint(filePath: string): Promise<{ bytes: number; sampledHash: string }> {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const hash = createHash('sha256');
    hash.update(`fp1:${size}:`);
    if (size <= SAMPLE_BYTES * 2) {
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await fh.read(buf, off, size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      hash.update(buf.subarray(0, off));
    } else {
      const head = Buffer.alloc(SAMPLE_BYTES);
      const tail = Buffer.alloc(SAMPLE_BYTES);
      await fh.read(head, 0, SAMPLE_BYTES, 0);
      await fh.read(tail, 0, SAMPLE_BYTES, size - SAMPLE_BYTES);
      hash.update(head);
      hash.update(tail);
    }
    return { bytes: size, sampledHash: hash.digest('hex') };
  } finally {
    await fh.close();
  }
}
