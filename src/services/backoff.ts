/**
 * Delay before retry number `attempt` (1-based) after a refused Edge handshake:
 * exponential and jittered (≈0.25, 0.5, 1, 2, 3 s). A lone refusal clears at once, but
 * the refusal rate climbs with this IP's recent volume — after a burst it can refuse
 * several in a row, and hammering only prolongs that.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(3_000, 250 * 2 ** (attempt - 1)) + Math.random() * 200;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
