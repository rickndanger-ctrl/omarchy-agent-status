// The conversation tile's session, on the hub: listens in ~9 s chunks, transcribes them in order, keeps 2-3 hint
// lines up to date from the last couple of minutes, and on stop writes a summary and action items to a file.
// Contract: docs/CONVERSATION.md. Only the newest session stays in memory. Nothing is ever sent anywhere but the
// transcriber and the backend the owner chose (with the local model as the one fallback for Claude).
// Dependencies are passed in, so the test can drive every step: transcribe(pcm) → text, think({...}) → {text, ms},
// diag(name, detail), dir (the folder for finished conversations), and limitMs (30 minutes unless a test shortens it).

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { THINK_BACKENDS } from './think.mjs'

export const CONVERSATION_MAX_BYTES = 1024 * 1024
// The hub's guard: the session stops by itself at 31 minutes, and a chunk after that is 410. The app stops at 30
// minutes and sends its last chunk, which must still count.
const LIMIT_MS = 31 * 60_000
const GAP_MS = 8_000 // how long the queue waits for a missing chunk before going on without it
const GAP_POLL_MS = 250
const HINT_MS = 20_000
const SUMMARY_MS = 60_000
const HINT_CONTEXT_MS = 120_000 // the hints read the last couple of minutes of the talk
// The order the helpers are tried in when the chosen one fails: Claude, then Codex, then the local model.
const CHAIN = ['claude', 'codex', 'local']
const WHO = { claude: 'Claude', codex: 'Codex', local: 'local model' }

const HINT_SYSTEM = 'You help during a conversation. Reply with 2 or 3 lines, each under 40 characters, chosen from: a key point, a question worth asking, a useful fact. Nothing else.'
const SUMMARY_SYSTEM = 'Summarize the conversation. Reply in this form: a line "SUMMARY:", then up to 5 short lines, then a line "ACTIONS:", then one line per action item starting with "- ". Nothing else.'

const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const bulletless = line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()

// Two or three hint lines from the model's answer, each at most 40 characters.
export function hintsFrom(text) {
  return String(text).split('\n').map(bulletless).filter(Boolean).slice(0, 3).map(l => l.slice(0, 40))
}

// The summary (up to 5 lines) and the action items, from the form the summary request asks for. An answer without
// the markers is taken as the summary.
export function summaryFrom(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean)
  const actionsAt = lines.findIndex(l => /^actions:?$/i.test(l))
  const summaryAt = lines.findIndex(l => /^summary:?$/i.test(l))
  const summaryEnd = actionsAt >= 0 ? actionsAt : lines.length
  const summaryLines = lines.slice(summaryAt >= 0 ? summaryAt + 1 : 0, summaryEnd)
  const summary = summaryLines.map(bulletless).filter(Boolean).slice(0, 5).map(l => clip(l, 200))
  const actions = actionsAt >= 0 ? lines.slice(actionsAt + 1).map(bulletless).filter(Boolean).map(l => clip(l, 200)) : []
  return { summary, actions }
}

// The folder name and file name for a conversation: local time, to the minute it started.
function stampOf(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

export function createConversations({ transcribe, think, diag, dir, limitMs = LIMIT_MS, now = () => Date.now() }) {
  let current = null // the newest session; an older one is dropped when a new one starts

  const view = s => ({
    id: s.id,
    state: s.state,
    backend: s.backend,
    startedAt: s.startedAt,
    ...(s.stoppedAt ? { stoppedAt: s.stoppedAt } : {}),
    hints: s.hints,
    ...(s.summary ? { summary: s.summary, actions: s.actions } : {}),
    ...(s.fallback ? { fallback: s.fallback } : {}),
    ...(s.error ? { error: s.error } : {}),
    chunks: s.chunks,
    words: s.words,
    skipped: s.skipped,
  })

  // One request, down the chain from the session's backend. A helper that is not set up, not running or failing is
  // passed over; the first one that answers does it. When it is not the chosen one, the tile says who answered and
  // why the chosen one did not (its own error line). If none answers, the chosen one's error is the error.
  async function ask(s, system, prompt, timeoutMs) {
    const timeoutSec = timeoutMs / 1000
    let first = null
    for (const backend of CHAIN.slice(CHAIN.indexOf(s.backend))) {
      try {
        const r = await think({ backend, system, prompt, timeoutSec })
        s.fallback = backend === s.backend ? undefined : `(${WHO[backend]} answered: ${first.message})`
        return r
      } catch (err) {
        first ??= err
      }
    }
    throw first
  }

  // Hints: never more than one request in flight; a request asked for meanwhile runs once after it.
  async function requestHint(s) {
    if (s.hintBusy) {
      s.hintQueued = true
      return
    }
    if (!s.transcript.length) return
    s.hintBusy = true
    try {
      const since = now() - HINT_CONTEXT_MS
      const context = s.transcript.filter(t => t.at >= since).map(t => t.text).join('\n')
      const r = await ask(s, HINT_SYSTEM, context, HINT_MS)
      s.hints = hintsFrom(r.text)
      s.error = undefined // a good answer clears an earlier failure
      diag('conv.hint', `${r.ms} ms`)
    } catch (err) {
      s.error = clip(err.message, 120)
      diag('conv.error', 'hint failed')
    } finally {
      s.hintBusy = false
      if (s.hintQueued) {
        s.hintQueued = false
        void requestHint(s)
      }
    }
  }

  // Chunks are transcribed one at a time, lowest seq first. A chunk that fails is logged and skipped.
  async function transcribeOne(s, seq, pcm) {
    const started = now()
    let text
    try {
      text = String(await transcribe(pcm) ?? '').trim()
    } catch {
      s.skipped += 1
      diag('conv.error', `chunk ${seq}: transcription failed`)
      return
    }
    const words = text ? text.split(/\s+/).length : 0
    s.transcript.push({ at: now(), text })
    s.chunks += 1
    s.words += words
    diag('conv.chunk', `seq ${seq} ${now() - started} ms ${words} words`)
    void requestHint(s)
  }

  // Chunks come in order but may overtake each other, so the queue waits for the next seq. A seq that never comes
  // is waited for a few seconds, then the lowest one that did arrive goes on. A stop does not wait at all.
  function pump(s) {
    if (s.pump) return s.pump
    s.pump = (async () => {
      while (s.pending.size) {
        if (s.pending.has(s.nextSeq)) {
          const seq = s.nextSeq
          const pcm = s.pending.get(seq)
          s.pending.delete(seq)
          s.nextSeq += 1
          s.gapMs = 0
          await transcribeOne(s, seq, pcm)
          continue
        }
        if (s.skipGaps || s.gapMs >= GAP_MS) {
          s.nextSeq = Math.min(...s.pending.keys())
          s.gapMs = 0
          continue
        }
        await new Promise(resolve => setTimeout(resolve, GAP_POLL_MS))
        s.gapMs += GAP_POLL_MS
      }
    })().finally(() => {
      s.pump = null
      if (s.pending.size) pump(s)
    })
    return s.pump
  }
  async function drain(s) {
    while (s.pump) await s.pump
  }

  function writeRecord(s) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const stamp = stampOf(s.startedAt)
    let name = `${stamp}.md`
    for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${stamp}-${n}.md`
    const file = path.join(dir, name)
    const list = items => (items?.length ? items.map(i => `- ${i}`).join('\n') : '(none)')
    const body = [
      `# Conversation ${stamp}`,
      '',
      `Backend: ${s.backend}`,
      '',
      '## Summary',
      s.summary?.length ? s.summary.map(l => `- ${l}`).join('\n') : '(no summary)',
      '',
      '## Action items',
      list(s.actions),
      '',
      '## Transcript',
      s.transcript.map(t => t.text).join('\n\n'),
      '',
    ].join('\n')
    writeFileSync(file, body, { mode: 0o600 })
    chmodSync(file, 0o600)
    return file
  }

  // Stop: the chunks already heard are finished, the whole talk is summarized, and the record is written.
  async function finish(s, reason) {
    s.state = 'summarizing'
    s.skipGaps = true
    await drain(s)
    try {
      if (s.words === 0) {
        // Nothing came out of the talk: an error, not an empty summary. A failed chunk means it could not be
        // transcribed; otherwise it was silence.
        s.state = 'error'
        s.error = s.skipped ? 'Nothing could be transcribed' : 'Nothing was heard'
        diag('conv.error', `no words, ${s.chunks} chunks, ${s.skipped} skipped, ${reason}`)
        writeRecord(s)
        return
      }
      const r = await ask(s, SUMMARY_SYSTEM, s.transcript.map(t => t.text).join('\n'), SUMMARY_MS)
      const { summary, actions } = summaryFrom(r.text)
      s.summary = summary
      s.actions = actions
      s.error = undefined // a good summary clears an earlier failure
      s.state = 'done'
      diag('conv.stop', `${s.chunks} chunks, ${s.words} words, ${reason}`)
    } catch (err) {
      s.state = 'error'
      s.error = clip(err.message, 120)
      diag('conv.error', 'summary failed')
    }
    try {
      writeRecord(s)
    } catch {
      diag('conv.error', 'record not written')
    }
  }

  function stopSession(s, reason) {
    if (s.state !== 'listening') return
    clearTimeout(s.timer)
    s.stoppedAt = now()
    void finish(s, reason)
  }

  return {
    start(backend) {
      if (!THINK_BACKENDS.includes(backend)) return { status: 400, body: { error: 'backend must be local, claude or codex' } }
      if (current?.state === 'listening') return { status: 409, body: { error: 'already listening' } }
      if (current?.state === 'summarizing') return { status: 409, body: { error: 'still summarizing the last conversation' } }
      const s = {
        id: randomBytes(6).toString('hex'),
        state: 'listening',
        backend,
        startedAt: now(),
        hints: [],
        chunks: 0,
        words: 0,
        transcript: [],
        pending: new Map(),
        seen: new Set(),
        nextSeq: 0, // seq counts from 0, in send order
        skipped: 0,
        gapMs: 0,
        skipGaps: false,
        pump: null,
        hintBusy: false,
        hintQueued: false,
      }
      s.timer = setTimeout(() => stopSession(s, 'time limit'), limitMs)
      current = s
      diag('conv.start', backend)
      return { status: 200, body: { id: s.id, startedAt: s.startedAt } }
    },
    chunk(id, seq, pcm) {
      const s = current
      if (!s || s.id !== id || s.state !== 'listening') return { status: 404, body: { error: 'unknown or finished conversation' } }
      if (now() - s.startedAt > limitMs) return { status: 410, body: { error: 'over 31 minutes' } }
      if (!Number.isInteger(seq) || seq < 0) return { status: 400, body: { error: 'seq must be a number from 0' } }
      // A seq below the next expected one is a late chunk (its gap was given up) or a repeat: dropped, not heard.
      if (seq < s.nextSeq) return { status: 200, body: { ok: true } }
      if (!s.seen.has(seq)) {
        s.seen.add(seq)
        s.pending.set(seq, pcm)
        pump(s)
      }
      return { status: 200, body: { ok: true } }
    },
    stop(id) {
      const s = current
      if (!s || s.id !== id) return { status: 404, body: { error: 'unknown or finished conversation' } }
      stopSession(s, 'stopped')
      return { status: 200, body: { ok: true } }
    },
    state() {
      return current ? view(current) : { state: 'idle' }
    },
  }
}
