import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REASON_TEXT, reasonText } from '../../src/shared/reasons';

const emitted = (file: string) => [...readFileSync(path.join(__dirname, '../../src', file), 'utf8').matchAll(/'([A-Z][A-Z_]{3,})'/g)].map((m) => m[1]!);

describe('reason texts', () => {
  it('every reason code produced by ranking and AutoCull has a Vietnamese explanation', () => {
    const codes = new Set([...emitted('culling/ranking.ts'), ...emitted('worker/autocull.ts')].filter((c) => !['GLOBAL_QUOTA_EXHAUSTED'].includes(c)));
    for (const c of codes) expect(REASON_TEXT[c], c).toBeTruthy();
  });

  it('unknown codes are shown as-is instead of disappearing', () => {
    expect(reasonText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(reasonText('EYES_CLOSED')).toMatch(/nhắm/);
  });
});
