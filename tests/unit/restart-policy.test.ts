import { describe, expect, it } from 'vitest';
import { MAX_CRASHES, restartDelay } from '../../src/main/restart-policy';

describe('worker restart policy', () => {
  it('backs off exponentially after repeated crashes', () => {
    const now = 100_000;
    expect(restartDelay([now], now)).toBe(500);
    expect(restartDelay([now - 2000, now], now)).toBe(1000);
    expect(restartDelay([now - 3000, now - 2000, now], now)).toBe(2000);
  });

  it('gives up after too many crashes within a minute', () => {
    const now = 100_000;
    const crashes = Array.from({ length: MAX_CRASHES }, (_, i) => now - i * 1000);
    expect(restartDelay(crashes, now)).toBeNull();
  });

  it('forgets crashes older than a minute', () => {
    const now = 1_000_000;
    const old = Array.from({ length: 10 }, (_, i) => now - 120_000 - i);
    expect(restartDelay([...old, now], now)).toBe(500);
  });
});
