// The runners behind the conversation tile: one request in, one text out, on this machine. A node runs them for the
// hub (POST /api/think); the hub runs them itself when a backend's node is "self". The three backends:
//   local   an OpenAI-compatible chat on 127.0.0.1 (Ornith 35B on the laptop); never exposed beyond loopback
//   claude  claude -p, with no tools, no MCP servers and no saved session, in a fresh temp folder
//   codex   codex exec, read-only and ephemeral, in a fresh temp folder, with the prompt on stdin
// Test hooks: HUD_THINK_FAKE=1 answers with canned text; HUD_LOCAL_LLM_URL points "local" elsewhere.
// Errors are one plain line; nothing from a prompt or an answer is logged here.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// Runs a command with the input on stdin, and resolves with its stdout. The command is killed at the timeout.
function runCli(cmd, args, { input, cwd, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${label} did not answer in ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stdin.on('error', () => {})
    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(err.code === 'ENOENT' ? `${cmd} is not on PATH` : `${label} failed`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${label} failed`))
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
    if (err?.name === 'TimeoutError') throw new Error(`The local model did not answer in ${Math.round(timeoutMs / 1000)} s`)
    throw new Error(`The local model is not running at ${url}`)
  }
  if (!res.ok) throw new Error(`The local model answered ${res.status}`)
  return String((await res.json()).choices?.[0]?.message?.content ?? '').trim()
}

async function viaClaude({ system, prompt, timeoutMs }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-glasses-think-'))
  try {
    const out = await runCli('claude', ['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence'], {
      input: `${system}\n\n${prompt}`, cwd: dir, timeoutMs, label: 'Claude',
    })
    return out.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function viaCodex({ system, prompt, timeoutMs }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-glasses-think-'))
  try {
    const out = await runCli('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-C', dir, '-'], {
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
