/** Polls a Muse job until it finishes. Free of the network and timers' real clocks so it can be tested. */
export interface MuseJob { status: string; question: string; reply: string; error?: string }
export const MUSE_POLLS = 215; // 0.7 s apart = about 2.5 minutes
export const MUSE_DONE = ['done', 'error', 'timeout'];

/** Calls `onJob` for every answer it gets; returns whether Muse finished (false: every poll failed or it never finished: the caller must say so). */
export async function pollMuseJob(
  fetchJob: () => Promise<MuseJob | null>,
  wait: () => Promise<void>,
  onJob: (job: MuseJob, finished: boolean) => void,
  polls = MUSE_POLLS,
): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    await wait();
    const job = await fetchJob();
    if (!job) continue;
    const finished = MUSE_DONE.includes(job.status);
    onJob(job, finished);
    if (finished) return true;
  }
  return false;
}
