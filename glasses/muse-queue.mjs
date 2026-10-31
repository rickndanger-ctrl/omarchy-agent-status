// Listen-only, best-effort Muse adapter. Observed G2 requests pause future
// snippets; posted jobs expose a bounded hold so the relay can queue G2 FIFO.
import { sanitizeMuseReply } from './muse-clean.mjs'

const RUNNING = new Set(['queued', 'sending', 'waiting', 'running', 'pending', 'thinking'])
const REASONS = Object.freeze({
  busy: 'Muse is busy', unavailable: 'No Muse is ready right now',
  cancelled: 'Muse request cancelled', timeout: 'Muse took too long',
  error: 'Muse request failed', invalid: 'Muse request is invalid',
})
class Failure extends Error {
  constructor(status, reason = REASONS[status]) { super(reason); this.status = status }
}
const positive = (value, fallback, cap) => typeof value === 'number' && Number.isFinite(value) && value > 0
  ? Math.min(value, cap) : fallback
const observe = (fn, value) => { try { fn?.(value) } catch { /* Observers do not own admission. */ } }
function relay(value) {
  try {
    const url = new URL(value?.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { url: url.href.replace(/\/$/, ''), token: typeof value.token === 'string' ? value.token : '' }
  } catch { return null }
}

/**
 * ask({text,signal,onStatus}) -> Promise<{status,reply,reason}>.
 * noteG2(method,path) records only known hub-observed G2 routes. holds(index)
 * identifies only this adapter's POSTed, unfinished target before its deadline.
 * status: done|busy|unavailable|cancelled|timeout|error. There is no queue,
 * retry, fallback, G2 mutation, or persistent uncertain-admission quarantine.
 * request(url,token,{method,body,signal,timeout}) may supply parsed JSON for
 * fixtures; otherwise bounded streaming fetch is used independently of G2.
 * timeoutMs is the HUD config alias for the whole-attempt attemptMs limit.
 */
export function createListenMuse({ muses = [], isG2Busy = () => true, request,
  fetch: fetchImpl = globalThis.fetch, pollMs = 700, requestMs = 6000,
  attemptMs, timeoutMs, g2PauseMs = 60_000, maxBodyBytes = 65536, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const relays = Array.isArray(muses) ? muses.map(relay) : []
  pollMs = positive(pollMs, 700, 6000)
  requestMs = positive(requestMs, 6000, 30_000)
  attemptMs = positive(attemptMs, positive(timeoutMs, 150_000, 150_000), 150_000)
  maxBodyBytes = Math.floor(positive(maxBodyBytes, 65536, 65536))
  g2PauseMs = typeof g2PauseMs === 'number' && Number.isFinite(g2PauseMs) && g2PauseMs > 0 ? g2PauseMs : 60_000
  let inFlight = false
  let lastG2At = -Infinity
  let held = null

  function noteG2(method, path) {
    if (typeof method !== 'string' || typeof path !== 'string') return false
    const route = path.split('?', 1)[0]
    const observed = method === 'POST' && (route === '/api/muse/ask' || route === '/api/transcribe')
      || method === 'GET' && (route === '/api/muse/reply' || route === '/api/muse')
    if (!observed) return false
    const at = now()
    // A backward clock cannot shorten an already observed cooldown.
    if (Number.isFinite(at)) lastG2At = Math.max(lastG2At, at)
    return true
  }
  function holds(index) {
    if (!held) return false
    const at = now()
    if (held.signal.aborted || !Number.isFinite(at) || at >= held.end) { held = null; return false }
    return Number.isInteger(index) && held.index === index && held.posted === true
  }

  // Explicit timer races also bound transports that ignore AbortSignal.
  function bounded(operation, ms, parent) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let settled = false, timer
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimer(timer)
        parent.removeEventListener('abort', aborted)
        controller.abort()
        if (error) reject(error)
        else resolve(value)
      }
      const aborted = () => finish(parent.reason instanceof Failure ? parent.reason : new Failure('cancelled'))
      if (parent.aborted) { aborted(); return }
      parent.addEventListener('abort', aborted, { once: true })
      timer = setTimer(() => finish(new Failure('timeout')), ms)
      // The handlers consume late results/rejections after deadline or cancel.
      try { Promise.resolve(operation(controller.signal)).then(value => finish(null, value), error => finish(error)) }
      catch (error) { finish(error) }
    })
  }

  async function fetchJson(url, token, init) {
    if (typeof fetchImpl !== 'function') throw new Failure('unavailable')
    const response = await fetchImpl(url, { ...init, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
    const discard = () => { try { void response?.body?.cancel().catch(() => {}) } catch { /* Already closed. */ } }
    if (response?.ok !== true || response.redirected) { discard(); throw new Failure('unavailable') }
    const length = Number(response.headers?.get('content-length'))
    if (length > maxBodyBytes) { discard(); throw new Failure('unavailable') }
    const reader = response.body?.getReader()
    if (!reader) throw new Failure('unavailable')
    const chunks = []
    let size = 0, complete = false
    const cancel = () => { try { void reader.cancel().catch(() => {}) } catch { /* Stream may already be closed. */ } }
    init.signal.addEventListener('abort', cancel, { once: true })
    try {
      if (init.signal.aborted) throw new Failure('cancelled')
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > maxBodyBytes) throw new Failure('unavailable')
        chunks.push(value)
      }
      complete = true
      const bytes = new Uint8Array(size)
      let at = 0
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
      return JSON.parse(new TextDecoder().decode(bytes))
    } finally {
      init.signal.removeEventListener('abort', cancel)
      if (!complete) cancel()
      try { reader.releaseLock() } catch { /* Aborted pending read may still own its lock. */ }
    }
  }
  const transport = typeof request === 'function' ? request : fetchJson

  async function ask({ text, signal, onStatus } = {}) {
    let attempt = null
    const outcome = (status, reply = '', reason = status === 'done' ? '' : REASONS[status]) => {
      // Clear before notifying observers, without disturbing a concurrent ask's
      // hold when this call merely returns busy before creating its own attempt.
      if (attempt && held === attempt) held = null
      observe(onStatus, { state: status === 'done' || status === 'cancelled' ? 'idle' : status === 'busy' ? 'busy' : 'unavailable', ...(reason ? { reason } : {}) })
      return { status, reply, reason }
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000
        || (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
      return outcome('error', '', REASONS.invalid)
    }
    if (signal?.aborted) return outcome('cancelled')
    if (inFlight) return outcome('busy')
    if (!relays.length || !relays.at(-1)) return outcome('unavailable')
    inFlight = true
    const controller = new AbortController(), end = now() + attemptMs
    attempt = { index: relays.length - 1, end, posted: false, signal: controller.signal }
    const aborted = () => controller.abort(new Failure('cancelled'))
    signal?.addEventListener('abort', aborted, { once: true })
    const deadline = setTimer(() => controller.abort(new Failure('timeout')), attemptMs)
    function check() {
      if (controller.signal.aborted) throw controller.signal.reason
      if (now() >= end) throw new Failure('timeout')
    }
    function gate() {
      check()
      if (now() - lastG2At < g2PauseMs) throw new Failure('busy')
      let busy = true
      try { busy = isG2Busy() !== false } catch { /* Unknown gate is a veto. */ }
      if (busy) throw new Failure('busy')
    }
    async function call(muse, path, method = 'GET', body) {
      check()
      const timeout = Math.min(requestMs, end - now())
      const value = await bounded(s => {
        if (method === 'POST' && path === '/ask') {
          attempt.posted = true; held = attempt
        }
        return transport(`${muse.url}${path}`, muse.token,
          { method, ...(body === undefined ? {} : { body }), signal: s, timeout })
      }, timeout, controller.signal)
      check()
      return value
    }
    async function health(muse) {
      gate()
      const value = await call(muse, '/selftest')
      gate()
      if (value?.busy === true || value?.composer === false) throw new Failure('busy')
      if (value?.ok !== true || value?.composer !== true || value?.busy !== false) throw new Failure('unavailable')
    }
    async function pause(ms) {
      check()
      await new Promise((resolve, reject) => {
        const done = () => { clearTimer(timer); controller.signal.removeEventListener('abort', cancel); resolve() }
        const cancel = () => { clearTimer(timer); controller.signal.removeEventListener('abort', cancel); reject(controller.signal.reason) }
        const timer = setTimer(done, Math.min(ms, end - now()))
        controller.signal.addEventListener('abort', cancel, { once: true })
        if (controller.signal.aborted) cancel()
      })
      check()
    }
    try {
      gate()
      observe(onStatus, { state: 'thinking' })
      gate() // An observer may cancel synchronously before any request.
      const target = relays.at(-1)
      // G2 can queue behind our bounded target hold. An unrelated down/busy
      // primary relay must not veto a ready Listen target.
      await health(target)
      await health(target)
      gate()
      // Exactly one attempt. A timeout/malformed receipt may have submitted;
      // drop this snippet and never retry it on this or another relay.
      const receipt = await call(target, '/ask', 'POST', JSON.stringify({ text }))
      // A relay may return an already terminal job directly from POST. Never
      // retain a hold or issue a later poll after that terminal evidence.
      function terminal(value) {
        if (value?.status === 'done') {
          if (held === attempt) held = null
          if (typeof value.reply !== 'string') throw new Failure('unavailable')
          const reply = sanitizeMuseReply(value.reply.slice(0, 65536)).text.trim().slice(0, 300)
          return outcome('done', reply)
        }
        if (value?.status === 'error' || value?.status === 'timeout') {
          if (held === attempt) held = null
          throw new Failure(value.status)
        }
        return null
      }
      const completed = terminal(receipt)
      if (completed) return completed
      if (typeof receipt?.id !== 'string' || !/^\w{1,40}$/.test(receipt.id)) throw new Failure('unavailable')
      for (;;) {
        const value = await call(target, `/reply/${receipt.id}`)
        const completed = terminal(value)
        if (completed) return completed
        if (!RUNNING.has(value?.status)) throw new Failure('unavailable')
        await pause(pollMs)
      }
    } catch (error) {
      return outcome(error instanceof Failure ? error.status : 'unavailable')
    } finally {
      if (held === attempt) held = null
      clearTimer(deadline)
      signal?.removeEventListener('abort', aborted)
      controller.abort()
      inFlight = false
    }
  }
  return { ask, noteG2, holds }
}
