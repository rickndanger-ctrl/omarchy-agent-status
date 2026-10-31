// Fixture-only native proof. Run from a disposable /tmp clone, never the owner's installed Home app.
// The real Home/SDK renderer uses an owned simulator; only microphone I/O is replaced with synthetic PCM.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const tmpRoot = await realpath(os.tmpdir());
assert.equal(process.platform, 'darwin', 'Native screenshot proof requires macOS');
assert.ok(root.startsWith(tmpRoot + path.sep) || root.startsWith('/private/tmp/'), 'Run only in a disposable /tmp clone');
const repo = path.resolve(root, '../..'), glasses = path.dirname(root);
assert.ok((await readFile(path.join(repo, '.git/config'), 'utf8')).includes('[remote "origin"]'), 'Use an actual throwaway clone');
const output = path.resolve(process.env.LISTEN_SHOTS_DIR || path.join(repo, 'output/listen-home'));
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'listen-home-native-')));
const home = path.join(work, 'home'), bundle = path.join(work, 'ListenHomeFixture.app');
const executable = path.join(bundle, 'Contents/MacOS/ListenHomeFixture');
const token = 'listen-home-fixture-token';
const transcript = 'We need a plan for the community garden and volunteers.';
const notes = ['Compare the raised bed sizes.', 'Confirm Saturday pickup and tools.'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
let hub, fixture, vite, launcher, hubPort, simulatorPort, latest = null, hubLog = '', asrHits = 0;
let nativePids = [], relayHits = [], proof = [];
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function freePort() {
  const server = net.createServer(); const port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
}
async function bytes(req, limit = 1_000_000) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; assert.ok(n <= limit); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function wait(predicate, label, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (hub && hub.exitCode !== null) throw new Error(`Fixture hub exited: ${hubLog.slice(-500)}`);
    const value = await predicate(); if (value) return value;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}; latest ${JSON.stringify(latest)?.slice(-1800)}`);
}
async function event(action) {
  const r = await request(`http://127.0.0.1:${simulatorPort}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  assert.ok(r.ok, action); await sleep(800);
}
async function frame(name, target = 'glasses') {
  await sleep(1100);
  const r = await request(`http://127.0.0.1:${simulatorPort}/api/screenshot/${target}`);
  assert.ok(r.ok); const png = Buffer.from(await r.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  if (target === 'glasses') { assert.equal(png.readUInt32BE(16), 576); assert.equal(png.readUInt32BE(20), 288); }
  const raw = path.join(output, `native-${name}`); await writeFile(raw, png);
  execFileSync('python3', ['-c', `from PIL import Image
import sys
im=Image.open(sys.argv[1]).convert('RGBA')
assert im.getbbox(), 'Blank framebuffer'
Image.alpha_composite(Image.new('RGBA',im.size,(0,0,0,255)),im).convert('RGB').save(sys.argv[2])`, raw, path.join(output, name)]);
}
async function phone(input, pauseMs = 800) {
  const r = await request(`http://127.0.0.1:${hubPort}/api/input`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
  assert.ok(r.ok); const b = await r.json(); assert.equal(b.delivered, true, 'Real Home remote waiter received input'); await sleep(pauseMs);
}
try {
  await mkdir(output, { recursive: true }); await mkdir(home, { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await copyFile(path.join(root, `node_modules/@evenrealities/sim-darwin-${os.arch()}/bin/evenhub-simulator`), executable);
  await chmod(executable, 0o755);
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ListenHomeFixture</string><key>CFBundleIdentifier</key><string>com.piebird.listenhome.fixture</string><key>CFBundleName</key><string>Listen Home Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  fixture = http.createServer(async (req, res) => {
    if (req.url === '/asr' && req.method === 'POST') {
      const data = await bytes(req); assert.ok(data.includes(Buffer.from('RIFF'))); asrHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: transcript }));
    }
    req.resume(); relayHits.push(req.url); res.writeHead(503); res.end('{}');
  });
  const fixturePort = await listen(fixture); hubPort = await freePort(); simulatorPort = await freePort();
  const tokenFile = path.join(work, 'hub.token'), config = path.join(work, 'hub.json');
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ nodes: [], peers: [], listen: { notesFrom: 'page' }, muse: [{ name: 'fake-only', url: `http://127.0.0.1:${fixturePort}/relay`, tokenFile }] }));
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: work,
    HUD_TOKEN_FILE: tokenFile, HUD_HUB_CONFIG: config, HUD_TRANSCRIBE_URL: `http://127.0.0.1:${fixturePort}/asr`, GROQ_API_KEY: 'fake',
    LISTEN_TEST_ALLOW_PORTS: `${fixturePort},${hubPort}`, LISTEN_TEST_GUARD_LOG: path.join(work, 'guard.log') };
  hub = spawn(process.execPath, ['--import', path.join(glasses, 'test-helpers/listen-network-guard.mjs'), path.join(glasses, 'hud-server.mjs'), '--mode', 'hub', '--host', '127.0.0.1', '--port', String(hubPort), '--machine', 'Listen Home Fixture'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [hub.stdout, hub.stderr]) stream.on('data', d => { hubLog = (hubLog + d).slice(-8000); });
  await wait(async () => { try { return (await request(`http://127.0.0.1:${hubPort}/api/health`)).ok; } catch { return false; } }, 'fake-only hub ready');
  const hubUrl = `http://127.0.0.1:${hubPort}/`;
  const sdkFile = path.join(root, 'node_modules/@evenrealities/even_hub_sdk/dist/index.js');
  const facade = `export * from ${JSON.stringify('/@fs' + sdkFile)};
import { waitForEvenAppBridge as actual } from ${JSON.stringify('/@fs' + sdkFile)};
export async function waitForEvenAppBridge(){
 const sdk=await actual(), state=globalThis.__listenFixture={micOn:false,starts:0,stops:0,menu:[],events:[],frames:[],handlers:[]};
 const facade=Object.create(sdk);
 facade.onEvenHubEvent=fn=>{state.handlers.push(fn);return sdk.onEvenHubEvent(e=>{if(!e.audioEvent&&state.events.length<40)state.events.push(e);fn(e);});};
 facade.audioControl=async on=>{state.micOn=on;if(on)state.starts++;else state.stops++;return true;};
 facade.getAppLocation=async()=>null;
 for(const name of ['createStartUpPageContainer','rebuildPageContainer','textContainerUpgrade'])facade[name]=async c=>{
  if(c?.menuObject?.menuItems)state.menu=c.menuObject.menuItems.map(i=>({id:i.itemID,name:i.itemName}));
  state.frames.push({name,content:c?.content,text:(c?.textObject??[]).map(t=>t.content)});state.frames=state.frames.slice(-12);
  return sdk[name](c);
 };
 return facade;
}`;
  const entry = path.join(root, 'tests/.listen-native-entry.ts'), html = path.join(root, 'tests/.listen-native.html');
  await writeFile(entry, `localStorage.setItem('home.token',${JSON.stringify(token)});localStorage.setItem('home.tiles','0');
const originalFetch=globalThis.fetch;let sessionId='';globalThis.fetch=async(...args)=>{if(new URL(String(args[0]),location.href).pathname==='/api/home')return new Response(JSON.stringify({now:Date.now(),paused:false,machines:[{name:'Fixture',online:true}],sessions:[],pending:[],messages:null,muse:false,voice:true,pinned:[],weather:null,studio:null}),{headers:{'Content-Type':'application/json'}});const r=await originalFetch(...args);if(String(args[0]).includes('api/listen/start')&&r.ok)sessionId=(await r.clone().json()).id;return r;};
await import('../src/main');
let injected=false,busy=false;setInterval(async()=>{const s=globalThis.__listenFixture;if(!s||busy)return;busy=true;try{
 if(s.micOn&&!injected){injected=true;for(const h of s.handlers)h({audioEvent:{audioPcm:new Uint8Array(288000)}});}
 await originalFetch('/__listen_fixture/report',{method:'POST',body:JSON.stringify({...s,handlers:undefined,id:sessionId,preview:document.getElementById('glass')?.textContent})});
}finally{busy=false;}},200);`);
  await writeFile(html, '<!doctype html><html><body><div id="app"></div><script type="module" src="./.listen-native-entry.ts"></script></body></html>');
  vite = await createServer({ configFile: false, root, appType: 'mpa', define: { 'import.meta.env.VITE_HUBS': JSON.stringify(hubUrl) }, plugins: [{
    name: 'fixture-only-sdk', enforce: 'pre', resolveId(spec, importer) { if (spec === '@evenrealities/even_hub_sdk' && importer?.endsWith('/src/glasses.ts')) return '\0listen-fixture-sdk'; },
    load(id) { if (id === '\0listen-fixture-sdk') return facade; },
    configureServer(server) { server.middlewares.use('/__listen_fixture/report', async (req, res) => { latest = JSON.parse((await bytes(req)).toString()); res.writeHead(200); res.end('{}'); }); },
  }], server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await vite.listen();
  const simulatorEnv = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: work, XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache') };
  launcher = spawn('/usr/bin/open', ['-g', '-j', '-n', '-W', '--env', `HOME=${home}`, '--env', `XDG_CONFIG_HOME=${simulatorEnv.XDG_CONFIG_HOME}`, '--env', `XDG_CACHE_HOME=${simulatorEnv.XDG_CACHE_HOME}`, '--stdout', path.join(work, 'native.log'), '--stderr', path.join(work, 'native-error.log'), bundle, '--args', '--config', path.join(work, 'simulator.yaml'), '--no-glow', '--automation-port', String(simulatorPort), `http://127.0.0.1:${vite.httpServer.address().port}/tests/.listen-native.html`], { cwd: work, env: simulatorEnv, stdio: 'ignore' });
  await wait(async () => { try { return (await request(`http://127.0.0.1:${simulatorPort}/api/ping`)).ok; } catch { return false; } }, 'owned native simulator ready');
  nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.trim().split(/\s+/, 2)[1] === executable).map(l => Number(l.trim().split(/\s+/)[0]));
  assert.equal(nativePids.length, 1);
  await wait(() => latest?.preview?.includes('AGENTS'), 'real Home rendered');
  for (let i = 0; i < 30 && !/^> Muse Listen$/m.test(latest.preview); i++) await event('down');
  assert.match(latest.preview, /^> Muse Listen$/m); await frame('home-muse-listen.png');
  assert.equal(latest.menu.length, 10); assert.ok(latest.menu.some(i => i.name === 'Muse Listen' && i.id === 3));
  proof.push('PASS Home row and 10-item SDK menu include Muse Listen');
  await event('context_menu'); await frame('menu.png'); await event('double_click');
  // Re-find the row after native menu dismissal; the wake press is intentionally ignored.
  await sleep(1200);
  for (let i = 0; i < 30 && !/^> Muse Listen$/m.test(latest.preview); i++) await event('down');
  for (let i = 0; i < 3 && !/MUSE/.test(latest?.preview || ''); i++) { await event('click'); await sleep(1200); }
  await wait(() => /MUSE/.test(latest?.preview || '') && /Listening|hold to start/i.test(latest?.preview || ''), 'Listen screen opened');
  await event('click'); assert.equal(latest.micOn, false, 'Touch tap cannot start');
  await event('long_press'); await event('long_press_release');
  await wait(() => latest?.micOn && latest.preview?.replace(/\s+/g, ' ').includes(transcript) && asrHits > 0, 'synthetic PCM to fake ASR to real Home transcript');
  await frame('listen-transcript.png'); proof.push('PASS physical hold starts, tap did not; PCM traversed real hub fake ASR; transcript rendered');
  for (const text of notes) {
    const r = await request(`http://127.0.0.1:${hubPort}/listen/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, about: '00:00', id: latest.id }) });
    assert.equal(r.status, 200, 'Real /listen/note POST accepted');
  }
  await wait(() => latest?.preview?.replace(/\s+/g, ' ').includes(notes[0]) && latest?.preview?.replace(/\s+/g, ' ').includes(notes[1]), 'manual notes polled into Home screen');
  await frame('listen-notes.png'); proof.push('PASS real loopback /listen/note POSTs arrived in Home');
  await phone('down'); await sleep(650); await phone('down');
  await wait(() => />\s*\[\d\d:\d\d\]\s*Confirm Saturday/.test(latest?.preview || ''), 'second note selected');
  await frame('listen-note-selected.png'); proof.push('PASS remote down twice selected second note and transcript anchor');
  await phone('down', 0); await sleep(100); await phone('down', 0);
  await wait(() => !/>\s*\[\d\d:\d\d\]/.test(latest?.preview || ''), 'rapid double-down returns newest despite render pacing');
  proof.push('PASS rapid remote double-down returns newest despite SDK render pacing');
  await event('double_click'); await wait(() => latest?.micOn === false && /AGENTS/.test(latest.preview || ''), 'back stops microphone and returns Home');
  const state = await request(`${hubUrl}api/listen?id=${encodeURIComponent(latest.id)}&since=0`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  assert.equal(state.state, 'stopped'); assert.deepEqual(relayHits, []);
  const guard = await readFile(path.join(work, 'guard.log'), 'utf8').catch(() => ''); assert.equal(guard, '');
  const consoleRows = await request(`http://127.0.0.1:${simulatorPort}/api/console`).then(r => r.json());
  await writeFile(path.join(output, 'console.json'), JSON.stringify(consoleRows));
  assert.doesNotMatch(JSON.stringify(consoleRows), /\[uncaught\]|\[unhandledrejection\]/i);
  proof.push('PASS back stopped session and mic; no relay requests, network denials or uncaught errors');
} finally {
  if (!nativePids.length) nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.trim().split(/\s+/, 2)[1] === executable).map(l => Number(l.trim().split(/\s+/)[0]));
  for (const pid of nativePids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  launcher?.kill(); hub?.kill('SIGTERM');
  await vite?.close(); fixture?.closeAllConnections?.();
  if (fixture) await new Promise(resolve => fixture.close(resolve));
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'proof.txt'), proof.join('\n') + '\n');
  await writeFile(path.join(output, 'last-client.json'), JSON.stringify(latest, null, 2));
  await writeFile(path.join(output, 'fixture-hub.log'), hubLog);
  await rm(work, { recursive: true, force: true });
}
console.log(proof.join('\n'));
