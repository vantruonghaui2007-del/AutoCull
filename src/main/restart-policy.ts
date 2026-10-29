export const CRASH_WINDOW_MS = 60_000;
export const MAX_CRASHES = 5;
const BASE_DELAY_MS = 500;

/**
 * Delay before restarting a crashed worker, given the times of recent crashes (including the
 * latest). Returns null when it keeps crashing: the build is probably broken and restarting
 * in a loop would only burn CPU while the UI waits.
 */
export function restartDelay(crashTimes: number[], now: number): number | null {
  const recent = crashTimes.filter((t) => now - t <= CRASH_WINDOW_MS);
  if (recent.length >= MAX_CRASHES) return null;
  return BASE_DELAY_MS * 2 ** Math.max(0, recent.length - 1);
}
