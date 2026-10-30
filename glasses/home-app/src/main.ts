import './style.css';
import { Glasses, DEFAULT_OUTLINE } from './glasses';
import { ShownWatch } from './shownwatch';
import { applyMuseLatest } from './musesync';
import { plainMuseError, pollMuseJob, MUSE_POLLS, MUSE_DEADLINE_MS, type MuseJob } from './musepoll';
import { HomeModel, age, recentChats, recentMessages, type Action, type ChatMessage, type HomeData, type Input } from './model';
import { HubPicker, hubsToTry, firstAnswer, NoHubAnswered } from './hubpick';
import { LayoutLoader } from './layoutcache';
import { MuseCache } from './musecache';
import { RemoteInput } from './remote';
import { TerminalCache } from './terminalcache';
import { InputQueue, type InputSource } from './inputqueue';
import { makeHandle, TOP_SCREENS, runConversationEffect, startConversation, openSettings, runSettingsAction } from './inputflow';
import { MENU, GLASSES_MENU, INTERNAL_MENU, setHideDone } from './menu';
import { Latest } from './latest';
import { ConversationSession, ConvHttpError, CONV_BACKENDS, asBackend, type Conversation, type ConvHub } from './conversation';
import type { Desk, DeskAppId } from './desk'; // type only: desk.ts itself is loaded by import() when the Desk is opened
import { Tiles, tileChats, DEFAULT_LAYOUT, PAGE_COUNT, availableWidgets, normalizeLayout, type Layout, type OpenTarget, type Reminder, type TileContext, type TileEffect, type UrlTile } from './tiles';

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
// Only the hubs in HUBS are ever used: a stored or page address that is not one of them is dropped (src/hubpick.ts).
const picker = new HubPicker(HUBS, here, store.get('home.base'), Date.now());
if (picker.staleStored) store.set('home.base', '');
const hubs = () => picker.order();
let base = picker.current;
/** A hub answered or was paired with: make it current and remember it (allowed hubs only). Returns true if it changed. */
function adopt(hub: string): boolean {
  const changed = picker.useHub(hub, Date.now());
  base = picker.current;
  remote.sync(); // a different current hub means a new wait on that hub
  if (changed || store.get('home.base') !== base) store.set('home.base', base);
  return changed;
}
let token = store.get('home.token');

let foreground = true;
// The phone remote: while Home is in front, one long-poll to the current hub brings the phone's buttons; each one goes through handle() like a gesture.
const remote = new RemoteInput({
  hub: () => base, token: () => token, active: () => foreground,
  apply: input => (input === 'settings' ? inputQueue.pushMenu(INTERNAL_MENU.settings, 'remote') : handle(input, 'remote')),
});

function savedOutline(): number { const n = Number(store.get('home.outline')); return n >= 1 && n <= 15 ? Math.round(n) : DEFAULT_OUTLINE; }
function savedBrightness(): number { const n = Number(store.get('home.brightness')); return n >= 1 && n <= 4 ? Math.round(n) : 4; }
const model = new HomeModel();
model.hideDone = store.get('home.hideDone') === '1';
// Quiet mode (on unless switched off): pop-ups only for pinned agents.
model.quiet = store.get('home.quiet') !== '0';
model.brightness = savedBrightness();
// Texts older than 24 h are hidden on the glasses unless switched off (phone checkbox or the glasses menu).
model.hideOldTexts = store.get('home.hideOldTexts') !== '0';
let recording: Uint8Array[] | null = null;
let status = 'Starting…';

// The Conversation tile (docs/CONVERSATION.md): listens only after a Start. The session talks to the one hub it started on.
function convHubFor(hub: string, tok: string): ConvHub {
  const call = async <T>(path: string, init: RequestInit, ms: number): Promise<T> => {
    const res = await fetch(new URL(`api/conversation${path}`, hub), { ...init, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': (init.headers as Record<string, string> | undefined)?.['Content-Type'] ?? 'application/json' }, signal: AbortSignal.timeout(ms) });
    const body = await res.json().catch(() => ({})) as T & { error?: string };
    if (!res.ok) throw new ConvHttpError(body.error || `server said ${res.status}`, res.status);
    return body;
  };
  return {
    start: backend => call('/start', { method: 'POST', body: JSON.stringify({ backend }) }, 8000),
    chunk: async (id, seq, pcm) => { await call(`/chunk?id=${encodeURIComponent(id)}&seq=${seq}`, { method: 'POST', body: pcm as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } }, 20_000); },
    stop: async id => { await call('/stop', { method: 'POST', body: JSON.stringify({ id }) }, 8000); },
    get: () => call<Conversation>('', { method: 'GET' }, 8000),
  };
}
const convSentKey = 'home.convSent';
const convSent = () => { try { return JSON.parse(store.get(convSentKey) || '[]') as string[]; } catch { return []; } };
// Built on first use, never at startup: if it cannot be made the Conversation tile says so and the rest of Home still starts.
let convInstance: ConversationSession | null | undefined;
function getConv(): ConversationSession | null {
  if (convInstance !== undefined) return convInstance;
  try {
    convInstance = new ConversationSession({
      hub: () => convHubFor(base, token),
      mic: { on: () => glasses.microphone(true), off: () => glasses.microphone(false) },
      voiceMicBusy: () => recording !== null,
      sent: { has: id => convSent().includes(id), add: id => store.set(convSentKey, JSON.stringify([...convSent(), id].slice(-30))) },
      diag: (name, detail = '') => diag(name, detail),
      changed: () => paint(),
    });
  } catch (error) {
    convInstance = null;
    diag('conv.init-failed', error instanceof Error ? error.message : String(error));
  }
  return convInstance;
}
function convBackend() { try { return asBackend(store.get('home.convAi')); } catch { return asBackend(undefined); } }
const convHost = () => {
  const conv = getConv();
  return conv && { conv, backend: convBackend, dispatch: (action: Action) => void run(action), flash: (text: string) => model.showFlash(text, Date.now()), paint: () => paint() };
};
let lastDevice = '';
const glasses = new Glasses({
  onInput: input => handle(input, 'touch'),
  onMenu: id => inputQueue.pushMenu(id),
  onStatus: text => { status = text; diag('status', text); paint(); },
  onForeground: on => { foreground = on; if (!on) { model.abandonTalk(); if (recording !== null) void run({ kind: 'cancelMic' }); inputQueue.clear('left the front'); void getConv()?.stop('background'); } remote.sync(); if (on) { void poll(); if (showingDesk()) void desk!.resume(true); } },
  onDevice: d => {
    // Log what the Even app reports when it changes (once signed in to a hub), so a missing battery can be traced.
    if (d.raw !== lastDevice && token) { lastDevice = d.raw; diag('device', d.raw.slice(0, 300)); }
    if (typeof d.battery === 'number') model.battery = d.battery;
    paint();
  },
  onLifecycle: event => diag('lifecycle', event),
  onImu: sample => desk?.imuSample(sample),
  onImuOff: () => desk?.imuLost(),
  onFrame: what => diag('frame', `${model.screenKind} ${what}`),
  onDrawn: text => { const ms = museShown.drawn(text, Date.now()); if (ms !== null) diag('muse.shown', ms); },
  onSlowRender: ms => diag('render.slow', `${ms} ms on ${model.screenKind}`),
  onAudio: pcm => {
    const c = getConv();
    if (c?.isListening()) { c.onAudio(pcm); return; }
    if (!recording) return;
    if (!recording.length) diag('mic.first-audio', pcm.length);
    if (recording.length < 4000) recording.push(pcm);
  },
}, GLASSES_MENU);
glasses.setBrightness(model.brightness);

$('app').innerHTML = `
<main>
  <header><b>G2 OMAC</b><span>G2 · ${BUILD}</span></header>
  <section id="pairbox" class="pairbox ${token ? 'hidden' : ''}">
    <p><b>Pair G2 OMAC</b> with your computers. Enter the 6-digit code from Claude.</p>
    <input id="code-top" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
    <button id="pair-top">Pair</button>
  </section>
  <p id="status" class="status"></p>
  <label class="row"><input type="checkbox" id="hide-old"> Hide messages older than 24 h</label>
  <label class="row"><input type="checkbox" id="hide-done"> Hide finished agents</label>
  <label class="row"><input type="checkbox" id="desk-swap"> Desk: swap axes</label>
  <label class="row"><input type="checkbox" id="desk-invx"> Desk: invert X</label>
  <label class="row"><input type="checkbox" id="desk-invy"> Desk: invert Y</label>
  <label class="row">Tile outline brightness <input type="range" id="outline" min="1" max="15" step="1"> <span id="outline-val"></span></label>
  <label class="row"><input type="checkbox" id="quiet"> Quiet mode: pop-ups only for pinned agents</label>
  <details class="row"><summary>Pinned agents</summary>
    <textarea id="pinned-text" rows="8" spellcheck="false" placeholder="label | computer | agent | session"></textarea>
    <button id="pinned-save">Save pinned</button> <span id="pinned-note"></span>
  </details>
  <pre id="glass" class="glass"></pre>
  <div class="pad">
    <button data-input="up">▲ Swipe up</button>
    <button data-input="select">Tap</button>
    <button data-input="back">Double-tap</button>
    <button data-input="down">▼ Swipe down</button>
  </div>
  <label class="row">Conversation AI <select id="conv-ai">${CONV_BACKENDS.map(b => `<option value="${b.id}">${b.label}</option>`).join('')}</select></label>
  <details id="tiles-editor">
    <summary>Tiles</summary>
    <p class="muted">Five pages, two apps each. This is what the glasses show in Tiles.</p>
    <p class="muted">Gestures: on a page, swipe changes page and tap lets you choose a tile. Choosing: swipe switches left/right, tap opens it, double-tap goes back to the page. In a tile: swipe scrolls, tap opens its actions, double-tap goes back to choosing. Double-tap on a page leaves Tiles.</p>
    <label class="row"><input type="checkbox" id="start-tiles"> Start in Tiles</label>
    <div id="tile-rows"></div>
    <div class="row"><button id="tiles-save">Save tiles</button></div>
  </details>
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
$<HTMLSelectElement>('conv-ai').value = convBackend();
$<HTMLSelectElement>('conv-ai').onchange = () => store.set('home.convAi', $<HTMLSelectElement>('conv-ai').value);
$('save').onclick = () => {
  let entered = $<HTMLInputElement>('base').value.trim() || picker.primary;
  if (!entered.endsWith('/')) entered += '/';
  token = $<HTMLInputElement>('token').value.trim();
  store.set('home.token', token);
  remote.sync();
  if (picker.allowed(entered)) { adopt(entered); status = 'Saved.'; } else status = 'Saved the token. That server is not one of your hubs, so it is not used.';
  $<HTMLInputElement>('base').value = base;
  paint();
  void poll();
};
$('pause').onclick = () => inputQueue.pushMenu(MENU.pause);
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
        adopt(hub);
        store.set('home.token', token);
        remote.sync();
        $<HTMLInputElement>('token').value = token;
        status = 'Paired. G2 OMAC is connected.';
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
async function apiFrom<T>(path: string, init?: RequestInit, once = false, only?: string): Promise<{ hub: string; body: T }> {
  try {
    const { hub, value } = await firstAnswer<Promise<T>>(hubsToTry(hubs(), once, only), async hub => {
      let res: Response;
      try {
        res = await fetch(new URL(`api/${path}`, hub), {
          ...init,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
      } catch (error) {
        return { skip: error };
      }
      // Tailscale answers 502/503/504 itself when the hub program behind it is down (no JSON body).
      // Home's own errors are JSON, so only the bare gateway errors count as "this hub is down".
      if (res.status >= 502 && res.status <= 504 && !(res.headers.get('content-type') ?? '').includes('json')) return { skip: new Error(`hub down (${res.status})`) };
      if (adopt(hub)) diag('hub.switch', new URL(hub).hostname);
      void learnName(hub);
      if (res.status === 401) throw new HttpError('wrong token');
      if (!res.ok) throw new HttpError(`server said ${res.status}`);
      return { value: res.json() as Promise<T> };
    });
    return { hub, body: await value };
  } catch (error) {
    if (error instanceof NoHubAnswered) picker.allFailed();
    throw error instanceof NoHubAnswered ? error.last : error;
  }
}
async function api<T>(path: string, init?: RequestInit, once = false, only?: string): Promise<T> {
  return (await apiFrom<T>(path, init, once, only)).body;
}

/** The hubs say their own name in /api/health ("machine"); the clock tile shows "via <name>". Asked once per hub. */
const learning = new Set<string>();
async function learnName(hub: string): Promise<void> {
  if (picker.knowsName(hub) || learning.has(hub)) return;
  learning.add(hub);
  try {
    const health = await (await fetch(new URL('api/health', hub), { signal: AbortSignal.timeout(4000) })).json() as { machine?: string };
    if (health.machine) picker.noteName(hub, health.machine);
  } catch { /* asked again next time */ } finally { learning.delete(hub); }
}

/** Not on the preferred hub: at most once a minute, ask its /api/health (no token) and go back when it answers. */
async function maybeReturnToPrimary(): Promise<void> {
  if (!picker.primaryCheckDue(Date.now())) return;
  try {
    const res = await fetch(new URL('api/health', picker.primary), { signal: AbortSignal.timeout(4000) });
    const health = await res.json() as { ok?: boolean; machine?: string };
    if (!res.ok || !health.ok) return;
    if (health.machine) picker.noteName(picker.primary, health.machine);
    if (adopt(picker.primary)) diag('hub.back', new URL(picker.primary).hostname);
  } catch { /* still down: look again in a minute */ }
}

// ---- Tiles: five pages of two apps each (src/tiles.ts). ----
const tiles = new Tiles();
tiles.setLayout(DEFAULT_LAYOUT);
/** Start in Tiles (on unless switched off): Home opens in Tiles. Off: Tiles only opens from the Home list or the long-press menu. The double-tap from Tiles still reaches the old Home. */
let tilesOn = store.get('home.tiles') !== '0';
let tilesActive = false;
/** A full screen opened from a tile: double-tap returns to Tiles. */
let fromTiles = false;
const museTile = new MuseCache();
const tileData = {
  terminals: new Map<string, string[]>(),
  chats: new Map<number, string[]>(),
  reminders: null as Reminder[] | null,
  urls: new Map<string, UrlTile>(),
};
let justAdded: { title: string; at: number } | null = null;
const tileCtx = (): TileContext => ({
  // The tiles see a filtered copy of the chat list; model.data itself stays whole so pop-ups are unaffected.
  data: model.data && model.data.messages ? { ...model.data, messages: tileChats(model.data.messages, tiles.getLayout(), Date.now(), model.hideOldTexts) } : model.data,
  now: Date.now(), battery: model.battery, hub: picker.state(), sent: pane => model.sentTo(pane, Date.now()),
  terminal: key => tileData.terminals.get(key) ?? null,
  chat: id => tileData.chats.get(id) ?? null,
  // The tile reads the same chat as the Muse screen: every reply of this session is on it. Before any ask it shows what the relay last said.
  muse: () => model.museTileView() ?? museTile.get(),
  museWaiting: () => model.museTileView()?.waiting ?? museTile.isWaiting,
  museElsewhere: () => model.museTileView()?.elsewhere ?? false,
  // For ~5 s after a voice add the Reminders tile shows "Added: <title>" at the top, from the add result (no extra fetch).
  reminders: () => (tileData.reminders && justAdded && Date.now() - justAdded.at < 5000
    ? [{ id: 'just-added', title: justAdded.title, due: null, list: '', added: justAdded.at }, ...tileData.reminders]
    : tileData.reminders),
  url: endpoint => tileData.urls.get(endpoint) ?? null,
  conversation: () => getConv()?.view() ?? null,
});
const showingTiles = () => tilesActive && !fromTiles;
// Screens a tile opens: one double-tap there goes straight back to Tiles.

/** Set once the first /api/home poll worked: nothing else (Muse) is read before that. */
let homeLoaded = false;
let tilesBusy = false;
/** Muse is fetched once when a page with its tile is shown (entering Tiles, or swiping to that page), never on a timer. */
async function refreshTiles(): Promise<void> {
  if (!showingTiles() || tilesBusy) return;
  tilesBusy = true;
  const page = tiles.render(tileCtx()).page;
  // What the tiles fetched is shown through the input queue (a press made before it acts on what the owner saw).
  const writes: (() => void)[] = [];
  try {
    await Promise.all(tiles.needs(tileCtx()).map(async need => {
      try {
        if (need.kind === 'terminal') {
          const query = new URLSearchParams({ machine: need.machine, pane: need.pane, ...(need.window ? { window: need.window } : {}), ...(need.appThread ? { appThread: need.appThread } : {}), stamps: '1' });
          const lines = (await api<{ lines: string[] }>(`terminal?${query}`)).lines;
          writes.push(() => tileData.terminals.set(need.key, lines));
        } else if (need.kind === 'chat') {
          const r = await api<{ messages: ChatMessage[] }>(`messages?chat=${need.id}`);
          const shown = recentMessages(r.messages, Date.now(), model.hideOldTexts);
          const chatLines = [...(shown.hidden ? ['(older messages hidden)'] : []), ...[...shown.messages].reverse().map(m => `${m.fromMe ? 'Me' : m.from} (${age(m.when, Date.now())}): ${m.text}`)];
          writes.push(() => tileData.chats.set(need.id, chatLines));
        } else if (need.kind === 'muse') {
          const stamp = museTile.pageFetchStart(page, homeLoaded);
          if (stamp === null) return; // already read for this page view, or an ask is in flight (its reply is the newest word)
          const read = museTile.startRead();
          applyMuseLatest(model, museTile, stamp, await api<{ question: string; reply: string }>('muse').catch(() => null), read);
        } else if (need.kind === 'reminders') {
          const list = (await api<{ reminders: Reminder[] }>('reminders')).reminders;
          writes.push(() => { tileData.reminders = list; });
        } else if (need.kind === 'conversation') {
          await getConv()?.load(apply => writes.push(apply));
        } else if (need.kind === 'url') {
          const tile = await api<UrlTile>(`tile?url=${encodeURIComponent(need.endpoint)}`);
          writes.push(() => tileData.urls.set(need.endpoint, tile));
        }
      } catch { /* keep what the tile showed; it says Loading… if it never had anything */ }
    }));
  } finally {
    tilesBusy = false;
    inputQueue.pushExternal('tiles', () => { for (const write of writes) write(); paint(); });
  }
}

// The layout is remembered on the phone, so Tiles opens with your pages before the hub has answered, and a hub that
// is slow to wake gets quick retries (2, 5, 10 s) before the 60 s timer takes over.
const layoutLoader = new LayoutLoader({
  get: () => store.get('home.layout'),
  set: v => store.set('home.layout', v),
  fetch: () => api<Layout>('layout'),
  apply: layout => { tiles.setLayout(layout); buildEditor(); paint(); },
  after: (ms, fn) => { setTimeout(fn, ms); },
});
function loadLayout(): Promise<void> { return layoutLoader.load(); }

/** The phone's Tiles editor: one row per page, two dropdowns of everything Home knows. Not rebuilt while you are editing. */
function setHideOldTexts(on: boolean): void {
  model.hideOldTexts = on;
  store.set('home.hideOldTexts', on ? '1' : '0');
  $<HTMLInputElement>('hide-old').checked = on;
  paint();
}
$<HTMLInputElement>('hide-done').checked = model.hideDone;
$<HTMLInputElement>('hide-done').onchange = () => { setHideDone(model, store, $<HTMLInputElement>('hide-done').checked); paint(); };
$<HTMLInputElement>('hide-old').checked = model.hideOldTexts;
$<HTMLInputElement>('hide-old').onchange = () => setHideOldTexts($<HTMLInputElement>('hide-old').checked);
/** The Desk's head-pointer switches (phone page): saved like the other settings and applied at once. */
const deskOptions = () => ({ swapAxes: store.get('home.deskSwap') === '1', invertX: store.get('home.deskInvX') === '1', invertY: store.get('home.deskInvY') === '1' });
for (const [id, key] of [['desk-swap', 'home.deskSwap'], ['desk-invx', 'home.deskInvX'], ['desk-invy', 'home.deskInvY']] as const) {
  $<HTMLInputElement>(id).checked = store.get(key) === '1';
  $<HTMLInputElement>(id).onchange = () => { store.set(key, $<HTMLInputElement>(id).checked ? '1' : '0'); desk?.setPointerOptions(deskOptions()); diag('desk.options', JSON.stringify(deskOptions())); };
}
const outlineInput = $<HTMLInputElement>('outline');
outlineInput.value = String(savedOutline());
$('outline-val').textContent = outlineInput.value;
glasses.setOutline(Number(outlineInput.value));
outlineInput.oninput = () => { store.set('home.outline', outlineInput.value); $('outline-val').textContent = outlineInput.value; glasses.setOutline(Number(outlineInput.value)); diag('outline', outlineInput.value); };
$<HTMLInputElement>('quiet').checked = model.quiet;
$<HTMLInputElement>('quiet').onchange = () => { model.quiet = $<HTMLInputElement>('quiet').checked; store.set('home.quiet', model.quiet ? '1' : '0'); diag('quiet', model.quiet ? 'on' : 'off'); };
/** The pinned list: one pin per line, "label | computer | agent | session". The hub stores it; Home's rows come from the sessions. */
type PinLine = { label: string; machine: string; agent: string; session: string };
const pinsToText = (pins: PinLine[]) => pins.map(p => `${p.label} | ${p.machine} | ${p.agent} | ${p.session}`).join('\n');
async function loadPinnedEditor(): Promise<void> {
  if (!token) return;
  const r = await api<{ pins: PinLine[] }>('pinned').catch(() => null);
  if (r && document.activeElement !== $('pinned-text')) $<HTMLTextAreaElement>('pinned-text').value = pinsToText(r.pins);
}
$('pinned-save').onclick = async () => {
  const pins = $<HTMLTextAreaElement>('pinned-text').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [label, machine, agent, session] = l.split('|').map(x => x.trim()); return { label, machine, agent, session }; });
  const r = await api('pinned', { method: 'PUT', body: JSON.stringify({ pins }) }).catch((e: Error) => ({ error: e.message }));
  $('pinned-note').textContent = (r as { error?: string }).error ? `Not saved: ${(r as { error?: string }).error}` : 'Saved';
  void poll();
};
function syncStartInTiles(): void { $<HTMLInputElement>('start-tiles').checked = tilesOn; }
$<HTMLInputElement>('start-tiles').onchange = () => {
  tilesOn = $<HTMLInputElement>('start-tiles').checked;
  store.set('home.tiles', tilesOn ? '1' : '0');
};
syncStartInTiles();
let editorDirty = false;
let editorKey = '';
function buildEditor(): void {
  if (editorDirty) return;
  const layout = tiles.getLayout();
  const options = availableWidgets(model.data);
  const key = JSON.stringify([layout, options.map(o => o.id)]);
  if (key === editorKey) return;
  editorKey = key;
  const rows = $('tile-rows');
  rows.replaceChildren(...layout.pages.map((page, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('b');
    label.textContent = `Page ${i + 1}`;
    row.append(label);
    for (const side of ['left', 'right'] as const) {
      const select = document.createElement('select');
      select.dataset.page = String(i);
      select.dataset.side = side;
      const choices = options.some(o => o.id === page[side]) ? options : [...options, { id: page[side], label: page[side] }];
      for (const o of choices) select.append(new Option(o.label, o.id, false, o.id === page[side]));
      select.onchange = () => { editorDirty = true; };
      row.append(select);
    }
    return row;
  }));
}
$('tiles-save').onclick = async () => {
  const pages = Array.from({ length: PAGE_COUNT }, (_, i) => ({
    left: $<HTMLSelectElement>('tile-rows').querySelector<HTMLSelectElement>(`select[data-page="${i}"][data-side="left"]`)?.value ?? 'empty',
    right: $<HTMLSelectElement>('tile-rows').querySelector<HTMLSelectElement>(`select[data-page="${i}"][data-side="right"]`)?.value ?? 'empty',
  }));
  await saveLayout(normalizeLayout({ pages }));
};

async function saveLayout(layout: Layout): Promise<void> {
  tiles.setLayout(layout);
  layoutLoader.remember(layout);
  editorDirty = false;
  try {
    await api('layout', { method: 'PUT', body: JSON.stringify(tiles.getLayout()) });
    status = 'Tiles saved.';
  } catch (error) {
    status = `Tiles not saved: ${error instanceof Error ? error.message : error}`;
  }
  buildEditor();
  paint();
}

function enterTiles(startup = false): void {
  model.abandonListen(); // Tiles in front must not leave a listening screen (and its open microphone) behind
  museTile.resetPage();
  tilesActive = true;
  fromTiles = false;
  if (!startup) void loadLayout(); // at start-up layoutLoader.start() has already shown the remembered layout and asked the hub
  void refreshTiles();
  paint();
}

/** Do what a tile's action asked for. */
function runTileEffect(effect: TileEffect): void | Promise<void> {
  if (effect.kind === 'action') { void run(effect.action); return; }
  if (effect.kind === 'open') {
    fromTiles = true;
    const action = model.openTarget(effect.target as OpenTarget);
    if (action) void run(action);
    void refreshTerminal();
    return;
  }
  if (effect.kind === 'conversation') {
    const host = convHost();
    if (!host) { model.showFlash('Conversation is not available', Date.now()); return; }
    return runConversationEffect(host, effect.op); // the input queue waits for it (at most 3 s)
  }
  if (effect.kind === 'reminderDone') {
    void api('reminders/done', { method: 'POST', body: JSON.stringify({ id: effect.id }) }).catch(() => {}).then(() => refreshTiles());
  } else if (effect.kind === 'urlAction') {
    void api('tile/action', { method: 'POST', body: JSON.stringify({ url: effect.endpoint, id: effect.id }) }).catch(() => {}).then(() => refreshTiles());
  }
}


// --- Desk (test): src/desk.ts is loaded only when it is opened ---
let desk: Desk | null = null;
/** off: not used; desk: the grid is showing; app: a screen opened from it is showing (Back returns to the grid). */
let deskMode: 'off' | 'desk' | 'app' = 'off';
let deskApp: DeskAppId | null = null;
/** When each press arrived, so two downs are judged by arrival, not by when the queue got to them. */
let deskArrivals: number[] = [];
const showingDesk = () => deskMode === 'desk' && desk !== null;
async function openDesk(): Promise<void> {
  try {
    if (!desk) {
      const mod = await import('./desk');
      desk = new mod.Desk({ imu: open => glasses.imu(open), paint: () => paint(), settled: () => glasses.settled(), diag: (n, d) => diag(n, d), now: () => Date.now() });
      desk.setPointerOptions(deskOptions());
    }
  } catch (error) {
    diag('desk.load-failed', error instanceof Error ? error.message : String(error));
    model.showFlash('Desk is not available', Date.now());
    paint();
    return;
  }
  tilesActive = false; fromTiles = false;
  model.abandonListen();
  model.goHome();
  deskMode = 'desk'; deskApp = null; deskArrivals = [];
  paint();
  await desk.enter();
}
function leaveDesk(): void {
  if (deskMode === 'off') return;
  deskMode = 'off'; deskApp = null; deskArrivals = [];
  desk?.leave();
}
function backToDesk(): void {
  if (deskMode !== 'app' || !desk) return;
  if (deskApp) desk.appBack(deskApp);
  deskApp = null; tilesActive = false; fromTiles = false;
  model.goHome();
  deskMode = 'desk'; deskArrivals = [];
  paint();
  void desk.enter();
}
function openDeskApp(app: DeskAppId): void {
  if (!desk) return;
  if (app === 'reminders' || app === 'clock') { desk.note(`${app === 'clock' ? 'Clock' : 'Reminders'}: not yet`); paint(); return; }
  if (app === 'listen') {
    const host = convHost();
    if (!host) { desk.note('Listen: not available'); paint(); return; }
    void startConversation(host).then(() => { desk?.note('Listen: started'); paint(); });
    return;
  }
  deskMode = 'app'; deskApp = app;
  desk.leave();
  if (app === 'tiles') enterTiles();
  else {
    if (app === 'muse') { model.goTo('muse'); void run({ kind: 'loadMuse' }); }
    else if (app === 'messages') model.goTo('messages');
    else if (app === 'agents') model.goTo('agents');
    else if (app === 'studio') model.openTarget({ kind: 'studio' });
    else if (app === 'settings') model.openSettings();
    void refreshTerminal();
  }
  paint();
}
function deskInput(input: Input): void {
  if (!desk) return;
  const at = deskArrivals.shift() ?? Date.now();
  const result = desk.input(input, at);
  if (result?.kind === 'home') { leaveDesk(); model.goHome(); paint(); return; }
  if (result?.kind === 'open') { openDeskApp(result.app); return; }
  paint();
}

let prevKind = model.screenKind;
/** Set around the paint of a Muse answer the owner is waiting for: that frame skips the write pacing. */
let urgentPaint = false;
/** The final Muse reply wanted on the glasses: when exactly that frame is drawn, log how long after the ask. */
const museShown = new ShownWatch();
/** Display off (Quick settings): a blank page until any press or remote action. */
let blank = false;
function wake(): void { blank = false; diag('display', 'on'); paint(); }
const settingsHost = {
  model, isBlank: () => blank, wake, setBlank: () => { blank = true; diag('display', 'off'); },
  showingTiles: () => showingTiles(), markOpenedFromTile: () => { fromTiles = true; },
  returnToTiles: () => { if (tilesActive && fromTiles) { fromTiles = false; void refreshTiles(); } },
  saveBrightness: (value: number) => { store.set('home.brightness', String(value)); glasses.setBrightness(value); diag('brightness', value); },
  closeApp: async () => { diag('close', await glasses.shutDown()); },
  paint: () => paint(),
};
function paint(): void {
  // The microphone is open only while a voice reply is on screen and in front: leaving the page (menu, Home, Desk) closes it.
  if (recording !== null && !(model.micWanted() && foreground && !showingDesk())) void run({ kind: 'cancelMic' });
  // A reminder that was added or cancelled (or whose voice failed) ends on Home: that is back in Tiles.
  if (fromTiles && model.screenKind === 'home' && (prevKind === 'listen' || prevKind === 'confirm')) fromTiles = false;
  prevKind = model.screenKind;
  let preview: string;
  if (blank) {
    preview = '(display off: any press wakes it)';
    glasses.setText(' ');
  } else if (showingDesk()) {
    preview = desk!.render();
    glasses.setText(preview);
  } else if (showingTiles()) {
    const frame = tiles.render(tileCtx());
    glasses.setTiles(`p${frame.page}`, frame.focus, frame.left, frame.right);
    const l = frame.left.split('\n');
    const r = frame.right.split('\n');
    preview = Array.from({ length: Math.max(l.length, r.length) }, (_, i) => (l[i] ?? '').padEnd(28) + '│ ' + (r[i] ?? '')).join('\n');
  } else {
    preview = model.render(Date.now());
    glasses.setText(preview, urgentPaint);
  }
  $('glass').textContent = preview;
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
        adopt(hub);
        store.set('home.token', token);
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
  if (!token && !(await autoPair())) { model.setError('Pair G2 OMAC on the phone screen'); paint(); return; }
  if (polling) return;
  polling = true;
  void maybeReturnToPrimary();
  try {
    const fresh = await api<HomeData>('home');
    homeLoaded = true;
    inputQueue.pushExternal('poll', () => { model.update(fresh); buildEditor(); paint(); });
    startSimAsks();
    // No weather yet? Try sharing the location again (at most every 2 minutes).
    if (!fresh.weather && Date.now() - lastLocationTry > 120_000) void shareLocation();
  } catch (error) {
    // Token no longer accepted (changed on the hubs)? Re-pair quietly, then try again next poll.
    if (error instanceof HttpError && error.message === 'wrong token') void autoPair();
    const message = error instanceof Error ? error.message : String(error);
    inputQueue.pushExternal('poll', () => { model.setError(message); paint(); });
  } finally {
    polling = false;
  }
}

/** The open agent page shows its conversation, refreshed while it is open. */
let terminalBusy = false;
const terminalCache = new TerminalCache();
async function refreshTerminal(): Promise<void> {
  const target = model.terminalTarget();
  if (!target || terminalBusy) return;
  terminalBusy = true;
  const query = new URLSearchParams({ machine: target.machine, pane: target.pane, ...(target.window ? { window: target.window } : {}), ...(target.appThread ? { appThread: target.appThread } : {}), stamps: '1' });
  let lines: string[] | null = null;
  try {
    lines = (await api<{ lines: string[] }>(`terminal?${query}`)).lines;
  } catch { /* shown as "could not load" */ } finally {
    terminalBusy = false;
    // The same text as last time changes nothing on the glasses: no update, no repaint.
    if (terminalCache.shouldApply(target.key, lines, model.hasTerminal(target.key))) inputQueue.pushExternal('terminal', () => { if (model.setTerminal(target.key, lines)) terminalCache.record(target.key, lines); paint(); });
  }
}

/**
 * Simulator only: ?museasks=3 types 3 asks ("Sim question one/two/three") through the real askMuse path, one after the reply of the previous.
 * Off without the flag.
 */
const SIM_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
let simAsksStarted = false;
function startSimAsks(): void {
  const n = (() => { try { return Math.min(9, Math.max(0, Number(new URLSearchParams(globalThis.location?.search ?? '').get('museasks')) || 0)); } catch { return 0; } })();
  if (!n || simAsksStarted) return;
  simAsksStarted = true;
  void (async () => {
    model.goTo('muse');
    paint();
    for (let i = 0; i < n; i++) {
      const text = `Sim question ${SIM_WORDS[i]}`;
      const ask = model.beginMuseAsk(text);
      paint();
      await run({ kind: 'askMuse', text, ask });
    }
  })();
}

/** Only the newest chat load / microphone start counts: an older answer arriving late is ignored. */
const chatLoads = new Latest();
const recordings = new Latest();
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
      const req = chatLoads.next();
      const r = await api<{ messages: Parameters<HomeModel['setChat']>[0] }>(`messages?chat=${action.id}`).catch(() => null);
      if (chatLoads.isLatest(req)) model.setChat(r ? r.messages : null, Date.now(), action.id);
    } else if (action.kind === 'prompt') {
      const r = await api<{ ok: boolean }>('prompt', { method: 'POST', body: JSON.stringify(action) });
      diag('prompt', `${action.machine} ${action.pane === 'orchestrator' ? 'orchestrator' : action.window ? 'window' : 'tmux'} ok=${r.ok}`);
      model.promptDone(r.ok, Boolean(action.key), Date.now(), action.pane);
      setTimeout(() => paint(), 3100); // the tile's note ends by itself
      for (const wait of [500, 1500, 3000]) setTimeout(() => void refreshTerminal(), wait);
    } else if (action.kind === 'startMic') {
      if (getConv()?.isListening()) { model.setTranscript(null, Date.now()); model.showFlash('Stop listening first', Date.now()); paint(); return; }
      const id = recordings.next();
      recording = [];
      const on = await glasses.microphone(true);
      diag('mic.start', on);
      // A start that failed late must not undo a newer recording (or a cancel) made meanwhile.
      if (!on && recordings.isLatest(id)) { recording = null; model.setTranscript(null, Date.now()); }
    } else if (action.kind === 'cancelMic') {
      diag('mic.cancel', recording === null ? 'not recording' : `${recording.length} chunks`);
      recordings.invalidate();
      recording = null;
      await glasses.microphone(false);
    } else if (action.kind === 'stopMic') {
      const id = recordings.next(); // a later start or cancel makes this recording's transcript out of date
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
        if (recordings.isLatest(id)) model.setTranscript(body.text ?? '', Date.now()); else diag('voice.stale', id);
      } catch (error) {
        diag('voice.error', error instanceof Error ? error.message : String(error));
        if (recordings.isLatest(id)) {
          model.setTranscript(null, Date.now());
          status = `Voice: ${error instanceof Error ? error.message : error}`;
        }
      }
    } else if (action.kind === 'sendText') {
      const r = await api<{ ok: boolean; error?: string }>('messages/send', { method: 'POST', body: JSON.stringify({ chat: action.chat, text: action.text }) }).catch(e => ({ ok: false, error: String(e.message ?? e) }));
      diag('text.send', `ok=${r.ok}`);
      model.showFlash(r.ok ? `Text sent to ${action.name}` : 'Text not sent', Date.now());
      const req = chatLoads.next();
      const fresh = await api<{ messages: Parameters<HomeModel['setChat']>[0] }>(`messages?chat=${action.chat}`).catch(() => null);
      if (fresh && chatLoads.isLatest(req)) model.setChat(fresh.messages, Date.now(), action.chat);
    } else if (action.kind === 'askMuse') {
      museTile.askStart(action.text);
      paint();
      const askedAt = Date.now();
      const askKey = `${askedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // the hub ignores a repeat of the same ask
      const ask = action.ask ?? model.beginMuseAsk(action.text); // the newest ask owns the Muse screen and tile (conversation asks too)
      const asked: { id?: string; error?: string; hub?: string } = await apiFrom<{ id?: string; error?: string }>('muse/ask', { method: 'POST', body: JSON.stringify({ text: action.text, clientId: askKey }) }, true).then(r => ({ ...r.body, hub: r.hub })).catch(e => ({ error: String(e.message ?? e) }));
      if (asked.error) asked.error = plainMuseError(asked.error);
      const acceptedBy = asked.hub; // this job lives on this hub: its polls never go to another one
      diag('muse.ask', asked.id ? 'queued' : asked.error ?? 'failed');
      if (!asked.id) { const newest = model.setMuseProblem(action.text, asked.error ?? 'could not reach the Muse relay', ask); if (newest) { museTile.askReply(action.text, `Muse didn't get it: ${asked.error ?? 'could not reach the Muse relay'}.`); museTile.askEnd(); } paint(); return; }
      // Muse answers in a few seconds; long answers take longer. Check every 0.7 s for up to 2.5 minutes.
      const ended = await pollMuseJob(
        () => api<MuseJob>(`muse/reply?id=${encodeURIComponent(asked.id!)}`, undefined, false, acceptedBy).catch(() => null), // unreachable: keep waiting until the deadline
        () => new Promise<void>(r => setTimeout(r, 700)),
        (job, finished) => {
        const waiting = job.status === 'waiting';
        if (model.museIsNewest(ask)) { museTile.setWaiting(waiting); if (!job.reply) model.setMuseWaiting(ask, waiting); }
        const newest = job.reply ? model.setMuseAnswer(job.question, job.reply, ask) : model.museIsNewest(ask);
        if (job.reply && newest) museTile.askReply(job.question, job.reply);
        // A partial reply is only drawn when the glasses are idle: a write in flight would hold the final one back behind it.
        if (finished || !glasses.busy()) {
          if (finished && job.reply && newest) {
            urgentPaint = true;
            try { paint(); } finally { urgentPaint = false; }
            const wanted = glasses.wantedText();
            // Only when the Muse screen is what was painted: the owner may have gone elsewhere (another screen, Tiles, the Desk, display off).
            // ...and the answer's first line is inside the frame (not scrolled out of the 6-line window).
            if (!museShown.expectOnScreen(!blank && !showingDesk() && !showingTiles() && model.museAnswerInView(), wanted, askedAt)) diag('muse.shown', 'not on screen');
            // Already on the glasses (nothing changed and no older write in flight)? Then it is shown now.
            else if (glasses.upToDate()) { const ms = museShown.drawn(wanted!, Date.now()); if (ms !== null) diag('muse.shown', ms); }
          } else paint();
        }
        if (finished) {
          diag('muse.reply', `${job.status} ${job.error ?? ''}`);
          if (!job.reply) {
            const why = job.error || (job.status === 'timeout' ? 'Muse took too long' : 'unknown error');
            if (model.setMuseProblem(action.text, why, ask)) museTile.askReply(action.text, `Muse didn't get it: ${why}.`);
          }
          paint();
        }
        },
        MUSE_POLLS,
        { at: askedAt + MUSE_DEADLINE_MS, now: Date.now },
      );
      if (!ended) {
        // Every poll failed or Muse never finished: do not stay on "Muse is thinking…".
        diag('muse.reply', 'gave up: Muse took too long');
        if (model.setMuseProblem(action.text, 'Muse took too long', ask)) museTile.askReply(action.text, "Muse didn't get it: Muse took too long.");
      }
      if (model.museIsNewest(ask)) museTile.askEnd();
      paint();
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
    } else if (action.kind === 'addReminder') {
      const r = await api<{ ok: boolean }>('reminders/add', { method: 'POST', body: JSON.stringify({ title: action.title }) }).catch(() => ({ ok: false }));
      diag('reminder.add', `ok=${r.ok}`);
      model.showFlash(r.ok ? 'Reminder added' : 'Reminder not added', Date.now());
      if (r.ok) { justAdded = { title: action.title, at: Date.now() }; setTimeout(paint, 5100); }
      if (fromTiles) fromTiles = false;
      void refreshTiles();
    } else if (action.kind === 'displayOff' || action.kind === 'brightness' || action.kind === 'closeApp' || action.kind === 'settingsBack') {
      // Quick settings: see inputflow.ts
      await runSettingsAction(settingsHost, action).job;
    } else if (action.kind === 'startConversation') {
      const host = convHost();
      if (!host) model.showFlash('Conversation is not available', Date.now()); else await startConversation(host);
    } else if (action.kind === 'openTiles') {
      enterTiles();
    } else if (action.kind === 'openDesk') {
      await openDesk();
    } else if (action.kind === 'loadMuse') {
      const stamp = museTile.fetchStart();
      const read = museTile.startRead();
      if (stamp === null) { model.restoreMuse(); } // an ask is in flight: nothing is read, the ask's own screen stays
      else {
        const latest = await api<{ question: string; reply: string }>('muse').catch(() => null);
        applyMuseLatest(model, museTile, stamp, latest, read); // the same rule as the tile's own read (refreshTiles)
      }
    }
  } catch (error) {
    model.showFlash(error instanceof Error ? error.message : 'Failed', Date.now());
  }
  paint();
}

/** What a press does (src/inputflow.ts), given the pieces of this file. */
const applyInput = makeHandle({
  model, tiles, tileCtx, showingTiles,
  inOpenedScreen: () => tilesActive && fromTiles,
  leaveTiles: () => { if (deskMode === 'app') { backToDesk(); return; } tilesActive = false; model.goHome(); paint(); },
  showingDesk, deskInput, inDeskApp: () => deskMode === 'app' && !tilesActive, backToDesk,
  backToTiles: () => { fromTiles = false; paint(); void refreshTiles(); },
  paint, isBlank: () => blank, wake, runTileEffect,
  runModelAction: action => run(action),
  saveLayout: layout => void saveLayout(layout),
  refreshTiles: () => void refreshTiles(),
  refreshTerminal: () => void refreshTerminal(),
  now: () => Date.now(),
});
/** Changes whenever the screen does: the model's screen plus Tiles shown/hidden (seen at each call). */
let tilesFlips = 0;
let wasShowingTiles = false;
let wasShowingDesk = false;
function screenGeneration(): number {
  const now = showingTiles();
  if (now !== wasShowingTiles) { tilesFlips++; wasShowingTiles = now; }
  const deskNow = showingDesk();
  if (deskNow !== wasShowingDesk) { tilesFlips++; wasShowingDesk = deskNow; }
  return model.generation + tilesFlips;
}
/** Touchpad and phone remote share this one queue: a press is applied once the glasses show the one before. */
const inputQueue = new InputQueue({
  apply: applyInput,
  menu: id => menu(id),
  foreground: () => foreground,
  generation: screenGeneration,
  screen: () => (showingDesk() ? 'desk' : showingTiles() ? 'tiles' : model.screenKind),
  captureRemoteUp: () => showingTiles() ? tiles.capturePosition() : model.capturePosition(),
  holdRemoteUp: () => showingDesk(),
  cancelRemoteUp: () => { if (showingDesk()) deskArrivals.shift(); },
  settled: capMs => glasses.settled(capMs),
  log: (name, detail) => diag(name, detail),
});
function handle(input: Input, source: InputSource = 'touch'): void {
  if (showingDesk()) deskArrivals.push(Date.now());
  inputQueue.push(input, source);
}

async function menu(id: number): Promise<void> {
  diag('menu', id);
  if (blank) { wake(); return; } // the wake press is not passed on
  if (id === INTERNAL_MENU.settings) {
    if (showingDesk()) { deskMode = 'app'; deskApp = 'settings'; desk!.leave(); }
    openSettings(settingsHost);
    return;
  }
  if ([MENU.home, MENU.agents, MENU.messages, MENU.muse, MENU.tiles, MENU.editPage].includes(id)) leaveDesk();
  if (id === MENU.home) model.goTo('home');
  if (id === MENU.agents) model.goTo('agents');
  if (id === MENU.messages) model.goTo('messages');
  if (id === MENU.muse) { model.goTo('muse'); void run({ kind: 'loadMuse' }); }
  if (id === MENU.listen) {
    const host = convHost();
    if (!host) { model.showFlash('Conversation is not available', Date.now()); return; }
    return startConversation(host);
  }
  if (id === MENU.tiles) enterTiles();
  if (id === MENU.editPage) { if (!showingTiles()) enterTiles(); tiles.startEdit(tileCtx()); }
  if (id === MENU.tilesOn) {
    tilesOn = !tilesOn;
    store.set('home.tiles', tilesOn ? '1' : '0');
    model.showFlash(tilesOn ? 'Start in Tiles: on' : 'Start in Tiles: off', Date.now());
    syncStartInTiles();
  }
  if (id === MENU.hideOldTexts) {
    setHideOldTexts(!model.hideOldTexts);
    model.showFlash(model.hideOldTexts ? 'Texts older than 24 h hidden' : 'All texts shown', Date.now());
  }
  if (id !== MENU.tiles && id !== MENU.tilesOn && ![MENU.listen, INTERNAL_MENU.settings, MENU.hideOldTexts, MENU.pause, MENU.editPage].includes(id)) { tilesActive = false; fromTiles = false; }
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

layoutLoader.start();
void loadPinnedEditor();
if (tilesOn) { tiles.resetPage(); enterTiles(true); } else paint();
void glasses.connect().then(() => shareLocation());
setInterval(() => void shareLocation(), 30 * 60_000);
remote.sync();
void poll();
setInterval(() => { if (foreground) void poll(); }, POLL_MS);
// The open agent's conversation refreshes faster than the rest, so replies show up quickly.
setInterval(() => { if (foreground && showingDesk() && !desk!.imuOn) void desk!.resume(); }, 3000); // reconnect: tracking is back on while the Desk is in front
setInterval(() => { void getConv()?.tick(apply => inputQueue.pushExternal('conversation', apply)); if (foreground) { void refreshTerminal(); void refreshTiles(); } }, 1200);
setInterval(() => void loadLayout(), 60_000);
setInterval(paint, 15_000); // keep the clock current between polls
