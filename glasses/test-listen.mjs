import test from 'node:test'
import assert from 'node:assert/strict'
import { createListen, LISTEN_MAX_BYTES } from './listen.mjs'

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const speech = (n, prefix = 'word') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
const pcm = (ms = 1000, marker = 0) => { const bytes = new Uint8Array(ms * 32); bytes[0] = marker; return bytes }

test('default page mode never invokes automatic ask or status callbacks across speech and timers', async () => {
  let calls = 0
  const f = fixture({ notesFrom: undefined, ask: () => { calls++; throw new Error('must not run') } })
  for (let seq = 0; seq < 4; seq++) {
    await f.clock.advance(46_000)
    await f.engine.chunk(f.id, seq, pcm())
  }
  assert.equal(calls, 0)
  assert.equal(f.engine.snapshot().body.lines.length, 4)
  assert.deepEqual(f.engine.snapshot().body.notes, [])
  assert.deepEqual(f.engine.snapshot().body.muse, { state: 'idle' })
  f.engine.close()
})

test('page mode needs no ask callback and missing chat callbacks fail closed', () => {
  const clock = new Clock()
  const engine = createListen({ transcribe: async () => '', now: clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  assert.equal(engine.snapshot().status, 404)
  assert.equal(engine.start().status, 200)
  engine.close()
  for (const notesFrom of ['chat', 'both']) {
    assert.throws(() => createListen({ notesFrom, transcribe: async () => '' }), TypeError)
  }
})

test('invalid notesFrom values fall back to page and never call ask', async () => {
  for (const notesFrom of ['', null, 'invalid', true, 1, {}, ['chat']]) {
    const f = fixture({ notesFrom })
    await f.engine.chunk(f.id, 0, pcm())
    await f.clock.advance(46_000)
    assert.equal(f.asks.length, 0)
    assert.equal(f.engine.snapshot().body.notesFrom, 'page')
    assert.equal(f.engine.addNote(f.id, { text: 'Manual note' }).status, 200)
    f.engine.close()
  }
})

test('chat-only mode rejects page notes with409 while preserving automatic chat', async () => {
  const f = fixture({ notesFrom: 'chat' })
  assert.equal(f.engine.snapshot().body.notesFrom, 'chat')
  assert.equal(f.engine.addNote(f.id, { text: 'Page note' }).status, 409)
  assert.deepEqual(f.engine.snapshot().body.notes, [])
  await f.engine.chunk(f.id, 0, pcm())
  await flush()
  assert.equal(f.asks.length, 1)
  assert.deepEqual(f.engine.snapshot().body.notes.map(note => note.text), ['Check the deadline.'])
  f.engine.close()
})

test('page notes sanitize and cap300 characters without imposing chat25word limit', async () => {
  const f = fixture({ notesFrom: 'page' })
  await f.clock.advance(10_000)
  await f.engine.chunk(f.id, 0, pcm())
  const first = f.engine.addNote(f.id, { text: 'Helpful note.\n\nMuse\nStatus\nApprovals history\nAllowed once · 2h ago' })
  assert.deepEqual(first.body.note, { t: 10_000, at_t: 9000, text: 'Helpful note.' })
  const long = f.engine.addNote(f.id, { text: 'word '.repeat(100), at_t: 1234 })
  assert.ok(long.body.note.text.length <= 300)
  assert.ok(long.body.note.text.split(' ').length > 25)
  assert.equal(long.body.note.at_t, 1234)
  assert.equal(long.body.note.t, 10_001)
  assert.deepEqual(f.engine.state(f.id, 10_001).body.notes, [long.body.note])
  first.body.note.text = 'mutation'
  const snapshot = f.engine.snapshot()
  snapshot.body.notes[0].text = 'also mutation'
  snapshot.body.lines[0].text = 'mutation'
  assert.equal(f.engine.snapshot().body.notes[0].text, 'Helpful note.')
  assert.notEqual(f.engine.snapshot().body.lines[0].text, 'mutation')
  f.engine.close()
})

test('page admission rejects invalid notes/anchors and stale sessions without side effects', () => {
  const f = fixture({ notesFrom: 'page' })
  for (const text of ['', ' ', null, 42, '—']) assert.equal(f.engine.addNote(f.id, { text }).status, 400)
  for (const at_t of [-1, Infinity, NaN, '00:01', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(f.engine.addNote(f.id, { text: 'Useful', at_t }).status, 400)
  }
  assert.equal(f.engine.addNote('other', { text: 'Wrong session' }).status, 404)
  assert.deepEqual(f.engine.snapshot().body.notes, [])
  assert.equal(f.engine.addNote(f.id, { text: 'Before transcript' }).body.note.at_t, 0)
  f.engine.stop(f.id)
  assert.equal(f.engine.addNote(f.id, { text: 'Stopped' }).status, 410)
  assert.equal(f.engine.snapshot().body.state, 'stopped')
  const next = f.engine.start().body.id
  assert.notEqual(next, f.id)
  assert.equal(f.engine.addNote(f.id, { text: 'Old session' }).status, 404)
  assert.deepEqual(f.engine.snapshot().body.notes, [])
  f.engine.close()
})

test('early manual03 anchor is preserved without advancing actual arrival or session clocks', async () => {
  const f = fixture({ notesFrom: 'page' })
  await f.clock.advance(1300)
  const result = f.engine.addNote(f.id, { text: 'About three seconds', at_t: 3000 })
  assert.deepEqual(result, { status: 200, body: { note: { t: 1300, at_t: 3000, text: 'About three seconds' } } })
  const snapshot = f.engine.snapshot().body
  assert.equal(snapshot.now_t, 1300)
  assert.deepEqual(snapshot.notes, [result.body.note])
  assert.equal(f.asks.length, 0)
  f.engine.close()
})

test('both mode merges page and automatic notes with one bounded ordered timeline', async () => {
  const f = fixture({ notesFrom: 'both', maxNotes: 2 })
  assert.equal(f.engine.snapshot().body.notesFrom, 'both')
  f.engine.addNote(f.id, { text: 'Page first' })
  await f.engine.chunk(f.id, 0, pcm())
  await flush()
  assert.equal(f.asks.length, 1)
  f.engine.addNote(f.id, { text: 'Page last' })
  const notes = f.engine.snapshot().body.notes
  assert.deepEqual(notes.map(note => note.text), ['Check the deadline.', 'Page last'])
  assert.ok(notes[1].t > notes[0].t)
  f.engine.close()
})

test('start chooses per-session notesFrom with metadata and independent page/chat gates', async () => {
  for (const configured of ['page', 'chat', 'both']) {
    const f = fixture({ notesFrom: configured })
    for (const mode of ['page', 'chat', 'both']) {
      f.engine.stop(f.engine.snapshot().body.id)
      const input = { backend: 'muse', notesFrom: mode }
      const started = f.engine.start(input)
      const id = started.body.id
      input.notesFrom = 'changed'
      assert.equal(started.status, 200)
      assert.equal(started.body.notesFrom, mode)
      assert.equal(f.engine.snapshot().body.notesFrom, mode)
      assert.equal(f.engine.state(id).body.notesFrom, mode)
      const before = f.asks.length
      await f.engine.chunk(id, 0, pcm())
      await flush()
      assert.equal(f.asks.length - before, mode === 'page' ? 0 : 1)
      assert.equal(f.engine.addNote(id, { text: 'Manual note' }).status, mode === 'chat' ? 409 : 200)
    }
    f.engine.stop(f.engine.snapshot().body.id)
    assert.equal(f.engine.start().body.notesFrom, configured, 'Override never mutates configured default')
    f.engine.close()
  }
})

test('invalid explicit start mode returns400 before active conflict and leaves current session unchanged', () => {
  const f = fixture({ notesFrom: 'page' })
  for (const notesFrom of [undefined, null, '', 'invalid', 1, true, {}, ['chat']]) {
    assert.deepEqual(f.engine.start({ notesFrom }), { status: 400, body: { error: 'notesFrom must be page, chat or both' } })
    assert.equal(f.engine.snapshot().body.id, f.id)
    assert.equal(f.engine.snapshot().body.notesFrom, 'page')
  }
  assert.equal(f.engine.start({ notesFrom: 'both' }).status, 409)
  f.engine.stop(f.id)
  assert.equal(f.engine.start({ notesFrom: 'invalid' }).status, 400)
  assert.equal(f.engine.snapshot().body.state, 'stopped')
  f.engine.close()
})

test('page-only provider setup refuses chat override without invoking any callback', () => {
  const clock = new Clock()
  const engine = createListen({ transcribe: async () => '', now: clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  assert.equal(engine.start({ notesFrom: 'chat' }).status, 503)
  assert.equal(engine.snapshot().status, 404)
  assert.equal(engine.start({ notesFrom: 'page' }).status, 200)
  engine.close()
})

class Clock {
  at = 1_000_000
  next = 0
  timers = new Map()
  now = () => this.at
  setTimer = (fn, ms) => { const id = ++this.next; this.timers.set(id, { at: this.at + ms, fn }); return id }
  clearTimer = id => this.timers.delete(id)
  async advance(ms) {
    const end = this.at + ms
    for (let i = 0; i < 1000; i++) {
      const due = [...this.timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.at = due[1].at
      this.timers.delete(due[0])
      due[1].fn()
      await flush()
      if (i === 999) throw new Error('timer loop')
    }
    this.at = end
    await flush()
  }
}

function fixture(options = {}) {
  const clock = new Clock(), asks = [], transcriptions = []
  let ids = 0
  const engine = createListen({
    notesFrom: 'chat',
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    idFactory: () => `listen-${++ids}`,
    transcribe: async bytes => { transcriptions.push(bytes[0]); return speech(25) },
    ask: async request => { asks.push(request); return { status: 'done', reply: 'Check the deadline.' } },
    ...options,
  })
  const start = engine.start()
  return { engine, clock, asks, transcriptions, id: start.body.id, start }
}

test('start is an explicit Muse-only opt-in and sessions/cursors fail closed', () => {
  const clock = new Clock()
  let called = 0
  const engine = createListen({ transcribe: () => { called++; return '' }, ask: () => { called++; return '' },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  assert.equal(called, 0)
  assert.equal(engine.start('local').status, 400)
  assert.equal(engine.state().status, 404)
  const started = engine.start({ backend: 'muse' })
  assert.equal(started.status, 200)
  assert.equal(started.body.startedAt, clock.at)
  assert.equal(engine.start().status, 409)
  for (const since of [-1, Infinity, NaN, '', 'oops']) assert.equal(engine.state(started.body.id, since).status, 400)
  assert.equal(engine.state('other').status, 404)
  assert.equal(engine.stop('other').status, 404)
  engine.close()
  assert.equal(clock.timers.size, 0)
})

test('line time comes from PCM receipt, while since filters publication after delayed ASR', async () => {
  const pending = deferred()
  const f = fixture({ transcribe: () => pending.promise, minWords: 100 })
  await f.clock.advance(10_000)
  const chunk = f.engine.chunk(f.id, 0, pcm(2000))
  await f.clock.advance(10_000)
  const watermark = f.engine.state(f.id).body.now_t
  await f.clock.advance(10_000)
  pending.resolve('A delayed transcript')
  const result = await chunk
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.lines, [{ t: 8000, text: 'A delayed transcript' }])
  const state = f.engine.state(f.id, watermark).body
  assert.equal(state.now_t, 30_000)
  assert.deepEqual(state.lines, result.body.lines)
  assert.deepEqual(Object.keys(state.lines[0]).sort(), ['t', 'text'])
  assert.equal(f.engine.state(f.id, 30_000).body.lines.length, 1)
  assert.equal(f.engine.state(f.id, 30_001).body.lines.length, 0)
  f.engine.close()
})

test('out-of-order chunks are serialized and repeats reuse their result without another ASR', async () => {
  const order = []
  const f = fixture({ transcribe: async bytes => { order.push(bytes[0]); return `line ${bytes[0]}` }, minWords: 100 })
  await f.clock.advance(9000)
  const later = f.engine.chunk(f.id, 1, pcm(1000, 1))
  const duplicate = f.engine.chunk(f.id, 1, pcm(1000, 7))
  await flush()
  assert.deepEqual(order, [])
  await f.clock.advance(1000)
  const first = await f.engine.chunk(f.id, 0, pcm(1000, 0))
  const second = await later
  assert.deepEqual(order, [0, 1])
  assert.deepEqual(await duplicate, second)
  assert.deepEqual(await f.engine.chunk(f.id, 1, pcm(1000, 9)), second)
  assert.ok(first.body.lines[0].t <= second.body.lines[0].t)
  assert.deepEqual(f.engine.state(f.id).body.lines.map(l => l.text), ['line 0', 'line 1'])
  f.engine.close()
})

test('missing chunks have a bounded gap wait and bad PCM/sequence is rejected', async () => {
  const f = fixture({ gapMs: 1000, minWords: 100 })
  assert.equal((await f.engine.chunk(f.id, -1, pcm())).status, 400)
  assert.equal((await f.engine.chunk(f.id, 0.5, pcm())).status, 400)
  assert.equal((await f.engine.chunk(f.id, 1000, pcm())).status, 409)
  assert.equal((await f.engine.chunk(f.id, 0, new Uint8Array(0))).status, 400)
  assert.equal((await f.engine.chunk(f.id, 0, new Uint8Array(3))).status, 400)
  assert.equal((await f.engine.chunk(f.id, 0, new Uint8Array(LISTEN_MAX_BYTES + 2))).status, 413)
  const missing = f.engine.chunk(f.id, 2, pcm())
  await f.clock.advance(999)
  assert.deepEqual(f.transcriptions, [])
  await f.clock.advance(1)
  assert.equal((await missing).status, 200)
  await f.engine.chunk(f.id, 1, pcm())
  assert.equal(f.transcriptions.length, 1)
  f.engine.close()
})

test('pending chunk count/bytes are bounded and stop settles waiting uploads', async () => {
  const pending = deferred()
  let calls = 0
  const f = fixture({ transcribe: () => { calls++; return pending.promise }, maxPendingChunks: 2, maxPendingBytes: 64_000 })
  const first = f.engine.chunk(f.id, 0, pcm())
  const second = f.engine.chunk(f.id, 1, pcm())
  assert.equal((await f.engine.chunk(f.id, 2, pcm())).status, 429)
  assert.equal(f.engine.stop(f.id).status, 200)
  assert.equal((await first).status, 410)
  assert.equal((await second).status, 410)
  pending.resolve(speech(25))
  await flush()
  assert.equal(calls, 1)
  assert.equal(f.asks.length, 0)
  assert.deepEqual(f.engine.state(f.id).body.lines, [])
})

test('at least25 new words are required and asks start at most once per45 seconds', async () => {
  const text = [speech(24), 'last', speech(25)]
  const f = fixture({ transcribe: async () => text.shift() })
  await f.clock.advance(1000)
  await f.engine.chunk(f.id, 0, pcm())
  assert.equal(f.asks.length, 0)
  await f.engine.chunk(f.id, 1, pcm())
  await flush()
  assert.equal(f.asks.length, 1)
  await f.clock.advance(1000)
  await f.engine.chunk(f.id, 2, pcm())
  await f.clock.advance(43_999)
  assert.equal(f.asks.length, 1)
  await f.clock.advance(1)
  assert.equal(f.asks.length, 2)
  const notes = f.engine.state(f.id).body.notes
  assert.deepEqual(notes.map(n => [n.t, n.at_t]), [[1000, 1000], [46_000, 2000]])
  f.engine.close()
})

test('three snippets produce two notes, dropping dash and including the last two timed contexts', async () => {
  const prompts = [], replies = ['First useful note', '—', 'Third useful note', 'Fourth useful note']
  const f = fixture({ transcribe: async bytes => speech(25, `batch${bytes[0]}-`),
    ask: async request => { prompts.push(request.text); return { status: 'done', reply: replies.shift() } } })
  await f.clock.advance(1000)
  for (let seq = 0; seq < 3; seq++) {
    if (seq) await f.clock.advance(45_000)
    await f.engine.chunk(f.id, seq, pcm(1000, seq))
    await flush()
  }
  const state = f.engine.state(f.id).body
  assert.deepEqual(state.notes.map(n => n.text), ['First useful note', 'Third useful note'])
  assert.match(prompts[2], /25 words/)
  assert.match(prompts[2], /\[00:00[–-]00:01\]/)
  assert.match(prompts[2], /\[00:45[–-]00:46\]/)
  assert.match(prompts[2], /batch0-0/)
  assert.match(prompts[2], /batch1-0/)
  await f.clock.advance(45_000)
  await f.engine.chunk(f.id, 3, pcm(1000, 3))
  await flush()
  assert.doesNotMatch(prompts[3], /batch0-0/)
  f.engine.close()
})

test('only terminal done replies become sanitized, capped notes', async () => {
  const results = [
    { status: 'sending', reply: 'PARTIAL MUST NOT APPEAR' },
    { status: 'done', reply: '—' },
    { status: 'done', reply: 'Status\nApprovals history\nAllowed once · 2h ago' },
    { status: 'done', reply: 'Helpful note.\n\nMuse\nStatus\nApprovals history\nAllowed once · 2h ago' },
    { status: 'done', reply: 'x'.repeat(500) },
    { status: 'done', reply: speech(40) },
  ]
  const f = fixture({ snippetMs: 1, ask: async () => results.shift() })
  for (let seq = 0; seq < 6; seq++) {
    await f.clock.advance(1)
    await f.engine.chunk(f.id, seq, pcm())
    await flush()
  }
  const notes = f.engine.state(f.id).body.notes
  assert.equal(notes.length, 3)
  assert.equal(notes[0].text, 'Helpful note.')
  assert.equal(notes[1].text.length, 300)
  assert.equal(notes[2].text.split(/\s+/).length, 25)
  assert.doesNotMatch(JSON.stringify(notes), /PARTIAL|Approvals|Muse sent no text/)
  f.engine.close()
})

test('stop aborts queued Muse work and suppresses every late status/result and future timer', async () => {
  const answer = deferred(), calls = []
  const f = fixture({ ask: request => { calls.push(request); request.onStatus({ state: 'busy', reason: 'RAW RELAY SECRET' }); return answer.promise } })
  await f.engine.chunk(f.id, 0, pcm())
  await flush()
  assert.equal(f.engine.state(f.id).body.muse.state, 'busy')
  await f.engine.chunk(f.id, 1, pcm())
  assert.equal(f.engine.stop(f.id).status, 200)
  assert.equal(calls[0].signal.aborted, true)
  calls[0].onStatus({ state: 'unavailable', reason: 'RAW RELAY SECRET' })
  answer.resolve({ status: 'done', reply: 'Late answer' })
  await f.clock.advance(100_000)
  const state = f.engine.state(f.id).body
  assert.equal(state.state, 'stopped')
  assert.equal(state.muse.state, 'idle')
  assert.equal(calls.length, 1)
  assert.deepEqual(state.notes, [])
  assert.doesNotMatch(JSON.stringify(state), /RAW RELAY SECRET|Late answer/)
  assert.equal((await f.engine.chunk(f.id, 2, pcm())).status, 410)
})

test('silence does not renew the30-minute guard; speech and hub close do', async () => {
  const texts = ['speech', '']
  const f = fixture({ idleMs: 1000, transcribe: async () => texts.shift() })
  await f.clock.advance(200)
  await f.engine.chunk(f.id, 0, pcm())
  await f.clock.advance(400)
  await f.engine.chunk(f.id, 1, pcm())
  await f.clock.advance(599)
  assert.equal(f.engine.state(f.id).body.state, 'listening')
  await f.clock.advance(1)
  assert.equal(f.engine.state(f.id).body.state, 'stopped')
  assert.equal(f.engine.start().status, 200)
  f.engine.close()
  assert.equal(f.clock.timers.size, 0)
})

test('retained transcript/notes and prompt data stay bounded; returned views cannot mutate state', async () => {
  const prompts = []
  const f = fixture({ minWords: 2, snippetMs: 1, maxLines: 2, maxNotes: 2, maxLineChars: 100,
    maxSnippetWords: 30, maxSnippetChars: 200, transcribe: async () => speech(100),
    ask: async r => { prompts.push(r.text); return { status: 'done', reply: 'Useful.' } } })
  for (let seq = 0; seq < 4; seq++) {
    await f.clock.advance(1000)
    await f.engine.chunk(f.id, seq, pcm())
    await flush()
  }
  const view = f.engine.state(f.id).body
  assert.equal(view.lines.length, 2)
  assert.equal(view.notes.length, 2)
  assert.ok(view.lines.every(l => l.text.length <= 100))
  assert.ok(prompts.every(p => p.length < 1000))
  view.lines[0].text = 'mutated'
  view.notes[0].text = 'mutated'
  assert.doesNotMatch(JSON.stringify(f.engine.state(f.id).body), /mutated/)
  f.engine.close()
})

test('clock rollback does not move the shared cursor backwards or lose new publications', async () => {
  const f = fixture({ minWords: 100 })
  await f.clock.advance(5000)
  const cursor = f.engine.state(f.id).body.now_t
  f.clock.at -= 2000
  await f.engine.chunk(f.id, 0, pcm())
  const view = f.engine.state(f.id, cursor).body
  assert.equal(view.now_t, cursor)
  assert.equal(view.lines.length, 1)
  f.engine.close()
})

test('notes use arrival time and publication cursors while speech retains its earlier end', async () => {
  const answer = deferred()
  const f = fixture({ ask: () => answer.promise })
  await f.clock.advance(10_000)
  await f.engine.chunk(f.id, 0, pcm(2000))
  await f.clock.advance(20_000)
  const cursor = f.engine.state(f.id).body.now_t
  await f.clock.advance(10_000)
  answer.resolve({ status: 'done', reply: 'Remember the follow-up.' })
  await flush()
  const view = f.engine.state(f.id, cursor).body
  assert.deepEqual(view.lines, [])
  assert.deepEqual(view.notes, [{ t: 40_000, at_t: 10_000, text: 'Remember the follow-up.' }])
  f.engine.close()
})

test('finished broker callbacks cannot overwrite a later request status', async () => {
  const requests = [], second = deferred()
  const f = fixture({ snippetMs: 1, ask: request => {
    requests.push(request)
    return requests.length === 1 ? Promise.resolve({ status: 'done', reply: 'First.' }) : second.promise
  } })
  await f.engine.chunk(f.id, 0, pcm())
  await flush()
  await f.clock.advance(1)
  await f.engine.chunk(f.id, 1, pcm())
  assert.equal(f.engine.state(f.id).body.muse.state, 'thinking')
  requests[0].onStatus({ state: 'unavailable', reason: 'OLD RAW FAILURE' })
  assert.equal(f.engine.state(f.id).body.muse.state, 'thinking')
  f.engine.close()
  second.resolve({ status: 'done', reply: 'Too late.' })
  await flush()
})

test('missing IDs/sequences and ASR failures never submit or expose provider errors', async () => {
  const f = fixture({ transcribe: async () => { throw new Error('RAW PROVIDER CREDENTIAL') } })
  assert.equal((await f.engine.chunk(undefined, 0, pcm())).status, 404)
  assert.equal((await f.engine.chunk(f.id, undefined, pcm())).status, 400)
  const result = await f.engine.chunk(f.id, 0, pcm())
  assert.deepEqual(result, { status: 200, body: { ok: true, lines: [] } })
  assert.equal(f.asks.length, 0)
  assert.doesNotMatch(JSON.stringify(f.engine.state(f.id)), /RAW PROVIDER/)
  f.engine.close()
})

test('identical repeated speech has unique integer timestamps even at one receive clock', async () => {
  const pending = deferred()
  let calls = 0
  const f = fixture({ minWords: 100, transcribe: () => ++calls === 1 ? 'Repeat this.' : pending.promise })
  const first = await f.engine.chunk(f.id, 0, pcm())
  const second = f.engine.chunk(f.id, 1, pcm())
  const watermark = f.engine.state(f.id).body.now_t
  pending.resolve('Repeat this.')
  await second
  const view = f.engine.state(f.id, watermark).body
  const repeated = view.lines.filter(line => line.text === 'Repeat this.')
  assert.equal(repeated.length, 2)
  assert.ok(repeated.every(line => Number.isInteger(line.t)))
  assert.equal(repeated[1].t, first.body.lines[0].t + 1)
  assert.equal(new Set(repeated.map(line => `${line.t}:${line.text}`)).size, 2)
  assert.ok(view.now_t >= repeated[1].t)
  f.engine.close()
})

test('identical notes completed together have unique timestamps after a delayed GET cursor', async () => {
  const first = deferred()
  let calls = 0
  const f = fixture({ snippetMs: 0.5, ask: () => ++calls === 1 ? first.promise : Promise.resolve({ status: 'done', reply: 'Same useful note.' }) })
  await f.engine.chunk(f.id, 0, pcm())
  await f.engine.chunk(f.id, 1, pcm())
  await f.clock.advance(45_000)
  const watermark = f.engine.state(f.id).body.now_t
  first.resolve({ status: 'done', reply: 'Same useful note.' })
  await flush()
  await f.clock.advance(0.5)
  const view = f.engine.state(f.id, watermark).body
  assert.equal(calls, 2)
  assert.deepEqual(view.notes.map(note => note.t), [45_000, 45_001])
  assert.ok(view.notes.every(note => Number.isInteger(note.t)))
  assert.equal(new Set(view.notes.map(note => `${note.t}:${note.text}`)).size, 2)
  assert.ok(view.now_t >= view.notes[1].t)
  f.engine.close()
})

test('long priority queue waits cannot bunch actual sends after the first completion', async () => {
  const queued = deferred(), actualSendTimes = []
  let f, calls = 0
  f = fixture({ ask: () => {
    calls++
    if (calls === 1) return queued.promise
    actualSendTimes.push(f.clock.now())
    return Promise.resolve({ status: 'done', reply: 'Second note.' })
  } })
  await f.engine.chunk(f.id, 0, pcm())
  await f.engine.chunk(f.id, 1, pcm())
  await f.clock.advance(60_000)
  actualSendTimes.push(f.clock.now()) // the broker finally sends behind G2
  await f.clock.advance(2000)
  queued.resolve({ status: 'done', reply: 'First note.' })
  await flush()
  assert.equal(calls, 1)
  await f.clock.advance(44_999)
  assert.equal(calls, 1)
  await f.clock.advance(1)
  assert.equal(calls, 2)
  assert.ok(actualSendTimes[1] - actualSendTimes[0] >= 45_000)
  f.engine.close()
})

test('two large context snippets and a new snippet fit the broker even with oversized config', async () => {
  const prompts = []
  const f = fixture({ minWords: 1, snippetMs: 1, maxLineChars: 20_000, maxSnippetWords: 20_000, maxSnippetChars: 20_000,
    transcribe: async () => 'contextword '.repeat(1000),
    ask: async request => { prompts.push(request.text); return { status: 'done', reply: 'Useful.' } } })
  for (let seq = 0; seq < 3; seq++) {
    await f.clock.advance(1000)
    await f.engine.chunk(f.id, seq, pcm())
    await flush()
  }
  assert.equal(prompts.length, 3)
  assert.match(prompts[2], /Previous snippets:/)
  assert.equal(prompts[2].match(/\[[\d:]+[–-][\d:]+\]/g).length, 3)
  assert.ok(prompts.every(prompt => prompt.length <= 16_000))
  f.engine.close()
})

test('proven no-POST busy/skipped attempts retain speech for one later idle send without a hot loop', async () => {
  const requests = [], results = ['busy', 'skipped', 'done'], posts = []
  const f = fixture({ ask: async request => {
    requests.push(request)
    const status = results.shift()
    if (status === 'done') posts.push(request.text)
    return { status, reason: 'RAW SERVICE DETAILS', reply: 'Useful after idle.' }
  }, transcribe: async bytes => speech(25, `batch${bytes[0]}-`) })
  await f.clock.advance(1000)
  await f.engine.chunk(f.id, 0, pcm(1000, 0))
  await flush()
  assert.equal(f.engine.state(f.id).body.muse.state, 'busy')
  assert.deepEqual(f.engine.state(f.id).body.notes, [])
  await f.clock.advance(1000)
  await f.engine.chunk(f.id, 1, pcm(1000, 1))
  await f.clock.advance(43_999)
  assert.equal(requests.length, 1)
  await f.clock.advance(1)
  assert.equal(requests.length, 2)
  assert.equal(f.engine.state(f.id).body.muse.state, 'busy')
  assert.doesNotMatch(JSON.stringify(f.engine.state(f.id)), /RAW SERVICE DETAILS/)
  await f.clock.advance(44_999)
  assert.equal(requests.length, 2)
  await f.clock.advance(1)
  assert.equal(requests.length, 3)
  assert.equal(posts.length, 1)
  assert.equal((posts[0].match(/batch0-0\b/g) ?? []).length, 1)
  assert.equal((posts[0].match(/batch1-0\b/g) ?? []).length, 1)
  assert.doesNotMatch(posts[0], /Previous snippets:/)
  assert.equal(f.engine.state(f.id).body.muse.state, 'idle')
  assert.deepEqual(f.engine.state(f.id).body.notes.map(note => note.text), ['Useful after idle.'])
  await f.clock.advance(90_000)
  assert.equal(requests.length, 3)
  f.engine.close()
})

test('stop cancels the cadence timer holding proven unsent busy speech', async () => {
  let attempts = 0
  const f = fixture({ ask: async () => { attempts++; return { status: 'busy' } } })
  await f.engine.chunk(f.id, 0, pcm())
  await flush()
  assert.equal(attempts, 1)
  assert.equal(f.clock.timers.size, 2) // silence guard plus retained-speech cadence
  f.engine.stop(f.id)
  assert.equal(f.clock.timers.size, 0)
  await f.clock.advance(90_000)
  assert.equal(attempts, 1)
  assert.deepEqual(f.engine.state(f.id).body.notes, [])
})

test('uncertain, error and timeout results never restore or retry a possibly posted snippet', async () => {
  for (const status of ['uncertain', 'error', 'timeout']) {
    let attempts = 0
    const f = fixture({ ask: async () => { attempts++; return { status, reason: 'RAW UNCERTAINTY' } } })
    await f.engine.chunk(f.id, 0, pcm())
    await flush()
    await f.clock.advance(90_000)
    assert.equal(attempts, 1, status)
    assert.equal(f.engine.state(f.id).body.muse.state, 'unavailable')
    assert.doesNotMatch(JSON.stringify(f.engine.state(f.id)), /RAW UNCERTAINTY/)
    f.engine.close()
  }
})

for (const outcome of ['uncertain', 'unavailable', 'error', 'timeout', 'cancelled', 'rejected']) {
  test(`${outcome} snippet is absent from all later prompts while confirmed context and new speech survive`, async () => {
    const pending = deferred(), prompts = [], requests = []
    const f = fixture({ snippetMs: 1000, transcribe: async bytes => speech(25, `batch${bytes[0]}-`),
      ask: async request => {
        requests.push(request)
        prompts.push(request.text)
        if (requests.length === 2) {
          await pending.promise
          if (outcome === 'rejected') throw new Error('PRIVATE FAILED PROVIDER DETAIL')
          return { status: outcome, reason: 'PRIVATE FAILED PROVIDER DETAIL' }
        }
        if (requests.length === 3) return { status: 'busy' } // proven no POST
        return { status: 'done', reply: requests.length === 1 ? '—' : 'Confirmed note.' }
      } })
    await f.clock.advance(1000)
    await f.engine.chunk(f.id, 0, pcm(1000, 0))
    await flush()
    await f.clock.advance(1000)
    await f.engine.chunk(f.id, 1, pcm(1000, 1))
    await f.engine.chunk(f.id, 2, pcm(1000, 2)) // speech arriving during failed attempt
    assert.equal(prompts.length, 2)
    pending.resolve()
    await flush()
    requests[1].onStatus({ state: 'thinking' }) // terminal callbacks must stay inert
    await f.clock.advance(1000)
    assert.equal(prompts.length, 3)
    assert.match(prompts[2], /Previous snippets:/)
    assert.match(prompts[2], /batch0-0\b/) // done dash still confirms context
    assert.match(prompts[2], /batch2-0\b/) // new speech was not dropped
    await f.clock.advance(1000) // no-POST busy retry retains the exact fresh speech
    assert.equal(prompts.length, 4)
    assert.equal(prompts[3], prompts[2])
    await f.clock.advance(1000)
    await f.engine.chunk(f.id, 3, pcm(1000, 3))
    await flush()
    assert.equal(prompts.length, 5)
    assert.match(prompts[4], /batch0-0\b/)
    assert.match(prompts[4], /batch2-0\b/)
    assert.match(prompts[4], /batch3-0\b/)
    for (const prompt of prompts.slice(2)) {
      assert.doesNotMatch(prompt, /batch1-\d+\b/, outcome)
      assert.doesNotMatch(prompt, /PRIVATE FAILED PROVIDER DETAIL/)
    }
    assert.doesNotMatch(JSON.stringify(f.engine.state(f.id)), /PRIVATE FAILED PROVIDER DETAIL/)
    f.engine.close()
  })
}

test('cancelled and failed service results suppress late callbacks and keep errors private', async () => {
  const requests = []
  const f = fixture({ snippetMs: 1, ask: async request => {
    requests.push(request)
    if (requests.length === 1) return { status: 'cancelled', reason: 'RAW CANCEL DETAILS' }
    throw new Error('RAW SERVICE CREDENTIAL')
  } })
  await f.engine.chunk(f.id, 0, pcm())
  await flush()
  assert.equal(f.engine.state(f.id).body.muse.state, 'idle')
  requests[0].onStatus({ state: 'busy', reason: 'RAW LATE CALLBACK' })
  assert.equal(f.engine.state(f.id).body.muse.state, 'idle')
  await f.clock.advance(1)
  await f.engine.chunk(f.id, 1, pcm())
  await flush()
  assert.equal(f.engine.state(f.id).body.muse.state, 'unavailable')
  requests[1].onStatus({ state: 'thinking' })
  assert.equal(f.engine.state(f.id).body.muse.state, 'unavailable')
  assert.doesNotMatch(JSON.stringify(f.engine.state(f.id)), /RAW /)
  f.engine.close()
})
