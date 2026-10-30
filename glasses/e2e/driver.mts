// One app start against two REAL hud-servers (a hub and a node): pair.auto, touch presses, remote presses, a typed ask through the real askMuse path.
// E2E_SCENARIO: 'tile' (ask from the Muse TILE), 'full' (open the full-screen Muse view, ask twice from there) or 'basic' (presses only).
// Prints one JSON line {ok, problems[], diag[]}. Env: E2E_HUBS (comma list, the app's VITE_HUBS), E2E_HUB (the hub's URL), E2E_TOKEN, E2E_OWNER.
import http from 'node:http';
const hub = process.env.E2E_HUB!, token = process.env.E2E_TOKEN!, owner = process.env.E2E_OWNER!;
const el: any = new Proxy(function () {}, { get: (_t, k) => (k === 'style' || k === 'dataset' || k === 'classList' ? el : k === 'value' ? '' : k === 'checked' ? false : k === 'children' ? [] : k === Symbol.toPrimitive ? () => '' : el), set: () => true, apply: () => el, construct: () => el });
const store = new Map<string, string>();
const g = globalThis as any;
g.document = { getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], createElement: () => el, body: el, addEventListener() {}, title: '' };
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
g.window = globalThis; g.addEventListener = () => {}; g.history = { replaceState() {} };
g.location = { search: '', href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', pathname: '/', port: '' };
// fetch over node:http (the SDK replaces the timers undici needs). Tailscale Serve labels the sender on /api/pair/auto.
g.fetch = (input: any, init: any = {}) => new Promise((resolve, reject) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/transcribe') return resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ text: 'hello muse' }), text: async () => '{}' }); // the app's own speech-to-text call
  const headers = { ...(init.headers ?? {}) };
  if (url.pathname === '/api/pair/auto') headers['tailscale-user-login'] = owner;
  const r = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: init.method ?? 'GET', headers }, res => {
    let b = ''; res.on('data', c => { b += c; });
    res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode, headers: { get: (k: string) => res.headers[k.toLowerCase()] ?? null }, json: async () => JSON.parse(b || '{}'), text: async () => b }));
  });
  r.on('error', reject);
  if (init.signal) init.signal.addEventListener?.('abort', () => r.destroy(new Error('aborted')));
  if (init.body) r.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
  r.end();
});
const problems: string[] = [];
const scenario = process.env.E2E_SCENARIO ?? 'basic';
const base = Number(process.env.E2E_ASK_BASE ?? 0); // asks the fake relay answered before this run
process.on('unhandledRejection', e => problems.push('unhandled: ' + ((e as Error)?.message ?? e)));
const call = (path: string, method = 'GET', body?: unknown) => g.fetch(hub + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r: any) => r.json());
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
await import(new URL('../home-app/src/main.ts', import.meta.url).href);
await sleep(2500);
const bridge = g.__fakeBridge;
const ev = (t: number) => ({ textEvent: { containerID: 1, containerName: 'tile-left', eventType: t } });
const press = async (t: number, wait = 700) => { for (const h of bridge.handlers) h(ev(t)); await sleep(wait); }; // 0 tap, 1 up, 2 down, 3 double-tap
const diagNow = async (): Promise<string[]> => (await call('/api/diag')).diagnostics.map((x: any) => `${x.name} ${x.detail}`);
const waitFor = async (re: RegExp, count: number, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if ((await diagNow()).filter(x => re.test(x)).length >= count) return true; await sleep(250); } return false; };
const drawnWith = (needle: string, since: number) => bridge.drawn.filter((d: any) => d.at >= since && d.text.includes(needle));
const lastShown = async () => (await diagNow()).filter(x => x.startsWith('shown ')).at(-1) ?? '';
/** Tap through listen -> stop -> confirm -> Send from the Muse screen or the tile's action list. */
const voiceAsk = async () => { await press(0, 900); await press(0, 1500); await press(0, 900); };
if (scenario === 'basic') {
  await press(0); await press(0); await press(1);
  await call('/api/input', 'POST', { input: 'down' }); await sleep(1500);
  await call('/api/input', 'POST', { input: 'up' }); await sleep(1500);
} else if (scenario === 'tile') {
  await press(0); await press(0); await press(0); // Tiles page: choose, enter the Muse tile, its actions
  const t0 = Date.now();
  await voiceAsk(); // Ask Muse (first action) -> listening -> stop -> confirm -> Send
  if (!await waitFor(/^muse\.reply done/, 1)) problems.push('tile: no muse.reply done');
  await sleep(1500);
  if (!drawnWith(`Answer ${base + 1}`, t0).length) problems.push('tile: the answer was never in a drawn frame');
  if (!(await lastShown()).includes('tiles')) problems.push('tile: did not end on Tiles, last: ' + await lastShown());
} else if (scenario === 'full') {
  await press(0); await press(0); await press(0);
  await press(2); await press(0, 1200); // actions list -> Full screen
  if (!(await diagNow()).some(x => x.startsWith('shown muse'))) problems.push('full: the Muse screen did not open: ' + (await lastShown()));
  for (const n of [1, 2]) {
    const t0 = Date.now();
    await voiceAsk(); // tap (listen) -> tap (stop) -> tap (Send) from the full-screen Muse view
    if (!await waitFor(/^muse\.reply done/, n)) problems.push(`full ask ${n}: no muse.reply done`);
    await sleep(1500);
    if (!drawnWith(`Answer ${base + n}`, t0).length) problems.push(`full ask ${n}: the answer was never in a drawn frame (drawn: ${bridge.drawn.filter((d: any) => d.at >= t0).map((d: any) => d.kind + ':' + d.text.replace(/\n/g, '/').slice(0, 40)).join(' | ')})`);
    // the screens of a full-screen ask are drawn as full page rebuilds (listening, confirm, and the answer)
    const rebuilt = bridge.drawn.filter((d: any) => d.at >= t0 && d.kind === 'rebuild').map((d: any) => d.text);
    if (!rebuilt.some((t: string) => /Listening/.test(t))) problems.push(`full ask ${n}: the listening screen was not a rebuild`);
    if (!rebuilt.some((t: string) => t.includes(`Answer ${base + n}`))) problems.push(`full ask ${n}: the answer was not drawn as a full rebuild`);
    await sleep(500);
  }
}
const diag = await diagNow();
const has = (re: RegExp) => diag.filter(x => re.test(x)).length;
if (!has(/^pair\.auto/)) problems.push('no pair.auto');
if (!has(/^input (select|back|up|down) from touch/)) problems.push('touch presses did not log input');
if (!has(/^input\.queued/)) problems.push('no input.queued');
if (scenario === 'basic') {
  if (!has(/^remote\.input down delivered/)) problems.push('the remote press was not delivered');
  if (!has(/^input down from remote/)) problems.push('the remote press did not log input');
}
console.log(JSON.stringify({ ok: problems.length === 0, problems, diag }));
process.exit(0);
