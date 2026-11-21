/** Local calendar day as YYYY-MM-DD. */
export const dayKey = (d: Date) => d.toLocaleDateString("sv");

/** 75 -> "1:15", 3675 -> "1:01:15". */
export function clock(seconds: number) {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * A day counts once its logged seconds reach the goal. `current` is the run
 * ending today, or yesterday if today's goal isn't met yet; `record` is the longest run.
 */
export function streaks(
  log: Record<string, number>,
  goalSeconds: number,
  today = new Date(),
) {
  const met = (d: Date) => (log[dayKey(d)] ?? 0) >= goalSeconds;

  const day = new Date(today);
  if (!met(day)) day.setDate(day.getDate() - 1);
  let current = 0;
  while (met(day)) {
    current++;
    day.setDate(day.getDate() - 1);
  }

  let record = 0;
  let run = 0;
  let last = "";
  for (const key of Object.keys(log).sort()) {
    if (log[key] < goalSeconds) continue;
    const before = new Date(`${key}T12:00`);
    before.setDate(before.getDate() - 1);
    run = dayKey(before) === last ? run + 1 : 1;
    last = key;
    record = Math.max(record, run);
  }
  return { current, record };
}

/** Adds the seconds between two timestamps to the log, split at local midnights. */
export function addSession(log: Record<string, number>, start: number, end: number) {
  const out = { ...log };
  for (let t = start; t < end; ) {
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const stop = Math.min(end, midnight);
    out[dayKey(d)] = (out[dayKey(d)] ?? 0) + (stop - t) / 1000;
    t = stop;
  }
  return out;
}
