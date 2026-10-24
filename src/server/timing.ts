/** Opaque correlation and monotonic durations only. Never include arguments, screens or transcripts. */
export type TimingContext = { owner: string; revision: number; operation?: string };
export function timing(context: TimingContext, phase: string, started = performance.now()) {
  console.log('Phone timing:', JSON.stringify({ ...context, phase, durationMs: Math.round((performance.now() - started) * 10) / 10 }));
}
export async function measure<T>(context: TimingContext, phase: string, work: () => T): Promise<Awaited<T>> {
  const started = performance.now();
  try { return await work(); } finally { timing(context, phase, started); }
}
