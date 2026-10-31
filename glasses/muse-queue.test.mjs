import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from './muse-queue.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)) }
const idle = () => ({ ok: true, composer: true, busy: false })
const muses = [
  { name: 'G2', url: 'http://first.invalid', token: 'fixture-first' },
  { name: 'Listen', url: 'http://last.invalid', token: 'fixture-last' },
]

function fixture(options = {}) {
  let time = 0, next = 0
  const timers = new Map(), calls = [], statuses = []
  const setTimer = (fn, ms) => { const id = ++next; timers.set(id, { at: time + ms, fn }); return id }
  const request = async (url, token, init) => {
    const call = { url, token, ...init }; calls.push(call)
    if (options.respond) return options.respond(call, calls)
    if (url.endsWith('/selftest')) return idle()
    if (url.endsWith('/ask')) return { id: 'job1' }
    return { status: 'done', reply: 'A useful note.' }
  }
  const client = api.createListenMuse({
    muses, isG2Busy: () => false, request, pollMs: 10, requestMs: 30, attemptMs: 100,
    now: () => time, setTimer, clearTimer: id => timers.delete(id), ...options,
  })
  return { client, calls, statuses, timers,
    ask: (extra = {}) => client.ask({ text: 'A conversation snippet', onStatus: s => statuses.push(s), ...extra }),
    tick: async ms => {
      const end = time + ms
      await flush()
      for (;;) {
        const entry = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        time = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush()
      }
      time = end; await flush()
    },
  }
}
const posts = f => f.calls.filter(c => c.method === 'POST')

test('factory is lazy and exposes only independent Listen asks', async () => {
  const f = fixture()
  assert.equal(f.calls.length, 0)
  assert.equal(api.createMuseQueue, undefined)
  assert.equal(api.createMuseBridge, undefined)
  assert.equal((await f.ask()).status, 'done')
  assert.equal(f.timers.size, 0)
})

test('last configured Muse alone receives the question; all other relays are checked twice', async () => {
  const f = fixture()
  assert.deepEqual(await f.ask(), { status: 'done', reply: 'A useful note.', reason: '' })
  assert.equal(posts(f).length, 1)
  assert.equal(posts(f)[0].url, 'http://last.invalid/ask')
  assert.equal(posts(f)[0].token, 'fixture-last')
  assert.deepEqual(f.calls.filter(c => c.url.endsWith('/selftest')).map(c => c.url), [
    'http://first.invalid/selftest', 'http://last.invalid/selftest',
    'http://first.invalid/selftest', 'http://last.invalid/selftest',
  ])
})

test('missing or invalid LAST configuration never falls back to first Muse', async () => {
  for (const config of [[], [muses[0], {}], [muses[0], { url: 'bad' }], [muses[0], { url: 'https://user:pass@last.invalid' }]]) {
    const f = fixture({ muses: config })
    assert.equal((await f.ask()).status, 'unavailable')
    assert.equal(f.calls.length, 0)
  }
})

test('G2 gate must explicitly return false, including the default unknown gate', async () => {
  for (const isG2Busy of [undefined, () => true, () => undefined, () => 'false', () => { throw Error('secret') }]) {
    const f = fixture({ isG2Busy })
    assert.equal((await f.ask()).status, 'busy')
    assert.equal(f.calls.length, 0)
  }
})

test('both chosen and other relay require exact ok/composer/busy health booleans', async () => {
  for (const bad of [{}, { ok: true, composer: true }, { ok: true, composer: 'true', busy: false },
    { ok: true, composer: true, busy: 'false' }, { ok: true, composer: true, busy: true },
    { ok: false, composer: true, busy: false }]) {
    for (const host of ['first', 'last']) {
      const f = fixture({ respond: c => c.url.includes(host) ? bad : idle() })
      assert.notEqual((await f.ask()).status, 'done')
      assert.equal(posts(f).length, 0)
    }
  }
})

test('read-only G2 gate is checked again after held health', async () => {
  const held = deferred(); let busy = false
  const f = fixture({ isG2Busy: () => busy, respond: c => c.url.includes('last') ? held.promise : idle() })
  const result = f.ask(); await flush(); busy = true; held.resolve(idle())
  assert.equal((await result).status, 'busy')
  assert.equal(posts(f).length, 0)
})

test('direct G2 activity on another relay during chosen health vetoes POST', async () => {
  const held = deferred(); let firstChecks = 0
  const f = fixture({ respond: c => {
    if (c.url.includes('first')) return ++firstChecks === 1 ? idle() : { ...idle(), busy: true, composer: false }
    return held.promise
  } })
  const result = f.ask(); await flush(); held.resolve(idle())
  assert.equal((await result).status, 'busy')
  assert.equal(posts(f).length, 0)
})

test('target becoming busy during the second other-relay pass vetoes POST', async () => {
  let targetChecks = 0
  const f = fixture({ respond: c => {
    if (c.url.includes('first')) return idle()
    if (c.url.endsWith('/selftest')) return ++targetChecks === 1 ? idle() : { ...idle(), busy: true, composer: false }
    return c.method === 'POST' ? { id: '1' } : { status: 'done', reply: 'Unexpected submission' }
  } })
  assert.equal((await f.ask()).status, 'busy')
  assert.equal(targetChecks, 2)
  assert.equal(posts(f).length, 0)
})

test('a concurrent Listen ask drops immediately instead of entering any queue', async () => {
  const held = deferred()
  const f = fixture({ respond: () => held.promise })
  const first = f.ask(); await flush()
  assert.equal((await f.ask({ text: 'another snippet' })).status, 'busy')
  assert.equal(f.calls.length, 1)
  await f.tick(30)
  assert.equal((await first).status, 'timeout')
  assert.equal(posts(f).length, 0)
})

test('queued/sending/waiting/running are polled to terminal and cleaned to 300 characters', async () => {
  const replies = ['queued', 'sending', 'waiting', 'running']; let reads = 0
  const f = fixture({ respond: c => {
    if (c.url.endsWith('/selftest')) return idle()
    if (c.method === 'POST') return { id: 'job_1' }
    if (reads < replies.length) return { status: replies[reads++] }
    return { status: 'done', reply: 'x'.repeat(350) + '\nStatus\nApprovals history\nAllowed once · 2h ago' }
  } })
  const result = f.ask(); await f.tick(40)
  assert.equal((await result).reply, 'x'.repeat(300))
  assert.equal(posts(f).length, 1)
  assert.equal(reads, 4)
  assert.equal(f.timers.size, 0)
})

test('window chrome is cleaned and the no-note em dash survives for the engine', async () => {
  for (const [reply, expected] of [['Useful.\nStatus\nApprovals history\nAllowed once · 2h ago', 'Useful.'], ['—', '—']]) {
    const f = fixture({ respond: c => c.url.endsWith('/selftest') ? idle() : c.method === 'POST' ? { id: '1' } : { status: 'done', reply } })
    assert.equal((await f.ask()).reply, expected)
  }
})

test('malformed or uncertain POST is never retried or sent to another relay', async () => {
  for (const receipt of [null, {}, { uncertain: true }, { id: 1 }, { id: '../escape' }, { id: 'x'.repeat(41) }]) {
    const f = fixture({ respond: c => c.url.endsWith('/selftest') ? idle() : receipt })
    assert.equal((await f.ask()).status, 'unavailable')
    assert.equal(posts(f).length, 1)
    assert.equal(f.calls.filter(c => c.url.includes('/reply/')).length, 0)
  }
})

test('POST errors are sanitized and a subsequent snippet is not poisoned', async () => {
  let attempts = 0
  const f = fixture({ respond: c => {
    if (c.url.endsWith('/selftest')) return idle()
    if (c.method === 'POST') {
      if (++attempts === 1) throw Error('http://private.invalid Bearer secret-key')
      return { id: 'fresh' }
    }
    return { status: 'done', reply: 'Recovered.' }
  } })
  const result = await f.ask()
  assert.equal(result.status, 'unavailable')
  assert.doesNotMatch(JSON.stringify([result, f.statuses]), /private|secret-key|Bearer/)
  assert.equal((await f.ask()).reply, 'Recovered.')
  assert.equal(attempts, 2)
})

test('each health, POST, and reply request has a hard timeout even if transport ignores abort', async () => {
  for (const stage of ['selftest', 'ask', 'reply']) {
    const f = fixture({ respond: c => {
      if (c.url.includes(`/${stage}`)) return new Promise(() => {})
      return c.url.endsWith('/selftest') ? idle() : { id: '1' }
    } })
    const result = f.ask(); await f.tick(30)
    assert.equal((await result).status, 'timeout')
    assert.equal(posts(f).length, stage === 'selftest' ? 0 : 1)
    assert.equal(f.timers.size, 0)
  }
})

test('whole attempt deadline bounds repeated nonterminal replies and poll waits', async () => {
  const f = fixture({ respond: c => c.url.endsWith('/selftest') ? idle() : c.method === 'POST' ? { id: '1' } : { status: 'waiting' } })
  const result = f.ask(); await f.tick(100)
  assert.equal((await result).status, 'timeout')
  assert.equal(posts(f).length, 1)
  assert.equal(f.timers.size, 0)
})

test('timeoutMs mount alias bounds the whole attempt', async () => {
  const f = fixture({ attemptMs: undefined, timeoutMs: 25, respond: () => new Promise(() => {}) })
  const result = f.ask(); await f.tick(25)
  assert.equal((await result).status, 'timeout')
  assert.equal(f.timers.size, 0)
})

test('abort from thinking observer prevents all I/O', async () => {
  const controller = new AbortController(), f = fixture()
  const result = await f.ask({ signal: controller.signal, onStatus: s => { if (s.state === 'thinking') controller.abort() } })
  assert.equal(result.status, 'cancelled')
  assert.equal(f.calls.length, 0)
  assert.equal(f.timers.size, 0)
})

test('cancel while health/POST/reply is pending settles promptly and ignores late result', async () => {
  for (const stage of ['selftest', 'ask', 'reply']) {
    const held = deferred(), controller = new AbortController()
    const f = fixture({ respond: c => c.url.includes(`/${stage}`) ? held.promise : c.url.endsWith('/selftest') ? idle() : { id: '1' } })
    const result = f.ask({ signal: controller.signal }); await flush(); controller.abort()
    assert.equal((await result).status, 'cancelled')
    const calls = f.calls.length, changes = f.statuses.length
    held.resolve(stage === 'selftest' ? idle() : stage === 'ask' ? { id: 'late' } : { status: 'done', reply: 'late' })
    await f.tick(200)
    assert.equal(f.calls.length, calls)
    assert.equal(f.statuses.length, changes)
    assert.equal(f.timers.size, 0)
  }
})

test('forgotten/invalid/error replies drop without retry and never expose relay error text', async () => {
  for (const reply of [null, {}, { status: 'mystery' }, { status: 'error', error: 'secret' }, { status: 'done', reply: 42 }]) {
    const f = fixture({ respond: c => c.url.endsWith('/selftest') ? idle() : c.method === 'POST' ? { id: '1' } : reply })
    const result = await f.ask()
    assert.notEqual(result.status, 'done')
    assert.doesNotMatch(JSON.stringify([result, f.statuses]), /secret/)
    assert.equal(posts(f).length, 1)
    assert.equal(f.calls.filter(c => c.url.includes('/reply/')).length, 1)
  }
})

test('invalid input and already-aborted attempts perform no I/O', async () => {
  const controller = new AbortController(); controller.abort()
  const f = fixture()
  for (const text of ['', ' ', 42, 'x'.repeat(16001)]) assert.equal((await f.ask({ text })).status, 'error')
  assert.equal((await f.ask({ signal: controller.signal })).status, 'cancelled')
  assert.equal(f.calls.length, 0)
})

test('independent fetch rejects redirects and oversized bodies without exposing credentials', async () => {
  for (const huge of [false, true]) {
    const calls = []
    const f = fixture({ request: undefined, fetch: async (url, init) => {
      calls.push({ url, ...init })
      if (huge) return new Response('x'.repeat(65537))
      return new Response(null, { status: 302, headers: { location: 'http://private.invalid' } })
    } })
    const result = await f.ask()
    assert.equal(result.status, 'unavailable')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].redirect, 'error')
    assert.equal(calls[0].headers.Authorization, 'Bearer fixture-first')
    assert.doesNotMatch(JSON.stringify([result, f.statuses]), /private|fixture-first/)
  }
})

test('independent fetch streams bounded JSON for success and sends a single JSON POST', async () => {
  const calls = []
  const f = fixture({ request: undefined, fetch: async (url, init) => {
    calls.push({ url, ...init })
    return new Response(JSON.stringify(url.endsWith('/selftest') ? idle() : init.method === 'POST' ? { id: '1' } : { status: 'done', reply: 'note' }))
  } })
  assert.equal((await f.ask()).reply, 'note')
  const sent = calls.filter(c => c.method === 'POST')
  assert.equal(sent.length, 1)
  assert.deepEqual(JSON.parse(sent[0].body), { text: 'A conversation snippet' })
})

test('rejected HTTP responses close their body stream', async () => {
  let closed = 0
  const f = fixture({ request: undefined, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('private error')) },
    cancel() { closed++ },
  }), { status: 503 }) })
  assert.equal((await f.ask()).status, 'unavailable')
  await flush()
  assert.equal(closed, 1)
})

test('stalled fetch body is hard bounded and its stream is cancelled', async () => {
  let closed = 0
  const f = fixture({ request: undefined, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{')) },
    cancel() { closed++ },
  })) })
  const result = f.ask(); await f.tick(30)
  assert.equal((await result).status, 'timeout')
  assert.equal(closed, 1)
  assert.equal(f.timers.size, 0)
})
