import test from 'node:test'
import assert from 'node:assert/strict'
import { createMuseQueue, createMuseBridge } from './muse-queue.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)) }

function fixture(options = {}) {
  let time = 0, active = 0, maximum = 0
  const calls = [], reads = [], waits = [], replies = new Map()
  const sleep = (ms, { signal } = {}) => new Promise(resolve => {
    const item = { at: time + ms, resolve }
    waits.push(item)
    signal?.addEventListener('abort', () => {
      const index = waits.indexOf(item)
      if (index >= 0) waits.splice(index, 1)
      resolve()
    }, { once: true })
  })
  const queue = createMuseQueue({
    now: () => time, sleep, pollMs: 10, timeoutMs: 100,
    ask: async (text, start) => {
      calls.push({ text, start })
      active++; maximum = Math.max(maximum, active)
      const id = `0-job${calls.length}`
      replies.set(id, { status: 'running', reply: '' })
      return { id, muse: 'fixture' }
    },
    read: async id => {
      reads.push(id)
      const result = replies.get(id)
      if (['done', 'error', 'timeout'].includes(result?.status) && !result.observed) {
        result.observed = true
        active--
      }
      return result
    },
    ...options,
  })
  return {
    queue, calls, reads, now: () => time, maximum: () => maximum,
    done: (id, reply = 'note') => replies.set(id, { status: 'done', reply }),
    reply: (id, value) => replies.set(id, value),
    tick: async ms => {
      time += ms
      for (const item of [...waits]) if (item.at <= time) {
        waits.splice(waits.indexOf(item), 1)
        item.resolve()
      }
      await flush()
    },
  }
}

test('one shared slot lasts through terminal reply; queued G2 asks win in FIFO order', async () => {
  const f = fixture()
  const first = f.queue.enqueue('listen one', { source: 'listen' })
  await flush()
  assert.deepEqual(await first.id, { id: '0-job1', muse: 'fixture' })
  const later = f.queue.enqueue('listen two', { source: 'listen' })
  const g1 = f.queue.enqueue('g2 one', { source: 'g2', start: 2 })
  const g2 = f.queue.enqueue('g2 two', { source: 'g2' })
  await flush()
  assert.deepEqual(f.calls.map(c => c.text), ['listen one'])
  assert.deepEqual(f.queue.snapshot().queued, { g2: 2, listen: 1 })
  for (const [id, next] of [['0-job1', 'g2 one'], ['0-job2', 'g2 two'], ['0-job3', 'listen two']]) {
    f.done(id)
    await f.tick(10)
    assert.equal(f.calls.at(-1).text, next)
  }
  assert.equal(f.calls[1].start, 2)
  f.done('0-job4')
  await f.tick(10)
  assert.equal((await later.result).status, 'done')
  assert.equal((await g1.result).status, 'done')
  assert.equal((await g2.result).status, 'done')
  assert.equal(f.maximum(), 1)
  assert.equal(f.queue.snapshot().active, null)
})

test('queued cancellation prevents any ask, including an already-aborted signal', async () => {
  const f = fixture()
  f.queue.enqueue('first', { source: 'g2' })
  await flush()
  const controller = new AbortController()
  const queued = f.queue.enqueue('cancel me', { source: 'listen', signal: controller.signal })
  controller.abort()
  assert.equal((await queued.result).status, 'cancelled')
  assert.equal(await queued.id, null)
  const already = f.queue.enqueue('never', { source: 'listen', signal: controller.signal })
  assert.equal((await already.result).status, 'cancelled')
  f.done('0-job1')
  await f.tick(10)
  assert.equal(f.calls.length, 1)
})

test('active cancellation drops delivery but does not release the shared slot', async () => {
  const f = fixture()
  const active = f.queue.enqueue('active', { source: 'listen' })
  await flush()
  const next = f.queue.enqueue('priority', { source: 'g2' })
  assert.equal(active.cancel(), true)
  assert.equal((await active.result).status, 'cancelled')
  await f.tick(200)
  assert.equal(f.calls.length, 1)
  assert.equal(f.queue.snapshot().blocked, true)
  assert.equal(active.status().state, 'idle')
  f.done('0-job1', 'late answer that must not arrive')
  await f.tick(10)
  assert.equal(f.calls.length, 2)
  assert.equal((await active.result).reply, '')
  f.done('0-job2')
  await f.tick(10)
  assert.equal((await next.result).status, 'done')
})

test('consumer timeout never frees a running or unreadable relay job', async () => {
  const f = fixture()
  const first = f.queue.enqueue('slow', { source: 'listen' })
  await flush()
  f.queue.enqueue('next', { source: 'g2' })
  await f.tick(101)
  assert.equal((await first.result).status, 'timeout')
  assert.equal(f.calls.length, 1)
  f.reply('0-job1', null)
  await f.tick(1000)
  assert.equal(f.calls.length, 1)
  f.done('0-job1')
  await f.tick(10)
  assert.equal(f.calls.length, 2)
})

test('no-send null releases; uncertain or malformed admissions block without leaking details', async () => {
  for (const value of [{ uncertain: true, error: 'PRIVATE-RELAY' }, { id: 'bad id', token: 'PRIVATE-TOKEN' }]) {
    let calls = 0
    const f = fixture({ ask: async () => { calls++; return value } })
    const job = f.queue.enqueue('question', { source: 'listen' })
    await flush()
    assert.equal(await job.id, null)
    const result = await job.result
    assert.equal(result.status, 'unavailable')
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
    f.queue.enqueue('blocked', { source: 'g2' })
    await f.tick(1000)
    assert.equal(calls, 1)
    assert.equal(f.queue.snapshot().blocked, true)
  }
  let calls = 0
  const f = fixture({ ask: async () => { calls++; return calls === 1 ? null : { id: '0-second', muse: 'fake' } } })
  const first = f.queue.enqueue('not sent', { source: 'g2' })
  await flush()
  assert.equal((await first.result).status, 'unavailable')
  f.queue.enqueue('second', { source: 'g2' })
  await flush()
  assert.equal(calls, 2)
})

test('rejected admission and read errors never expose raw relay errors or release uncertain work', async () => {
  const f = fixture({ ask: async () => { throw new Error('PRIVATE-KEY PRIVATE-RELAY') } })
  const job = f.queue.enqueue('question', { source: 'listen' })
  await flush()
  assert.doesNotMatch(JSON.stringify(await job.result), /PRIVATE/)
  assert.equal(f.queue.snapshot().blocked, true)
  const g = fixture({ read: async () => { throw new Error('PRIVATE-READ') } })
  const pending = g.queue.enqueue('question', { source: 'listen' })
  await flush()
  await g.tick(101)
  assert.equal((await pending.result).status, 'timeout')
  assert.doesNotMatch(JSON.stringify(pending.status()), /PRIVATE/)
})

test('done replies use Muse cleaning and 300-character cap; terminal errors are plain and never retried', async () => {
  const f = fixture()
  const first = f.queue.enqueue('question', { source: 'listen' })
  await flush()
  f.done('0-job1', 'Useful note.\nStatus\nApprovals history\nAllowed once · 2h ago\nPRIVATE-CHROME')
  await f.tick(10)
  assert.equal((await first.result).reply, 'Useful note.')
  const second = f.queue.enqueue('question', { source: 'listen' })
  await flush()
  f.done('0-job2', 'x'.repeat(500))
  await f.tick(10)
  assert.equal((await second.result).reply.length, 300)
  const third = f.queue.enqueue('question', { source: 'g2' })
  await flush()
  f.reply('0-job3', { status: 'error', error: 'Command failed: PRIVATE-RELAY', reply: 'PRIVATE-ERROR-BODY' })
  await f.tick(10)
  assert.equal((await third.result).status, 'error')
  assert.doesNotMatch(JSON.stringify(await third.result), /PRIVATE/)
  assert.equal(f.calls.length, 3)
})

test('status observers cannot break scheduling; cancelled observers never receive late updates', async () => {
  const statuses = []
  const f = fixture()
  const job = f.queue.enqueue('note', { source: 'listen', onStatus: value => { statuses.push(value.state); throw new Error('observer') } })
  await flush()
  job.cancel()
  const before = statuses.length
  f.done('0-job1')
  await f.tick(10)
  assert.equal(statuses.length, before)
  assert.ok(statuses.includes('thinking'))
})

test('queue bound and invalid inputs fail with fixed reasons and no sends', async () => {
  const f = fixture({ maxQueued: 1 })
  f.queue.enqueue('active', { source: 'g2' })
  await flush()
  f.queue.enqueue('queued', { source: 'g2' })
  const full = f.queue.enqueue('overflow', { source: 'g2' })
  assert.equal((await full.result).status, 'unavailable')
  assert.equal(f.calls.length, 1)
  const bad = f.queue.enqueue({}, { source: 'unknown' })
  assert.equal((await bad.result).status, 'error')
})

test('fast G2 virtual receipt is immediate after Listen has held the slot beyond eight seconds', async () => {
  const f = fixture({ timeoutMs: 100_000 })
  f.queue.enqueue('held Listen', { source: 'listen' })
  await flush()
  await f.tick(9000)
  const admitted = []
  const bridge = createMuseBridge(f.queue, { relayUrl: 'http://fixture.invalid/muse', now: f.now,
    idFactory: () => 'qtest1', onAdmitted: (...args) => admitted.push(args) })
  const receipt = bridge.ask('G2 question', 1)
  assert.deepEqual(receipt, { id: '0-qtest1', muse: 'queued' })
  assert.equal(receipt?.then, undefined)
  assert.deepEqual(bridge.lookup('http://fixture.invalid/muse/reply/qtest1'), {
    status: 'sending', question: 'G2 question', reply: '', error: '',
  })
  assert.equal(f.calls.length, 1)
  assert.equal(f.queue.snapshot().queued.g2, 1)
  f.done('0-job1')
  await f.tick(10)
  assert.deepEqual(admitted, [['0-qtest1', '0-job2']])
  assert.equal(f.calls[1].start, 1)
})

test('bridge only intercepts exact configured relay base and its own generated ids', async () => {
  const f = fixture()
  const bridge = createMuseBridge(f.queue, { relayUrl: 'https://fixture.invalid/muse', idFactory: () => 'qknown' })
  bridge.ask('question')
  for (const url of ['https://other.invalid/muse/reply/qknown', 'http://fixture.invalid/muse/reply/qknown',
    'https://fixture.invalid/other/reply/qknown', 'https://fixture.invalid/muse/reply/qmissing',
    'https://fixture.invalid/muse/reply/qknown?x=1']) assert.equal(bridge.lookup(url), undefined)
  assert.equal(bridge.lookup('https://fixture.invalid/muse/reply/qknown').status, 'sending')
  await flush()
})

test('bridge converts no-send and uncertainty to sanitized terminal legacy reply shapes', async () => {
  const f = fixture({ ask: async () => ({ uncertain: true, error: 'PRIVATE-RELAY' }) })
  const bridge = createMuseBridge(f.queue, { relayUrl: 'http://fixture.invalid', idFactory: () => 'quncertain' })
  bridge.ask('question')
  await flush()
  const reply = bridge.lookup('http://fixture.invalid/reply/quncertain')
  assert.equal(reply.status, 'error')
  assert.equal(reply.reply, '')
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE|Command failed/)
  assert.equal(f.queue.snapshot().blocked, true)
})

test('late admission after timeout remains owned until its real terminal reply', async () => {
  const admission = deferred()
  let calls = 0
  const f = fixture({ ask: async () => { calls++; return admission.promise } })
  const old = f.queue.enqueue('old', { source: 'listen' })
  await flush()
  f.queue.enqueue('next', { source: 'g2' })
  await f.tick(101)
  assert.equal((await old.result).status, 'timeout')
  assert.equal(await old.id, null)
  admission.resolve({ id: '0-late', muse: 'fake' })
  await flush()
  assert.equal(calls, 1)
  assert.equal(f.queue.snapshot().blocked, true)
  f.done('0-late')
  await f.tick(10)
  assert.equal(calls, 2)
  assert.equal((await old.result).reply, '')
})

test('bridge capacity pruning never removes the terminal result being looked up', async () => {
  const f = fixture({ ask: async () => null })
  let id = 0
  const bridge = createMuseBridge(f.queue, { relayUrl: 'http://fixture.invalid', maxEntries: 1,
    idFactory: () => `q${++id}` })
  bridge.ask('first')
  await flush()
  const result = bridge.lookup('http://fixture.invalid/reply/q1')
  assert.notEqual(result, undefined)
  assert.equal(result.status, 'error')
  assert.equal(bridge.ask('second').id, '0-q2')
  assert.equal(bridge.lookup('http://fixture.invalid/reply/q2').status, 'sending')
  await flush()
})

test('idle factory and snapshots never probe or poll Muse', async () => {
  const f = fixture()
  await f.tick(100_000)
  assert.deepEqual(f.queue.snapshot(), { active: null, queued: { g2: 0, listen: 0 }, blocked: false })
  assert.equal(f.calls.length, 0)
  assert.equal(f.reads.length, 0)
})

test('missing or malformed relay configuration never crashes HUD setup or sends a G2 ask', async () => {
  const f = fixture()
  for (const relayUrl of [undefined, '', 'not a URL', 'file:///private/fixture', 'http://user:secret@fixture.invalid',
    'https://fixture.invalid?secret=value', 'https://fixture.invalid/#fragment']) {
    let bridge
    assert.doesNotThrow(() => { bridge = createMuseBridge(f.queue, { relayUrl }) })
    assert.equal(bridge.lookup('http://fixture.invalid/reply/qanything'), undefined)
    assert.equal(bridge.ask('do not send'), null)
  }
  await flush()
  assert.equal(f.calls.length, 0)
})

test('unknown admission settles queued and future clients without releasing the physical slot', async () => {
  const admission = deferred()
  let calls = 0
  const f = fixture({ ask: async () => { calls++; return admission.promise } })
  f.queue.enqueue('active Listen', { source: 'listen' })
  await flush()
  const queued = f.queue.enqueue('queued G2', { source: 'g2' })
  let result
  queued.result.then(value => { result = value })
  admission.resolve({ uncertain: true, error: 'PRIVATE-RELAY' })
  await flush()
  assert.equal(result?.status, 'unavailable')
  assert.match(result.reason, /previous question/)
  assert.equal(await queued.id, null)
  const next = f.queue.enqueue('new G2', { source: 'g2' })
  assert.equal((await next.result).status, 'unavailable')
  assert.equal(await next.id, null)
  assert.equal(calls, 1)
  assert.deepEqual(f.queue.snapshot(), { active: 'listen', queued: { g2: 0, listen: 0 }, blocked: true })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})

test('thinking observers can cancel before ask and release a proven unsent slot', async () => {
  for (const observer of ['status', 'change']) {
    const controller = new AbortController()
    const f = fixture({ onChange: value => { if (observer === 'change' && value.active === 'listen') controller.abort() } })
    const first = f.queue.enqueue('cancel before ask', { source: 'listen', signal: controller.signal,
      onStatus: value => { if (observer === 'status' && value.state === 'thinking') controller.abort() } })
    await flush()
    assert.equal((await first.result).status, 'cancelled')
    assert.equal(f.calls.length, 0)
    assert.equal(f.queue.snapshot().active, null)
    f.queue.enqueue('G2 still works', { source: 'g2' })
    await flush()
    assert.equal(f.calls.length, 1)
  }
})

test('cancel during pre-send health check aborts only the pre-send signal and null releases', async () => {
  const health = deferred()
  let attempts = 0, posts = 0, preSendSignal
  const f = fixture({ ask: async (text, start, options) => {
    attempts++
    if (attempts === 1) preSendSignal = options?.signal
    await health.promise
    if (options?.signal?.aborted) return null
    posts++
    return { id: '0-posted', muse: 'fixture' }
  }, read: async () => ({ status: 'done', reply: 'answer' }) })
  const first = f.queue.enqueue('stopped Listen', { source: 'listen' })
  await flush()
  const next = f.queue.enqueue('queued G2', { source: 'g2' })
  first.cancel()
  assert.equal(preSendSignal?.aborted, true)
  assert.equal(posts, 0)
  assert.equal(attempts, 1)
  health.resolve()
  await flush()
  assert.equal((await first.result).status, 'cancelled')
  assert.equal((await next.result).status, 'done')
  assert.equal(attempts, 2)
  assert.equal(posts, 1)
})

test('timeout then stop during health check prevents a late POST and queued G2 still works', async () => {
  const health = deferred()
  const caller = new AbortController()
  let attempts = 0, posts = 0, preSendSignal
  const f = fixture({ ask: async (text, start, options) => {
    attempts++
    if (attempts === 1) preSendSignal = options.signal
    await health.promise
    if (options.signal.aborted) return null
    posts++
    return { id: '0-live', muse: 'fixture' }
  }, read: async () => ({ status: 'done', reply: 'G2 answer' }) })
  const old = f.queue.enqueue('Listen before stop', { source: 'listen', signal: caller.signal })
  await flush()
  const next = f.queue.enqueue('queued G2', { source: 'g2' })
  await f.tick(101)
  assert.equal((await old.result).status, 'timeout')
  caller.abort()
  assert.equal(preSendSignal.aborted, true)
  assert.equal(posts, 0)
  assert.equal(attempts, 1)
  health.resolve()
  await flush()
  assert.equal((await next.result).status, 'done')
  assert.equal(posts, 1)
  assert.equal(attempts, 2)
  assert.equal((await old.result).reply, '')
})
