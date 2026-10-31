import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { createListenPage, transcriptText, formatWallTime, formatSessionTime, parseAbout, escapeHTML, NOTE_BODY_BYTES } from './listen-page.mjs'
import { createListen } from './listen.mjs'

const base = Date.UTC(2026, 9, 30, 15, 0, 0)
const sample = () => ({ id: 'fixture-session', state: 'listening', startedAt: base, now_t: 10_000,
  lines: [{ t: 1_000, text: 'First transcript line' }, { t: 5_000, text: 'Newest transcript line' }],
  notes: [{ t: 8_000, at_t: 5_000, text: 'A useful note' }], muse: { state: 'idle' } })

function fixture(options = {}) {
  let data = sample()
  const added = [], snapshots = []
  const listen = { snapshot() { snapshots.push(true); return { status: 200, body: structuredClone(data) } },
    addNote(id, value) { added.push({ id, ...value }); return { status: 200, body: { note: { t: 10_000, at_t: value.at_t ?? 5_000, text: value.text } } } } }
  const handle = createListenPage({ listen, ...options })
  return { handle, added, snapshots, set: value => { data = value } }
}

function request({ method = 'GET', path = '/listen/live.html', headers = {}, address = '127.0.0.1', body = '', chunks, stream } = {}) {
  const req = stream ?? Readable.from(chunks ?? (body ? [Buffer.from(body)] : []))
  req.method = method; req.url = path
  req.headers = { host: '127.0.0.1:5182', ...headers }
  req.socket = { remoteAddress: address, localPort: 5182 }
  return req
}

async function call(handle, options = {}) {
  const req = request(options)
  const response = { status: null, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body ?? '' } }
  const matched = await handle(req, response, options.normalizedPath)
  return { ...response, matched }
}
const json = (value, options = {}) => ({ method: 'POST', path: '/listen/note', body: JSON.stringify(value),
  ...options, headers: { 'content-type': 'application/json', ...options.headers } })
const form = (value, options = {}) => ({ method: 'POST', path: '/listen/note', body: new URLSearchParams(value).toString(),
  ...options, headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers } })

test('plain transcript has local wall and session timestamps, ordered newest at bottom', () => {
  const prior = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const data = sample()
    data.lines.reverse()
    const text = transcriptText(data)
    assert.match(text, /^Muse Listen \| session fixture-session \| started at 2026-10-30 08:00:00 \| live\n/)
    assert.match(text, /\[2026-10-30 08:00:01\] \[00:01\] First transcript line\n/)
    assert.ok(text.endsWith('[2026-10-30 08:00:05] [00:05] Newest transcript line\n'))
    assert.equal(formatWallTime(base), '2026-10-30 08:00:00')
    assert.equal(formatSessionTime(3_661_000), '1:01:01')
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior }
})

test('HTML refreshes at two seconds without replacing the draft form and escapes every user field', async () => {
  const f = fixture()
  f.set({ ...sample(), id: 'fixture"<id>', lines: [{ t: 0, text: '<script>bad()</script>&"' }],
    notes: [{ t: 1, at_t: 0, text: '<img src=x onerror=bad()>' }] })
  const view = await call(f.handle)
  assert.equal(view.status, 200)
  assert.match(view.body, /http-equiv="refresh" content="2"/)
  assert.match(view.body, /setInterval\(/)
  assert.match(view.body, /},2000\)/)
  assert.match(view.body, /<form method="post" action="\/listen\/note">/)
  assert.match(view.body, /textarea name="note"/)
  assert.match(view.body, /name="about"/)
  assert.match(view.body, /&lt;script&gt;bad\(\)&lt;\/script&gt;&amp;&quot;/)
  assert.match(view.body, /&lt;img src=x onerror=bad\(\)&gt;/)
  assert.doesNotMatch(view.body, /<img src=x|<script>bad\(\)/)
  assert.doesNotMatch(view.body, /location\.reload|textarea[^;]*replaceChildren/)
  assert.equal(view.headers['Cache-Control'], 'no-store')
  assert.equal(view.headers['Referrer-Policy'], 'same-origin', 'native same-origin form posts retain their Origin')
  assert.match(view.headers['Content-Security-Policy'], /form-action 'self'/)
  assert.equal(escapeHTML('&<>"\''), '&amp;&lt;&gt;&quot;&#39;')
})

test('loopback direct form and JSON admit no-token notes and parse about milliseconds', async () => {
  const f = fixture()
  const a = await call(f.handle, form({ note: 'Form note', about: '00:03' }))
  assert.equal(a.status, 303)
  assert.equal(a.headers.Location, '/listen/live.html')
  const b = await call(f.handle, json({ text: 'JSON note', about: '1:02:03' }))
  assert.equal(b.status, 200)
  assert.deepEqual(f.added, [{ id: 'fixture-session', text: 'Form note', at_t: 3000 },
    { id: 'fixture-session', text: 'JSON note', at_t: 3_723_000 }])
  await call(f.handle, json({ text: 'Default anchor' }))
  assert.deepEqual(f.added.at(-1), { id: 'fixture-session', text: 'Default anchor' })
})

test('refresh permits one request at a time and preserves both note/about drafts and their session binding', async () => {
  const page = await call(fixture().handle)
  const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]
  let refresh, finish, fetches = 0
  const nodes = Object.fromEntries(['transcript', 'recent-notes', 'session-state', 'note-availability'].map(id =>
    [id, { childNodes: [], scrollTop: 0, scrollHeight: 100, clientHeight: 50, replaceChildren(...children) { this.childNodes = children } }]))
  const note = { value: '' }, about = { value: '00:03' }, id = { value: 'old-session' }, field = { disabled: false }
  const select = { 'textarea[name=note]': note, 'input[name=about]': about, 'input[name=id]': id, fieldset: field }
  const incoming = { getElementById: key => ({ childNodes: [{ textContent: key + ' fresh' }] }),
    querySelector: key => key === 'input[name=id]' ? { value: 'new-session' } : { disabled: false } }
  const context = { document: { getElementById: key => nodes[key], querySelector: key => select[key], importNode: node => ({ ...node }) },
    location: { pathname: '/listen/live.html' }, DOMParser: class { parseFromString() { return incoming } },
    setInterval(callback, milliseconds) { assert.equal(milliseconds, 2000); refresh = callback },
    fetch() { fetches++; return new Promise(resolve => { finish = () => resolve({ ok: true, text: async () => 'fixture HTML' }) }) } }
  runInNewContext(script, context)
  const first = refresh()
  await refresh()
  assert.equal(fetches, 1)
  finish(); await first
  assert.equal(about.value, '00:03')
  assert.equal(id.value, 'old-session', 'an about-only draft must not silently move sessions')
  note.value = 'Keep this note'; about.value = ''
  const second = refresh(); finish(); await second
  assert.equal(note.value, 'Keep this note')
  assert.equal(id.value, 'old-session')
  note.value = ''
  const third = refresh(); finish(); await third
  assert.equal(id.value, 'new-session', 'only an empty form follows a new session automatically')
  assert.equal(fetches, 3)
  assert.equal(nodes.transcript.childNodes[0].textContent, 'transcript fresh')
})

test('IPv4 mapped loopback works while every other socket is refused even with a token', async () => {
  const f = fixture({ loopback: () => true })
  assert.equal((await call(f.handle, { address: '::ffff:127.0.0.1' })).status, 200)
  for (const address of ['::1', '127.0.0.2', '192.0.2.10', undefined]) {
    const req = request({ address: '127.0.0.1' }); req.socket.remoteAddress = address
    req.headers.authorization = 'Bearer fixture-valid-token'
    const response = { writeHead(status) { this.status = status }, end() {} }
    await f.handle(req, response)
    assert.equal(response.status, 403)
  }
  assert.equal(f.snapshots.length, 1)
})

test('forwarding and nonlocal Host or Origin never bypass loopback with tokens', async () => {
  const f = fixture()
  for (const headers of [
    { 'x-forwarded-for': '192.0.2.1' }, { forwarded: 'for=192.0.2.1' }, { 'x-real-ip': '127.0.0.1' },
    { 'x-forwarded-host': 'localhost:5182' }, { 'x-forwarded-proto': 'https' },
    { host: 'host.invalid:5182' }, { host: '127.0.0.1:9999' }, { host: 'user@127.0.0.1:5182' },
    { origin: 'http://host.invalid' }, { origin: 'null' }, { origin: 'http://localhost:5182' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) {
    const result = await call(f.handle, json({ text: 'Blocked' }, { headers: { ...headers, authorization: 'Bearer fixture-valid-token' } }))
    assert.equal(result.status, 403, JSON.stringify(headers))
  }
  assert.equal(f.snapshots.length, 0)
  assert.equal(f.added.length, 0)
  assert.equal((await call(f.handle, json({ text: 'Allowed' }, { headers: { origin: 'http://127.0.0.1:5182', 'sec-fetch-site': 'same-origin' } }))).status, 200)
})

test('optional loopback hook is only an additional veto', async () => {
  assert.equal((await call(fixture({ loopback: () => false }).handle)).status, 403)
  assert.equal((await call(fixture({ loopback: () => { throw new Error('private') } }).handle)).status, 403)
  assert.equal((await call(fixture({ loopback: () => true }).handle, { address: '192.0.2.10' })).status, 403)
})

test('all forwarded and Tailscale identity metadata variants are rejected even on loopback', async () => {
  const f = fixture()
  for (const header of ['tailscale-user-login', 'Tailscale-User-Login', 'tailscale-user-name', 'tailscale-user-profile-pic',
    'tailscale-custom-identity', 'x-forwarded-port', 'x-forwarded-prefix', 'x-forwarded-server', 'X-Forwarded-Custom']) {
    const result = await call(f.handle, json({ text: 'Must not admit proxy note' }, {
      headers: { [header]: 'fixture-proxy', authorization: 'Bearer fixture-valid-token' },
    }))
    assert.equal(result.status, 403, header)
  }
  assert.equal(f.snapshots.length, 0)
  assert.equal(f.added.length, 0)
  assert.equal((await call(f.handle, json({ text: 'Direct browser note' }, {
    headers: { origin: 'http://127.0.0.1:5182', 'sec-fetch-site': 'same-origin' },
  }))).status, 200)
})

test('stale form session, stopped sessions and chat mode do not admit notes', async () => {
  const f = fixture()
  assert.equal((await call(f.handle, form({ note: 'Old note', id: 'old-session' }))).status, 409)
  f.set({ ...sample(), state: 'stopped' })
  assert.equal((await call(f.handle, json({ text: 'Stopped note' }))).status, 410)
  f.set({ ...sample(), notesFrom: 'chat' })
  const html = await call(f.handle)
  assert.match(html.body, /Page notes are unavailable in chat mode/)
  assert.match(html.body, /<fieldset disabled>/)
  assert.equal((await call(f.handle, json({ text: 'Not a page session' }))).status, 409)
  assert.equal(f.added.length, 0)
})

test('malformed note fields, timestamps, duplicate forms and unsafe media types fail closed', async () => {
  const f = fixture()
  for (const about of ['-1:00', '00:60', '1:60:00', 'now', '1', 3, {}, '1:2:3:4']) {
    assert.equal((await call(f.handle, json({ text: 'Note', about }))).status, 400)
  }
  for (const value of [null, [], { text: '' }, { note: 'wrong JSON field' }, { text: 'Note', extra: true }]) {
    assert.equal((await call(f.handle, json(value))).status, 400)
  }
  assert.equal((await call(f.handle, { method: 'POST', path: '/listen/note', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'note=one&note=two' })).status, 400)
  assert.equal((await call(f.handle, { method: 'POST', path: '/listen/note', headers: { 'content-type': 'text/plain' }, body: 'Note' })).status, 415)
  assert.equal(f.added.length, 0)
  assert.equal(parseAbout('  '), undefined)
  assert.equal(parseAbout('65:05'), 3_905_000)
})

test('request body has a byte limit including chunked uploads and a stalled-body deadline', async () => {
  const f = fixture({ bodyTimeoutMs: 10 })
  assert.equal((await call(f.handle, json({ text: 'Note' }, { headers: { 'content-length': String(NOTE_BODY_BYTES + 1) } }))).status, 413)
  assert.equal((await call(f.handle, json({ text: 'x'.repeat(NOTE_BODY_BYTES) }))).status, 413)
  const stream = new PassThrough()
  const result = await call(f.handle, json({ text: 'Note' }, { stream }))
  assert.equal(result.status, 408)
  stream.destroy()
  assert.equal(f.added.length, 0)
})

test('an aborted body and its follow-up stream error are a private client error, not an unhandled hub error', async () => {
  const f = fixture()
  const stream = new PassThrough()
  const pending = call(f.handle, json({ text: 'Interrupted' }, { stream }))
  stream.emit('aborted')
  assert.doesNotThrow(() => stream.emit('error', new Error('PRIVATE STREAM DETAIL')))
  const response = await pending
  assert.equal(response.status, 400)
  assert.doesNotMatch(response.body, /PRIVATE STREAM DETAIL/)
  assert.equal(f.added.length, 0)
  stream.destroy()
})

test('page note through the actual in-memory engine appears in the API snapshot with no relay calls', async () => {
  let now = base, asks = 0
  const timers = new Map()
  let timerId = 0
  const listen = createListen({ now: () => now, idFactory: () => 'real-engine-fixture',
    setTimer: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId }, clearTimer: id => timers.delete(id),
    transcribe: async () => 'Twenty five words are not needed for a manual page note.',
    ask: async () => { asks++; throw new Error('must not call relay') } })
  const started = listen.start().body
  now += 5000
  await listen.chunk(started.id, 0, new Uint8Array(32_000))
  const handle = createListenPage({ listen })
  const result = await call(handle, json({ text: '<useful> ' + 'note '.repeat(100), about: '00:03' }))
  assert.equal(result.status, 200)
  const note = JSON.parse(result.body).note
  assert.equal(note.at_t, 3000)
  assert.ok(note.text.length <= 300)
  assert.deepEqual(listen.state(started.id).body.notes, [note])
  assert.equal(asks, 0)
  listen.close()
  assert.equal(timers.size, 0)
})

test('unknown routes and engine failures are plain, bounded responses and never relay text', async () => {
  const f = fixture()
  assert.equal((await call(f.handle, { path: '/api/listen' })).matched, false)
  assert.equal((await call(f.handle, { path: '/listen/unknown' })).status, 404)
  assert.equal((await call(f.handle, { path: '/listen' })).status, 303)
  assert.equal((await call(f.handle, { method: 'OPTIONS' })).status, 405)
  const handle = createListenPage({ listen: { snapshot() { throw new Error('PRIVATE RELAY CONTENT') }, addNote() {} } })
  const result = await call(handle)
  assert.equal(result.status, 503)
  assert.doesNotMatch(result.body, /PRIVATE RELAY CONTENT/)
})
