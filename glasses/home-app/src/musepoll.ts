/** Polls a Muse job until it finishes. Free of the network and timers' real clocks so it can be tested. */
export interface MuseJob { status: string; question: string; reply: string; error?: string }
export const MUSE_POLLS = 215; // 0.7 s apart
export const MUSE_DEADLINE_MS = 150_000; // 2.5 minutes from the ask, however long each read took
export const MUSE_DONE = ['done', 'error', 'timeout'];

/** Calls `onJob` for every answer it gets; returns whether Muse finished (false: every poll failed or it never finished: the caller must say so). */
export async function pollMuseJob(
  fetchJob: () => Promise<MuseJob | null>,
  wait: () => Promise<void>,
  onJob: (job: MuseJob, finished: boolean) => void,
  polls = MUSE_POLLS,
  deadline?: { at: number; now: () => number },
): Promise<boolean> {
  const late = () => deadline !== undefined && deadline.now() >= deadline.at;
  for (let i = 0; i < polls && !late(); i++) {
    await wait();
    const job = await fetchJob();
    if (late() && !(job && MUSE_DONE.includes(job.status))) return false; // each read can take seconds: the wall clock decides, not the count
    if (!job) continue;
    const finished = MUSE_DONE.includes(job.status);
    onJob(job, finished);
    if (finished) return true;
  }
  return false;
}
