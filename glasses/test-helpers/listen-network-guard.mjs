// TEST ONLY. Load with node --import before the hub. Never import from production.
// LISTEN_TEST_ALLOW_PORTS lists explicit fixture loopback ports; all other
// network destinations and all child commands are denied. The audit contains
// only denial categories, never URLs, headers, prompts, argv or credentials.
import { appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { urlToHttpOptions } from 'node:url'

const livePorts = new Set([5180, 5181, 5182, 8765, 8791, 18080, 18081])
const ports = String(process.env.LISTEN_TEST_ALLOW_PORTS || '').split(',').filter(Boolean).map(Number)
if (!ports.length || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535 || livePorts.has(p))) {
  throw new Error('Listen fixture requires explicit non-live loopback ports')
}
const allowed = new Set(ports)
const audit = process.env.LISTEN_TEST_GUARD_LOG

function deny(kind) {
  if (audit) appendFileSync(audit, JSON.stringify({ blocked: kind }) + '\n', { mode: 0o600 })
  throw new Error(`Listen fixture guard blocked ${kind}`)
}

function endpoint(host, port, protocol = 'http:') {
  const plain = String(host || 'localhost').replace(/^\[|\]$/g, '').toLowerCase()
  if (!['127.0.0.1', '::1', 'localhost'].includes(plain) || !allowed.has(Number(port)) || !['http:', 'https:'].includes(protocol)) {
    deny('network')
  }
}

function checkedUrl(value) {
  let url
  try { url = new URL(value) } catch { deny('network') }
  if (url.username || url.password) deny('network')
  endpoint(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), url.protocol)
  return url
}

const originalFetch = globalThis.fetch
globalThis.fetch = function guardedFetch(input, options = {}) {
  checkedUrl(typeof input === 'string' || input instanceof URL ? input : input?.url)
  if (options.dispatcher) deny('custom-socket')
  // A permitted fixture URL must not redirect into a real provider or relay.
  return originalFetch(input, { ...options, redirect: 'error' })
}

function requestOptions(args, protocol) {
  let options
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    options = { ...urlToHttpOptions(checkedUrl(args[0])), ...(typeof args[1] === 'object' ? args[1] : {}) }
  } else {
    options = { ...args[0] }
  }
  if (options.socketPath || options.createConnection || options.lookup || (options.agent !== undefined && options.agent !== false)) {
    deny('custom-socket')
  }
  endpoint(options.hostname || options.host, options.port || (protocol === 'https:' ? 443 : 80), options.protocol || protocol)
}

for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  for (const name of ['request', 'get']) {
    const original = module[name]
    module[name] = function guardedRequest(...args) {
      requestOptions(args, protocol)
      return Reflect.apply(original, this, args)
    }
  }
}

function socketOptions(args) {
  let first = args[0]
  if (Array.isArray(first)) first = first[0]
  const options = typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }
  if (!options || options.path || options.lookup) deny('custom-socket')
  endpoint(options.host || options.hostname, options.port)
}

for (const name of ['connect', 'createConnection']) {
  const original = net[name]
  net[name] = function guardedConnect(...args) {
    socketOptions(args)
    return Reflect.apply(original, this, args)
  }
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedSocket(...args) {
  socketOptions(args)
  return Reflect.apply(connect, this, args)
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = function blockedChild() { deny('child-command') }
}
childProcess.ChildProcess.prototype.spawn = function blockedChildInstance() { deny('child-command') }
// The hub imports named built-ins (execFile), which must see these guards too.
syncBuiltinESMExports()
