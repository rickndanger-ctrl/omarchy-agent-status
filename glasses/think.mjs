// The runners behind the conversation tile: one request in, one text out, on this machine. A node runs them for the
// hub (POST /api/think); the hub runs them itself when a backend's node is "self". The three backends:
//   local   an OpenAI-compatible chat on 127.0.0.1 (Ornith 35B on the laptop); never exposed beyond loopback
//   claude  claude -p, with no tools, no MCP servers and no saved session, in a fresh temp folder
//   codex   codex exec, read-only and ephemeral, in a fresh temp folder, with the prompt on stdin
// Each CLI is found once, when this file loads: HUD_CLAUDE_BIN / HUD_CODEX_BIN if set, else PATH, else the usual
// install folders (a LaunchAgent's PATH often lacks them). A CLI that is not found is "not set up on this hub".
// Test hooks: HUD_THINK_FAKE=1 answers with canned text; HUD_LOCAL_LLM_URL points "local" elsewhere.
// Errors are one plain line; nothing from a prompt or an answer is logged here.

import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export const THINK_BACKENDS = ['local', 'claude', 'codex']
const LOCAL_URL = () => process.env.HUD_LOCAL_LLM_URL || 'http://127.0.0.1:18081/v1'
const LOCAL_MODEL = () => process.env.HUD_LOCAL_MODEL || 'local'

const LABEL = { local: 'The local model', claude: 'Claude', codex: 'Codex' }

// The canned answers for HUD_THINK_FAKE=1: hints for a hint request, a summary for the summary request.
const FAKE_HINTS = 'A key point: the budget\nA question: who owns it?\nA useful fact: due Friday'
const FAKE_SUMMARY = 'SUMMARY:\nThe talk covered the budget.\nACTIONS:\n- Send the budget'

function fakeAnswer(system) {
  return /hint/i.test(system) ? FAKE_HINTS : FAKE_SUMMARY
}

// Where the CLIs are looked for after PATH: the folders a LaunchAgent usually leaves out.
const EXTRA_DIRS = () => [path.join(homedir(), '.local/bin'), '/opt/homebrew/bin', path.join(homedir(), '.local/share/mise/shims')]

function isRunnable(file) {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// The override wins when it is set, even if it is wrong: a missing override means "not set up", not a fallback search.
// Paths are made absolute here, once: the runners spawn from a temp folder, so a relative path would point nowhere.
// A relative PATH entry is skipped, for the same reason.
function findBinary(name, envVar) {
  const override = process.env[envVar]
  if (override) {
    const file = path.resolve(override)
    return isRunnable(file) ? file : null
  }
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir)), ...EXTRA_DIRS()]
  for (const dir of dirs) {
    const file = path.join(dir, name)
    if (isRunnable(file)) return file
  }
  return null
}

const BIN = {
  claude: findBinary('claude', 'HUD_CLAUDE_BIN'),
  codex: findBinary('codex', 'HUD_CODEX_BIN'),
}
console.log(`conversation helpers: claude ${BIN.claude ?? 'not found'}, codex ${BIN.codex ?? 'not found'}`)

// The state the hub shows on GET /api/diag. No tokens; a local model is "reachable" if its server answers at all.
export async function helpers() {
  let reachable = false
  try {
    await fetch(`${LOCAL_URL()}/models`, { signal: AbortSignal.timeout(1500) })
    reachable = true
  } catch {
    reachable = false
  }
  return { claude: { path: BIN.claude }, codex: { path: BIN.codex }, local: { reachable } }
}

// Runs a command with the input on stdin, and resolves with its stdout. The command is killed at the timeout.
function runCli(cmd, args, { input, cwd, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${label} didn't answer in ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stdin.on('error', () => {})
    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(err.code === 'ENOENT' ? `${label} isn't set up on this hub` : `${label} didn't answer`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${label} didn't answer`))
    })
    child.stdin.end(input)
  })
}

async function viaLocal({ system, prompt, timeoutMs }) {
  const url = LOCAL_URL()
  let res
  try {
    res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_MODEL(),
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`The local model didn't answer in ${Math.round(timeoutMs / 1000)} s`)
    throw new Error("The local model isn't running on this hub")
  }
  if (!res.ok) throw new Error(`The local model answered ${res.status}`)
  return String((await res.json()).choices?.[0]?.message?.content ?? '').trim()
}

async function viaClaude({ system, prompt, timeoutMs }) {
  if (!BIN.claude) throw new Error("Claude isn't set up on this hub")
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-glasses-think-'))
  try {
    const out = await runCli(BIN.claude, ['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence'], {
      input: `${system}\n\n${prompt}`, cwd: dir, timeoutMs, label: 'Claude',
    })
    return out.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function viaCodex({ system, prompt, timeoutMs }) {
  if (!BIN.codex) throw new Error("Codex isn't set up on this hub")
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-glasses-think-'))
  try {
    // --ignore-user-config: listed by "codex exec --help" on codex-cli 0.162.0, so a real run ignores the user's config.
    const out = await runCli(BIN.codex, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '-C', dir, '-'], {
      input: `${system}\n\n${prompt}`, cwd: dir, timeoutMs, label: 'Codex',
    })
    return out.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * One request, answered on this machine.
 * @returns {Promise<{text: string, ms: number}>}
 */
export async function think({ backend, system = '', prompt, timeoutSec = 60 }) {
  if (!THINK_BACKENDS.includes(backend)) throw new Error('backend must be local, claude or codex')
  const started = Date.now()
  const timeoutMs = Math.max(1, Number(timeoutSec) || 60) * 1000
  if (process.env.HUD_THINK_FAKE === '1') {
    return { text: fakeAnswer(system), ms: Date.now() - started }
  }
  const args = { system, prompt, timeoutMs, label: LABEL[backend] }
  const text = backend === 'local' ? await viaLocal(args) : backend === 'claude' ? await viaClaude(args) : await viaCodex(args)
  if (!text) throw new Error(`${LABEL[backend]} gave no answer`)
  return { text, ms: Date.now() - started }
}
