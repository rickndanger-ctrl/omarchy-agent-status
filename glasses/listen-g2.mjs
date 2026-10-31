// Listen-only best-effort G2 evidence. Frozen G2 routes/diagnostics are not changed.
// Each assertion owns a timestamp; rereading the same log cannot renew its lease.
export const G2_DIAGNOSTIC_TTL_MS = 150_000
export const G2_ACTIVITY_PAUSE_MS = 60_000
const voiceScreen = /\b(?:muse|confirm|listen)\b/i
const frameScreen = /^(?:muse|confirm|listen)(?:\s|$)/i
const terminal = /^(?:done|error|timeout)(?:\s|$)|^gave up:/i

export function isListenG2Busy(events, now, moving = false) {
  // museMoving reflects the hub's real G2 handoff, not a diagnostic assertion.
  if (moving === true) return true
  if (!Number.isFinite(now) || !Array.isArray(events)) return false
  const rows = events.slice(-1000).map((event, index) => {
    const at = typeof event?.at === 'number' ? event.at : Date.parse(event?.at)
    return { at, index, name: event?.name, detail: String(event?.detail ?? '').slice(0, 160) }
  }).filter(row => Number.isFinite(row.at) && row.at <= now)
    .sort((a, b) => a.at - b.at || a.index - b.index)
  let micUntil = -Infinity, screenUntil = -Infinity, activityUntil = -Infinity
  const asks = []
  for (const { at, name, detail } of rows) {
    const until = at + G2_DIAGNOSTIC_TTL_MS
    const activity = () => { activityUntil = Math.max(activityUntil, at + G2_ACTIVITY_PAUSE_MS) }
    if (name === 'muse.ask') {
      activity()
      if (detail.trim() === 'queued') asks.push(until)
    } else if (name === 'muse.reply' && terminal.test(detail)) {
      activity()
      asks.shift()
    } else if (name === 'mic.start') {
      activity()
      micUntil = /^(?:false|0|failed|error)(?:\s|$)/i.test(detail.trim()) ? -Infinity : until
    } else if (name === 'mic.first-audio') {
      activity()
      micUntil = until
    } else if (name === 'mic.stop' || name === 'mic.cancel') {
      activity()
      micUntil = -Infinity
    } else if (name === 'frame') {
      // G2 emits `${model.screenKind} ${frameKind}`. A later ordinary screen
      // supersedes the prior Muse/confirm assertion without answering anything.
      if (frameScreen.test(detail.trim())) { activity(); screenUntil = until }
      else if (/^(?:home|agents|messages|chat|terminal|reminders|settings|desk|tiles)(?:\s|$)/i.test(detail.trim())) { if (at < screenUntil) activity(); screenUntil = -Infinity }
    } else if (name === 'display') {
      if (/^off(?:\s|$)/i.test(detail.trim())) { if (at < screenUntil) activity(); screenUntil = -Infinity }
      else if (voiceScreen.test(detail)) { activity(); screenUntil = until }
    } else if (name === 'menu') {
      // Frozen glasses/home-app/src/menu.ts: MENU.muse is 7. Other menu IDs
      // navigate away; mic and queued-question leases remain independent.
      if (detail.trim() === '7' || voiceScreen.test(detail)) { activity(); screenUntil = until }
      else if (/^\d+$/.test(detail.trim())) { if (at < screenUntil) activity(); screenUntil = -Infinity }
    } else if (name === 'prompt' && voiceScreen.test(detail)) {
      activity()
      screenUntil = until
    } else if (name === 'muse.shown') {
      if (/not on screen/i.test(detail)) { if (at < screenUntil) activity(); screenUntil = -Infinity }
      else { activity(); screenUntil = until }
    } else if (name === 'close' || name === 'lifecycle' && /(?:background|foreground-exit|system-exit|abnormal-exit)/i.test(detail)) {
      if (at < screenUntil) activity()
      screenUntil = -Infinity
    }
  }
  return now < activityUntil || now < micUntil || now < screenUntil || asks.some(until => now < until)
}
