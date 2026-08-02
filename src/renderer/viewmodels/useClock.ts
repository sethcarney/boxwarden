import { useEffect, useState } from 'react';

export const CLOCK_INTERVAL_MS = 1_000;

/**
 * One clock for the whole app, so every relative timestamp on screen advances
 * together off a single timer instead of each card owning one.
 *
 * The value is passed down as a prop rather than read inside the components
 * that display it — the same reason `relativeTime` takes `now`: a component
 * that reads the clock itself cannot be asserted against a fixed value.
 */
export function useClock(intervalMs: number = CLOCK_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
