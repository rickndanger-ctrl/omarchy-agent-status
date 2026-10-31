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
//   POST /api/input  {input: up|down|select|back}  a phone remote's button (docs/REMOTE-INPUT.md)
//   GET  /api/input/wait?after=<seq>          the glasses' long-poll for those buttons (25 s)
//   POST /api/prompt {machine, pane, text|key} type a prompt into an agent's tmux pane (key: Escape)
//   POST /api/transcribe  (16 kHz s16le mono PCM body) → {text}   speech-to-text via Groq Whisper
//   POST /api/think {backend, system, prompt, timeoutSec}        one AI answer on this machine (docs/CONVERSATION.md)
//   POST /api/conversation/start {backend}, POST /api/conversation/chunk?id&seq (PCM), POST /api/conversation/stop {id}
//   GET  /api/conversation                    the conversation tile's session (idle, listening, summary)
//   GET  /api/messages?chat=<id>              hub: last messages of one chat (read-only)
//   GET  /api/muse                            hub: Muse's latest exchange (read-only, on demand)
//   GET  /api/layout, PUT /api/layout         the Tiles pages (layout.json); hub.json peers keep them in step
//   GET  /api/pinned, PUT /api/pinned         the pinned agents on Home (pinned.json: label, machine, agent, session); peers keep them in step
//   GET  /api/reminders                       hub: open Apple Reminders (Mini 1 relay)
//   POST /api/reminders/done {id}, /api/reminders/add {title, list?}
//   GET  /api/tile?url=<endpoint>             hub: a url: plug-in tile (only endpoints in layout.json)
//   POST /api/tile/action {url, id}           hub: an action on a url: plug-in tile
//   POST /api/hook/request, GET /api/hook/wait/<id>, POST /api/hook/cancel/<id>
//                                             approve_hook.py on this machine (loopback only)
//   GET  /, /assets/*                         the built glasses app (no token)

import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { helpers, think, THINK_BACKENDS } from './think.mjs'
import { sanitizeMuseReply } from './muse-clean.mjs'
import { createConversations, CONVERSATION_MAX_BYTES } from './conversation.mjs'
import { createListen, LISTEN_MAX_BYTES } from './listen.mjs'
import { createListenMuse } from './muse-queue.mjs'
import { isListenG2Busy } from './listen-g2.mjs'
import { createListenPage } from './listen-page.mjs'

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
// ---- orchestrator pin: the Claude session on this computer that the glasses read and write to (hub.json "orchestrator": {session, dir}) ----
// READ: the tail of its transcript (assistant text only, secrets redacted). WRITE: one JSON line in an inbox file the session picks up.
const expandHome = p => (String(p).startsWith('~') ? path.join(HOME, String(p).slice(1)) : String(p))
// Read in any mode: the computer that runs the session (a node, not necessarily the hub) answers for it. File: CONFIG_DIR/orchestrator.json, else hub.json.
const ORCH_CFG = readJson(process.env.HUD_ORCH_CONFIG || path.join(CONFIG_DIR, 'orchestrator.json')) || HUB.orchestrator
const ORCH = ORCH_CFG && /^[\w.-]+$/.test(String(ORCH_CFG.session || '')) && ORCH_CFG.dir
  ? { session: String(ORCH_CFG.session), dir: expandHome(ORCH_CFG.dir) } : null
const ORCH_PANE = 'orchestrator' // the pane name the glasses use for it; a tmux pane id (%3) can never collide
const ORCH_SESSION_FILE = () => path.join(CONFIG_DIR, 'orchestrator-session')
const ORCH_STALE_MS = 30 * 60_000
const ORCH_SCAN_HEAD = 64 * 1024
const ORCH_RESCAN_MS = Number(process.env.HUD_ORCH_RESCAN_MS) || 30_000
let orchPick = { id: '', why: '', checkedAt: 0 }
const orchMarked = new Map() // file name + size -> whether its first user message says ORCHESTRATOR (a read of the first 64 KB, once)
function orchIsMarked(name) {
  const file = path.join(ORCH.dir, name)
  let size = 0
  try { size = statSync(file).size } catch { return false }
  const key = `${name}:${Math.min(size, ORCH_SCAN_HEAD)}`
  if (orchMarked.has(key)) return orchMarked.get(key)
  let marked = false
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, ORCH_SCAN_HEAD))
      readSync(fd, buf, 0, buf.length, 0)
      for (const row of buf.toString('utf8').split('\n')) {
        let e
        try { e = JSON.parse(row) } catch { continue }
        if (e?.type !== 'user') continue
        const c = e.message?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.text ?? '').join(' ') : ''
        marked = text.includes('ORCHESTRATOR')
        break // only the first user message counts
      }
    } finally { closeSync(fd) }
  } catch { marked = false }
  orchMarked.set(key, marked)
  return marked
}
// Which transcript the orchestrator is: the id in CONFIG_DIR/orchestrator-session, else orchestrator.json; if that one has not changed for 30 minutes
// (or is gone), a NEWER transcript in the same folder whose first user message says ORCHESTRATOR.
function orchSessionId() {
  const now = Date.now()
  if (orchPick.id && now - orchPick.checkedAt < ORCH_RESCAN_MS) return orchPick.id
  let base = ORCH.session
  let why = 'orchestrator.json'
  try {
    const fromFile = readFileSync(ORCH_SESSION_FILE(), 'utf8').trim()
    if (/^[\w.-]+$/.test(fromFile)) { base = fromFile; why = 'orchestrator-session file' }
  } catch { /* no file: the configured session */ }
  let mtime = 0
  try { mtime = statSync(path.join(ORCH.dir, `${base}.jsonl`)).mtimeMs } catch { /* missing */ }
  let id = base
  if (!mtime || now - mtime > ORCH_STALE_MS) {
    try {
      const newer = readdirSync(ORCH.dir).filter(n => n.endsWith('.jsonl') && n.slice(0, -6) !== base && /^[\w.-]+$/.test(n.slice(0, -6)))
        .map(n => { try { return { n, m: statSync(path.join(ORCH.dir, n)).mtimeMs } } catch { return null } })
        .filter(x => x && x.m > mtime).sort((a, b) => b.m - a.m)
      const hit = newer.find(x => orchIsMarked(x.n))
      if (hit) { id = hit.n.slice(0, -6); why = `${base} unchanged 30 min, newer ORCHESTRATOR session` }
    } catch { /* no folder */ }
  }
  if (id !== orchPick.id) console.log(`orchestrator.session ${id} (${why})`)
  orchPick = { id, why, checkedAt: now }
  return id
}
const ORCH_FILE = () => path.join(ORCH.dir, `${orchSessionId()}.jsonl`)
const ORCH_INBOX = () => path.join(CONFIG_DIR, 'orchestrator-inbox.jsonl')
const ORCH_TAIL = 256 * 1024
const ORCH_WORKING_MS = 20_000
// Anything token-like is blanked before it leaves the hub.
export function redact(text) {
  return String(text)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[secret]')
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{8,}/g, '[secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [secret]')
    .replace(/\b((?:api[_-]?key|token|secret|password|passwd|key)\s*[=:]\s*)["']?[^\s"',;]{4,}["']?/gi, '$1[secret]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[secret]')
    .replace(/[A-Za-z0-9+\/_-]{32,}={0,2}/g, m => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? '[secret]' : m))
}
function orchState() {
  if (!ORCH) return null
  try {
    const st = statSync(ORCH_FILE())
    return { state: Date.now() - st.mtimeMs < ORCH_WORKING_MS ? 'working' : 'idle', at: st.mtimeMs / 1000 }
  } catch { return null }
}
async function orchestratorView() {
  if (!ORCH) return null
  let fh
  try {
    const { open } = await import('node:fs/promises')
    fh = await open(ORCH_FILE(), 'r')
    const { size } = await fh.stat()
    const start = Math.max(0, size - ORCH_TAIL)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let rows = buf.toString('utf8').split('\n')
    if (start > 0) rows = rows.slice(1) // the first line is cut
    const replies = []
    for (const row of rows) {
      let e
      try { e = JSON.parse(row) } catch { continue }
      if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
      const text = e.message.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text.trim()).filter(Boolean).join('\n')
      if (text) replies.push(text)
    }
    return replies.slice(-4).flatMap((t, i) => [...(i ? [''] : []), ...redact(t).split('\n')])
  } catch { return null } finally { await fh?.close() }
}
function orchestratorSend(text) {
  const clean = String(text ?? '').slice(0, 2000)
  if (!ORCH || !clean.trim()) return false
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  appendFileSync(ORCH_INBOX(), JSON.stringify({ at: Date.now(), text: clean, from: 'glasses' }) + '\n', { mode: 0o600 })
  return true
}
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
    // Spaces, session name before the path (path last, it may hold spaces): newer tmux prints a tab in -F output as "_".
    panes = (await run('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{session_name}|#{pane_current_path}'], { timeout: 2000 })).stdout
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
    const [, pane, pid, tmux, cwd] = line.match(/^(\S+) (\S+) (.*?)\|(.*)$/) ?? []
    if (!/^%\d+$/.test(pane || '')) continue
    const queue = [pid]
    for (let i = 0; i < queue.length && i < 200; i++) {
      const agent = agentOf.get(queue[i])
      if (agent) {
        result.push({ pane, agent, page: path.basename(cwd || ''), pid: queue[i], cwd, tmux })
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
        result.push({ pane: `screen:${pid}.${name}`, agent, page: path.basename(cwd), pid: queue[i], cwd, tmux: name })
        break
      }
      queue.push(...(children.get(queue[i]) ?? []))
    }
  }
  return result
}

/** Status sessions, each linked to its tmux pane when it has one; idle agents in tmux are listed too. */
/** The key status.py gives this Claude process's conversation (see status.py: sha256(session_id)[:20]). */
function claudeStatusKey(pid) {
  try {
    const { sessionId } = JSON.parse(readFileSync(path.join(homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'))
    return sessionId ? createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 20) : ''
  } catch {
    return ''
  }
}

async function sessionsWithPanes() {
  const [sessions, tmuxPanes, screens, windows] = await Promise.all([localSessions(), DEMO ? [] : agentPanes(), DEMO ? [] : agentScreens(), DEMO ? [] : agentWindows()])
  const panes = [...tmuxPanes, ...screens]
  const byRecency = [...sessions].sort((a, b) => b.at - a.at)
  // Exact match first: a Claude process records its conversation id, and status.py names that session
  // sha256(id)[:20]. Matching by folder alone fails once Claude works in a different folder than it was
  // started in, which left a second, un-openable copy of the chat (and its "finished" alerts pointed there).
  const sameChat = (s, term) => term.agent === 'claude' && s.session === claudeStatusKey(term.pid)
  for (const term of [...panes, ...windows]) {
    const match = byRecency.find(s => !s.pane && !s.window && sameChat(s, term))
    if (!match) continue
    if (term.window) Object.assign(match, { window: term.window, workspace: term.workspace || match.workspace })
    else Object.assign(match, { pane: term.pane, tmux: term.tmux })
    term.matched = true
  }
  for (const pane of panes) {
    if (pane.matched) continue
    const match = byRecency.find(s => !s.pane && s.agent === pane.agent && s.page === pane.page)
    if (match) Object.assign(match, { pane: pane.pane, tmux: pane.tmux })
    else sessions.push({ agent: pane.agent, name: AGENT_NAMES[pane.agent], session: `tmux${pane.pane}`, state: 'idle', page: pane.page, at: 0, workspace: '', machine: MACHINE, pane: pane.pane, tmux: pane.tmux })
  }
  // Agents in a plain terminal window (no tmux): prompt them by typing into that window.
  for (const win of windows) {
    if (win.matched || sessions.some(s => s.window === win.window)) continue
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

async function codexThreadView(threadId, stamps = false) {
  const result = await codexEngine(call => call('thread/read', { threadId, includeTurns: true }))
  const out = []
  for (const turn of result.thread?.turns ?? result.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).map(c => c.text ?? '').join(' ').trim()
        if (text && !text.startsWith('<')) said(out, 'you', text, item.createdAt ?? turn.startedAt ?? turn.createdAt, stamps)
      } else if (item.type === 'agentMessage' && String(item.text ?? '').trim()) said(out, 'codex', String(item.text).trim(), item.createdAt ?? turn.completedAt ?? turn.startedAt, stamps)
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
  const [sessions, desk, starts, studio] = await Promise.all([sessionsWithPanes(), desktop(), canStart(), studioSummary()])
  const orch = orchState()
  if (orch) sessions.push({ agent: 'claude', name: 'Orchestrator', session: 'orchestrator', state: orch.state, page: 'Orchestrator', at: orch.at, workspace: '', machine: MACHINE, pane: ORCH_PANE, tmux: ORCH_PANE })
  return { machine: MACHINE, online: true, sessions, pending: publicPending(), desktop: desk, canStart: starts, studio }
}

// Studio Routing (re-studio/viewer on the laptop) serves a short summary for the glasses; any node running it reports it.
const STUDIO_URL = process.env.STUDIO_URL || 'http://127.0.0.1:8765/api/studio'
async function studioSummary() {
  if (DEMO) return { at: Date.now() / 1000, machines: [{ name: 'Laptop', line: 'Reverser · step 4 · engines', busy: true }, { name: 'Mini 2', line: 'standing by', busy: false }],
    feed: [{ t: Date.now() / 1000 - 60, text: 'Claude → Reverser: write up the engine manager now', kind: 'say' }] }
  try {
    const res = await fetch(STUDIO_URL, { signal: AbortSignal.timeout(1500) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// ---- hub -------------------------------------------------------------------------

// Hands a question to the first Muse, from index `start` on, that is up and
// whose text box is ready. Returns {id, muse} or null.
// Every reply taken from a relay goes through this before it is served: the answer only, the cut logged once per reply.
const museTrimLogged = new Set()
function museReply(raw, id, partial = false) {
  const { text, trimmed, anchor } = sanitizeMuseReply(raw, { partial })
  if (trimmed > 0) {
    const key = `${id}:${trimmed}`
    if (!museTrimLogged.has(key)) { museTrimLogged.add(key); if (museTrimLogged.size > 200) museTrimLogged.clear(); console.log(`muse.trimmed ${trimmed} chars at ${anchor}`) }
  }
  return text
}

async function askMuse(text, start) {
  for (const [i, muse] of MUSES.entries()) {
    if (i < start) continue
    try {
      const health = await call(`${muse.url}/selftest`, muse.token, { timeout: 8000 })
      if (!health.ok || (!health.composer && !LISTEN_MUSE.holds(i))) continue
      const r = await call(`${muse.url}/ask`, muse.token, { method: 'POST', body: JSON.stringify({ text }), timeout: 10_000 })
      return { id: `${i}-${r.id}`, muse: muse.name }
    } catch { /* try the next Muse */ }
  }
  return null
}
// Glasses id → id of the same question re-asked on a later Muse.
const museMoved = new Map()
const museMoving = new Set() // ids being handed on right now (the glasses poll fast)

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

// Open Reminders, cached briefly: the glasses poll /api/home often and the relay makes one call per list.
let remindersCache = null // { at, items }
// When the hub first saw each open reminder (ms): the "added" time, since the relay sends no creation date.
// Kept in memory; pruned to the reminders that are still open after each full read.
const firstSeen = new Map()
// The same order as the tile's sortReminders (src/tiles.ts): due within a day (overdue too) first, soonest
// first; then the newest added; a tie goes to the Reminders list.
const DAY_MS = 86_400_000
const byRelevance = now => {
  const soon = r => typeof r.dueAt === 'number' && r.dueAt <= now + DAY_MS
  return (a, b) =>
    Number(soon(b)) - Number(soon(a))
    || (soon(a) && soon(b) ? a.dueAt - b.dueAt : 0)
    || (b.added ?? -Infinity) - (a.added ?? -Infinity)
    || Number(b.list === 'Reminders') - Number(a.list === 'Reminders')
}
async function openReminders() {
  const lists = listOf(await remindersRelay('/lists'), 'lists')
  // One list at a time: the relay serves at most 8 connections and answers "busy" (503) past that.
  const groups = []
  for (const l of lists) {
    const items = listOf(await remindersRelay(`/lists/${encodeURIComponent(l.id)}/items?open=1`), 'items')
    groups.push(items.map(i => ({ id: String(i.id), title: clip(i.title, 120), due: dueLabel(i.due), dueAt: msOrNull(i.due), created: msOrNull(i.created ?? i.creationDate), list: clip(l.title, 40) })))
  }
  const now = Date.now()
  const all = groups.flat().map(({ created, ...r }) => {
    if (!firstSeen.has(r.id)) firstSeen.set(r.id, now)
    return { ...r, added: created ?? firstSeen.get(r.id) }
  })
  const open = new Set(all.map(r => r.id))
  for (const id of firstSeen.keys()) if (!open.has(id)) firstSeen.delete(id)
  return all.sort(byRelevance(now))
}
const msOrNull = iso => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}
async function remindersSummary() {
  if (DEMO) return demoReminders()
  if (!REMINDERS_URL) return null
  if (remindersCache && Date.now() - remindersCache.at < 15_000) return remindersCache.items
  // A failure is cached too (as null): a down relay must not stall every /api/home poll.
  let items = null
  try {
    // Sorted in openReminders, so the 30 kept are the ones that matter most.
    items = (await openReminders()).slice(0, 30)
  } catch {
    items = null
  }
  remindersCache = { at: Date.now(), items }
  return items
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
    hub: MACHINE,
    weather: DEMO ? { temp: 62, desc: 'Cloudy', hi: 68, lo: 51, rainAt: '4 PM', rainChance: 70 } : weather,
    messages: MODE === 'hub' || DEMO ? await messagesSummary() : null,
    reminders: await remindersSummary(),
    muse: MODE === 'hub' ? MUSES.length > 0 : DEMO,
    studio: views.find(v => v.studio)?.studio ?? null,
    pinned: MODE === 'hub' ? loadPinned().pins : [],
  }
}

const remindersRelay = (route, init = {}) => call(`${REMINDERS_URL}${route}`, REMINDERS_TOKEN, { timeout: 4000, ...init })
// The relay answers either a bare array or an object holding one under `key`.
const listOf = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : [])
// Writes: the relay's reply body is not needed (and may be empty), only its status.
async function remindersWrite(route, body) {
  const res = await fetch(`${REMINDERS_URL}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REMINDERS_TOKEN}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`${res.status}`)
}
// The list a new reminder goes to: the one named (id or title), else hub.json remindersList,
// else the list titled "Reminders", else the first list.
async function resolveReminderList(wanted) {
  const lists = listOf(await remindersRelay('/lists'), 'lists')
  const find = name => (name ? lists.find(l => l.id === name || l.title === name) : undefined)
  const list = find(String(wanted ?? '')) ?? find(REMINDERS_LIST) ?? lists.find(l => l.title === 'Reminders') ?? lists[0]
  if (!list) throw new Error('no reminder lists')
  return String(list.id)
}
// A short, tile-sized due time in this machine's time zone: "Today 9 AM", "Tomorrow", "Oct 30".
function dueLabel(iso, now = Date.now()) {
  if (!iso) return null
  const due = new Date(iso)
  if (Number.isNaN(due.getTime())) return null
  if (due.getTime() < now) return 'Overdue'
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((dayStart(due) - dayStart(new Date(now))) / 86_400_000)
  // Intl puts a narrow no-break space before AM/PM; a tile counts characters, so use plain spaces.
  const clock = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: due.getMinutes() ? '2-digit' : undefined }).replace(/\s/g, ' ')
  if (days === 0) return `Today ${clock}`
  if (days === 1) return 'Tomorrow'
  return due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ---- demo data (HUD_DEMO=1, for the simulator) -----------------------------------------
const demoReminders = () => [
  { id: 'demo-r1', title: 'Pick up dry cleaning', due: null, list: 'Errands' },
  { id: 'demo-r2', title: 'Call the dentist', due: null, list: 'Home' },
]

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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
  if (pane === ORCH_PANE && ORCH) return key ? false : orchestratorSend(text)
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

/** A time (ISO text, seconds or ms) as ms since 1970; 0 when unknown. */
function toMs(t) {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t
  return Date.parse(t ?? '') || 0
}

/**
 * One message in a conversation view. With `stamps` (newer glasses apps ask for it), a "::msg <who> <ms>"
 * header line comes first (no blank line: the bar is the gap) and the app draws it as a bar with the speaker
 * and time; otherwise "Claude: …" after a blank line.
 */
function said(out, who, text, time, stamps) {
  if (stamps) out.push(`::msg ${who} ${toMs(time)}`, text)
  else out.push('', `${who === 'you' ? 'You' : who === 'claude' ? 'Claude' : 'Codex'}: ${text}`)
}

/** Claude's own record of the conversation: ~/.claude/sessions/<pid>.json points to the transcript. */
async function claudeConversation(pid, stamps = false) {
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
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join(' ') : ''
      if (text.trim() && !text.startsWith('<')) said(out, 'you', text.trim(), item.timestamp, stamps)
    } else if (item.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        // Label replies and leave a blank line before each, so they stand apart from yours on the glasses.
        if (c.type === 'text' && c.text.trim()) said(out, 'claude', c.text.trim(), item.timestamp, stamps)
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
async function codexConversation(pid, cwd, stamps = false) {
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
      said(out, p.role === 'user' ? 'you' : 'codex', text, item.timestamp, stamps)
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

async function terminalView(pane, window, stamps = false) {
  const all = [...(await agentPanes()), ...(await agentScreens()), ...(await agentWindows())]
  const target = all.find(t => (pane && t.pane === pane) || (window && t.window === window))
  if (!target) return null
  const conversation = target.agent === 'claude' ? await claudeConversation(target.pid, stamps)
    : target.agent === 'codex' ? await codexConversation(target.pid, target.cwd, stamps).catch(() => null)
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
  const res = await fetch(process.env.HUD_TRANSCRIBE_URL || 'https://api.groq.com/openai/v1/audio/transcriptions', {
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

// ---- tiles: the pages (layout.json), Reminders and url: plug-in tiles -----------------------
// ---- the conversation tile (docs/CONVERSATION.md): think on the right node, listen in short chunks ------------
// hub.json "conversation": {"local": "lap", "claude": "lap", "codex": "Mini 1"}. A backend with no entry, or "self",
// runs on this machine; otherwise the named node runs it (POST /api/think, with that node's token).
const CONVERSATION_NODES = HUB.conversation ?? {}
async function thinkAt(args) {
  const where = CONVERSATION_NODES[args.backend] || 'self'
  if (where === 'self' || where === MACHINE) return think(args)
  const node = NODES.find(n => n.name === where)
  if (!node) throw new Error(`no node named ${where} in hub.json`)
  // The node's own error line (say, "Claude isn't set up on this hub") is passed on as it is. Anything else that is
  // not an answer (no reply, a cut-off or bad body, no text) is "did not answer", so the chain goes on.
  let res
  try {
    res = await fetch(`${node.url}/api/think`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout((Number(args.timeoutSec) + 5) * 1000),
    })
  } catch {
    throw new Error(`${where} did not answer`)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error || `${where} did not answer`)
  if (typeof body?.text !== 'string' || !body.text.trim()) throw new Error(`${where} did not answer`)
  return { text: body.text, ms: Number(body.ms) || 0 }
}
// Diagnostics for the conversation: names and counts or timings only, never transcript text.
const conversationDiag = (name, detail) => {
  diagnostics.push({ at: new Date().toISOString(), name, detail: clip(detail, 160) })
  if (diagnostics.length > 1000) diagnostics.shift()
}
const CONVERSATION = createConversations({
  transcribe,
  think: thinkAt,
  diag: conversationDiag,
  dir: path.join(CONFIG_DIR, 'conversations'),
  limitMs: Number(process.env.HUD_CONV_LIMIT_MS) || undefined,
})

// Listen owns only its best-effort snippets; G2's Muse paths above are unchanged.
function listenG2Busy() {
  return isListenG2Busy(diagnostics, Date.now(), museMoving.size > 0)
}
const LISTEN_MUSE = createListenMuse({
  muses: MUSES,
  isG2Busy: listenG2Busy,
  pollMs: HUB.listen?.pollMs,
  attemptMs: HUB.listen?.timeoutMs,
  requestMs: HUB.listen?.requestMs,
})
const LISTEN = createListen({
  transcribe,
  ask: request => LISTEN_MUSE.ask(request),
  diag: conversationDiag,
  snippetMs: HUB.listen?.snippetMs,
  minWords: HUB.listen?.minWords,
  idleMs: HUB.listen?.idleMs,
  notesFrom: HUB.listen?.notesFrom,
})
const LISTEN_PAGE = createListenPage({ listen: LISTEN, loopback })

// Apple Reminders: the Mini 1 relay, configured like the Messages relay (hub.json "remindersUrl", "remindersTokenFile", "remindersList").
const REMINDERS_URL = HUB.remindersUrl ? String(HUB.remindersUrl).replace(/\/$/, '') : ''
const REMINDERS_TOKEN = HUB.remindersTokenFile ? tokenFrom(HUB.remindersTokenFile) : ''
const REMINDERS_LIST = HUB.remindersList ? String(HUB.remindersList) : '' // default list for new reminders: an id or a title
// DEFAULT_LAYOUT mirrors glasses/home-app/src/tiles.ts; keep the two equal.
const TILE_LAYOUT_FILE = path.join(CONFIG_DIR, 'layout.json')
const DEFAULT_LAYOUT = {
  pages: [
    { left: 'muse', right: 'agent:Dell/claude' },
    { left: 'chat:recent', right: 'agent:Mini 1/codex' },
    { left: 'reminders', right: 'studio' },
    { left: 'approvals', right: 'messages' },
    { left: 'clock', right: 'empty' },
  ],
}
const PAGE_COUNT = 5
const WIDGET_ID_MAX = 80

// A layout from a request or from disk: exactly PAGE_COUNT pages of {left, right} widget ids, or null.
function checkLayout(raw) {
  if (!raw || !Array.isArray(raw.pages) || raw.pages.length !== PAGE_COUNT) return null
  const ok = id => typeof id === 'string' && id.length > 0 && id.length <= WIDGET_ID_MAX
  const pages = raw.pages.map(pg => (pg && ok(pg.left) && ok(pg.right) ? { left: pg.left, right: pg.right } : null))
  return pages.every(Boolean) ? { pages } : null
}
// The layout on disk and when it was saved (ms). A file from before updatedAt existed counts as 0.
function loadLayout() {
  const raw = readJson(TILE_LAYOUT_FILE)
  const layout = checkLayout(raw)
  return layout ? { ...layout, updatedAt: Number(raw.updatedAt) || 0 } : { ...DEFAULT_LAYOUT, updatedAt: 0 }
}
function saveLayout(layout, updatedAt) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(TILE_LAYOUT_FILE, JSON.stringify({ pages: layout.pages, updatedAt }, null, 2) + '\n', { mode: 0o600 })
}
// Hubs in hub.json "peers" keep one layout. A saved change goes to each peer once, marked relayed; a relayed
// copy is kept only if it is newer and is never passed on, so two hubs cannot loop. On start, each hub takes
// the newest copy from its peers. Fire and forget, like the location.
function pushLayout(layout) {
  for (const peer of HUB.peers ?? []) {
    call(`${String(peer.url).replace(/\/$/, '')}/api/layout`, peer.tokenFile ? tokenFrom(peer.tokenFile) : TOKEN, { method: 'PUT', body: JSON.stringify({ ...layout, relayed: true }), timeout: 8000 }).catch(() => {})
  }
}
async function pullLayouts() {
  for (const peer of HUB.peers ?? []) {
    try {
      const theirs = await call(`${String(peer.url).replace(/\/$/, '')}/api/layout`, peer.tokenFile ? tokenFrom(peer.tokenFile) : TOKEN, { timeout: 8000 })
      const layout = checkLayout(theirs)
      const updatedAt = Number(theirs.updatedAt) || 0
      if (layout && updatedAt > loadLayout().updatedAt) saveLayout(layout, updatedAt)
    } catch {
      // The peer is down: keep what this hub has.
    }
  }
}

// ---- pinned agents: the list Home shows first (pinned.json). Only the list is stored; their state comes from the sessions. ----
const PINNED_FILE = path.join(CONFIG_DIR, 'pinned.json')
const PIN_MAX = 12
const pin = (label, machine, agent, session) => ({ label, machine, agent, session })
// The sessions are the ones com.rick.home-agents already keeps: tmux 'claude'/'codex' on the Minis, screen 'claude'/'codex' on Neo.
// Dell has no tmux: its Claude is the laptop window the Tiles 'agent:Dell/claude' tile follows (session 'tile', resolved by the app like that tile).
const DEFAULT_PINS = [
  pin('Claude · Orchestrator', 'Dell', 'claude', ORCH_PANE),
  pin('Claude · Mini 1', 'Mini 1', 'claude', 'claude'), pin('Codex · Mini 1', 'Mini 1', 'codex', 'codex'),
  pin('Claude · Mini 2', 'Mini 2', 'claude', 'claude'), pin('Codex · Mini 2', 'Mini 2', 'codex', 'codex'),
  pin('Claude · Neo', 'Neo', 'claude', 'claude'), pin('Codex · Neo', 'Neo', 'codex', 'codex'),
  pin('Claude · Dell window', 'Dell', 'claude', 'tile'),
]
// A pin list from a request or from disk: up to PIN_MAX pins of non-empty strings, or null.
function checkPins(raw) {
  const list = raw && Array.isArray(raw.pins) ? raw.pins : null
  if (!list || list.length > PIN_MAX) return null
  const ok = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 60
  const pins = list.map(x => (x && ok(x.label) && ok(x.machine) && ok(x.agent) && ok(x.session) ? pin(x.label.trim(), x.machine.trim(), x.agent.trim(), x.session.trim()) : null))
  return pins.every(Boolean) ? { pins } : null
}
function loadPinned() {
  const raw = readJson(PINNED_FILE)
  const checked = checkPins(raw)
  return checked ? { ...checked, updatedAt: Number(raw.updatedAt) || 0 } : { pins: DEFAULT_PINS, updatedAt: 0 }
}
function savePinned(pins, updatedAt) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(PINNED_FILE, JSON.stringify({ pins, updatedAt }, null, 2) + '\n', { mode: 0o600 })
}
// Kept in step between hubs exactly like the layout: a saved change goes to each peer once (relayed), a relayed copy is kept only if newer.
function pushPinned(value) {
  for (const peer of HUB.peers ?? []) {
    call(`${String(peer.url).replace(/\/$/, '')}/api/pinned`, peer.tokenFile ? tokenFrom(peer.tokenFile) : TOKEN, { method: 'PUT', body: JSON.stringify({ ...value, relayed: true }), timeout: 8000 }).catch(() => {})
  }
}
async function pullPinned() {
  for (const peer of HUB.peers ?? []) {
    try {
      const theirs = await call(`${String(peer.url).replace(/\/$/, '')}/api/pinned`, peer.tokenFile ? tokenFrom(peer.tokenFile) : TOKEN, { timeout: 8000 })
      const checked = checkPins(theirs)
      const updatedAt = Number(theirs.updatedAt) || 0
      if (checked && updatedAt > loadPinned().updatedAt) savePinned(checked.pins, updatedAt)
    } catch {
      // The peer is down: keep what this hub has.
    }
  }
}

// The endpoints of the url: tiles in the saved layout. Nothing else is ever fetched for a tile.
function layoutUrlEndpoints() {
  const out = new Set()
  for (const pg of loadLayout().pages) for (const id of [pg.left, pg.right]) if (id.startsWith('url:')) out.add(id.slice(4))
  return out
}

// A plug-in endpoint is plain JSON over http(s); no hub token goes to it.
async function pluginCall(endpoint, options = {}) {
  if (!/^https?:\/\//.test(endpoint)) throw new Error('not a web address')
  const res = await fetch(endpoint, { ...options, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}
// Keeps a plug-in's answer to the UrlTile shape and sensible sizes.
function tileFrom(raw) {
  const lines = Array.isArray(raw?.lines) ? raw.lines.slice(0, 60).map(l => String(l ?? '').slice(0, 200)) : []
  const actions = Array.isArray(raw?.actions)
    ? raw.actions.slice(0, 6).map(a => ({ label: clip(a?.label, 30), id: clip(a?.id, 40) })).filter(a => a.label && a.id)
    : []
  return { title: clip(raw?.title, 40) || 'Tile', lines, actions }
}

// ---- phone remote (docs/REMOTE-INPUT.md): a phone's four buttons, delivered to the glasses' long-poll ----------
const INPUTS = new Set(['up', 'down', 'select', 'back', 'settings'])
const INPUT_RETAIN_MS = 2000 // an input is delivered only this long after it arrived, never replayed later
const INPUT_LISTEN_MS = 3000 // a wait closed this recently still counts as the glasses listening
const INPUT_RATE = 10 // inputs per second, shared by every phone
const INPUT_WAIT_MS = Number(process.env.HUD_INPUT_WAIT_MS) || 25_000
let inputSeq = 0
let inputsKept = [] // {seq, input, at}
const inputWaiters = new Set() // {after, finish}
let openWaits = 0
let lastWaitEnd = 0
const inputTimes = [] // when the recent inputs arrived, for the shared rate limit

// Inputs with a number above `after` that arrived in the last few seconds, oldest first.
function freshInputs(after) {
  const now = Date.now()
  inputsKept = inputsKept.filter(i => now - i.at <= INPUT_RETAIN_MS)
  return inputsKept.filter(i => i.seq > after)
}
const glassesListening = () => openWaits > 0 || Date.now() - lastWaitEnd < INPUT_LISTEN_MS
// One diagnostic for the phone remote: a name and a short detail, capped like the others.
function remoteDiag(name, detail) {
  diagnostics.push({ at: new Date().toISOString(), name, detail })
  if (diagnostics.length > 1000) diagnostics.shift()
}
// True when this input would go over the shared limit; otherwise it is counted.
function overInputRate() {
  const now = Date.now()
  while (inputTimes.length && now - inputTimes[0] >= 1000) inputTimes.shift()
  if (inputTimes.length >= INPUT_RATE) return true
  inputTimes.push(now)
  return false
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname.replace(/^\/hud(?=\/|$)/, '') || '/'
  LISTEN_MUSE.noteG2(req.method, p)
  if (p === '/listen' || p.startsWith('/listen/')) return LISTEN_PAGE(req, res, p)
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
      if (pane === ORCH_PANE && ORCH) { const lines = await orchestratorView(); return lines ? send(res, 200, { lines }) : send(res, 404, { error: 'agent not found' }) }
      if (DEMO) return send(res, 200, { lines: ['You: run the tests', 'Running the test suite now.', '[Bash] npm test', 'All 15 tests pass.'] })
      const appThread = url.searchParams.get('appThread') || ''
      const stamps = url.searchParams.get('stamps') === '1'
      if (appThread) return send(res, 200, { lines: await codexThreadView(appThread, stamps) })
      const lines = await terminalView(pane, window, stamps)
      return lines ? send(res, 200, { lines }) : send(res, 404, { error: 'agent not found' })
    }
    if (p === '/api/listen' || p.startsWith('/api/listen/')) {
      if (MODE !== 'hub') return send(res, 404, { error: 'Listen is unavailable on this node' })
      if (req.method === 'GET' && p === '/api/listen') {
        const raw = url.searchParams.get('since')
        const r = LISTEN.state(url.searchParams.get('id'), raw === null ? undefined : raw.trim() ? Number(raw) : NaN)
        return send(res, r.status, r.body)
      }
      if (req.method === 'POST' && p === '/api/listen/chunk') {
        const pcm = await readRaw(req, LISTEN_MAX_BYTES).catch(() => null)
        if (!pcm) return send(res, 413, { error: 'chunk too large' })
        const seq = url.searchParams.get('seq')
        const r = await LISTEN.chunk(url.searchParams.get('id'), seq?.trim() ? Number(seq) : NaN, pcm)
        return send(res, r.status, r.body)
      }
      if (req.method === 'POST' && (p === '/api/listen/start' || p === '/api/listen/stop')) {
        const b = await readBody(req).catch(() => null)
        if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'invalid request' })
        const r = p.endsWith('/start') ? LISTEN.start(b) : LISTEN.stop(b.id)
        return send(res, r.status, r.body)
      }
      return send(res, 404, { error: 'unknown Listen endpoint' })
    }
    if (req.method === 'POST' && p === '/api/transcribe') {
      const pcm = await readRaw(req, 4_000_000) // ~2 minutes of 16 kHz audio
      if (pcm.length < 3200) return send(res, 200, { text: '' })
      return send(res, 200, { text: await transcribe(pcm) })
    }
    // One AI answer on this machine: the node side of the conversation tile (any node serves it).
    if (req.method === 'POST' && p === '/api/think') {
      // A summary request carries the whole talk, so this body may be much larger than the usual 16 KB.
      const raw = await readRaw(req, 512 * 1024).catch(() => null)
      let b = {}
      try { b = JSON.parse(raw?.toString() || '{}') } catch { b = {} }
      if (!THINK_BACKENDS.includes(b.backend)) return send(res, 400, { error: 'backend must be local, claude or codex' })
      if (!String(b.prompt ?? '').trim()) return send(res, 400, { error: 'prompt is required' })
      try {
        return send(res, 200, await think({ backend: b.backend, system: String(b.system ?? ''), prompt: String(b.prompt), timeoutSec: Number(b.timeoutSec) || 60 }))
      } catch (err) {
        return send(res, 502, { error: clip(err.message, 160) })
      }
    }
    if (req.method === 'POST' && p === '/api/conversation/start') {
      const b = await readBody(req).catch(() => ({}))
      const r = CONVERSATION.start(b.backend)
      return send(res, r.status, r.body)
    }
    if (req.method === 'POST' && p === '/api/conversation/chunk') {
      // About 9 s of 16 kHz PCM per chunk; a larger body is refused.
      const pcm = await readRaw(req, CONVERSATION_MAX_BYTES).catch(() => null)
      if (!pcm) return send(res, 413, { error: 'chunk too large' })
      const r = CONVERSATION.chunk(url.searchParams.get('id'), Number(url.searchParams.get('seq')), pcm)
      return send(res, r.status, r.body)
    }
    if (req.method === 'POST' && p === '/api/conversation/stop') {
      const b = await readBody(req).catch(() => ({}))
      const r = CONVERSATION.stop(String(b.id ?? ''))
      return send(res, r.status, r.body)
    }
    if (req.method === 'GET' && p === '/api/conversation') return send(res, 200, CONVERSATION.state())
    // Step-by-step app diagnostics (names and sizes only, never audio or words), last 1000 in memory.
    if (req.method === 'POST' && p === '/api/diag') {
      const b = await readBody(req)
      diagnostics.push({ at: new Date().toISOString(), name: clip(b.name, 40), detail: clip(b.detail, 160) })
      if (diagnostics.length > 1000) diagnostics.shift()
      return send(res, 200, { ok: true })
    }
    // helpers: which AI helpers this machine has (paths only, no tokens); the local model's reachability.
    if (req.method === 'GET' && p === '/api/diag') return send(res, 200, { diagnostics, helpers: await helpers() })
    // The phone remote. A phone posts a button; the glasses' app holds one long-poll open and gets it at once.
    if (req.method === 'POST' && p === '/api/input') {
      const b = await readBody(req).catch(() => ({}))
      const input = String(b?.input ?? '')
      if (!INPUTS.has(input)) return send(res, 400, { ok: false, error: 'input must be up, down, select, back or settings' })
      if (overInputRate()) {
        remoteDiag('remote.limited', input)
        return send(res, 429, { ok: false, error: 'too fast' })
      }
      if (!glassesListening()) {
        remoteDiag('remote.input', `${input} not delivered`)
        return send(res, 200, { ok: true, delivered: false, reason: 'no glasses listening on this hub' })
      }
      const seq = ++inputSeq
      inputsKept.push({ seq, input, at: Date.now() })
      for (const w of [...inputWaiters]) if (w.after < seq) w.finish(freshInputs(w.after))
      remoteDiag('remote.input', `${input} delivered`)
      return send(res, 200, { ok: true, delivered: true, seq })
    }
    if (req.method === 'GET' && p === '/api/input/wait') {
      // `after` missing or 0 means "from now": only inputs that arrive after this wait opened are returned.
      // An `after` above the latest seq belongs to a hub that has since restarted (its numbers began again at 0),
      // so it also means "from now"; otherwise the glasses would wait until the new numbers passed the old one.
      const given = Number(url.searchParams.get('after')) || 0
      const after = given > 0 && given <= inputSeq ? given : inputSeq
      const ready = freshInputs(after)
      if (ready.length) return send(res, 200, { seq: ready[ready.length - 1].seq, inputs: ready.map(({ seq, input, at }) => ({ seq, input, at })) })
      openWaits++
      await new Promise(resolve => {
        let done = false
        const finish = list => {
          if (done) return
          done = true
          clearTimeout(timer)
          inputWaiters.delete(waiter)
          openWaits--
          lastWaitEnd = Date.now()
          if (!res.headersSent) send(res, 200, list.length ? { seq: list[list.length - 1].seq, inputs: list.map(({ seq, input, at }) => ({ seq, input, at })) } : { seq: inputSeq, inputs: [] })
          resolve()
        }
        const waiter = { after, finish }
        inputWaiters.add(waiter)
        const timer = setTimeout(() => finish([]), INPUT_WAIT_MS)
        // The glasses went away mid-wait: the wait ends; the next one counts as listening again.
        res.on('close', () => finish([]))
      })
      return
    }
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
      const r = await askMuse(text, 0)
      if (r) return send(res, 200, r)
      return send(res, 502, { error: 'no Muse is ready right now' })
    }
    if (req.method === 'GET' && p === '/api/muse/reply') {
      let id = String(url.searchParams.get('id') ?? '')
      // A question handed on to another Muse is followed there (see below).
      while (museMoved.has(id)) id = museMoved.get(id)
      if (DEMO) return send(res, 200, { status: 'done', question: 'demo question', reply: 'Here is what Muse would say.' })
      const [, index, job] = id.match(/^(\d+)-(\w{1,40})$/) ?? []
      const muse = MUSES[Number(index)]
      if (MODE !== 'hub' || !muse || !job) return send(res, 400, { error: 'bad id' })
      const r = await call(`${muse.url}/reply/${job}`, muse.token, { timeout: 6000 })
      // musectl failed before anything was typed (Muse windowed, box not
      // clickable…): the question never reached this Muse, so hand it to the
      // next one that is ready. The glasses keep polling the same id.
      if (r.status === 'error' && /^Command failed/.test(String(r.error ?? '')) && r.question) {
        if (museMoving.has(id)) return send(res, 200, { status: 'sending', question: clip(r.question, 300), reply: '', error: '' })
        museMoving.add(id)
        const next = await askMuse(String(r.question), Number(index) + 1).finally(() => museMoving.delete(id))
        if (next) {
          museMoved.set(id, next.id)
          setTimeout(() => museMoved.delete(id), 10 * 60_000).unref()
          return send(res, 200, { status: 'sending', question: clip(r.question, 300), reply: '', error: '' })
        }
      }
      return send(res, 200, { status: String(r.status ?? ''), question: clip(r.question, 300), reply: museReply(r.reply, id, !['done', 'error', 'timeout'].includes(String(r.status))).slice(0, 2000), error: clip(r.error, 120) })
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
      return send(res, 200, { question: clip(latest.question, 300), reply: museReply(latest.reply, 'latest').slice(0, 900) })
    }
    if (req.method === 'GET' && p === '/api/layout') return send(res, 200, loadLayout())
    if (req.method === 'PUT' && p === '/api/layout') {
      const body = await readBody(req)
      const layout = checkLayout(body)
      if (!layout) return send(res, 400, { error: `layout needs ${PAGE_COUNT} pages of {left, right} widget ids` })
      if (body.relayed) {
        // A peer's copy: kept only if newer, and never passed on.
        const updatedAt = Number(body.updatedAt) || 0
        if (updatedAt > loadLayout().updatedAt) saveLayout(layout, updatedAt)
        return send(res, 200, { ok: true })
      }
      const updatedAt = Math.max(Date.now(), loadLayout().updatedAt + 1)
      saveLayout(layout, updatedAt)
      pushLayout({ ...layout, updatedAt })
      return send(res, 200, loadLayout())
    }
    if (req.method === 'GET' && p === '/api/pinned') return send(res, 200, loadPinned())
    if (req.method === 'PUT' && p === '/api/pinned') {
      const body = await readBody(req)
      const checked = checkPins(body)
      if (!checked) return send(res, 400, { error: `pinned needs up to ${PIN_MAX} pins of {label, machine, agent, session}` })
      if (body.relayed) {
        const updatedAt = Number(body.updatedAt) || 0
        if (updatedAt > loadPinned().updatedAt) savePinned(checked.pins, updatedAt)
        return send(res, 200, { ok: true })
      }
      const updatedAt = Math.max(Date.now(), loadPinned().updatedAt + 1)
      savePinned(checked.pins, updatedAt)
      pushPinned({ pins: checked.pins, updatedAt })
      return send(res, 200, loadPinned())
    }
    if (req.method === 'GET' && p === '/api/reminders') {
      if (DEMO) return send(res, 200, { reminders: demoReminders() })
      if (!REMINDERS_URL) return send(res, 404, { error: 'reminders unavailable' })
      return send(res, 200, { reminders: await openReminders() })
    }
    if (req.method === 'POST' && p === '/api/reminders/done') {
      const b = await readBody(req)
      const id = String(b.id ?? '').slice(0, 200)
      if (DEMO) return send(res, 200, { ok: true })
      if (!REMINDERS_URL || !id) return send(res, 400, { ok: false, error: 'cannot complete' })
      await remindersWrite(`/items/${encodeURIComponent(id)}/done`)
      remindersCache = null
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p === '/api/reminders/add') {
      const b = await readBody(req)
      const title = clip(b.title, 200)
      const list = clip(b.list, 60)
      if (DEMO) return send(res, 200, { ok: true })
      if (!REMINDERS_URL || !title) return send(res, 400, { ok: false, error: 'cannot add' })
      const listId = await resolveReminderList(list)
      await remindersWrite('/items', JSON.stringify({ listId, title }))
      remindersCache = null
      return send(res, 200, { ok: true })
    }
    if (req.method === 'GET' && p === '/api/tile') {
      const endpoint = String(url.searchParams.get('url') ?? '')
      if (!layoutUrlEndpoints().has(endpoint)) return send(res, 404, { error: 'not in layout' })
      return send(res, 200, tileFrom(await pluginCall(endpoint)))
    }
    if (req.method === 'POST' && p === '/api/tile/action') {
      const b = await readBody(req)
      const endpoint = String(b.url ?? '')
      const id = String(b.id ?? '').slice(0, 40)
      if (!layoutUrlEndpoints().has(endpoint)) return send(res, 404, { ok: false, error: 'not in layout' })
      if (!id) return send(res, 400, { ok: false, error: 'no action id' })
      await pluginCall(endpoint, { method: 'POST', body: JSON.stringify({ id }) })
      return send(res, 200, { ok: true })
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
    void pullLayouts()
    void pullPinned()
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
