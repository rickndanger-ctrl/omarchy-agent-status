// Home (G2 OMAC) after the Claude Conversation removal, against the REAL hud-server --demo on a temp HOME whose layout.json
// still names the retired "conversation" tile on a page. Run from glasses/home-app:   node tests/simulator-home-check.mjs
//
// Part A (any OS): the real app code (main.ts + glasses + model, fake Even bridge) against the demo hub. Asserts, from what the
//   app really draws and logs: Home has no Listen/Conversation/Desk row and the glasses menu has exactly 9 items (no 'Listen' or 'Desk'); the
//   Tiles page with that layout draws, its conversation slot renders as an empty tile, taps/back/page swipes do not crash and
//   the app logs no frame failure.
// Part B (macOS only): the same hub and the app served by Vite, shown in a hidden, owned copy of the native Even simulator
//   (never touches another app; only this run's copied executable is terminated). Captures tiles.png and
//   home.png (readable copies; native RGBA files kept) and checks the console for uncaught errors and the hub diag for frame failures.
// Never contacts Muse, a real hub or any real service: HOME is a temp folder, the environment is built, tokens are throwaway.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '..');            // glasses/home-app
const hudServer = path.resolve(root, '../hud-server.mjs');
const TOKEN = 'home-sim-check-token';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ---------------------------------------------------------------------------------------------------------------------
// The old layout: page 1 still has the retired tile; page 2 has it on the right. The other pages are ordinary.
const OLD_LAYOUT = { pages: [
  { left: 'conversation', right: 'clock' },
  { left: 'muse', right: 'conversation' },
  { left: 'messages', right: 'approvals' },
  { left: 'studio', right: 'reminders' },
  { left: 'empty', right: 'empty' },
], updatedAt: 1 };

// ---------------------------------------------------------------------------------------------------------------------
if (process.argv.includes('--driver')) {
  // ============================ the driver: runs INSIDE `node --import tsx --import <hooks>` =============================
  const mode = process.argv[process.argv.indexOf('--driver') + 1]; // 'home' | 'tiles'
  const hub = process.env.SIM_HUB;
  const el = new Proxy(function () {}, { get: (_t, k) => (k === 'style' || k === 'dataset' || k === 'classList' ? el : k === 'value' ? '' : k === 'checked' ? false : k === 'children' ? [] : k === Symbol.toPrimitive ? () => '' : el), set: () => true, apply: () => el, construct: () => el });
  const store = new Map([['home.token', TOKEN]]);
  if (mode === 'home') store.set('home.tiles', '0'); // start on Home, not in Tiles
  const g = globalThis;
  g.document = { getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], createElement: () => el, body: el, addEventListener() {}, title: '' };
  g.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: k => void store.delete(k) };
  g.Option = function Option() { return el; };
  g.window = globalThis; g.addEventListener = () => {}; g.history = { replaceState() {} };
  g.location = { search: '', href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', pathname: '/', port: '' };
  // fetch over node:http (the SDK replaces the timers undici needs)
  g.fetch = (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(String(input));
    const r = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode, headers: { get: k => res.headers[k.toLowerCase()] ?? null }, json: async () => JSON.parse(b || '{}'), text: async () => b }));
    });
    r.on('error', reject);
    if (init.signal) init.signal.addEventListener?.('abort', () => r.destroy(new Error('aborted')));
    if (init.body) r.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
    r.end();
  });
  const problems = [];
  process.on('unhandledRejection', e => problems.push('unhandled: ' + (e?.message ?? e)));
  process.on('uncaughtException', e => problems.push('uncaught: ' + (e?.message ?? e)));
  const call = (p, method = 'GET', body) => g.fetch(hub.replace(/\/$/, '') + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  await import(pathToFileURL(path.join(root, 'src/main.ts')).href);
  await sleep(3500);
  const out = { mode };
  try {
    const bridge = g.__fakeBridge;
    const press = async (t, wait = 700) => { for (const h of bridge.handlers) h({ textEvent: { containerID: 1, containerName: 'tile-left', eventType: t } }); await sleep(wait); }; // 0 tap, 1 up, 2 down, 3 double-tap
    const diagNow = async () => (await call('/api/diag')).diagnostics.map(x => `${x.name} ${x.detail}`);
    const lastShown = async () => (await diagNow()).filter(x => x.startsWith('shown ')).at(-1) ?? '';
    const drawn = () => bridge.drawn.map(d => d.text).join('\n');
    out.menu = bridge.menu ?? null;
    if (mode === 'home') {
      const text = drawn();
      if (!/AGENTS/.test(text)) problems.push('Home never drew its AGENTS list');
      out.homeText = text.slice(0, 600);
      if (!/Claude|Codex/.test(text)) problems.push('Home drew no agent row (demo sessions expected)');
      if (/conversation|\bDesk\b/i.test(text) || /\bListen\b/.test(text)) problems.push('Home draws a Listen/Conversation/Desk row: ' + (text.match(/.*(conversation|\bDesk\b|\bListen\b).*/i)?.[0] ?? ''));
      const names = bridge.menu ?? [];
      out.menuNames = names;
      if (names.length !== 9) problems.push(`the glasses menu has ${names.length} items, expected 9: ${names.join(', ')}`);
      if (names.some(n => /listen|conversation|desk/i.test(n))) problems.push('the glasses menu still has a Listen/Conversation/Desk item: ' + names.join(', '));
    } else {
      const layout = await call('/api/layout');
      out.layoutPage1 = layout.pages?.[0];
      if (layout.pages?.[0]?.left !== 'conversation') problems.push('the fixture did not reach the hub: page 1 left is ' + layout.pages?.[0]?.left);
      const first = drawn();
      out.tilesText = first.slice(0, 500);
      if (/conversation/i.test(first) || /\bListen\b/.test(first) || /not available/i.test(first)) problems.push('page 1 draws the retired tile: ' + (first.match(/.*(conversation|\bListen\b|not available).*/i)?.[0] ?? ''));
      if (!/^1\/5 /m.test(first)) problems.push('the Tiles page 1/5 was never drawn');
      if (!/^1\/5 Empty$/m.test(first)) problems.push('the conversation slot did not render as an empty tile ("1/5 Empty")');
      // walk the pages that carry the old id: choose + enter the empty slot, back out, swipe to page 2 (right slot), choose it
      await press(0); await press(0); await press(3);          // choose the left slot, enter the (empty) tile, back to choosing
      await press(3);                                           // back to the page level
      await press(2);                                           // swipe to page 2 (its right slot carries the old id)
      await press(0); await press(2); await press(0); await press(3); // choose, switch to the right slot, enter it, back
      await sleep(1000);
      const after = await diagNow();
      const all = drawn();
      if (!/^2\/5 Muse$/m.test(all)) problems.push('page 2 was never drawn (the swipes did not reach it)');
      if (!/^Empty$/m.test(all)) problems.push('page 2 right slot (the old conversation id) did not render as an empty tile');
      if (/conversation/i.test(all) || /\bListen\b/.test(all)) problems.push('a later frame draws the retired tile');
      out.shownAfter = (await lastShown());
      if (!out.shownAfter.startsWith('shown tiles')) problems.push(`Tiles was left unexpectedly: last shown "${out.shownAfter}"`);
      if (after.some(x => /^input\.error|^input\.dropped/.test(x))) problems.push('input errors: ' + after.filter(x => /^input\.(error|dropped)/.test(x)).join(' | '));
    }
    const diag = await diagNow();
    const bad = diag.filter(x => /^frame (failed|held)/.test(x) || /frame (failed|cut|deadline)/i.test(x));
    if (bad.length) problems.push('frame failures: ' + bad.join(' | '));
    out.diagTail = diag.slice(-12);

  } catch (error) { problems.push('driver error: ' + (error?.stack ?? error)); }
  console.log('RESULT ' + JSON.stringify({ ok: problems.length === 0, problems, ...out }));
  process.exit(0);
}

// ================================== the runner =====================================================================
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'home-sim-check-')));
const home = path.join(work, 'home');
await mkdir(path.join(home, '.config/agent-glasses'), { recursive: true });
await writeFile(path.join(home, '.config/agent-glasses/layout.json'), JSON.stringify(OLD_LAYOUT, null, 2));
await writeFile(path.join(work, 'hud.token'), TOKEN + '\n', { mode: 0o600 });
await writeFile(path.join(work, 'hub.json'), '{}');
const output = path.join(work, 'output');      // screenshots, proof.txt, summary.json and the driver logs land here (printed at the end)
await mkdir(output, { recursive: true });
const hubPort = await freePort();
const hubUrl = `http://127.0.0.1:${hubPort}/`;
// A BUILT environment: nothing inherited (no proxy, token, provider, studio or Muse setting can reach the hub or the app).
const cleanEnv = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', TMPDIR: work, XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache') };
const procs = []; const proof = [];
let ownedPids = [];
const hubFetch = async (p, init = {}) => (await fetch(new URL(p, hubUrl), { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(5000) })).json();
const summary = [];
let exitCode = 0;
try {
  // the real hub in demo mode
  const hubLog = (await import('node:fs')).openSync(path.join(work, 'hub.log'), 'w');
  const hub = spawn(process.execPath, [hudServer, '--mode', 'hub', '--host', '127.0.0.1', '--port', String(hubPort), '--machine', 'Home Sim'], {
    env: { ...cleanEnv, HUD_DEMO: '1', HUD_TOKEN_FILE: path.join(work, 'hud.token'), HUD_HUB_CONFIG: path.join(work, 'hub.json') }, stdio: ['ignore', hubLog, hubLog] });
  procs.push(hub);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(new URL('api/health', hubUrl))).ok) break; } catch {} await sleep(100); }
  const layout = await hubFetch('api/layout');
  assert.equal(layout.pages[0].left, 'conversation', 'the old layout (conversation on page 1) is what the hub serves');
  proof.push('PASS real hud-server --demo on a temp HOME serves a layout that still names the conversation tile (pages 1 and 2)');

  // generated hooks + shim for Part A: the real SDK plus a fake bridge that also records the glasses menu
  const sdk = pathToFileURL(path.join(root, 'node_modules/@evenrealities/even_hub_sdk/dist/index.js')).href;
  await writeFile(path.join(work, 'shim.mjs'), `export * from ${JSON.stringify(sdk)};
export const fakeBridge = globalThis.__fakeBridge ??= { handlers: [], calls: [], drawn: [], menu: null };
const textsOf = c => (c?.textObject ?? []).map(t => t.content ?? '').join('\\n');
const findMenu = o => { if (!o || typeof o !== 'object') return null; if (Array.isArray(o.menuItems)) return o.menuItems.map(i => String(i.itemName ?? i.name ?? '')); for (const v of Object.values(o)) { const r = findMenu(v); if (r) return r; } return null; };
export const waitForEvenAppBridge = async () => ({
  onEvenHubEvent: h => { fakeBridge.handlers.push(h); return () => {}; },
  onDeviceStatusChanged: () => () => {},
  getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
  createStartUpPageContainer: async c => { let j = null; try { j = JSON.parse(JSON.stringify(c)); } catch {} fakeBridge.menu = findMenu(j) ?? fakeBridge.menu; fakeBridge.drawn.push({ at: Date.now(), kind: 'startup', text: textsOf(c) }); return 0; },
  rebuildPageContainer: async c => { fakeBridge.drawn.push({ at: Date.now(), kind: 'rebuild', text: textsOf(c) }); return true; },
  textContainerUpgrade: async u => { fakeBridge.drawn.push({ at: Date.now(), kind: 'upgrade', text: u?.content ?? '' }); return true; },
  audioControl: async () => true, shutDownPageContainer: async () => true, imuControl: async () => true,
});
`);
  await writeFile(path.join(work, 'hooks.mjs'), `import { registerHooks } from 'node:module';
const shim = ${JSON.stringify(pathToFileURL(path.join(work, 'shim.mjs')).href)};
registerHooks({
  resolve(spec, context, next) { if (spec === '@evenrealities/even_hub_sdk' && context.parentURL?.includes('/src/glasses.ts')) return { url: shim, shortCircuit: true }; return next(spec, context); },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default ""', shortCircuit: true };
    const r = next(url, context);
    if (r.source && url.includes('/src/')) return { ...r, source: Buffer.from(r.source).toString('utf8').replaceAll('import.meta.env', '({VITE_HUBS:' + JSON.stringify(${JSON.stringify(hubUrl)}) + '})') };
    return r;
  },
});
`);
  const runDriver = mode => new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(path.join(work, 'hooks.mjs')).href, here, '--driver', mode], { cwd: root, env: { ...cleanEnv, SIM_HUB: hubUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('exit', async () => { clearTimeout(timer); await writeFile(path.join(output, `driver-${mode}.log`), text).catch(() => {}); const line = text.split('\n').reverse().find(l => l.startsWith('RESULT ')); resolve(line ? JSON.parse(line.slice(7)) : { ok: false, problems: ['the driver printed no result: ' + text.slice(-400)] }); });
  });
  for (const mode of ['home', 'tiles']) {
    const r = await runDriver(mode);
    summary.push(r);
    const label = mode === 'home' ? 'Home: no Listen/Conversation/Desk row, glasses menu has 9 items, no frame failures' : 'Tiles with the old layout: the conversation slot is an empty tile, taps/back/swipes do not crash, no frame failures';
    if (r.ok) proof.push(`PASS ${label}` + (mode === 'home' ? ` [menu: ${(r.menuNames ?? []).join(' | ')}]` : ''));
    else { proof.push(`FAIL ${label}: ${r.problems.join('; ')}`); exitCode = 1; }
  }

  // ---- Part B: the native simulator, macOS only ----------------------------------------------------------------------
  if (process.platform === 'darwin') {
    const { createServer } = await import('vite');
    const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
    const bundle = path.join(work, 'HomeFixtureSimulator.app');
    const executable = path.join(bundle, 'Contents/MacOS/HomeFixtureSimulator');
    await mkdir(path.dirname(executable), { recursive: true });
    await copyFile(path.join(root, `node_modules/@evenrealities/sim-darwin-${arch}/bin/evenhub-simulator`), executable);
    await chmod(executable, 0o755);
    await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>HomeFixtureSimulator</string>
<key>CFBundleIdentifier</key><string>com.piebird.home.fixture.simulator</string>
<key>CFBundleName</key><string>Home Fixture Simulator</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
    const simPort = await freePort();
    process.env.VITE_HUBS = hubUrl;
    const vite = await createServer({ configFile: false, root, appType: 'mpa', server: { host: '127.0.0.1', port: 0, strictPort: true }, envPrefix: 'VITE_' });
    await vite.listen();
    let launcher;
    const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const frame = async name => {
      await sleep(1500);
      const r = await request(`http://127.0.0.1:${simPort}/api/screenshot/glasses`);
      assert.ok(r.ok, 'native simulator screenshot accepted');
      const png = Buffer.from(await r.arrayBuffer());
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 576); assert.equal(png.readUInt32BE(20), 288);
      const nativePath = path.join(output, `native-${name}`);
      await writeFile(nativePath, png);
      execFileSync('python3', ['-c', `from PIL import Image
import sys
im=Image.open(sys.argv[1]).convert('RGBA')
assert im.getchannel('A').getextrema()==(0,255), 'Blank native framebuffer'
opaque=sum(v>0 for v in im.getchannel('A').getdata())
assert 1000<opaque<im.width*im.height//2, 'Expected a text framebuffer'
Image.alpha_composite(Image.new('RGBA',im.size,(0,0,0,255)),im).convert('RGB').save(sys.argv[2])
`, nativePath, path.join(output, name)]);
    };
    const shown = async () => ((await hubFetch('api/diag')).diagnostics ?? []).map(x => `${x.name} ${x.detail}`).filter(x => x.startsWith('shown ')).at(-1) ?? '';
    const waitShown = async (prefix, label, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await shown()).startsWith(prefix)) return; await sleep(300); } throw new Error(`Timed out: ${label} (last: ${await shown()})`); };
    const input = async action => { const r = await request(`http://127.0.0.1:${simPort}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); assert.ok(r.ok, `simulator input ${action} accepted`); };
    try {
      const appUrl = `http://127.0.0.1:${vite.httpServer.address().port}/?t=${TOKEN}`;
      const env = { ...cleanEnv };
      launcher = spawn('/usr/bin/open', ['-g', '-j', '-n', '-W', '--env', `HOME=${env.HOME}`, '--env', `XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`, '--env', `XDG_CACHE_HOME=${env.XDG_CACHE_HOME}`, '--stdout', path.join(work, 'native.log'), '--stderr', path.join(work, 'native-error.log'), bundle, '--args', '--config', path.join(work, 'simulator.yaml'), '--no-glow', '--automation-port', String(simPort), appUrl], { env, stdio: 'ignore' });
      launcher.on('error', () => {});
      let ping = false;
      for (let i = 0; i < 100; i++) { try { ping = (await request(`http://127.0.0.1:${simPort}/api/ping`)).ok; } catch {} if (ping) break; await sleep(250); }
      assert.ok(ping, 'owned native simulator automation API started');
      ownedPids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.trim().split(/\s+/, 2)[1] === executable).map(l => Number(l.trim().split(/\s+/)[0]));
      assert.equal(ownedPids.length, 1, 'one owned simulator process');
      await waitShown('shown tiles', 'the app starts in Tiles on the old layout');
      await frame('tiles.png');
      proof.push('PASS native simulator: Tiles page 1 (old conversation slot) captured; framebuffer 576x288');
      await input('double_click');
      await waitShown('shown home', 'double-tap leaves Tiles for Home');
      await frame('home.png');
      proof.push('PASS native simulator: Home captured after leaving Tiles');
      const logs = await request(`http://127.0.0.1:${simPort}/api/console`).then(r => r.json());
      await writeFile(path.join(work, 'console.json'), JSON.stringify(logs));
      assert.doesNotMatch(JSON.stringify(logs), /\[uncaught\]|\[unhandledrejection\]/i, 'no uncaught JavaScript errors in the simulator console');
      const diag = ((await hubFetch('api/diag')).diagnostics ?? []).map(x => `${x.name} ${x.detail}`);
      assert.ok(!diag.some(x => /^frame (failed|held)/.test(x)), 'no SDK frame failure in the hub diag: ' + diag.filter(x => /^frame/.test(x)).join(' | '));
      proof.push('PASS simulator console has no uncaught errors; hub diag has no frame failures');
    } finally {
      if (!ownedPids.length) ownedPids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.trim().split(/\s+/, 2)[1] === executable).map(l => Number(l.trim().split(/\s+/)[0]));
      for (const pid of ownedPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }   // exact executable match only; never GUI quit
      launcher?.kill();
      await vite.close();
    }
  } else {
    proof.push(`SKIP native simulator part (${process.platform}): it needs macOS; Part A ran`);
  }
} catch (error) {
  proof.push(`FAIL ${error?.message ?? error}`);
  exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  proof.push('CLEANUP owned processes and loopback servers only; outputs (proof.txt, summary.json, driver logs, PNGs) in ' + output);
  await writeFile(path.join(output, 'proof.txt'), proof.join('\n') + '\n');
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
}
console.log(proof.join('\n'));
process.exit(exitCode);
