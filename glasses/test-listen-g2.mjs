import test from 'node:test'
import assert from 'node:assert/strict'
import { G2_DIAGNOSTIC_TTL_MS as TTL, G2_ACTIVITY_PAUSE_MS as PAUSE, isListenG2Busy as busy } from './listen-g2.mjs'
const at = 1_000_000
const event = (name, detail = '', time = at) => ({ at: new Date(time).toISOString(), name, detail })

test('every diagnostic busy assertion expires at 2.5 minutes without refresh by reread', () => {
  const assertions = [event('muse.ask', 'queued'), event('mic.start', 'true'), event('mic.first-audio', '128'), event('frame', 'muse text'), event('frame', 'listen rebuild'), event('frame', 'confirm startup'), event('display', 'Muse'), event('menu', '7'), event('prompt', 'Muse confirm'), event('muse.shown', '503')]
  for (const assertion of assertions) {
    assert.equal(busy([assertion], at), true, assertion.name)
    assert.equal(busy([assertion], at + TTL - 1), true, assertion.name)
    assert.equal(busy([assertion], at + TTL), false, assertion.name)
    assert.equal(busy([assertion], at + TTL * 5), false, assertion.name)
  }
})
test('new relevant event renews only its own lease; unrelated callbacks do not', () => {
  const rows = [event('mic.start', 'true'), event('device', 'fixture', at + TTL - 1)]
  assert.equal(busy(rows, at + TTL + 1), false)
  rows.push(event('mic.first-audio', '256', at + TTL))
  assert.equal(busy(rows, at + TTL + 1), true)
  assert.equal(busy(rows, at + 2 * TTL), false)
})
test('mic stop/cancel/failed start clears mic evidence without a route mutation', () => {
  for (const done of [event('mic.stop', '3 chunks', at + 1), event('mic.cancel', 'not recording', at + 1), event('mic.start', 'false', at + 1)]) {
    assert.equal(busy([event('mic.start', 'true'), done], at + 2), true)
    assert.equal(busy([event('mic.start', 'true'), done], at + 1 + PAUSE), false)
  }
})
test('queued asks expire independently and terminal results clear oldest pending ask', () => {
  assert.equal(busy([event('muse.ask', 'queued'), event('muse.reply', 'done', at + 1)], at + 2), true)
  assert.equal(busy([event('muse.ask', 'queued'), event('muse.reply', 'done', at + 1)], at + 1 + PAUSE), false)
  for (const status of ['error', 'timeout', 'gave up: Muse took too long']) assert.equal(busy([event('muse.ask', 'queued'), event('muse.reply', status, at + 1)], at + 1 + PAUSE), false)
  const rows = [event('muse.ask', 'queued'), event('muse.ask', 'queued', at + TTL - 10), event('muse.reply', 'done', at + TTL + 1)]
  assert.equal(busy(rows, at + TTL + 2), true)
  assert.equal(busy(rows, at + TTL * 2), false)
})
test('known G2 frame/menu/display/prompt evidence blocks; leaving does not cancel other independent assertions', () => {
  for (const leave of [event('frame', 'home tiles', at + 1), event('menu', '4', at + 1), event('display', 'off', at + 1), event('muse.shown', 'not on screen', at + 1)]) assert.equal(busy([event('menu', '7'), leave], at + 1 + PAUSE), false)
  assert.equal(busy([event('mic.start', 'true'), event('display', 'off', at + 1)], at + 2), true)
  assert.equal(busy([event('prompt', 'fixture tmux ok=true')], at), false)
  assert.equal(busy([event('display', 'on')], at), false)
})
test('malformed/future events cannot create permanent busy; true real hub move is independent', () => {
  assert.equal(busy([{ at: 'invalid', name: 'mic.start' }, event('mic.start', 'true', at + 1)], at), false)
  assert.equal(busy(null, at), false)
  assert.equal(busy([], at, true), true)
  assert.equal(busy([], at, false), false)
})
test('bounded diagnostic tail and input ordering do not renew old evidence', () => {
  const rows = [event('mic.start', 'true'), ...Array.from({ length: 1000 }, () => event('device', 'fixture'))]
  assert.equal(busy(rows, at), false)
  assert.equal(busy([event('mic.stop', '', at + 10), event('mic.start', 'true')], at + 10 + PAUSE), false)
})

 test('terminal/stop activity enforces exact 60s, generic display-on never renews stale Muse', () => {
  for (const done of [event('mic.stop', '', at + 1), event('mic.cancel', '', at + 1), event('muse.reply', 'done', at + 1)]) {
    assert.equal(busy([done], at + PAUSE), true)
    assert.equal(busy([done], at + 1 + PAUSE), false)
  }
  const stale = [event('menu', '7'), event('display', 'on', at + TTL + 100)]
  assert.equal(busy(stale, at + TTL + 101), false)
})
