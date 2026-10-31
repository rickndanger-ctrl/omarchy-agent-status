// Direct-loopback live transcript and manual notes. No relay, network client,
// transcript logging, disk persistence, app/window control or shared auth bypass.
import { randomBytes } from 'node:crypto'

export const NOTE_BODY_BYTES = 4096
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1'])
const PROXY_HEADERS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'true-client-ip']
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" }
const NO_SESSION = 'no Listen session on this hub'
const oneLine = value => String(value ?? '').replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim()
const finiteTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

export function formatSessionTime(ms) {
  const seconds = finiteTime(ms) ? Math.floor(ms / 1000) : 0
  const pad = value => String(value).padStart(2, '0')
  return seconds < 3600 ? `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
    : `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/** Mac-local calendar fields, deliberately not UTC/toISOString. */
export function formatWallTime(epochMs) {
  const date = new Date(epochMs)
  if (!Number.isFinite(epochMs) || !Number.isFinite(date.getTime())) return 'Unknown time'
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function parseAbout(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('Invalid about time')
  const text = value.trim()
  if (!text) return undefined
  const pieces = text.split(':')
  if (pieces.length !== 2 && pieces.length !== 3 || pieces.some(piece => !/^\d{1,6}$/.test(piece))) throw new Error('Invalid about time')
  const numbers = pieces.map(Number)
  if (numbers.at(-1) > 59 || pieces.length === 3 && numbers[1] > 59) throw new Error('Invalid about time')
  const seconds = pieces.length === 2 ? numbers[0] * 60 + numbers[1] : numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
  return seconds * 1000
}

export function transcriptText(snapshot) {
  const live = snapshot.state === 'listening' ? 'live' : 'stopped'
  const header = `Muse Listen | session ${oneLine(snapshot.id)} | started at ${formatWallTime(snapshot.startedAt)} | ${live}`
  const lines = (Array.isArray(snapshot.lines) ? snapshot.lines : [])
    .filter(line => finiteTime(line?.t) && typeof line.text === 'string')
    .slice().sort((a, b) => a.t - b.t)
    .map(line => `[${formatWallTime(snapshot.startedAt + line.t)}] [${formatSessionTime(line.t)}] ${oneLine(line.text)}`)
  return [header, ...lines].join('\n') + '\n'
}

function authority(req) {
  // Node's normalized headers discard later Host occurrences. Admission must
  // use the complete raw list, before reading any session or request body.
  if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2
      || req.rawHeaders.some(value => typeof value !== 'string')) return null
  const raw = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) raw.push([req.rawHeaders[i].toLowerCase(), req.rawHeaders[i + 1]])
  const proxyMetadata = [...Object.keys(req.headers ?? {}), ...raw.map(([key]) => key)].some(key => {
    const name = key.toLowerCase()
    return PROXY_HEADERS.includes(name) || name.startsWith('x-forwarded-') || name.startsWith('tailscale-')
  })
  if (!LOOPBACK.has(req.socket?.remoteAddress) || proxyMetadata) return null
  const hosts = raw.filter(([key]) => key === 'host').map(([, value]) => value)
  const origins = raw.filter(([key]) => key === 'origin').map(([, value]) => value)
  const port = req.socket.localPort
  if (hosts.length !== 1 || origins.length > 1 || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const host = hosts[0]
  // No URL parsing here: abbreviated/octal IPv4, omitted/padded ports,
  // whitespace, trailing dots, userinfo and IPv6 aliases must never normalize in.
  if (host !== `127.0.0.1:${port}` && (!/^[\x00-\x7f]*$/.test(host) || host.toLowerCase() !== `localhost:${port}`)) return null
  const scheme = req.socket?.encrypted ? 'https:' : 'http:'
  const expectedOrigin = `${scheme}//${host.toLowerCase()}`
  if (origins.length && origins[0] !== expectedOrigin) return null
  const site = req.headers?.['sec-fetch-site']
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return null
  return expectedOrigin
}

function readBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bytes = 0, settled = false
    const chunks = []
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('data', data)
      req.removeListener('end', end)
      req.removeListener('aborted', aborted)
      req.removeListener('error', aborted)
      if (error) {
        // An aborted request can emit its stream error just after 'aborted'.
        // Consume that follow-up without leaking details or crashing the hub.
        req.once('error', () => {})
        req.resume()
        reject(error)
      } else resolve(value)
    }
    const data = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > NOTE_BODY_BYTES) return finish({ status: 413, reason: 'Note body too large' })
      chunks.push(buffer)
    }
    const end = () => {
      try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
      catch { finish({ status: 400, reason: 'Invalid note body' }) }
    }
    const aborted = () => finish({ status: 400, reason: 'Note body interrupted' })
    const timer = setTimeout(() => finish({ status: 408, reason: 'Note body timed out' }), timeoutMs)
    req.on('data', data).once('end', end).once('aborted', aborted).once('error', aborted)
  })
}

function parseNote(body, type) {
  let value
  if (type === 'application/json') {
    value = JSON.parse(body)
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['text', 'about', 'id'].includes(key))) throw new Error('Invalid note')
  } else {
    const form = new URLSearchParams(body)
    if ([...form.keys()].some(key => !['note', 'about', 'id'].includes(key) || form.getAll(key).length !== 1)) throw new Error('Invalid note')
    value = { text: form.get('note'), about: form.get('about') ?? undefined, id: form.get('id') ?? undefined }
  }
  if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('Invalid note')
  const at_t = parseAbout(value.about)
  return { text: value.text, ...(at_t === undefined ? {} : { at_t }), ...(value.id === undefined ? {} : { id: value.id }) }
}

const REFRESH_SCRIPT = `let refreshing=false;
const initial=document.getElementById('transcript');if(initial)initial.scrollTop=initial.scrollHeight;
setInterval(async()=>{if(refreshing)return;refreshing=true;try{
const r=await fetch(location.pathname,{cache:'no-store',credentials:'same-origin'});if(!r.ok&&r.status!==404&&r.status!==410)return;
const d=new DOMParser().parseFromString(await r.text(),'text/html');
for(const id of ['transcript','recent-notes','session-state','note-availability']){const a=document.getElementById(id),b=d.getElementById(id);if(a&&b){const follow=id==='transcript'&&a.scrollHeight-a.scrollTop-a.clientHeight<40;a.replaceChildren(...Array.from(b.childNodes,n=>document.importNode(n,true)));if(follow)a.scrollTop=a.scrollHeight;}}
const field=document.querySelector('fieldset'),next=d.querySelector('fieldset');if(field&&next)field.disabled=next.disabled;
const note=document.querySelector('textarea[name=note]'),about=document.querySelector('input[name=about]');
if(!note?.value.trim()&&!about?.value.trim()){const id=document.querySelector('input[name=id]'),next=d.querySelector('input[name=id]');if(id&&next)id.value=next.value;}
}catch{}finally{refreshing=false;}},2000);`

function html(snapshot, mode, nonce) {
  const active = snapshot?.state === 'listening'
  const enabled = active && mode !== 'chat'
  const text = snapshot ? transcriptText(snapshot) : NO_SESSION + '\n'
  const notes = (Array.isArray(snapshot?.notes) ? snapshot.notes : []).filter(note => finiteTime(note?.t) && finiteTime(note.at_t) && typeof note.text === 'string').slice(-20)
  const noteHTML = notes.length ? `<ol>${notes.map(note => `<li>[${escapeHTML(formatSessionTime(note.t))}] about [${escapeHTML(formatSessionTime(note.at_t))}] ${escapeHTML(note.text)}</li>`).join('')}</ol>` : '<p>No notes yet.</p>'
  const status = active ? 'Live' : snapshot ? 'Stopped' : NO_SESSION
  const availability = !active ? 'Start a Listen session to add notes.' : mode === 'chat' ? 'Page notes are unavailable in chat mode.' : 'Write a short note; about is optional.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Muse Listen</title><noscript><meta http-equiv="refresh" content="2"></noscript><style>body{max-width:60rem;margin:2rem auto;padding:0 1rem;font:16px system-ui;line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto;padding:1rem;background:#f3f4f6}textarea{display:block;width:95%;min-height:6rem}label{display:block;margin:.6rem 0}li{margin:.5rem 0}</style></head><body><h1>Muse Listen</h1><p id="session-state">${status}</p><pre id="transcript">${escapeHTML(text)}</pre><h2>Note box</h2><p id="note-availability">${escapeHTML(availability)}</p><form method="post" action="/listen/note"><fieldset${enabled ? '' : ' disabled'}><input type="hidden" name="id" value="${escapeHTML(snapshot?.id ?? '')}"><label>Note<textarea name="note" required></textarea></label><label>About (mm:ss or h:mm:ss, optional)<input name="about" placeholder="00:00" inputmode="numeric"></label><button type="submit">Send</button></fieldset></form><h2>Recent notes</h2><section id="recent-notes">${noteHTML}</section><script nonce="${nonce}">${REFRESH_SCRIPT}</script></body></html>`
}

/** Callable owns /listen and all /listen/* responses; mount before shared auth.
 * The optional loopback predicate can only veto, never relax the internal guard.
 */
export function createListenPage({ listen, loopback, notesFrom = 'page', bodyTimeoutMs = 3000 } = {}) {
  if (!listen || typeof listen.snapshot !== 'function' || typeof listen.addNote !== 'function') throw new TypeError('Listen page engine required')
  const nonce = randomBytes(18).toString('base64')
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra })
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
  }
  return async function handle(req, res, p) {
    const path = typeof p === 'string' ? p : String(req.url ?? '').split('?', 1)[0]
    if (path !== '/listen' && !path.startsWith('/listen/')) return false
    let local = authority(req) !== null
    if (local && loopback !== undefined) { try { local = typeof loopback === 'function' && loopback(req) === true } catch { local = false } }
    if (!local) { send(res, 404, { error: 'Not found' }); return true }
    if (!['/listen/live.txt', '/listen/live.html', '/listen/note', '/listen'].includes(path)) { send(res, 404, { error: 'Listen page not found' }); return true }
    if (path === '/listen' && req.method === 'GET') { send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/listen/live.html' }); return true }
    if (path === '/listen/note' ? req.method !== 'POST' : req.method !== 'GET') { send(res, 405, { error: 'Method not allowed' }); return true }
    if (path !== '/listen/note') {
      try {
        const view = await listen.snapshot()
        const snapshot = view?.status === 200 && view.body && typeof view.body.id === 'string' ? view.body : null
        if (!snapshot && view?.status !== 404) { send(res, 503, { error: 'Listen page unavailable' }); return true }
        const status = !snapshot ? 200 : snapshot.state === 'listening' ? 200 : 410
        if (path.endsWith('.txt')) send(res, status, snapshot ? transcriptText(snapshot) : NO_SESSION + '\n', 'text/plain; charset=utf-8')
        else send(res, status, html(snapshot, snapshot?.notesFrom ?? notesFrom, nonce), 'text/html; charset=utf-8', {
          'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        })
      } catch { send(res, 503, { error: 'Listen page unavailable' }) }
      return true
    }
    const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';', 1)[0].trim().toLowerCase() : ''
    if (!['application/json', 'application/x-www-form-urlencoded'].includes(type)) { send(res, 415, { error: 'Use JSON or form note data' }); return true }
    const length = req.headers['content-length']
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) { send(res, 400, { error: 'Invalid note body length' }); return true }
    if (length !== undefined && Number(length) > NOTE_BODY_BYTES) { send(res, 413, { error: 'Note body too large' }, undefined, { Connection: 'close' }); return true }
    let value
    try { value = parseNote(await readBody(req, Math.max(1, Math.min(3000, bodyTimeoutMs))), type) }
    catch (error) { send(res, error?.status ?? 400, { error: error?.reason ?? 'Invalid note data' }, undefined, { Connection: 'close' }); return true }
    try {
      const view = await listen.snapshot()
      if (view?.status === 404) { send(res, 409, { error: NO_SESSION }); return true }
      if (view?.status !== 200 || !view.body || typeof view.body.id !== 'string') { send(res, 503, { error: 'Listen note unavailable' }); return true }
      if (view.body.state !== 'listening') { send(res, 410, { error: 'Listen session stopped' }); return true }
      if (value.id !== undefined && value.id !== view.body.id) { send(res, 409, { error: 'Listen session changed; refresh the page' }); return true }
      if ((view.body.notesFrom ?? notesFrom) === 'chat') { send(res, 409, { error: 'Page notes unavailable in chat mode' }); return true }
      const result = await listen.addNote(view.body.id, { text: value.text, ...(value.at_t === undefined ? {} : { at_t: value.at_t }) })
      if (type === 'application/x-www-form-urlencoded' && result?.status === 200) send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/listen/live.html' })
      else if (result && Number.isInteger(result.status) && [200, 400, 404, 409, 410].includes(result.status)) send(res, result.status, result.body)
      else send(res, 503, { error: 'Listen note unavailable' })
    } catch { send(res, 503, { error: 'Listen note unavailable' }) }
    return true
  }
}
