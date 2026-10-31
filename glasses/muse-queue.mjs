// One in-flight Muse question for G2 and Listen. No network/config/filesystem I/O
// lives here: ask(text,start,{signal:preSendSignal}) and read(actualIndexJobId)
// are supplied by the hub. The signal may stop only work BEFORE POST; the hub
// must not use it to abort a POST that may already have submitted a question.
// ask returns {id,muse}, null ONLY if no POST was attempted, or {uncertain:true}.
// A rejected/malformed admission is also uncertain; it must never unlock Muse.
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { sanitizeMuseReply } from './muse-clean.mjs'

const ACTUAL_ID = /^\d+-\w{1,40}$/
const VIRTUAL_JOB = /^q\w{1,39}$/
const TERMINAL = new Set(['done', 'error', 'timeout'])
const RUNNING = new Set(['sending', 'running', 'queued', 'pending', 'thinking'])
const REASON = Object.freeze({
  invalid: 'Muse request is invalid', full: 'Muse queue is full',
  unavailable: 'No Muse is ready right now', uncertain: 'Muse admission could not be confirmed',
  reconcile: 'Muse is unavailable until the previous question is checked',
  read: 'Muse reply is unavailable', error: 'Muse request failed',
  timeout: 'Muse took too long', cancelled: 'Muse request cancelled',
})
const deferred = () => {
  let complete, settled = false
  const promise = new Promise(resolve => { complete = resolve })
  return { promise, resolve(value) { if (!settled) { settled = true; complete(value) } } }
}
const positive = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
const safely = (fn, value) => { try { fn?.(value) } catch { /* Observers never own the queue. */ } }

/** Handle: {id:Promise<{id,muse}|null>, result:Promise<{status,reply,reason}>, cancel(), status()}.
 * G2 uses id through createMuseBridge; Listen consumes result and onStatus.
 * onStatus receives {state:busy|thinking|idle|unavailable,reason?}. A consumer
 * timeout or active cancellation suppresses delivery, never releases the slot.
 */
export function createMuseQueue({ ask, read, now = () => Date.now(),
  sleep = (ms, { signal } = {}) => delay(ms, undefined, { signal, ref: false }),
  pollMs = 700, timeoutMs = 150_000, maxQueued = 64, onChange } = {}) {
  if (typeof ask !== 'function' || typeof read !== 'function') throw new TypeError('Muse callbacks are required')
  pollMs = positive(pollMs, 700)
  timeoutMs = positive(timeoutMs, 150_000)
  maxQueued = Number.isInteger(maxQueued) && maxQueued > 0 ? maxQueued : 64
  const pending = { g2: [], listen: [] }
  let active = null, scheduled = false

  function snapshot() {
    return { active: active?.source ?? null,
      queued: { g2: pending.g2.length, listen: pending.listen.length },
      blocked: Boolean(active && (active.cancelled || active.finished || active.uncertain)) }
  }
  const changed = () => safely(onChange, snapshot())
  function status(job, state, reason = '') {
    if (job.finished) return
    job.view = { state, ...(reason ? { reason } : {}) }
    if (!job.cancelled && !job.finished) safely(job.onStatus, { ...job.view })
  }
  function complete(job, outcome, reply = '', reason = '') {
    if (job.finished) return
    status(job, outcome === 'done' || outcome === 'cancelled' ? 'idle' : 'unavailable', reason)
    if (job.finished) return
    job.finished = true
    job.preSend.abort()
    job.id.resolve(null)
    job.result.resolve({ status: outcome, reply, reason })
    job.deadlineStop.abort()
    job.signal?.removeEventListener('abort', job.onAbort)
  }
  function quarantine(job) {
    job.uncertain = true
    job.unknownAdmission = true
    complete(job, 'unavailable', '', REASON.uncertain)
    for (const source of ['g2', 'listen']) {
      for (const waiting of pending[source].splice(0)) complete(waiting, 'unavailable', '', REASON.reconcile)
    }
  }
  async function pause(job, ms, controller) {
    try { await sleep(ms, { signal: controller.signal }) } catch { /* Abort is local timer cleanup only. */ }
  }
  async function deadline(job) {
    const end = now() + timeoutMs
    while (active === job && !job.finished && !job.deadlineStop.signal.aborted) {
      const left = end - now()
      if (left <= 0) { complete(job, 'timeout', '', REASON.timeout); changed(); return }
      await pause(job, left, job.deadlineStop)
    }
  }
  function schedule() {
    if (scheduled || active) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (active) return
      const job = pending.g2.shift() ?? pending.listen.shift()
      if (!job) return
      active = job
      job.started = true
      status(job, 'thinking')
      changed()
      void run(job)
    })
  }
  async function run(job) {
    let confirmedFree = false
    try {
      if (job.cancelled || job.finished) { confirmedFree = true; return }
      void deadline(job)
      let receipt
      if (job.cancelled || job.finished) { confirmedFree = true; return }
      try { receipt = await ask(job.text, job.start, { signal: job.preSend.signal }) } catch {
        quarantine(job)
        return
      }
      if (receipt === null) {
        confirmedFree = true
        complete(job, 'unavailable', '', REASON.unavailable)
        return
      }
      if (receipt?.uncertain || !receipt || typeof receipt.id !== 'string' || !ACTUAL_ID.test(receipt.id)
          || typeof receipt.muse !== 'string') {
        quarantine(job)
        return
      }
      job.actual = receipt.id
      if (!job.finished) job.id.resolve({ id: receipt.id, muse: receipt.muse })
      while (active === job) {
        let value
        try { value = await read(job.actual) } catch { /* No raw relay error reaches a consumer. */ }
        if (TERMINAL.has(value?.status)) {
          confirmedFree = true
          if (value.status === 'done' && typeof value.reply === 'string') {
            const bounded = value.reply.slice(0, 64 * 1024)
            complete(job, 'done', sanitizeMuseReply(bounded, { partial: bounded.length < value.reply.length }).text.trim().slice(0, 300))
          } else if (value.status === 'timeout') complete(job, 'timeout', '', REASON.timeout)
          else complete(job, 'error', '', REASON.error)
          return
        }
        job.uncertain = !RUNNING.has(value?.status)
        status(job, job.uncertain ? 'unavailable' : 'thinking', job.uncertain ? REASON.read : '')
        changed()
        await pause(job, pollMs, job.pollStop)
      }
    } catch {
      // An unexpected local callback failure is not evidence that Muse is idle.
      if (!job.actual) quarantine(job)
      else { job.uncertain = true; complete(job, 'unavailable', '', REASON.uncertain) }
    } finally {
      if (confirmedFree && active === job) {
        active = null
        job.pollStop.abort()
        job.deadlineStop.abort()
        schedule()
      }
      changed()
    }
  }
  function enqueue(text, { source = 'listen', start = 0, signal, onStatus } = {}) {
    const job = { text, source, start, signal, onStatus, id: deferred(), result: deferred(),
      view: { state: 'busy' }, cancelled: false, finished: false, started: false, uncertain: false,
      deadlineStop: new AbortController(), pollStop: new AbortController(), preSend: new AbortController() }
    function cancel() {
      if (job.finished) return false
      job.cancelled = true
      job.preSend.abort()
      if (!job.started) {
        const index = pending[source]?.indexOf(job)
        if (index >= 0) pending[source].splice(index, 1)
      }
      complete(job, 'cancelled', '', REASON.cancelled)
      changed()
      schedule()
      return true
    }
    const handle = { id: job.id.promise, result: job.result.promise, cancel, status: () => ({ ...job.view }) }
    job.onAbort = cancel
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000 || !['g2', 'listen'].includes(source)
        || !Number.isInteger(start) || start < 0 || (signal && typeof signal.addEventListener !== 'function')) {
      complete(job, 'error', '', REASON.invalid)
    } else if (signal?.aborted) cancel()
    else if (active?.unknownAdmission) complete(job, 'unavailable', '', REASON.reconcile)
    else if (pending.g2.length + pending.listen.length >= maxQueued) complete(job, 'unavailable', '', REASON.full)
    else {
      signal?.addEventListener('abort', cancel, { once: true })
      pending[source].push(job)
      status(job, 'busy')
      changed()
      schedule()
    }
    return handle
  }
  return { enqueue, snapshot, status(source = 'listen') {
    if (active) return active.source === source && !active.finished ? { ...active.view } : { state: 'busy' }
    return { state: pending.g2.length + pending.listen.length ? 'busy' : 'idle' }
  } }
}

/** Fast legacy G2 admission without changing existing /api/muse route bodies.
 * ask returns a virtual 0-q... receipt synchronously. At actual admission,
 * onAdmitted(virtualId,actualId) installs the hub's existing museMoved alias.
 * lookup intercepts ONLY owned virtual jobs on the exact configured relay0 URL.
 */
export function createMuseBridge(queue, { relayUrl, onAdmitted, now = () => Date.now(),
  idFactory = () => `q${randomBytes(12).toString('hex')}`, maxEntries = 256 } = {}) {
  let base = null
  if (typeof relayUrl === 'string' && relayUrl) {
    try {
      const parsed = new URL(relayUrl)
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
        base = relayUrl.replace(/\/$/, '')
      }
    } catch { /* Optional bad Muse configuration must not stop the existing HUD. */ }
  }
  maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 256
  const entries = new Map()
  function prune(makeSpace = false) {
    for (const [id, entry] of entries) if (entry.finishedAt !== undefined && now() - entry.finishedAt >= 600_000) entries.delete(id)
    if (makeSpace && entries.size >= maxEntries) for (const [id, entry] of entries) {
      if (entry.aliased || entry.result) entries.delete(id)
      if (entries.size < maxEntries) break
    }
  }
  return {
    ask(text, start = 0) {
      if (!base) return null
      prune(true)
      if (entries.size >= maxEntries) return null
      let job
      try { job = idFactory() } catch { return null }
      if (typeof job !== 'string' || !VIRTUAL_JOB.test(job) || entries.has(job)) return null
      const virtualId = `0-${job}`
      const handle = queue.enqueue(text, { source: 'g2', start })
      const entry = { question: typeof text === 'string' ? text.slice(0, 300) : '', handle, aliased: false, result: null }
      entries.set(job, entry)
      void handle.id.then(receipt => {
        if (receipt && receipt.id !== virtualId && typeof onAdmitted === 'function') {
          try { onAdmitted(virtualId, receipt.id); entry.aliased = true } catch { /* Keep a pending receipt if mapping failed. */ }
        }
      })
      void handle.result.then(result => { entry.result = result; entry.finishedAt = now() })
      return { id: virtualId, muse: 'queued' }
    },
    lookup(url) {
      if (!base || typeof url !== 'string' || !url.startsWith(`${base}/reply/`)) return undefined
      const job = url.slice(`${base}/reply/`.length)
      if (!VIRTUAL_JOB.test(job)) return undefined
      prune()
      const entry = entries.get(job)
      if (!entry) return undefined
      const result = entry.result
      return { status: result ? (result.status === 'done' ? 'done' : result.status === 'timeout' ? 'timeout' : 'error') : 'sending',
        question: entry.question, reply: result?.status === 'done' ? result.reply : '',
        error: result && result.status !== 'done' ? result.reason : '' }
    },
  }
}
