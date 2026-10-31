// Opt-in, in-memory Listen sessions. Providers, the Listen Muse service, time and
// timers are injected: this module never opens a relay or stores audio on disk.
import { randomBytes } from 'node:crypto'
import { sanitizeMuseReply, NO_TEXT } from './muse-clean.mjs'

export const LISTEN_MAX_BYTES = 1024 * 1024
const response = (status, body) => ({ status, body })
const fail = (status, reason) => response(status, { error: reason })
const cloneResult = result => response(result.status, { ...result.body,
  ...(result.body.lines ? { lines: result.body.lines.map(line => ({ ...line })) } : {}) })
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
const count = (value, fallback) => Math.max(1, Math.floor(positive(value, fallback)))
const words = text => text ? text.split(/\s+/).length : 0
const cleanText = (value, limit) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit).trim()
  : ''
const stamp = t => {
  const seconds = Math.floor(t / 1000), h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds / 60) % 60, s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * ask({text, sessionId, signal, onStatus}) is the Listen-only Muse service
 * callback. Only its terminal {status:'done', reply} can create a note.
 * notesFrom defaults (including invalid values) to page: no automatic asks.
 * snapshot() reads the current session; addNote(id,{text,at_t?}) admits a
 * sanitized page note in page/both mode. at_t is session milliseconds.
 * All public methods return {status,body}; chunk waits for ASR, never for Muse.
 */
export function createListen({
  transcribe, ask, notesFrom = 'page', diag = () => {}, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
  idFactory = () => randomBytes(12).toString('hex'),
  snippetMs = 45_000, minWords = 25, idleMs = 30 * 60_000, gapMs = 8000,
  maxPendingChunks = 32, maxPendingBytes = 4 * LISTEN_MAX_BYTES, maxSeqAhead = 128,
  maxLines = 2000, maxNotes = 200, maxLineChars = 4000,
  maxSnippetWords = 400, maxSnippetChars = 6000,
} = {}) {
  if (!['page', 'chat', 'both'].includes(notesFrom)) notesFrom = 'page'
  const automaticNotes = notesFrom !== 'page'
  if (typeof transcribe !== 'function' || (automaticNotes && typeof ask !== 'function')) throw new TypeError('Listen callbacks required')
  snippetMs = positive(snippetMs, 45_000)
  idleMs = positive(idleMs, 30 * 60_000)
  gapMs = positive(gapMs, 8000)
  minWords = count(minWords, 25)
  maxPendingChunks = count(maxPendingChunks, 32)
  maxPendingBytes = count(maxPendingBytes, 4 * LISTEN_MAX_BYTES)
  maxSeqAhead = count(maxSeqAhead, 128)
  maxLines = count(maxLines, 2000)
  maxNotes = count(maxNotes, 200)
  maxLineChars = count(maxLineChars, 4000)
  maxSnippetWords = Math.max(minWords, count(maxSnippetWords, 400))
  // Two context snippets plus the new snippet and labels stay below the shared
  // broker's 16,000-character limit, including oversized caller overrides.
  maxSnippetChars = Math.min(5000, count(maxSnippetChars, 5000))
  let current

  const diagnostic = name => { try { diag(name) } catch {} }
  const elapsed = session => {
    const value = now() - session.startedAt
    if (Number.isFinite(value)) session.clockT = Math.max(session.clockT, value, 0)
    return session.clockT
  }
  const timer = (fn, delay) => {
    const handle = setTimer(fn, Math.max(0, delay))
    handle?.unref?.()
    return handle
  }
  const cancelTimer = (session, key) => {
    if (session[key] !== undefined) clearTimer(session[key])
    session[key] = undefined
  }
  const settle = (entry, result) => {
    if (!entry.settled) { entry.settled = true; entry.resolve(result) }
  }
  const stopSession = session => {
    if (session.state === 'stopped') return
    elapsed(session)
    session.state = 'stopped'
    session.controller.abort()
    session.muse = { state: 'idle' }
    for (const key of ['idleTimer', 'gapTimer', 'snippetTimer']) cancelTimer(session, key)
    for (const entry of session.pending.values()) settle(entry, fail(410, 'Listen session stopped'))
    if (session.processing) settle(session.processing, fail(410, 'Listen session stopped'))
    session.pending.clear()
    session.pendingBytes = 0
    session.pendingCount = 0
    session.snippetParts = []
    session.context = []
    diagnostic('listen.stopped')
  }
  const active = session => {
    if (session !== current || session.state !== 'listening') return false
    if (elapsed(session) - session.lastSpeechAt >= idleMs) { stopSession(session); return false }
    return true
  }
  const armIdle = session => {
    cancelTimer(session, 'idleTimer')
    if (!active(session)) return
    session.idleTimer = timer(() => {
      session.idleTimer = undefined
      if (active(session)) armIdle(session)
    }, idleMs - (elapsed(session) - session.lastSpeechAt))
  }
  const known = id => typeof id === 'string' && current?.id === id ? current : undefined
  const boundedSnippet = session => {
    // Keep recent speech under both caps, even during a long broker wait.
    let text = session.snippetParts.map(part => part.text).join(' ')
    while (session.snippetParts.length > 1 && (words(text) > maxSnippetWords || text.length > maxSnippetChars)) {
      session.snippetParts.shift()
      text = session.snippetParts.map(part => part.text).join(' ')
    }
    if (session.snippetParts.length) {
      text = text.split(/\s+/).slice(-maxSnippetWords).join(' ').slice(-maxSnippetChars).trim()
      if (session.snippetParts.length === 1) session.snippetParts[0].text = text
    }
    return text
  }
  const museStatus = (session, value) => {
    if (!active(session)) return
    const state = typeof value === 'string' ? value : value?.state ?? value?.status
    if (['busy', 'queued'].includes(state)) session.muse = { state: 'busy', reason: 'Waiting for Muse' }
    else if (['thinking', 'running', 'sending'].includes(state)) session.muse = { state: 'thinking' }
    else if (['unavailable', 'error', 'timeout'].includes(state)) session.muse = { state: 'unavailable', reason: 'Muse unavailable' }
    else if (['idle', 'cancelled'].includes(state)) session.muse = { state: 'idle' }
  }
  const noteText = (reply, wordLimit = 25) => {
    if (typeof reply !== 'string') return ''
    // Bound even a malformed broker result before the shared sanitizer sees it.
    const cleaned = sanitizeMuseReply(reply.slice(0, 64 * 1024))
    let text = cleanText(cleaned.text, 64 * 1024)
    if (text === NO_TEXT || (cleaned.trimmed && /^(Status|Muse|Connected|Received)$/i.test(text))) return ''
    if (/^[—–-]+$/.test(text)) return ''
    text = text.split(/\s+/).slice(0, wordLimit).join(' ').slice(0, 300).trim()
    return text
  }
  const appendNote = (session, text, at_t) => {
    const t = Math.max(Math.floor(elapsed(session)), session.lastNoteT + 1)
    session.lastNoteT = t
    session.clockT = Math.max(session.clockT, t)
    const note = { t, at_t, text }
    session.notes.push(note)
    if (session.notes.length > maxNotes) session.notes.shift()
    return { ...note }
  }
  const kickSnippet = session => {
    if (!automaticNotes || !active(session) || session.asking) return
    const text = boundedSnippet(session)
    if (words(text) < minWords) return
    const delay = session.lastAttempt === undefined ? 0 : snippetMs - (elapsed(session) - session.lastAttempt)
    if (delay > 0) {
      if (session.snippetTimer === undefined) session.snippetTimer = timer(() => {
        session.snippetTimer = undefined
        kickSnippet(session)
      }, delay)
      return
    }
    cancelTimer(session, 'snippetTimer')
    const snippet = { text, start: session.snippetParts[0].start, end: session.snippetParts.at(-1).end }
    const labelled = part => `[${stamp(part.start)}–${stamp(part.end)}] ${part.text}`
    const prompt = [
      "Listen to Rick's live conversation. Reply with ONE useful note (25 words maximum), or exactly — if no note helps.",
      ...(session.context.length ? ['Previous snippets:', ...session.context.map(labelled)] : []),
      'New snippet:', labelled(snippet),
    ].join('\n')
    session.snippetParts = []
    const priorContext = session.context
    session.lastAttempt = elapsed(session)
    session.asking = true
    session.muse = { state: 'thinking' }
    let acceptingStatus = true
    void (async () => {
      try {
        // active() immediately precedes the callback so a stopped session never
        // submits even if an earlier transcription or timer finishes later.
        if (!active(session)) return
        const result = await ask({ text: prompt, sessionId: session.id,
          signal: session.controller.signal, onStatus: value => { if (acceptingStatus) museStatus(session, value) } })
        if (!active(session)) return
        if (result?.status === 'done') {
          // Only confirmed completed snippets become future prompt context.
          // A possibly POSTed attempt must not resurface as Previous snippets
          // after uncertainty, cancellation, timeout, failure or rejection.
          session.context = [...priorContext, snippet].slice(-2)
          const text = noteText(result.reply)
          if (text) {
            // Public (t,text) tuples are client deduplication identities. A
            // deterministic +1ms tie-break preserves identical real notes.
            appendNote(session, text, snippet.end)
          }
          session.muse = { state: 'idle' }
        } else if (['busy', 'skipped'].includes(result?.status)) {
          // These statuses prove the service made no POST. Restore the exact
          // unsent snapshot before newer speech, subject to the same bounds,
          // and leave context unchanged. finally enforces the full cadence
          // before retry; uncertain/error/timeout results never take this path.
          session.context = priorContext
          session.snippetParts = [{ ...snippet }, ...session.snippetParts]
          boundedSnippet(session)
          session.muse = { state: 'busy', reason: 'Muse busy; speech retained' }
        } else if (result?.status === 'cancelled') session.muse = { state: 'idle' }
        else session.muse = { state: 'unavailable', reason: 'Muse unavailable' }
      } catch {
        if (active(session)) session.muse = { state: 'unavailable', reason: 'Muse unavailable' }
        diagnostic('listen.muse_failed')
      } finally {
        acceptingStatus = false
        // A request can take time to complete after its actual Muse send.
        // Waiting a full interval after completion conservatively separates
        // real sends without requiring another service timing API.
        session.lastAttempt = elapsed(session)
        session.asking = false
        if (active(session)) kickSnippet(session)
      }
    })()
  }
  const pump = async session => {
    if (session.pumping || !active(session)) return
    session.pumping = true
    try {
      while (active(session)) {
        const entry = session.pending.get(session.nextSeq)
        if (!entry) {
          if (session.pending.size && session.gapTimer === undefined) session.gapTimer = timer(() => {
            session.gapTimer = undefined
            if (!active(session) || !session.pending.size) return
            session.nextSeq = Math.min(...session.pending.keys())
            void pump(session)
          }, gapMs)
          break
        }
        cancelTimer(session, 'gapTimer')
        session.pending.delete(session.nextSeq)
        session.processing = entry
        let text
        try { text = cleanText(await transcribe(entry.pcm), maxLineChars) }
        catch { diagnostic('listen.transcribe_failed') }
        if (!active(session)) { settle(entry, fail(410, 'Listen session stopped')); break }
        const resultLines = []
        if (text) {
          // Without a capture timestamp this is a PCM-duration estimate from
          // receipt, never an ASR-completion timestamp. Sequence order clamps
          // overlapping/out-of-order receipt estimates. Integer +1ms ties keep
          // repeated speech distinct for clients deduplicating (t,text). This
          // deterministic adjustment is part of the coarse start estimate.
          const start = Math.max(session.lastChunkStart + 1, Math.floor(entry.start))
          const end = Math.max(session.lastChunkEnd, Math.ceil(entry.end), start)
          session.clockT = Math.max(session.clockT, end)
          session.lastChunkStart = start
          session.lastChunkEnd = end
          session.lines.push({ t: start, text, published_t: elapsed(session) })
          if (session.lines.length > maxLines) session.lines.shift()
          resultLines.push({ t: start, text })
          session.lastSpeechAt = Math.max(session.lastSpeechAt, entry.end)
          armIdle(session)
          if (automaticNotes) {
            session.snippetParts.push({ start, end, text })
            boundedSnippet(session)
            kickSnippet(session)
          }
        }
        const result = response(200, { ok: true, lines: resultLines })
        session.completed.set(entry.seq, result)
        if (session.completed.size > maxPendingChunks) session.completed.delete(session.completed.keys().next().value)
        settle(entry, cloneResult(result))
        session.processing = undefined
        session.pendingBytes -= entry.pcm.length
        session.pendingCount--
        session.nextSeq++
      }
    } finally { session.pumping = false }
  }

  const api = {
    snapshot() { return api.state(current?.id) },
    addNote(id, value) {
      const session = known(id)
      if (!session) return fail(404, 'Listen session not found')
      if (!active(session)) return fail(410, 'Listen session stopped')
      if (notesFrom === 'chat') return fail(409, 'Page notes disabled')
      const text = noteText(value?.text, Infinity)
      if (!text) return fail(400, 'Invalid Listen note')
      const at_t = value?.at_t ?? session.lines.at(-1)?.t ?? 0
      if (typeof at_t !== 'number' || !Number.isFinite(at_t) || at_t < 0 || at_t > elapsed(session)) return fail(400, 'Invalid Listen note anchor')
      return response(200, { note: appendNote(session, text, at_t) })
    },
    start(backend = 'muse') {
      if (backend && typeof backend === 'object' && !Array.isArray(backend)) backend = backend.backend ?? 'muse'
      if (backend !== 'muse') return fail(400, 'Unsupported Listen backend')
      if (current && active(current)) return fail(409, 'Listen session already active')
      const startedAt = now()
      const id = idFactory()
      if (!Number.isFinite(startedAt) || typeof id !== 'string' || !id) return fail(503, 'Listen unavailable')
      current = { id, startedAt, clockT: 0, state: 'listening', controller: new AbortController(),
        nextSeq: 0, pending: new Map(), completed: new Map(), pendingCount: 0, pendingBytes: 0,
        pumping: false, processing: undefined, lines: [], notes: [], snippetParts: [], context: [],
        lastSpeechAt: 0, lastChunkStart: -1, lastChunkEnd: 0, lastNoteT: -1, asking: false, muse: { state: 'idle' } }
      armIdle(current)
      diagnostic('listen.started')
      return response(200, { id, startedAt })
    },
    async chunk(id, seq, pcm) {
      const session = known(id)
      if (!session) return fail(404, 'Listen session not found')
      if (!active(session)) return fail(410, 'Listen session stopped')
      if (!Number.isSafeInteger(seq) || seq < 0) return fail(400, 'Invalid chunk sequence')
      if (session.completed.has(seq)) return cloneResult(session.completed.get(seq))
      if (session.processing?.seq === seq) return cloneResult(await session.processing.promise)
      if (session.pending.has(seq)) return cloneResult(await session.pending.get(seq).promise)
      if (seq < session.nextSeq) return response(200, { ok: true, lines: [] })
      if (seq - session.nextSeq > maxSeqAhead) return fail(409, 'Chunk sequence too far ahead')
      if (pcm instanceof ArrayBuffer) pcm = new Uint8Array(pcm)
      if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2) return fail(400, 'Invalid PCM chunk')
      if (pcm.length > LISTEN_MAX_BYTES) return fail(413, 'PCM chunk too large')
      if (session.pendingCount >= maxPendingChunks || session.pendingBytes + pcm.length > maxPendingBytes) return fail(429, 'Too many pending chunks')
      const end = elapsed(session)
      let resolve
      const promise = new Promise(done => { resolve = done })
      const entry = { seq, pcm: Uint8Array.from(pcm), end, start: Math.max(0, end - pcm.length / 32), promise, resolve, settled: false }
      session.pending.set(seq, entry)
      session.pendingCount++
      session.pendingBytes += entry.pcm.length
      void pump(session)
      return cloneResult(await promise)
    },
    stop(id) {
      const session = known(id)
      if (!session) return fail(404, 'Listen session not found')
      stopSession(session)
      return response(200, { ok: true })
    },
    state(id, since) {
      const session = known(id)
      if (!session) return fail(404, 'Listen session not found')
      if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) return fail(400, 'Invalid Listen cursor')
      active(session)
      const now_t = elapsed(session)
      // since is a publication watermark, not the estimated speech start. Use
      // the previous now_t inclusively and deduplicate returned (t,text) pairs.
      return response(200, { id: session.id, state: session.state, startedAt: session.startedAt, now_t, notesFrom,
        lines: session.lines.filter(line => since === undefined || line.published_t >= since).map(({ t, text }) => ({ t, text })),
        notes: session.notes.filter(note => since === undefined || note.t >= since).map(note => ({ ...note })),
        muse: { ...session.muse } })
    },
    close(id) {
      if (id !== undefined && !known(id)) return fail(404, 'Listen session not found')
      if (current) stopSession(current)
      return response(200, { ok: true })
    },
  }
  return api
}
