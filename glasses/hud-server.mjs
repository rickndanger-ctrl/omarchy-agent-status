#!/usr/bin/env node
// Home HUD server for the Even G2 "Home" glasses app.
//
//   node mode: reports this machine's agent sessions (status.py sessions) and
//              holds this machine's pending Claude Code approvals.
//   hub mode:  everything a node does, plus it polls the other nodes over
//              Tailscale and adds the Messages relay summary and, on request
//              only, Muse's latest reply. The glasses app talks to the hub.
//
// No dependencies. Nothing from prompts, messages or Muse is written to disk;
// pending approvals live in memory only.
//
// Endpoints (Bearer token unless noted; a leading /hud from Tailscale Serve is stripped):
//   GET  /api/health                          (no token)
//   GET  /api/home                            time, machines, sessions, pending, messages summary
//   GET  /api/node?seen=<ms>&paused=0|1       one node's sessions + pending (hub → node)
//   POST /api/decide {machine, id, behavior}  behavior: allow | deny | desk
//   POST /api/focus  {machine, workspace}     laptop only: switch Hyprland workspace
//   POST /api/pause  {paused}                 stop sending approvals to the glasses
//   POST /api/prompt {machine, pane, text|key} type a prompt into an agent's tmux pane (key: Escape)
//   POST /api/transcribe  (16 kHz s16le mono PCM body) → {text}   speech-to-text via Groq Whisper
//   GET  /api/messages?chat=<id>              hub: last messages of one chat (read-only)
//   GET  /api/muse                            hub: Muse's latest exchange (read-only, on demand)
//   POST /api/hook/request, GET /api/hook/wait/<id>, POST /api/hook/cancel/<id>
//                                             approve_hook.py on this machine (loopback only)
//   GET  /, /assets/*                         the built glasses app (no token)

import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
// macOS keeps lsof in /usr/sbin, which launchd's default PATH leaves out.
// Agents often live in ~/.local/bin or Homebrew, which launchd's PATH also leaves out.
process.env.PATH = [path.join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH, '/usr/sbin', '/sbin'].filter(Boolean).join(':')
const here = path.dirname(fileURLToPath(import.meta.url))
const HOME = homedir()
const CONFIG_DIR = path.join(HOME, '.config/agent-glasses')
const STATUS_PY = path.join(here, '..', 'status.py')

const SEEN_WINDOW_MS = 10_000 // the hook waits for the glasses only if they polled this recently
const PENDING_TTL_MS = 200_000
const NODE_TIMEOUT_MS = 1_500

// ---- config ------------------------------------------------------------------

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const MODE = arg('mode') || process.env.HUD_MODE || 'node'
const PORT = Number(arg('port') || process.env.HUD_PORT || 5182)
const HOSTS = (arg('host') || process.env.HUD_HOST || '127.0.0.1').split(',').map(s => s.trim()).filter(Boolean)
const DEMO = process.env.HUD_DEMO === '1'
const APP_DIR = path.resolve(arg('app') || process.env.HUD_APP_DIR || path.join(here, 'home-app/dist'))

function shortMachine() {
  const h = hostname().toLowerCase()
  if (h.includes('mini-2')) return 'Mini 2'
  if (h.includes('mini-1') || h.includes('mini1')) return 'Mini 1'
  if (h.includes('neo')) return 'Neo'
  if (h.startsWith('omarchy')) return 'Dell'
  return h.slice(0, 6)
}
const MACHINE = arg('machine') || process.env.HUD_MACHINE || shortMachine()

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// One token for the phone. On mini 1 the hub reuses the relays' shared token so
// the glasses apps still need just one; elsewhere a token file is made once.
function loadToken() {
  const file = process.env.HUD_TOKEN_FILE || path.join(CONFIG_DIR, 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  for (const shared of ['.messages-relay/config.json', '.muse-relay/config.json']) {
    const token = readJson(path.join(HOME, shared))?.token
    if (token) return token
  }
  const token = randomBytes(18).toString('base64url')
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}
const TOKEN = loadToken()

// hub.json: {"nodes":[{"name":"lap","url":"http://100.x.y.z:5182","tokenFile":"~/.config/agent-glasses/lap.token"}],
//            "messagesUrl":"http://127.0.0.1:5181","museUrl":"http://127.0.0.1:5180"}
const expand = p => (p && p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)
// A token file is either the bare token or a relay's JSON config with a "token" field.
const tokenFrom = file => {
  let text = ''
  try {
    text = readFileSync(expand(file), 'utf8').trim()
  } catch {
    console.error(`Home HUD: cannot read ${file}; that connection is skipped until it exists.`)
    return ''
  }
  try { return JSON.parse(text).token ?? text } catch { return text }
}
const HUB = MODE === 'hub' ? readJson(process.env.HUD_HUB_CONFIG || path.join(CONFIG_DIR, 'hub.json')) || {} : {}
const NODES = (HUB.nodes || []).map(n => ({
  name: String(n.name),
  url: String(n.url).replace(/\/$/, ''),
  token: n.tokenFile ? tokenFrom(n.tokenFile) : TOKEN,
}))
const RELAY_TOKEN = HUB.messagesTokenFile ? tokenFrom(HUB.messagesTokenFile) : readJson(path.join(HOME, '.messages-relay/config.json'))?.token || ''
// Muse relays in order of preference (hub.json "muse"), else the single local museUrl.
const MUSES = (HUB.muse ?? (HUB.museUrl ? [{ name: 'local', url: HUB.museUrl }] : [])).map(m => ({
  name: String(m.name),
  url: String(m.url).replace(/\/$/, ''),
  token: m.tokenFile ? tokenFrom(m.tokenFile) : RELAY_TOKEN,
}))

// ---- local state ---------------------------------------------------------------

let glassesSeen = 0
let pairing = null // { code, until, misses }: one-time code that exchanges for the token
const diagnostics = []
let paused = false
const pending = new Map() // id -> {id, agent, page, tool, summary, at, behavior, waiters}

function expirePending() {
  const now = Date.now()
  for (const [id, item] of pending) if (now - item.at > PENDING_TTL_MS) finish(id, null)
}

function finish(id, behavior) {
  const item = pending.get(id)
  if (!item) return false
  pending.delete(id)
  for (const resolve of item.waiters) resolve(behavior)
  return true
}

const publicPending = () =>
  [...pending.values()].map(({ id, agent, page, tool, summary, at }) => ({ id, agent, page, tool, summary, at, machine: MACHINE }))

async function localSessions() {
  if (DEMO) return demoSessions()
  try {
    const { stdout } = await run('python3', [STATUS_PY, 'sessions'], { timeout: 4000 })
    return JSON.parse(stdout).sessions.map(s => ({ ...s, machine: MACHINE }))
  } catch {
    return []
  }
}

// ---- agents in tmux (started with the `ag` launcher) --------------------------------

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', hermes: 'Hermes' }

/** Every tmux pane with an agent running in it: the panes the glasses can type into. */
async function agentPanes() {
  let panes, processes
  try {
    // Spaces, path last: newer tmux prints a tab in -F output as "_".
    panes = (await run('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_current_path}'], { timeout: 2000 })).stdout
    processes = (await run('ps', ['-eo', 'pid=,ppid=,args='], { timeout: 2000 })).stdout
  } catch {
    return []
  }
  const children = new Map()
  const agentOf = new Map()
  for (const row of processes.split('\n')) {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, args] = m
    ;(children.get(ppid) ?? children.set(ppid, []).get(ppid)).push(pid)
    // "claude …", "/opt/homebrew/bin/codex …" or "node /…/codex …"
    const words = args.split(/\s+/).slice(0, 2).map(w => path.basename(w))
    const agent = words.find(w => AGENT_NAMES[w])
    if (agent) agentOf.set(pid, agent)
  }
  const result = []
  for (const line of panes.split('\n')) {
    const [, pane, pid, cwd] = line.match(/^(\S+) (\S+) ?(.*)$/) ?? []
    if (!/^%\d+$/.test(pane || '')) continue
    const queue = [pid]
    for (let i = 0; i < queue.length && i < 200; i++) {
      const agent = agentOf.get(queue[i])
      if (agent) {
        result.push({ pane, agent, page: path.basename(cwd || ''), pid: queue[i], cwd })
        break
      }
      queue.push(...(children.get(queue[i]) ?? []))
    }
  }
  return result
}

/**
 * Agents running in an ordinary terminal window on Hyprland (no tmux needed): the
 * agent process, its project folder, and the window it lives in.
 */
async function agentWindows() {
  if (process.platform !== 'linux') return []
  let clients, processes
  try {
    clients = JSON.parse((await run('hyprctl', ['clients', '-j'], { timeout: 2000 })).stdout)
    processes = (await run('ps', ['-eo', 'pid=,ppid=,args='], { timeout: 2000 })).stdout
  } catch {
    return []
  }
  const windowByPid = new Map(clients.filter(c => c.pid > 0).map(c => [String(c.pid), c]))
  const parent = new Map()
  const agents = []
  for (const row of processes.split('\n')) {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    parent.set(m[1], m[2])
    const agent = m[3].split(/\s+/).slice(0, 2).map(w => path.basename(w)).find(w => AGENT_NAMES[w])
    if (agent) agents.push({ pid: m[1], agent })
  }
  const result = []
  for (const { pid, agent } of agents) {
    let cwd = ''
    try {
      cwd = (await run('readlink', [`/proc/${pid}/cwd`], { timeout: 1000 })).stdout.trim()
    } catch { /* process ended */ }
    let window
    for (let p = parent.get(pid), i = 0; p && p !== '1' && i < 32; p = parent.get(p), i++) {
      if (windowByPid.has(p)) {
        window = windowByPid.get(p)
        break
      }
    }
    if (window && /^0x[0-9a-f]+$/.test(window.address)) {
      result.push({ agent, page: path.basename(cwd), window: window.address, workspace: String(window.workspace?.id ?? ''), pid, cwd })
    }
  }
  return result
}

/** GNU screen sessions with an agent in them (Macs without tmux). Pane ids look like "screen:1234.claude". */
async function agentScreens() {
  let list, processes
  try {
    list = (await run('screen', ['-ls'], { timeout: 2000 }).catch(e => ({ stdout: e.stdout || '' }))).stdout
    if (!/\d+\.\S+/.test(list)) return []
    processes = (await run('ps', ['-eo', 'pid=,ppid=,args='], { timeout: 2000 })).stdout
  } catch {
    return []
  }
  const children = new Map()
  const agentOf = new Map()
  for (const row of processes.split('\n')) {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    ;(children.get(m[2]) ?? children.set(m[2], []).get(m[2])).push(m[1])
    const agent = m[3].split(/\s+/).slice(0, 2).map(w => path.basename(w)).find(w => AGENT_NAMES[w])
    if (agent) agentOf.set(m[1], agent)
  }
  const result = []
  for (const [, pid, name] of list.matchAll(/^\s*(\d+)\.(\S+)\s/gm)) {
    const queue = [pid]
    for (let i = 0; i < queue.length && i < 200; i++) {
      const agent = agentOf.get(queue[i])
      if (agent) {
        let cwd = ''
        try {
          cwd = (await run('lsof', ['-a', '-p', queue[i], '-d', 'cwd', '-Fn'], { timeout: 2000 })).stdout.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? ''
        } catch { /* unknown folder */ }
        result.push({ pane: `screen:${pid}.${name}`, agent, page: path.basename(cwd), pid: queue[i], cwd })
        break
      }
      queue.push(...(children.get(queue[i]) ?? []))
    }
  }
  return result
}

/** Status sessions, each linked to its tmux pane when it has one; idle agents in tmux are listed too. */
async function sessionsWithPanes() {
  const [sessions, tmuxPanes, screens, windows] = await Promise.all([localSessions(), DEMO ? [] : agentPanes(), DEMO ? [] : agentScreens(), DEMO ? [] : agentWindows()])
  const panes = [...tmuxPanes, ...screens]
  const byRecency = [...sessions].sort((a, b) => b.at - a.at)
  for (const pane of panes) {
    const match = byRecency.find(s => !s.pane && s.agent === pane.agent && s.page === pane.page)
    if (match) match.pane = pane.pane
    else sessions.push({ agent: pane.agent, name: AGENT_NAMES[pane.agent], session: `tmux${pane.pane}`, state: 'idle', page: pane.page, at: 0, workspace: '', machine: MACHINE, pane: pane.pane })
  }
  // Agents in a plain terminal window (no tmux): prompt them by typing into that window.
  for (const win of windows) {
    if (sessions.some(s => s.window === win.window)) continue
    // Same project folder first; otherwise the newest live session of that agent on the same workspace
    // (Claude reports the folder it last worked in, which can differ from where it was started).
    const free = s => !s.pane && !s.window && s.agent === win.agent
    const match = byRecency.find(s => free(s) && s.page === win.page) ??
      byRecency.find(s => free(s) && s.state !== 'stopped' && String(s.workspace).split(',').includes(win.workspace))
    if (match) Object.assign(match, { window: win.window, workspace: win.workspace || match.workspace })
    else if (!panes.some(p => p.agent === win.agent && p.page === win.page)) {
      sessions.push({ agent: win.agent, name: AGENT_NAMES[win.agent], session: `win${win.window}`, state: 'idle', page: win.page, at: 0, workspace: win.workspace, machine: MACHINE, window: win.window })
    }
  }
  // The apps' own threads, so they can be followed (Codex app) or continued (Claude app) from the glasses.
  const [appThreads, desktops] = await Promise.all([codexAppThreads(), claudeDesktopSessions()])
  // A desktop session also reports through the status hooks; keep only the desktop row for that folder.
  const desktopFolders = new Set(desktops.map(d => d.folder))
  const kept = sessions.filter(x => !(x.agent === 'claude' && !x.pane && !x.window && desktopFolders.has(x.page)))
  return [...kept, ...appThreads, ...desktops]
}

/** Hyprland workspaces and their windows (Linux machines only). */
async function desktop() {
  if (DEMO) return { active: 1, workspaces: [{ id: 1, windows: ['Alacritty: claude'] }, { id: 2, windows: ['Chromium: Even Hub docs'] }, { id: 3, windows: ['Alacritty: codex'] }] }
  try {
    const [clients, active] = await Promise.all([
      run('hyprctl', ['clients', '-j'], { timeout: 2000 }).then(r => JSON.parse(r.stdout)),
      run('hyprctl', ['activeworkspace', '-j'], { timeout: 2000 }).then(r => JSON.parse(r.stdout)),
    ])
    const byId = new Map()
    for (const c of clients) {
      const id = c.workspace?.id
      if (!Number.isInteger(id) || id <= 0) continue
      ;(byId.get(id) ?? byId.set(id, []).get(id)).push(`${c.class || '?'}: ${c.title || ''}`.slice(0, 80))
    }
    return { active: active.id, workspaces: [...byId].sort((a, b) => a[0] - b[0]).map(([id, windows]) => ({ id, windows })) }
  } catch {
    return null
  }
}

// ---- app threads: the ChatGPT app's Codex threads and the Claude desktop app's sessions -----------------

// Codex's own engine (the app-server daemon the ChatGPT app uses) speaks JSON-RPC over a WebSocket on a
// local Unix socket. One short connection per request keeps this simple and robust.
const CODEX_SOCKET = path.join(HOME, '.codex/app-server-control/app-server-control.sock')

async function codexEngine(calls) {
  const { default: net } = await import('node:net')
  const { realpathSync } = await import('node:fs')
  const socketPath = realpathSync(CODEX_SOCKET)
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath)
    let buf = Buffer.alloc(0)
    let upgraded = false
    let nextId = 1
    const waiting = new Map()
    const timer = setTimeout(() => { c.destroy(); reject(new Error('Codex engine did not answer')) }, 20_000)
    const frame = text => {
      const body = Buffer.from(text)
      const mask = randomBytes(4)
      let head
      if (body.length < 126) head = Buffer.from([0x81, 0x80 | body.length])
      else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(body.length, 2) }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(body.length), 2) }
      return Buffer.concat([head, mask, Buffer.from(body.map((b, i) => b ^ mask[i % 4]))])
    }
    const call = (method, params) => new Promise((ok, fail) => {
      const id = nextId++
      waiting.set(id, m => (m.error ? fail(new Error(m.error.message ?? 'Codex error')) : ok(m.result)))
      c.write(frame(JSON.stringify({ id, method, params })))
    })
    c.on('connect', () => c.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    c.on('error', error => { clearTimeout(timer); reject(error) })
    c.on('data', async data => {
      buf = Buffer.concat([buf, data])
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        buf = buf.slice(end + 4)
        upgraded = true
        try {
          await call('initialize', { clientInfo: { name: 'home-hud', version: '1' } })
          c.write(frame(JSON.stringify({ method: 'initialized' })))
          const result = await calls(call)
          clearTimeout(timer)
          c.end()
          resolve(result)
        } catch (error) {
          clearTimeout(timer)
          c.destroy()
          reject(error)
        }
      }
      while (buf.length >= 2) {
        let len = buf[1] & 127
        let off = 2
        if (len === 126) { len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10 }
        if (buf.length < off + len) break
        const text = buf.slice(off, off + len).toString()
        buf = buf.slice(off + len)
        try {
          const m = JSON.parse(text)
          if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
        } catch { /* a notification we don't need */ }
      }
    })
  })
}

const AUTOMATIC = /^Review this change for security vulnerabilities/i

// Codex's engine can take over a second to list threads, longer than the hub waits for a node. So the
// list is kept in memory and refreshed in the background (at most every 5 s); callers get the last one.
let appThreadsCache = { list: [], at: 0, loading: null }
async function codexAppThreads() {
  if (DEMO || !existsSync(CODEX_SOCKET)) return []
  if (!appThreadsCache.loading && Date.now() - appThreadsCache.at > 5_000) {
    appThreadsCache.loading = listCodexAppThreads().then(list => { appThreadsCache = { list, at: Date.now(), loading: null } })
    if (!appThreadsCache.at) await appThreadsCache.loading // first call: wait once so the list isn't empty
  }
  return appThreadsCache.list
}

/** The ChatGPT app's recent Codex threads (not automatic reviews, sub-agents or terminal sessions). */
async function listCodexAppThreads() {
  try {
    const { data } = await codexEngine(call => call('thread/list', { limit: 40, sortKey: 'recency_at', sortDirection: 'desc' }))
    return data
      .filter(t => !t.parentThreadId && t.threadSource !== 'subagent' && t.originator !== 'codex-tui' && !AUTOMATIC.test(String(t.name ?? t.preview ?? '')))
      .slice(0, 6)
      .map(t => ({
        agent: 'codex', name: 'Codex app', session: `app:${t.id}`, page: String(t.name || t.preview || 'thread').replace(/\s+/g, ' ').slice(0, 32),
        state: t.status?.type === 'active' ? 'working' : 'idle', at: Number(t.updatedAt ?? 0) || 0, workspace: '', machine: MACHINE, appThread: t.id,
      }))
  } catch {
    return []
  }
}

async function codexThreadView(threadId) {
  const result = await codexEngine(call => call('thread/read', { threadId, includeTurns: true }))
  const out = []
  for (const turn of result.thread?.turns ?? result.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).map(c => c.text ?? '').join(' ').trim()
        if (text && !text.startsWith('<')) out.push('', `You: ${text}`)
      } else if (item.type === 'agentMessage' && String(item.text ?? '').trim()) out.push('', `Codex: ${String(item.text).trim()}`)
      else if (item.type === 'commandExecution') out.push(`[exec] ${String(item.command ?? '').split('\n')[0].slice(0, 80)}`)
      else if (item.type === 'fileChange') out.push('[edit] files')
    }
  }
  return out.slice(-80)
}

async function codexThreadSend(threadId, text) {
  // Load the thread in the engine (the app may not have it open), then start a turn: the app shows it live.
  await codexEngine(async call => {
    await call('thread/resume', { threadId }).catch(() => null)
    return call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
  })
  return true
}

/** Claude desktop app sessions on this computer (each records itself in ~/.claude/sessions/<pid>.json). */
async function claudeDesktopSessions() {
  if (DEMO) return []
  const { readdirSync } = await import('node:fs')
  const dir = path.join(HOME, '.claude/sessions')
  const found = []
  let names = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return [] }
  for (const n of names) {
    const pid = Number(n.replace('.json', ''))
    try { process.kill(pid, 0) } catch { continue } // that session isn't running any more
    const info = readJson(path.join(dir, n))
    if (info?.entrypoint !== 'claude-desktop' || !info.sessionId) continue
    found.push({
      agent: 'claude', name: 'Claude app', session: `desk:${info.sessionId}`, page: String(info.name || path.basename(info.cwd || '') || 'session').slice(0, 32),
      state: info.status === 'busy' ? 'working' : 'idle', at: 0, workspace: '', machine: MACHINE, desktopSession: info.sessionId,
      folder: path.basename(info.cwd || ''),
    })
  }
  return found
}

/** "Continue on glasses": reopen a Claude desktop conversation (same history) in a terminal session Home can drive. */
async function continueDesktopSession(sessionId) {
  const { readdirSync } = await import('node:fs')
  const dir = path.join(HOME, '.claude/sessions')
  const info = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => readJson(path.join(dir, n))).find(i => i?.sessionId === sessionId && i?.entrypoint === 'claude-desktop')
  if (!info?.cwd) return { ok: false, error: 'that session is no longer open in the Claude app' }
  return startAgentIn('claude', info.cwd, '', sessionId)
}

// ---- starting new agents from the glasses -------------------------------------------------------

const PROJECTS = path.join(HOME, 'Projects')
const START_SCRIPT = path.join(here, 'start-agent.sh')
const hasCommand = async name => run('bash', ['-c', `command -v ${name}`], { timeout: 4000 }).then(() => true, () => false)
let canStartCache = { at: 0, list: [] }

/** Which agents this computer can start (installed, plus tmux or screen to run them in). */
async function canStart() {
  if (DEMO) return ['claude', 'codex']
  if (Date.now() - canStartCache.at < 10 * 60_000) return canStartCache.list
  const runner = (await hasCommand('tmux')) || (await hasCommand('screen'))
  const list = runner ? (await Promise.all(['claude', 'codex'].map(async a => ((await hasCommand(a)) ? a : null)))).filter(Boolean) : []
  canStartCache = { at: Date.now(), list }
  return list
}

/** "Projects" plus the most recently used folders inside it. */
async function projectFolders() {
  if (DEMO) return ['Projects', 'omarchy-agent-status', 'black-team']
  const { readdirSync } = await import('node:fs')
  try {
    const dirs = readdirSync(PROJECTS, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => ({ name: d.name, at: statSync(path.join(PROJECTS, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 8)
      .map(d => d.name)
    return ['Projects', ...dirs]
  } catch {
    return ['Projects']
  }
}

async function screenText(pane) {
  if (pane.startsWith('screen:')) {
    const file = path.join(CONFIG_DIR, `.start-${process.pid}.txt`)
    await run('screen', ['-S', pane.slice(7), '-p', '0', '-X', 'hardcopy', file], { timeout: 3000 })
    await new Promise(r => setTimeout(r, 200))
    const text = readFileSync(file, 'utf8')
    await import('node:fs/promises').then(fs => fs.unlink(file)).catch(() => {})
    return text
  }
  return (await run('tmux', ['capture-pane', '-p', '-t', pane], { timeout: 3000 })).stdout
}

async function sendKeys(pane, keys) {
  if (pane.startsWith('screen:')) {
    const map = { Down: '\x1b[B', Enter: '\r' }
    for (const k of keys) await run('screen', ['-S', pane.slice(7), '-p', '0', '-X', 'stuff', map[k]], { timeout: 3000 })
  } else {
    for (const k of keys) await run('tmux', ['send-keys', '-t', pane, k], { timeout: 3000 })
  }
}

/**
 * The first minute of a new agent: answer the two first-run questions Rick chose "yes" to by asking for a
 * full-access agent in that folder: Claude's "trust this folder?" and its full-access (bypass) warning.
 */
async function acceptFirstRunQuestions(pane) {
  const answered = new Set()
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000))
    let text = ''
    try { text = await screenText(pane) } catch { return }
    if (!answered.has('trust') && /trust this folder/i.test(text) && /Yes, I trust/i.test(text)) {
      answered.add('trust')
      await sendKeys(pane, ['Down', 'Enter'])
      continue
    }
    if (!answered.has('bypass') && /Bypass Permissions mode/i.test(text) && /Yes, I accept/i.test(text)) {
      answered.add('bypass')
      await sendKeys(pane, ['Down', 'Enter'])
    }
  }
}

async function startAgent(agent, folder, task) {
  if (!(await projectFolders()).includes(folder)) return { ok: false, error: 'unknown folder' }
  return startAgentIn(agent, folder === 'Projects' ? PROJECTS : path.join(PROJECTS, folder), task)
}

async function startAgentIn(agent, dir, task, resumeId = '') {
  if (!(await canStart()).includes(agent)) return { ok: false, error: `${agent} can't be started here` }
  if (resumeId && !/^[\w-]{8,64}$/.test(resumeId)) return { ok: false, error: 'bad session id' }
  const folder = path.basename(dir)
  const taskFile = path.join(CONFIG_DIR, `task-${randomBytes(6).toString('hex')}.txt`)
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(taskFile, String(task ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 4000), { mode: 0o600 })
  const slug = folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)
  const base = `${agent}-${slug}`
  if (await hasCommand('tmux')) {
    const names = (await run('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 }).catch(() => ({ stdout: '' }))).stdout.split('\n')
    let name = base
    for (let n = 2; names.includes(name); n++) name = `${base}-${n}`
    await run('tmux', ['new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', dir, 'bash', START_SCRIPT, agent, taskFile, resumeId], { timeout: 5000 })
    const pane = (await run('tmux', ['list-panes', '-t', name, '-F', '#{pane_id}'], { timeout: 3000 })).stdout.trim().split('\n')[0]
    void acceptFirstRunQuestions(pane)
    return { ok: true, pane }
  }
  const screens = async () => (await run('screen', ['-ls'], { timeout: 3000 }).catch(e => ({ stdout: e.stdout || '' }))).stdout
  const taken = new Set([...(await screens()).matchAll(/\d+\.(\S+)\s/g)].map(m => m[1]))
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  // Values go in as environment variables, never spliced into the command text.
  await run('bash', ['-c', 'cd "$HUD_DIR" && screen -dmS "$HUD_NAME" bash "$HUD_SCRIPT" "$HUD_AGENT" "$HUD_TASK" "$HUD_RESUME"'], {
    timeout: 5000, env: { ...process.env, HUD_DIR: dir, HUD_NAME: name, HUD_SCRIPT: START_SCRIPT, HUD_AGENT: agent, HUD_TASK: taskFile, HUD_RESUME: resumeId },
  })
  await new Promise(r => setTimeout(r, 1000))
  const pid = [...(await screens()).matchAll(/(\d+)\.(\S+)\s/g)].find(m => m[2] === name)?.[1]
  const pane = pid ? `screen:${pid}.${name}` : ''
  if (pane) void acceptFirstRunQuestions(pane)
  return { ok: Boolean(pane), pane }
}

async function nodeView() {
  expirePending()
  const [sessions, desk, starts] = await Promise.all([sessionsWithPanes(), desktop(), canStart()])
  return { machine: MACHINE, online: true, sessions, pending: publicPending(), desktop: desk, canStart: starts }
}

// ---- hub -------------------------------------------------------------------------

async function call(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || NODE_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

async function remoteViews() {
  const seen = paused ? 0 : glassesSeen
  return Promise.all(
    NODES.map(async node => {
      try {
        const view = await call(`${node.url}/api/node?seen=${seen}`, node.token)
        return { ...view, machine: node.name, sessions: view.sessions.map(s => ({ ...s, machine: node.name })), pending: view.pending.map(p => ({ ...p, machine: node.name })) }
      } catch {
        return { machine: node.name, online: false, sessions: [], pending: [], desktop: null }
      }
    }),
  )
}

async function messagesSummary() {
  if (DEMO) return demoMessages()
  if (!HUB.messagesUrl || !RELAY_TOKEN) return null
  try {
    const { chats } = await call(`${HUB.messagesUrl}/chats?limit=6`, RELAY_TOKEN, { timeout: 3000 })
    return chats.map(c => ({ id: c.id, name: c.name, unread: !!c.unread, when: c.when, snippet: String(c.snippet || '').slice(0, 120), fromMe: !!c.lastFromMe }))
  } catch {
    return null
  }
}

async function home() {
  const views = [await nodeView(), ...(MODE === 'hub' ? await remoteViews() : [])]
  const priority = { attention: 5, error: 4, working: 3, done: 2, idle: 1.5, stopped: 1 }
  const sessions = views.flatMap(v => v.sessions).sort((a, b) => (priority[b.state] || 0) - (priority[a.state] || 0) || b.at - a.at)
  return {
    now: Date.now(),
    mode: MODE,
    paused,
    machines: views.map(v => ({ name: v.machine, online: v.online, canStart: v.canStart ?? [] })),
    sessions,
    pending: views.flatMap(v => v.pending).sort((a, b) => a.at - b.at),
    desktops: views.filter(v => v.desktop).map(v => ({ machine: v.machine, ...v.desktop })),
    voice: Boolean(GROQ_KEY) || DEMO,
    weather: DEMO ? { temp: 62, desc: 'Cloudy', hi: 68, lo: 51, rainAt: '4 PM', rainChance: 70 } : weather,
    messages: MODE === 'hub' || DEMO ? await messagesSummary() : null,
    muse: MODE === 'hub' ? MUSES.length > 0 : DEMO,
  }
}

// ---- demo data (HUD_DEMO=1, for the simulator) -----------------------------------------

const t0 = Date.now()
function demoSessions() {
  const ago = m => (Date.now() - m * 60_000) / 1000
  return [
    { agent: 'claude', name: 'Claude', session: 'demo1', state: 'working', page: 'omarchy-agent-status', at: ago(1), workspace: '1', machine: MACHINE, pane: '%0' },
    { agent: 'codex', name: 'Codex', session: 'demo2', state: 'done', page: 'black-team', at: ago(6), workspace: '3', machine: 'm1' },
    { agent: 'hermes', name: 'Hermes', session: 'demo3', state: 'working', page: 'camp', at: ago(12), workspace: '', machine: 'm2' },
  ]
}
function demoMessages() {
  const ago = m => (t0 - m * 60_000) / 1000
  return [
    { id: 1, name: 'Mom', unread: true, when: ago(3), snippet: 'Running late, be there at 7', fromMe: false },
    { id: 2, name: 'Alex', unread: false, when: ago(40), snippet: 'Sounds good 👍', fromMe: true },
  ]
}

// ---- HTTP ---------------------------------------------------------------------------

const send = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

const readBody = req =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > 16_000) reject(new Error('too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })

function authorized(req) {
  const given = Buffer.from(String(req.headers.authorization || ''))
  const wanted = Buffer.from(`Bearer ${TOKEN}`)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)

const clip = (value, n) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

async function decide(machine, id, behavior) {
  if (!['allow', 'deny', 'desk'].includes(behavior)) return false
  // A node treats anything the hub forwards to it as its own.
  if (machine === MACHINE || MODE !== 'hub') return finish(String(id), behavior)
  const node = NODES.find(n => n.name === machine)
  if (!node) return false
  const r = await call(`${node.url}/api/decide`, node.token, { method: 'POST', body: JSON.stringify({ machine, id, behavior }) })
  return !!r.ok
}

async function focus(machine, workspace) {
  const n = Number(String(workspace).split(',')[0])
  if (!Number.isInteger(n) || n < 1 || n > 30) return false
  if (machine !== MACHINE && MODE === 'hub') {
    const node = NODES.find(x => x.name === machine)
    if (!node) return false
    return !!(await call(`${node.url}/api/focus`, node.token, { method: 'POST', body: JSON.stringify({ machine, workspace: n }) })).ok
  }
  if (DEMO) return true
  // Hyprland 0.56+ takes Lua dispatches; older versions take the classic form.
  for (const args of [['dispatch', `hl.dsp.focus({ workspace = "${n}" })`], ['dispatch', 'workspace', String(n)]]) {
    try {
      const { stdout } = await run('hyprctl', args, { timeout: 2000 })
      if (stdout.trim() === 'ok') return true
    } catch { /* try the next form */ }
  }
  return false
}

// Typed into the agent's tmux pane exactly like keyboard input, then Enter.
async function prompt(machine, pane, text, key, window, appThread) {
  if (machine !== MACHINE && MODE === 'hub') {
    const node = NODES.find(x => x.name === machine)
    if (!node) return false
    return !!(await call(`${node.url}/api/prompt`, node.token, { method: 'POST', body: JSON.stringify({ machine, pane, text, key, window, appThread }), timeout: 25_000 })).ok
  }
  if (DEMO) return true
  if (appThread) {
    if (key || !/^[\w-]{8,64}$/.test(appThread)) return false
    // Must be a real thread in Codex's engine (not a sub-agent's).
    const known = await codexEngine(call => call('thread/read', { threadId: appThread, includeTurns: false })).catch(() => null)
    const thread = known?.thread ?? known
    if (!thread || thread.parentThreadId || thread.threadSource === 'subagent') return false
    const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 4000)
    return clean ? codexThreadSend(appThread, clean) : false
  }
  if (window) return typeIntoWindow(String(window), text, key)
  if (String(pane).startsWith('screen:')) return typeIntoScreen(String(pane), text, key)
  if (!(await agentPanes()).some(p => p.pane === pane)) return false
  if (key) {
    if (key !== 'Escape') return false
    await run('tmux', ['send-keys', '-t', pane, 'Escape'], { timeout: 2000 })
    return true
  }
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 4000)
  if (!clean) return false
  await run('tmux', ['send-keys', '-t', pane, '-l', clean], { timeout: 2000 })
  await new Promise(r => setTimeout(r, 150))
  await run('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 2000 })
  return true
}

// Groq key: the environment, or a private file Rick creates on the hub (chmod 600).
// ---- terminal view: what the agent has said, for the glasses ------------------------------

const DECOR = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║▐▛▜▝▘▗▖█▀▄░▒▓⠀-⣿·•.]*$/u
const CHROME = /(auto mode|shift\+tab|for shortcuts|esc to (cancel|dismiss|interrupt)|Update available|Update installed|for agents|\/effort|over the [\d.]+k-char limit|Press a number|Ask Codex to do anything|Try "|ctrl\+[a-z] to)/i

/** A terminal screen, minus borders, logos and status bars; prompts marked "You:". */
function cleanScreen(text) {
  const out = []
  for (let line of text.split('\n')) {
    line = line.replace(/\s+$/, '')
    if (!line.trim() || DECOR.test(line) || CHROME.test(line)) {
      if (out.length && out.at(-1) !== '') out.push('')
      continue
    }
    const m = line.match(/^\s*([❯›»>])\s*(.*)$/)
    if (m) {
      if (m[2].trim()) out.push(`You: ${m[2].trim()}`)
      continue
    }
    out.push(line.replace(/^\s*[⏺•●✻⎿]\s?/, '').replace(/^\s{2,}/, ''))
  }
  while (out.length && out.at(-1) === '') out.pop()
  return out.slice(-80)
}

/** Claude's own record of the conversation: ~/.claude/sessions/<pid>.json points to the transcript. */
async function claudeConversation(pid) {
  const info = readJson(path.join(HOME, '.claude/sessions', `${pid}.json`))
  if (!info?.sessionId || !info.cwd) return null
  const dir = path.join(HOME, '.claude/projects', info.cwd.replace(/[^A-Za-z0-9]/g, '-'))
  const file = path.join(dir, `${info.sessionId}.jsonl`)
  let text
  try {
    const size = statSync(file).size
    const handle = await import('node:fs/promises').then(fs => fs.open(file))
    const length = Math.min(size, 600_000)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, size - length)
    await handle.close()
    text = buf.toString('utf8')
  } catch {
    return []
  }
  const out = []
  for (const row of text.split('\n').slice(1)) {
    let item
    try { item = JSON.parse(row) } catch { continue }
    if (item.isMeta || item.isSidechain) continue
    const content = item.message?.content
    if (item.type === 'user') {
      const said = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join(' ') : ''
      if (said.trim() && !said.startsWith('<')) out.push('', `You: ${said.trim()}`)
    } else if (item.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        // Label replies and leave a blank line before each, so they stand apart from yours on the glasses.
        if (c.type === 'text' && c.text.trim()) out.push('', `Claude: ${c.text.trim()}`)
        if (c.type === 'tool_use') {
          const detail = c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? c.input?.url ?? ''
          out.push(`[${c.name}] ${String(detail).split('\n')[0].slice(0, 80)}`)
        }
      }
    }
  }
  return out.slice(-80)
}

async function readTail(file, limit = 600_000) {
  const fs = await import('node:fs/promises')
  const size = statSync(file).size
  const length = Math.min(size, limit)
  const handle = await fs.open(file)
  const buf = Buffer.alloc(length)
  await handle.read(buf, 0, length, size - length)
  await handle.close()
  return buf.toString('utf8')
}

/** Codex's own log: the rollout file it has open, else the newest one for the same folder. */
async function codexConversation(pid, cwd) {
  let file = ''
  try {
    // The open log may belong to a child (e.g. node launcher → native codex), so include descendants.
    const rows = (await run('ps', ['-eo', 'pid=,ppid='], { timeout: 2000 })).stdout.trim().split('\n').map(r => r.trim().split(/\s+/))
    const pids = [String(pid)]
    for (let i = 0; i < pids.length && pids.length < 50; i++) pids.push(...rows.filter(([, pp]) => pp === pids[i]).map(([c]) => c))
    const { stdout } = await run('lsof', ['-a', '-p', pids.join(','), '-Fn'], { timeout: 3000 })
    const open = [...new Set(stdout.split('\n').filter(l => /^n.*rollout-.*\.jsonl$/.test(l)).map(l => l.slice(1)))]
    // Codex keeps its sub-agents' logs open too; the conversation is the one that isn't a sub-agent,
    // or failing that, the parent named in a sub-agent's log.
    const meta = f => { try { return JSON.parse(readFileSync(f, 'utf8').split('\n', 1)[0]).payload ?? {} } catch { return {} } }
    file = open.find(f => !meta(f).parent_thread_id) ?? ''
    if (!file && open.length) {
      const parent = meta(open[0]).session_id
      const dir = path.dirname(open[0])
      try {
        const { readdirSync } = await import('node:fs')
        file = readdirSync(dir).filter(n => parent && n.includes(parent)).map(n => path.join(dir, n))[0] ?? ''
      } catch { /* leave it to the folder search below */ }
    }
  } catch { /* not open, or no lsof */ }
  if (!file) {
    const { readdirSync } = await import('node:fs')
    const base = path.join(HOME, '.codex/sessions')
    const days = []
    for (let back = 0; back < 3; back++) {
      const d = new Date(Date.now() - back * 86_400_000)
      days.push(path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')))
    }
    const candidates = days.flatMap(dir => {
      try {
        return readdirSync(dir).filter(n => n.startsWith('rollout-') && n.endsWith('.jsonl')).map(n => path.join(dir, n))
      } catch {
        return []
      }
    }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 25)
    // Only a log begun after this Codex started can be its own; with two Codexes in one folder,
    // "newest log for the folder" alone would show the other one's conversation.
    let started = 0
    try {
      started = Date.parse((await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000 })).stdout.trim()) || 0
    } catch { /* unknown start: accept none */ }
    for (const candidate of candidates) {
      const stamp = path.basename(candidate).match(/rollout-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/)
      const begun = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}`).getTime() : 0
      if (!started || begun < started - 5000) continue
      try {
        const first = JSON.parse(readFileSync(candidate, 'utf8').split('\n', 1)[0])
        if (first.payload?.cwd === cwd) { file = candidate; break }
      } catch { /* skip */ }
    }
  }
  if (!file) return null
  const out = []
  for (const row of (await readTail(file)).split('\n').slice(1)) {
    let item
    try { item = JSON.parse(row) } catch { continue }
    const p = item.payload
    if (item.type !== 'response_item' || !p) continue
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content ?? []).map(c => c.text ?? '').join(' ').trim()
      // Codex stores its own setup (AGENTS.md, environment) as user messages; skip those.
      if (!text || text.startsWith('<') || text.startsWith('# AGENTS.md')) continue
      if (p.role === 'user') out.push('', `You: ${text}`)
      else out.push('', `Codex: ${text}`)
    } else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
      let detail = ''
      try {
        const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments ?? p.action ?? {}
        detail = [].concat(args.command ?? args.cmd ?? args.path ?? '').join(' ')
      } catch { /* unreadable arguments */ }
      out.push(`[${p.name ?? 'shell'}] ${detail.split('\n')[0].slice(0, 80)}`)
    }
  }
  return out.slice(-80)
}

async function terminalView(pane, window) {
  const all = [...(await agentPanes()), ...(await agentScreens()), ...(await agentWindows())]
  const target = all.find(t => (pane && t.pane === pane) || (window && t.window === window))
  if (!target) return null
  const conversation = target.agent === 'claude' ? await claudeConversation(target.pid)
    : target.agent === 'codex' ? await codexConversation(target.pid, target.cwd).catch(() => null)
    : null
  if (conversation?.length) return conversation
  try {
    if (target.pane?.startsWith('screen:')) {
      const file = path.join(CONFIG_DIR, `.screen-${process.pid}.txt`)
      await run('screen', ['-S', target.pane.slice(7), '-p', '0', '-X', 'hardcopy', file], { timeout: 3000 })
      await new Promise(r => setTimeout(r, 200))
      const text = readFileSync(file, 'utf8')
      await import('node:fs/promises').then(fs => fs.unlink(file)).catch(() => {})
      return cleanScreen(text)
    }
    if (target.pane) return cleanScreen((await run('tmux', ['capture-pane', '-p', '-J', '-S', '-300', '-t', target.pane], { timeout: 3000 })).stdout)
  } catch { /* fall through */ }
  return ['(Nothing to show for this agent yet.)']
}

/** Type into a GNU screen session with `screen -X stuff`. macOS's screen 4.00 sends text as-is (no escape codes). */
async function typeIntoScreen(pane, text, key) {
  if (!/^screen:\d+\.[\w.-]+$/.test(pane) || !(await agentScreens()).some(p => p.pane === pane)) return false
  const target = pane.slice('screen:'.length)
  const stuff = s => run('screen', ['-S', target, '-p', '0', '-X', 'stuff', s], { timeout: 3000 })
  if (key) {
    if (key !== 'Escape') return false
    await stuff('\x1b')
    return true
  }
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 4000)
  if (!clean) return false
  await stuff(clean)
  await new Promise(r => setTimeout(r, 150))
  await stuff('\r')
  return true
}

/** Focus the agent's terminal window, check it really has focus, then type like a keyboard. */
/** Is the screen locked? Closing the lid locks Omarchy; the lock screen then has the keyboard, even though
 * Hyprland still reports the agent's window as active. Asks Omarchy's shell, and also looks for Hyprland's
 * session-lock marker on any monitor. Either one saying "locked" counts. */
async function screenLocked() {
  const shell = await run('quickshell', ['ipc', '-p', '/usr/share/omarchy/shell', 'call', 'lock', 'isLocked'], { timeout: 2000 })
    .then(r => r.stdout.trim() === 'true', () => false)
  if (shell) return true
  return run('hyprctl', ['-j', 'monitors'], { timeout: 2000 })
    .then(r => JSON.parse(r.stdout).some(m => (m.solitaryBlockedBy ?? []).includes('LOCK')), () => false)
}

async function typeIntoWindow(address, text, key) {
  if (!/^0x[0-9a-f]+$/.test(address) || !(await agentWindows()).some(w => w.window === address)) return false
  if (await screenLocked()) return false // keystrokes would go into the lock screen's password box
  if (key && key !== 'Escape') return false
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 4000)
  if (!key && !clean) return false
  for (const args of [['dispatch', `hl.dsp.focus({ window = "address:${address}" })`], ['dispatch', 'focuswindow', `address:${address}`]]) {
    try {
      if ((await run('hyprctl', args, { timeout: 2000 })).stdout.trim() === 'ok') break
    } catch { /* try the next form */ }
  }
  await new Promise(r => setTimeout(r, 250))
  const active = JSON.parse((await run('hyprctl', ['activewindow', '-j'], { timeout: 2000 })).stdout)
  if (active.address !== address) return false // never type into the wrong window
  if (await screenLocked()) return false // locked while we were focusing
  if (key) {
    await run('wtype', ['-k', 'Escape'], { timeout: 3000 })
    return true
  }
  await run('wtype', ['--', clean], { timeout: 15_000 })
  await new Promise(r => setTimeout(r, 150))
  if (await screenLocked()) return false // locked mid-typing: don't press Enter (that would submit a password)
  await run('wtype', ['-k', 'Return'], { timeout: 3000 })
  return true
}

const GROQ_KEY = process.env.GROQ_API_KEY || (() => {
  try {
    return readFileSync(path.join(CONFIG_DIR, 'groq.key'), 'utf8').trim()
  } catch {
    return ''
  }
})()

function wav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Speech to text with Groq's hosted Whisper. The audio is not kept. */
async function transcribe(pcm) {
  if (DEMO) return 'run the tests and tell me what fails'
  if (!GROQ_KEY) throw new Error('voice needs the hub on Mini 1')
  const form = new FormData()
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'prompt.wav')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'json')
  form.append('language', 'en')
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}` }, body: form, signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`speech service said ${res.status}`)
  return String((await res.json()).text || '').trim()
}

const readRaw = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) reject(new Error('too large'))
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }

async function serveStatic(res, pathname) {
  try {
    const file = path.resolve(APP_DIR, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)))
    if (!file.startsWith(APP_DIR + path.sep) || !statSync(file).isFile()) throw new Error('missing')
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname.replace(/^\/hud(?=\/|$)/, '') || '/'
  if (req.method === 'OPTIONS') return send(res, 204, {})
  if (!p.startsWith('/api/')) return req.method === 'GET' ? serveStatic(res, p) : send(res, 405, {})
  if (p === '/api/health') return send(res, 200, { ok: true, mode: MODE, machine: MACHINE })

  // The approval hook on this machine. Loopback only; it reads the same token file.
  if (p.startsWith('/api/hook/')) {
    if (!loopback(req) || !authorized(req)) return send(res, 403, { error: 'forbidden' })
    if (req.method === 'POST' && p === '/api/hook/request') {
      const body = await readBody(req)
      if (paused || Date.now() - glassesSeen > SEEN_WINDOW_MS) return send(res, 200, { skip: true })
      const id = randomBytes(6).toString('hex')
      pending.set(id, { id, agent: clip(body.agent, 16) || 'claude', page: clip(body.page, 32), tool: clip(body.tool, 40), summary: clip(body.summary, 160), at: Date.now(), waiters: [] })
      return send(res, 200, { id })
    }
    const wait = p.match(/^\/api\/hook\/wait\/([0-9a-f]+)$/)
    if (req.method === 'GET' && wait) {
      const item = pending.get(wait[1])
      if (!item) return send(res, 200, { behavior: null, gone: true })
      const ms = Math.min(Number(url.searchParams.get('ms')) || 20_000, 30_000)
      const behavior = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), ms)
        item.waiters.push(b => {
          clearTimeout(timer)
          resolve(b)
        })
        req.on('close', () => clearTimeout(timer))
      })
      return send(res, 200, behavior === undefined ? { behavior: null } : { behavior, gone: true })
    }
    const cancel = p.match(/^\/api\/hook\/cancel\/([0-9a-f]+)$/)
    if (req.method === 'POST' && cancel) return send(res, 200, { ok: finish(cancel[1], null) })
    return send(res, 404, { error: 'not found' })
  }

  // Pairing: the installed app has no QR link, so a 6-digit, 10-minute, single-use code gives it the token.
  if (req.method === 'POST' && p === '/api/pair') {
    const code = String((await readBody(req)).code ?? '')
    diagnostics.push({ at: new Date().toISOString(), name: 'pair.code', detail: !pairing || Date.now() > pairing.until ? 'no active code' : code === pairing.code ? 'ok' : 'wrong code' })
    if (!pairing || Date.now() > pairing.until) return send(res, 403, { error: 'no pairing code active' })
    if (code !== pairing.code) {
      if (++pairing.misses >= 5) pairing = null
      return send(res, 403, { error: 'wrong code' })
    }
    pairing = null
    return send(res, 200, { token: TOKEN })
  }
  // Automatic pairing: Tailscale Serve labels each request with the sender's Tailscale login. Only trusted
  // when the request came through Serve (it connects from this machine), so a direct call can't fake it.
  if (req.method === 'POST' && p === '/api/pair/auto') {
    const who = String(req.headers['tailscale-user-login'] || '')
    const owner = String(HUB.owner || process.env.HUD_OWNER || '')
    diagnostics.push({ at: new Date().toISOString(), name: 'pair.auto', detail: `${who || 'no login label'}${loopback(req) ? '' : ' (direct)'}` })
    if (owner && loopback(req) && who.toLowerCase() === owner.toLowerCase()) return send(res, 200, { token: TOKEN })
    return send(res, 403, { error: 'not recognized' })
  }
  if (!authorized(req)) return send(res, 401, { error: 'bad token' })
  if (req.method === 'POST' && p === '/api/pair/new') {
    pairing = { code: String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0'), until: Date.now() + 10 * 60_000, misses: 0 }
    return send(res, 200, { code: pairing.code, minutes: 10 })
  }
  try {
    if (req.method === 'GET' && p === '/api/home') {
      if (!paused) glassesSeen = Date.now()
      return send(res, 200, await home())
    }
    if (req.method === 'GET' && p === '/api/node') {
      const seen = Number(url.searchParams.get('seen')) || 0
      glassesSeen = Math.max(glassesSeen, Math.min(seen, Date.now()))
      return send(res, 200, await nodeView())
    }
    if (req.method === 'POST' && p === '/api/decide') {
      const b = await readBody(req)
      return send(res, 200, { ok: await decide(String(b.machine), String(b.id), String(b.behavior)) })
    }
    if (req.method === 'POST' && p === '/api/focus') {
      const b = await readBody(req)
      return send(res, 200, { ok: await focus(String(b.machine), b.workspace) })
    }
    if (req.method === 'POST' && p === '/api/location') {
      // From the phone, for the weather; rounded to about a kilometer and kept only on the hub.
      const b = await readBody(req)
      const lat = Math.round(Number(b.lat) * 100) / 100
      const lon = Math.round(Number(b.lon) * 100) / 100
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { ok: false })
      const moved = !location || location.lat !== lat || location.lon !== lon
      location = { lat, lon }
      if (moved) {
        writeFileSync(LOCATION_FILE, JSON.stringify(location), { mode: 0o600 })
        await refreshWeather()
        // Hand it to the other hubs too, so a backup hub has the weather ready if it takes over.
        if (!b.relayed) {
          for (const peer of HUB.peers ?? []) {
            call(`${String(peer.url).replace(/\/$/, '')}/api/location`, peer.tokenFile ? tokenFrom(peer.tokenFile) : TOKEN, { method: 'POST', body: JSON.stringify({ lat, lon, relayed: true }), timeout: 8000 }).catch(() => {})
          }
        }
      }
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && p === '/api/folders') {
      const machine = String(url.searchParams.get('machine'))
      if (machine !== MACHINE && MODE === 'hub') {
        const node = NODES.find(x => x.name === machine)
        if (!node) return send(res, 404, { error: 'unknown computer' })
        return send(res, 200, await call(`${node.url}/api/folders?${url.searchParams}`, node.token, { timeout: 6000 }))
      }
      return send(res, 200, { folders: await projectFolders() })
    }
    if (req.method === 'POST' && p === '/api/continue') {
      const b = await readBody(req)
      const machine = String(b.machine)
      if (machine !== MACHINE && MODE === 'hub') {
        const node = NODES.find(x => x.name === machine)
        if (!node) return send(res, 404, { ok: false, error: 'unknown computer' })
        return send(res, 200, await call(`${node.url}/api/continue`, node.token, { method: 'POST', body: JSON.stringify(b), timeout: 15_000 }))
      }
      return send(res, 200, await continueDesktopSession(String(b.session)))
    }
    if (req.method === 'POST' && p === '/api/start') {
      const b = await readBody(req)
      const machine = String(b.machine)
      if (machine !== MACHINE && MODE === 'hub') {
        const node = NODES.find(x => x.name === machine)
        if (!node) return send(res, 404, { ok: false, error: 'unknown computer' })
        return send(res, 200, await call(`${node.url}/api/start`, node.token, { method: 'POST', body: JSON.stringify(b), timeout: 15_000 }))
      }
      if (DEMO) return send(res, 200, { ok: true, pane: '%9' })
      return send(res, 200, await startAgent(String(b.agent), String(b.folder), b.task))
    }
    if (req.method === 'POST' && p === '/api/prompt') {
      const b = await readBody(req)
      return send(res, 200, { ok: await prompt(String(b.machine), String(b.pane), b.text, b.key, b.window, b.appThread) })
    }
    if (req.method === 'GET' && p === '/api/terminal') {
      const machine = String(url.searchParams.get('machine'))
      const pane = url.searchParams.get('pane') || ''
      const window = url.searchParams.get('window') || ''
      if (machine !== MACHINE && MODE === 'hub') {
        const node = NODES.find(x => x.name === machine)
        if (!node) return send(res, 404, { error: 'unknown computer' })
        return send(res, 200, await call(`${node.url}/api/terminal?${url.searchParams}`, node.token, { timeout: 6000 }))
      }
      if (DEMO) return send(res, 200, { lines: ['You: run the tests', 'Running the test suite now.', '[Bash] npm test', 'All 15 tests pass.'] })
      const appThread = url.searchParams.get('appThread') || ''
      if (appThread) return send(res, 200, { lines: await codexThreadView(appThread) })
      const lines = await terminalView(pane, window)
      return lines ? send(res, 200, { lines }) : send(res, 404, { error: 'agent not found' })
    }
    if (req.method === 'POST' && p === '/api/transcribe') {
      const pcm = await readRaw(req, 4_000_000) // ~2 minutes of 16 kHz audio
      if (pcm.length < 3200) return send(res, 200, { text: '' })
      return send(res, 200, { text: await transcribe(pcm) })
    }
    // Step-by-step app diagnostics (names and sizes only, never audio or words), last 100 in memory.
    if (req.method === 'POST' && p === '/api/diag') {
      const b = await readBody(req)
      diagnostics.push({ at: new Date().toISOString(), name: clip(b.name, 40), detail: clip(b.detail, 160) })
      if (diagnostics.length > 100) diagnostics.shift()
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && p === '/api/diag') return send(res, 200, { diagnostics })
    if (req.method === 'POST' && p === '/api/pause') {
      paused = !!(await readBody(req)).paused
      if (paused) glassesSeen = 0
      return send(res, 200, { ok: true, paused })
    }
    if (req.method === 'GET' && p === '/api/messages') {
      const chat = Number(url.searchParams.get('chat')) | 0
      if (DEMO) return send(res, 200, { messages: [{ from: 'Mom', fromMe: false, when: t0 / 1000, text: 'Running late, be there at 7' }, { from: 'me', fromMe: true, when: t0 / 1000 - 600, text: 'What time are you coming?' }] })
      if (MODE !== 'hub' || !HUB.messagesUrl || !chat) return send(res, 404, { error: 'messages unavailable' })
      const { messages } = await call(`${HUB.messagesUrl}/chats/${chat}/messages?limit=6`, RELAY_TOKEN, { timeout: 4000 })
      return send(res, 200, { messages: messages.map(m => ({ from: m.from, fromMe: m.fromMe, when: m.when, text: String(m.text || '').slice(0, 300) })) })
    }
    if (req.method === 'POST' && p === '/api/messages/send') {
      // Sends through Rick's Messages relay (POST /send), the same way his Messages glasses app does.
      const b = await readBody(req)
      const chat = Number(b.chat) | 0
      const text = String(b.text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1000)
      if (DEMO) return send(res, 200, { ok: true })
      if (MODE !== 'hub' || !HUB.messagesUrl || !chat || !text) return send(res, 400, { ok: false, error: 'cannot send' })
      const r = await call(`${HUB.messagesUrl}/send`, RELAY_TOKEN, { method: 'POST', body: JSON.stringify({ chatId: chat, text }), timeout: 20_000 })
      return send(res, 200, { ok: !!r.ok })
    }
    if (req.method === 'POST' && p === '/api/muse/ask') {
      // The Muse relay's own /ask, exactly as Ask Muse uses it; the relay runs one question at a time.
      const text = String((await readBody(req)).text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1000)
      if (DEMO) return send(res, 200, { id: 'demo' })
      if (MODE !== 'hub' || !MUSES.length || !text) return send(res, 400, { error: 'cannot ask Muse' })
      // First Muse that is up and whose text box is ready gets the question; the id remembers which.
      for (const [i, muse] of MUSES.entries()) {
        try {
          const health = await call(`${muse.url}/selftest`, muse.token, { timeout: 8000 })
          if (!health.ok || !health.composer) continue
          const r = await call(`${muse.url}/ask`, muse.token, { method: 'POST', body: JSON.stringify({ text }), timeout: 10_000 })
          return send(res, 200, { id: `${i}-${r.id}`, muse: muse.name })
        } catch { /* try the next Muse */ }
      }
      return send(res, 502, { error: 'no Muse is ready right now' })
    }
    if (req.method === 'GET' && p === '/api/muse/reply') {
      const id = String(url.searchParams.get('id') ?? '')
      if (DEMO) return send(res, 200, { status: 'done', question: 'demo question', reply: 'Here is what Muse would say.' })
      const [, index, job] = id.match(/^(\d+)-(\w{1,40})$/) ?? []
      const muse = MUSES[Number(index)]
      if (MODE !== 'hub' || !muse || !job) return send(res, 400, { error: 'bad id' })
      const r = await call(`${muse.url}/reply/${job}`, muse.token, { timeout: 6000 })
      return send(res, 200, { status: String(r.status ?? ''), question: clip(r.question, 300), reply: String(r.reply ?? '').slice(0, 2000), error: clip(r.error, 120) })
    }
    if (req.method === 'GET' && p === '/api/muse') {
      if (DEMO) return send(res, 200, { question: 'What is on my calendar today?', reply: 'You have a dentist appointment at 3 PM and dinner with Alex at 7.' })
      // Read-only. Never /ask: the Muse relay types into Muse, and Ask Muse owns that.
      if (MODE !== 'hub' || !MUSES.length) return send(res, 404, { error: 'muse unavailable' })
      let latest = null
      for (const muse of MUSES) {
        latest = await call(`${muse.url}/latest`, muse.token, { timeout: 6000 }).catch(() => null)
        if (latest) break
      }
      if (!latest) return send(res, 502, { error: 'no Muse reachable' })
      return send(res, 200, { question: clip(latest.question, 300), reply: String(latest.reply || '').slice(0, 900) })
    }
    return send(res, 404, { error: 'not found' })
  } catch (err) {
    return send(res, 502, { error: clip(err.message, 120) })
  }
}

// ---- weather (Open-Meteo, no account needed) for the top line, plus a heads-up before rain ----------

const LOCATION_FILE = path.join(CONFIG_DIR, 'location.json')
let location = readJson(LOCATION_FILE) // {lat, lon}, rounded to ~1 km
let weather = null
let lastRainNotice = 0

const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorms', 96: 'Thunderstorms', 99: 'Thunderstorms' }
const hourLabel = iso => { const h = Number(iso.slice(11, 13)); return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` }

async function refreshWeather() {
  if (!location) return
  const q = new URLSearchParams({
    latitude: String(location.lat), longitude: String(location.lon), timezone: 'auto', forecast_days: '2',
    temperature_unit: 'fahrenheit', current: 'temperature_2m,weather_code',
    hourly: 'precipitation_probability', daily: 'temperature_2m_max,temperature_2m_min',
  })
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const d = await res.json()
    const now = d.current.time.slice(0, 13) // local "YYYY-MM-DDTHH"
    const start = d.hourly.time.findIndex(t => t.slice(0, 13) >= now)
    let rainAt = null
    let rainChance = 0
    let rainInHours = null
    for (let i = Math.max(0, start); i < start + 12 && i < d.hourly.time.length; i++) {
      if (d.hourly.precipitation_probability[i] >= 50) {
        rainAt = hourLabel(d.hourly.time[i]); rainChance = d.hourly.precipitation_probability[i]; rainInHours = i - start
        break
      }
    }
    weather = {
      temp: Math.round(d.current.temperature_2m), desc: WMO[d.current.weather_code] ?? '',
      hi: Math.round(d.daily.temperature_2m_max[0]), lo: Math.round(d.daily.temperature_2m_min[0]),
      rainAt, rainChance, at: Date.now(),
    }
    const raining = /rain|drizzle|shower|thunder/i.test(weather.desc)
    if (rainAt && rainInHours !== null && rainInHours <= 2 && !raining && Date.now() - lastRainNotice > 6 * 3600_000) {
      lastRainNotice = Date.now()
      await notify('rain', `Rain around ${rainAt}`, `${rainChance}% chance · now ${weather.temp}° ${weather.desc}`)
    }
  } catch { /* keep the last forecast */ }
}

// ---- phone notifications (ntfy) while Home isn't open on the glasses ----------------------------
// hub.json: "ntfy": {"server": "https://ntfy.sh", "topic": "<random>"}. The Even app mirrors iPhone
// notifications onto the glasses. Only short labels are sent (agent, computer, project), never
// commands, prompts or message text.

const NTFY = MODE === 'hub' && HUB.ntfy?.topic ? { server: String(HUB.ntfy.server || 'https://ntfy.sh').replace(/\/$/, ''), topic: String(HUB.ntfy.topic) } : null
let watchedStates = null
const watchedPending = new Set()
const lastNotified = new Map()

async function notify(key, title, body, priority = 'default') {
  if (!NTFY) return
  // A backup hub stays quiet while the main hub is up, so nothing arrives twice.
  // onlyIfDown: one health URL or a list (a chain of backups); if any of them is up, it notifies instead.
  for (const healthUrl of [].concat(HUB.ntfy.onlyIfDown ?? [])) {
    const up = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) }).then(r => r.ok).catch(() => false)
    if (up) return
  }
  if (Date.now() - (lastNotified.get(key) ?? 0) < 60_000) return // one per thing per minute
  lastNotified.set(key, Date.now())
  try {
    await fetch(`${NTFY.server}/${encodeURIComponent(NTFY.topic)}`, {
      method: 'POST', body, headers: { Title: title, Tags: 'eyeglasses', Priority: priority }, signal: AbortSignal.timeout(8000),
    })
  } catch { /* the next event will try again */ }
}

async function watchForAlerts() {
  const views = [await nodeView(), ...(await remoteViews())]
  const sessions = views.flatMap(v => v.sessions)
  const pending = views.flatMap(v => v.pending)
  const keyOf = x => `${x.machine}/${x.pane || x.window || `${x.agent}/${x.session}`}`
  const states = new Map(sessions.map(x => [keyOf(x), x.state]))
  // Home open on the glasses (polled in the last 15 s): its own pop-ups cover it.
  const glassesOpen = Date.now() - glassesSeen < 15_000
  if (watchedStates && !glassesOpen) {
    for (const p of pending) {
      if (!watchedPending.has(`${p.machine}/${p.id}`)) await notify(`approve:${p.machine}/${p.id}`, `Approval needed · ${p.machine}`, `${p.agent === 'claude' ? 'Claude' : p.agent} wants to use ${p.tool}${p.page ? ` in ${p.page}` : ''}`, 'high')
    }
    for (const x of sessions) {
      const before = watchedStates.get(keyOf(x))
      if (!before || before === x.state) continue
      if (x.state === 'attention') await notify(`agent:${keyOf(x)}`, `${x.name} needs you · ${x.machine}`, x.page || 'Open Home on your glasses', 'high')
      else if (x.state === 'done') await notify(`agent:${keyOf(x)}`, `${x.name} finished · ${x.machine}`, x.page || 'Open Home on your glasses')
    }
  }
  watchedStates = states
  watchedPending.clear()
  for (const p of pending) watchedPending.add(`${p.machine}/${p.id}`)
}

// One bad request or a stray promise must never take the server down; log it and keep serving.
process.on('unhandledRejection', error => console.error('Home HUD: unhandled', error))

export function start() {
  for (const host of HOSTS) {
    http.createServer((req, res) => handle(req, res).catch(() => send(res, 500, { error: 'server error' }))).listen(PORT, host)
  }
  console.log(`Home HUD ${MODE} "${MACHINE}" on ${HOSTS.join(', ')}:${PORT}${DEMO ? ' (demo data)' : ''}`)
  if (MODE === 'hub') {
    void refreshWeather()
    setInterval(() => void refreshWeather(), 15 * 60_000)
  }
  if (NTFY) {
    let busy = false
    setInterval(() => {
      if (busy) return
      busy = true
      watchForAlerts().catch(() => {}).finally(() => { busy = false })
    }, 5000)
  }
}

start()
