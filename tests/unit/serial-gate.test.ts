import { expect, it } from 'vitest';
import { SerialGate } from '../../src/media/serial-gate';

it('shares one work slot across callers and releases it only after settlement (including failures)', async () => {
  const gate = new SerialGate();
  const events: string[] = [];
  let finish!: () => void;
  const first = gate.run(async () => {
    events.push('first');
    await new Promise<void>((r) => { finish = r; });
    events.push('settled');
    throw new Error('decode failed');
  }).catch(() => {});
  const second = gate.run(async () => { events.push('second'); });
  await Promise.resolve();
  expect(events).toEqual(['first']);
  finish();
  await Promise.all([first, second]);
  expect(events).toEqual(['first', 'settled', 'second']);
});
