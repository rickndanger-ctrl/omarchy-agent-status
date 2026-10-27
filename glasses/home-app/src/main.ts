import './style.css';
import { Glasses } from './glasses';
import { HomeModel, type Action, type HomeData, type Input } from './model';

const BUILD = '2026-10-26-b12';
const POLL_MS = 2000;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* optional */ } },
};

// A dev QR can carry the token once (?t=…); it is stored and removed from the address.
const params = new URLSearchParams(location.search);
if (params.get('t')) {
  store.set('home.token', params.get('t')!);
  params.delete('t');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}
// Hubs in order of preference, from VITE_HUBS in glasses/home-app/.env.local (kept out of git). Installed from Even Hub, Home's code lives on the phone,
// so if one hub is down it simply talks to the next. Loaded from a hub (dev QR), that hub comes first.
const HUBS: string[] = (import.meta.env.VITE_HUBS ?? '').split(',').map((h: string) => h.trim()).filter(Boolean);
// Only a page actually served by a hub (/hud/ behind Tailscale, or a node on :5182) counts as one.
const here = /^https?:$/.test(location.protocol) && (/\/hud\/$/.test(new URL('.', location.href).pathname) || location.port === '5182') ? new URL('.', location.href).href : '';
const defaultBase = here || HUBS[0];
const hubs = () => [...new Set([store.get('home.base'), here, ...HUBS].filter(Boolean))];
let base = store.get('home.base') || defaultBase;
let token = store.get('home.token');

const model = new HomeModel();
model.hideDone = store.get('home.hideDone') === '1';
let foreground = true;
let recording: Uint8Array[] | null = null;
let status = 'Starting…';

const MENU = { refresh: 1, pause: 2, hideDone: 3, home: 4, agents: 5, messages: 6, muse: 7 };
let lastDevice = '';
const glasses = new Glasses({
  onInput: input => handle(input),
  onMenu: id => void menu(id),
  onStatus: text => { status = text; diag('status', text); paint(); },
  onForeground: on => { foreground = on; if (on) void poll(); },
  onDevice: d => {
    // Log what the Even app reports when it changes (once signed in to a hub), so a missing battery can be traced.
    if (d.raw !== lastDevice && token) { lastDevice = d.raw; diag('device', d.raw.slice(0, 300)); }
    if (typeof d.battery === 'number') model.battery = d.battery;
    paint();
  },
  onLifecycle: event => diag('lifecycle', event),
  onSlowRender: ms => diag('render.slow', `${ms} ms on ${model.screenKind}`),
  onAudio: pcm => {
    if (!recording) return;
    if (!recording.length) diag('mic.first-audio', pcm.length);
    if (recording.length < 4000) recording.push(pcm);
  },
}, [
  { id: MENU.home, name: 'Home' },
  { id: MENU.agents, name: 'Agents' },
  { id: MENU.messages, name: 'Messages' },
  { id: MENU.muse, name: 'Muse' },
  { id: MENU.refresh, name: 'Refresh' },
  { id: MENU.pause, name: 'Pause/resume approvals' },
  { id: MENU.hideDone, name: 'Hide/show finished agents' },
]);

$('app').innerHTML = `
<main>
  <header><b>HOME</b><span>G2 · ${BUILD}</span></header>
  <section id="pairbox" class="pairbox ${token ? 'hidden' : ''}">
    <p><b>Pair Home</b> with your computers. Enter the 6-digit code from Claude.</p>
    <input id="code-top" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
    <button id="pair-top">Pair</button>
  </section>
  <p id="status" class="status"></p>
  <pre id="glass" class="glass"></pre>
  <div class="pad">
    <button data-input="up">▲ Swipe up</button>
    <button data-input="select">Tap</button>
    <button data-input="back">Double-tap</button>
    <button data-input="down">▼ Swipe down</button>
  </div>
  <details ${token ? '' : 'open'}>
    <summary>Connection</summary>
    <label>Server<input id="base" autocomplete="off" spellcheck="false"></label>
    <label>Pairing code<input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6 digits"></label>
    <div class="row"><button id="pair">Pair</button></div>
    <label>Token<input id="token" type="password" autocomplete="off"></label>
    <div class="row"><button id="save">Save</button><button id="pause">Pause approvals</button></div>
    <p class="muted">Only your own computers on your Tailscale network. Nothing is sent anywhere else.</p>
  </details>
</main>`;
$<HTMLInputElement>('base').value = base;
$<HTMLInputElement>('token').value = token;
$('save').onclick = () => {
  base = $<HTMLInputElement>('base').value.trim() || defaultBase;
  if (!base.endsWith('/')) base += '/';
  token = $<HTMLInputElement>('token').value.trim();
  store.set('home.base', base);
  store.set('home.token', token);
  status = 'Saved.';
  paint();
  void poll();
};
$('pause').onclick = () => void menu(MENU.pause);
$('pair-top').onclick = () => { $<HTMLInputElement>('code').value = $<HTMLInputElement>('code-top').value; $('pair').click(); };
// One-time pairing: a 6-digit code made on a hub exchanges for the access token, so nothing long has to be typed.
$('pair').onclick = async () => {
  const code = $<HTMLInputElement>('code').value.replace(/\D/g, '');
  for (const hub of hubs()) {
    try {
      const res = await fetch(new URL('api/pair', hub), { method: 'POST', body: JSON.stringify({ code }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
      const body = await res.json() as { token?: string };
      if (body.token) {
        token = body.token;
        base = hub;
        store.set('home.token', token);
        store.set('home.base', base);
        $<HTMLInputElement>('token').value = token;
        status = 'Paired. Home is connected.';
        $('pairbox').classList.add('hidden');
        void poll().then(() => shareLocation());
        paint();
        return;
      }
    } catch { /* try the next hub */ }
  }
  status = 'That code did not work. Ask for a new one.';
  paint();
};
document.querySelectorAll<HTMLButtonElement>('[data-input]').forEach(b => { b.onclick = () => handle(b.dataset.input as Input); });
addEventListener('keydown', e => {
  const key: Record<string, Input> = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'select', Backspace: 'back', Escape: 'back' };
  if (key[e.key] && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); handle(key[e.key]); }
});

/** Report one step to the server's diagnostics log (no audio, no words). */
function diag(name: string, detail: string | number | boolean = ''): void {
  if (!token) return;
  void fetch(new URL('api/diag', base), {
    method: 'POST', body: JSON.stringify({ name, detail: String(detail) }),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }).catch(() => {});
}

class HttpError extends Error {}

/** Calls the current hub; if it can't be reached at all, the next hub takes over (and stays current). */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown = new Error('no hub reachable');
  for (const hub of [base, ...hubs().filter(h => h !== base)]) {
    let res: Response;
    try {
      res = await fetch(new URL(`api/${path}`, hub), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    // Tailscale answers 502/503/504 itself when the hub program behind it is down (no JSON body).
    // Home's own errors are JSON, so only the bare gateway errors count as "this hub is down".
    if (res.status >= 502 && res.status <= 504 && !(res.headers.get('content-type') ?? '').includes('json')) {
      lastError = new Error(`hub down (${res.status})`);
      continue;
    }
    if (hub !== base) {
      base = hub;
      store.set('home.base', base);
      diag('hub.switch', new URL(hub).hostname);
    }
    if (res.status === 401) throw new HttpError('wrong token');
    if (!res.ok) throw new HttpError(`server said ${res.status}`);
    return res.json() as Promise<T>;
  }
  throw lastError;
}

function paint(): void {
  const text = model.render(Date.now());
  glasses.setText(text);
  $('glass').textContent = text;
  $('status').textContent = status;
}

/** Pair without a code: the hubs recognize Rick's own Tailscale login and hand over the token. */
async function autoPair(): Promise<boolean> {
  for (const hub of hubs()) {
    try {
      const res = await fetch(new URL('api/pair/auto', hub), { method: 'POST', signal: AbortSignal.timeout(8000) });
      const body = await res.json() as { token?: string };
      if (body.token) {
        token = body.token;
        base = hub;
        store.set('home.token', token);
        store.set('home.base', base);
        $<HTMLInputElement>('token').value = token;
        $('pairbox').classList.add('hidden');
        diag('pair.auto', new URL(hub).hostname);
        return true;
      }
    } catch { /* try the next hub */ }
  }
  return false;
}

let polling = false;
async function poll(): Promise<void> {
  if (!token && !(await autoPair())) { model.setError('Pair Home on the phone screen'); paint(); return; }
  if (polling) return;
  polling = true;
  try {
    model.update(await api<HomeData>('home'));
    // No weather yet? Try sharing the location again (at most every 2 minutes).
    if (!model.data?.weather && Date.now() - lastLocationTry > 120_000) void shareLocation();
  } catch (error) {
    // Token no longer accepted (changed on the hubs)? Re-pair quietly, then try again next poll.
    if (error instanceof HttpError && error.message === 'wrong token') void autoPair();
    model.setError(error instanceof Error ? error.message : String(error));
  } finally {
    polling = false;
    paint();
  }
}

/** The open agent page shows its conversation, refreshed while it is open. */
let terminalBusy = false;
async function refreshTerminal(): Promise<void> {
  const target = model.terminalTarget();
  if (!target || terminalBusy) return;
  terminalBusy = true;
  const query = new URLSearchParams({ machine: target.machine, pane: target.pane, ...(target.window ? { window: target.window } : {}), ...(target.appThread ? { appThread: target.appThread } : {}), stamps: '1' });
  try {
    model.setTerminal(target.key, (await api<{ lines: string[] }>(`terminal?${query}`)).lines);
  } catch {
    model.setTerminal(target.key, null);
  } finally {
    terminalBusy = false;
    paint();
  }
}

const FLASH = { allow: 'Allowed', deny: 'Denied', desk: 'Left for the desk' };
async function run(action: Action): Promise<void> {
  try {
    if (action.kind === 'decide') {
      const r = await api<{ ok: boolean }>('decide', { method: 'POST', body: JSON.stringify(action) });
      model.showFlash(r.ok ? FLASH[action.behavior] : 'Already answered', Date.now());
      void poll();
    } else if (action.kind === 'focus') {
      const r = await api<{ ok: boolean }>('focus', { method: 'POST', body: JSON.stringify(action) });
      model.showFlash(r.ok ? `Workspace ${action.workspace} on ${action.machine}` : 'Could not switch', Date.now());
    } else if (action.kind === 'loadChat') {
      const r = await api<{ messages: Parameters<HomeModel['setChat']>[0] }>(`messages?chat=${action.id}`).catch(() => null);
      model.setChat(r ? r.messages : null, Date.now());
    } else if (action.kind === 'prompt') {
      const r = await api<{ ok: boolean }>('prompt', { method: 'POST', body: JSON.stringify(action) });
      diag('prompt', `${action.machine} ${action.window ? 'window' : 'tmux'} ok=${r.ok}`);
      model.showFlash(r.ok ? (action.key ? 'Stopped' : 'Sent') : 'Could not send to that agent', Date.now());
      for (const wait of [500, 1500, 3000]) setTimeout(() => void refreshTerminal(), wait);
    } else if (action.kind === 'startMic') {
      recording = [];
      const on = await glasses.microphone(true);
      diag('mic.start', on);
      if (!on) { recording = null; model.setTranscript(null, Date.now()); }
    } else if (action.kind === 'cancelMic') {
      recording = null;
      await glasses.microphone(false);
    } else if (action.kind === 'stopMic') {
      await glasses.microphone(false);
      const chunks = recording ?? [];
      recording = null;
      const audio = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { audio.set(c, at); at += c.length; }
      diag('mic.stop', `${chunks.length} chunks, ${audio.length} bytes`);
      paint();
      try {
        const res = await fetch(new URL('api/transcribe', base), {
          method: 'POST', body: audio,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
          signal: AbortSignal.timeout(25_000),
        });
        const body = await res.json() as { text?: string; error?: string };
        if (!res.ok) throw new Error(body.error || `server said ${res.status}`);
        diag('voice.text', `${(body.text ?? '').length} characters`);
        model.setTranscript(body.text ?? '', Date.now());
      } catch (error) {
        diag('voice.error', error instanceof Error ? error.message : String(error));
        model.setTranscript(null, Date.now());
        status = `Voice: ${error instanceof Error ? error.message : error}`;
      }
    } else if (action.kind === 'sendText') {
      const r = await api<{ ok: boolean; error?: string }>('messages/send', { method: 'POST', body: JSON.stringify({ chat: action.chat, text: action.text }) }).catch(e => ({ ok: false, error: String(e.message ?? e) }));
      diag('text.send', `ok=${r.ok}`);
      model.showFlash(r.ok ? `Text sent to ${action.name}` : 'Text not sent', Date.now());
      const fresh = await api<{ messages: Parameters<HomeModel['setChat']>[0] }>(`messages?chat=${action.chat}`).catch(() => null);
      if (fresh && model.screenKind === 'chat') model.setChat(fresh.messages, Date.now());
    } else if (action.kind === 'askMuse') {
      paint();
      const asked: { id?: string; error?: string } = await api<{ id?: string; error?: string }>('muse/ask', { method: 'POST', body: JSON.stringify({ text: action.text }) }).catch(e => ({ error: String(e.message ?? e) }));
      diag('muse.ask', asked.id ? 'queued' : asked.error ?? 'failed');
      if (!asked.id) { model.setMuseProblem(action.text, asked.error ?? 'could not reach the Muse relay'); paint(); return; }
      // Muse answers in a few seconds; long answers take longer. Check every 0.7 s for up to 2.5 minutes.
      for (let i = 0; i < 215; i++) {
        await new Promise(r => setTimeout(r, 700));
        const job = await api<{ status: string; question: string; reply: string; error?: string }>(`muse/reply?id=${encodeURIComponent(asked.id)}`).catch(() => null);
        if (!job) continue;
        if (job.reply) model.setMuseAnswer(job.question, job.reply);
        paint();
        if (['done', 'error', 'timeout'].includes(job.status)) {
          diag('muse.reply', `${job.status} ${job.error ?? ''}`);
          if (!job.reply) model.setMuseProblem(action.text, job.error || (job.status === 'timeout' ? 'Muse took too long' : 'unknown error'));
          paint();
          break;
        }
      }
    } else if (action.kind === 'continueSession') {
      const r = await api<{ ok: boolean; pane?: string; error?: string }>('continue', { method: 'POST', body: JSON.stringify(action) })
        .catch(e => ({ ok: false, error: String(e.message ?? e) } as { ok: boolean; pane?: string; error?: string }));
      diag('agent.continue', `${action.machine} ok=${r.ok} ${r.error ?? ''}`);
      model.showFlash(r.ok ? 'Continuing on the glasses' : `Couldn't continue: ${r.error ?? 'error'}`, Date.now());
      if (r.ok && r.pane) model.expectAgent(action.machine, r.pane, Date.now());
      void poll();
    } else if (action.kind === 'loadFolders') {
      const r = await api<{ folders: string[] }>(`folders?machine=${encodeURIComponent(action.machine)}`).catch(() => null);
      model.setFolders(action.machine, r?.folders ?? null);
    } else if (action.kind === 'startAgent') {
      const r = await api<{ ok: boolean; pane?: string; error?: string }>('start', { method: 'POST', body: JSON.stringify(action) })
        .catch(e => ({ ok: false, error: String(e.message ?? e) } as { ok: boolean; pane?: string; error?: string }));
      diag('agent.start', `${action.machine} ${action.agent} ok=${r.ok} ${r.error ?? ''}`);
      model.showFlash(r.ok ? `Started ${action.agent} on ${action.machine}` : `Couldn't start: ${r.error ?? 'error'}`, Date.now());
      if (r.ok && r.pane) model.expectAgent(action.machine, r.pane, Date.now());
      void poll();
    } else if (action.kind === 'loadMuse') {
      model.setMuse(await api<{ question: string; reply: string }>('muse').catch(() => null));
    }
  } catch (error) {
    model.showFlash(error instanceof Error ? error.message : 'Failed', Date.now());
  }
  paint();
}

function handle(input: Input): void {
  diag('input', `${input} on ${model.screenKind}`);
  const action = model.input(input, Date.now());
  paint();
  if (action) void run(action);
  void refreshTerminal();
}

async function menu(id: number): Promise<void> {
  diag('menu', id);
  if (id === MENU.home) model.goTo('home');
  if (id === MENU.agents) model.goTo('agents');
  if (id === MENU.messages) model.goTo('messages');
  if (id === MENU.muse) { model.goTo('muse'); void run({ kind: 'loadMuse' }); }
  if (id === MENU.refresh) void poll();
  if (id === MENU.hideDone) {
    model.hideDone = !model.hideDone;
    store.set('home.hideDone', model.hideDone ? '1' : '0');
  }
  if (id === MENU.pause) {
    const paused = !model.data?.paused;
    try {
      await api('pause', { method: 'POST', body: JSON.stringify({ paused }) });
      model.showFlash(paused ? 'Approvals paused: answer at the desk' : 'Approvals on', Date.now());
      $('pause').textContent = paused ? 'Resume approvals' : 'Pause approvals';
    } catch {
      model.showFlash('Could not reach the server', Date.now());
    }
    void poll();
  }
  paint();
}

/** Share the phone's location with the hub (rounded there) so the top line can show the weather. */
let lastLocationTry = 0;
async function shareLocation(): Promise<void> {
  if (!token) return;
  lastLocationTry = Date.now();
  const at = await glasses.location();
  diag('location', at ? 'ok' : 'unavailable');
  if (at) await api('location', { method: 'POST', body: JSON.stringify(at) }).catch(() => {});
}

paint();
void glasses.connect().then(() => shareLocation());
setInterval(() => void shareLocation(), 30 * 60_000);
void poll();
setInterval(() => { if (foreground) void poll(); }, POLL_MS);
// The open agent's conversation refreshes faster than the rest, so replies show up quickly.
setInterval(() => { if (foreground) void refreshTerminal(); }, 1200);
setInterval(paint, 15_000); // keep the clock current between polls
