// Fixture-only native proof for the orchestrator hold flow. Run from a disposable /tmp clone, never the owner's installed Home app.
// The real Home/SDK renderer uses an owned simulator; only microphone I/O is replaced with synthetic PCM.
// The fixture hub forwards the orchestrator's terminal and prompt to a fixture node, so the only POSTs seen are counted here.
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
const output = path.resolve(process.env.ORCH_SHOTS_DIR || path.join(repo, 'output/orch-hold'));
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orch-hold-native-')));
const home = path.join(work, 'home'), bundle = path.join(work, 'OrchHoldFixture.app');
const executable = path.join(bundle, 'Contents/MacOS/OrchHoldFixture');
const token = 'orch-hold-fixture-token';
const nodeToken = 'orch-hold-fixture-node-token';
const orchPane = 'orchestrator';
const transcript = 'Orchestrator fixture: check the garden plan.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
let hub, fixture, vite, launcher, hubPort, simulatorPort, latest = null, hubLog = '', asrHits = 0;
let nativePids = [], promptHits = [], unexpectedHits = [], proof = [];
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
try {
  await mkdir(output, { recursive: true }); await mkdir(home, { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await copyFile(path.join(root, `node_modules/@evenrealities/sim-darwin-${os.arch()}/bin/evenhub-simulator`), executable);
  await chmod(executable, 0o755);
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>OrchHoldFixture</string><key>CFBundleIdentifier</key><string>com.piebird.orchholdfixture</string><key>CFBundleName</key><string>Orchestrator Hold Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  // One fixture server plays three roles: fake ASR, a fake node (terminal + prompt), and nothing else.
  fixture = http.createServer(async (req, res) => {
    if (req.url === '/asr' && req.method === 'POST') {
      const data = await bytes(req); assert.ok(data.includes(Buffer.from('RIFF'))); asrHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: transcript }));
    }
    if (req.url?.startsWith('/node/api/terminal') && req.method === 'GET') {
      req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ lines: ['You: fixture plan', 'Claude: ready.'] }));
    }
    if (req.url === '/node/api/prompt' && req.method === 'POST') {
      const body = JSON.parse((await bytes(req)).toString());
      promptHits.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
    }
    req.resume(); unexpectedHits.push(`${req.method} ${req.url}`); res.writeHead(404); res.end('{}');
  });
  const fixturePort = await listen(fixture); hubPort = await freePort(); simulatorPort = await freePort();
  const tokenFile = path.join(work, 'hub.token'), nodeTokenFile = path.join(work, 'node.token'), config = path.join(work, 'hub.json');
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(nodeTokenFile, nodeToken, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ nodes: [{ name: 'Fixture', url: `http://127.0.0.1:${fixturePort}/node`, tokenFile: nodeTokenFile }], peers: [] }));
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: work,
    HUD_TOKEN_FILE: tokenFile, HUD_HUB_CONFIG: config, HUD_TRANSCRIBE_URL: `http://127.0.0.1:${fixturePort}/asr`, GROQ_API_KEY: 'fake',
    FIXTURE_ALLOW_PORTS: `${fixturePort},${hubPort}`, FIXTURE_GUARD_LOG: path.join(work, 'guard.log') };
  hub = spawn(process.execPath, ['--import', path.join(glasses, 'test-helpers/fixture-network-guard.mjs'), path.join(glasses, 'hud-server.mjs'), '--mode', 'hub', '--host', '127.0.0.1', '--port', String(hubPort), '--machine', 'Orch Hold Fixture'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [hub.stdout, hub.stderr]) stream.on('data', d => { hubLog = (hubLog + d).slice(-8000); });
  await wait(async () => { try { return (await request(`http://127.0.0.1:${hubPort}/api/health`)).ok; } catch { return false; } }, 'fake-only hub ready');
  const hubUrl = `http://127.0.0.1:${hubPort}/`;
  const sdkFile = path.join(root, 'node_modules/@evenrealities/even_hub_sdk/dist/index.js');
  const facade = `export * from ${JSON.stringify('/@fs' + sdkFile)};
import { waitForEvenAppBridge as actual } from ${JSON.stringify('/@fs' + sdkFile)};
export async function waitForEvenAppBridge(){
 const sdk=await actual(), state=globalThis.__orchFixture={micOn:false,starts:0,stops:0,menu:[],events:[],frames:[],handlers:[]};
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
  const entry = path.join(root, 'tests/.orch-native-entry.ts'), html = path.join(root, 'tests/.orch-native.html');
  // The fake Home page: one live orchestrator on a fixture computer, pinned so it is one row from Home.
  const orchSession = { machine: 'Fixture', pane: orchPane, agent: 'claude', session: 'fixture-session', tmux: 'fixture-session', name: 'Orchestrator', state: 'idle', page: 'fixture', at: 1, workspace: '' };
  await writeFile(entry, `localStorage.setItem('home.token',${JSON.stringify(token)});localStorage.setItem('home.tiles','0');
const originalFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{if(new URL(String(args[0]),location.href).pathname==='/api/home')return new Response(JSON.stringify({now:Date.now(),paused:false,machines:[{name:'Fixture',online:true}],sessions:[${JSON.stringify(orchSession)}],pending:[],messages:null,muse:false,voice:true,pinned:[{label:'Orchestrator',machine:'Fixture',agent:'claude',session:'fixture-session'}],weather:null,studio:null}),{headers:{'Content-Type':'application/json'}});return originalFetch(...args);};
await import('../src/main');
let injected=false,busy=false;setInterval(async()=>{const s=globalThis.__orchFixture;if(!s||busy)return;busy=true;try{
 if(s.micOn&&!injected){injected=true;for(const h of s.handlers)h({audioEvent:{audioPcm:new Uint8Array(288000)}});}
 await originalFetch('/__orch_fixture/report',{method:'POST',body:JSON.stringify({...s,handlers:undefined,preview:document.getElementById('glass')?.textContent})});
}finally{busy=false;}},200);`);
  await writeFile(html, '<!doctype html><html><body><div id="app"></div><script type="module" src="./.orch-native-entry.ts"></script></body></html>');
  vite = await createServer({ configFile: false, root, appType: 'mpa', define: { 'import.meta.env.VITE_HUBS': JSON.stringify(hubUrl) }, plugins: [{
    name: 'fixture-only-sdk', enforce: 'pre', resolveId(spec, importer) { if (spec === '@evenrealities/even_hub_sdk' && importer?.endsWith('/src/glasses.ts')) return '\0orch-fixture-sdk'; },
    load(id) { if (id === '\0orch-fixture-sdk') return facade; },
    configureServer(server) { server.middlewares.use('/__orch_fixture/report', async (req, res) => { latest = JSON.parse((await bytes(req)).toString()); res.writeHead(200); res.end('{}'); }); },
  }], server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await vite.listen();
  const simulatorEnv = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: work, XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache') };
  launcher = spawn('/usr/bin/open', ['-g', '-j', '-n', '-W', '--env', `HOME=${home}`, '--env', `XDG_CONFIG_HOME=${simulatorEnv.XDG_CONFIG_HOME}`, '--env', `XDG_CACHE_HOME=${simulatorEnv.XDG_CACHE_HOME}`, '--stdout', path.join(work, 'native.log'), '--stderr', path.join(work, 'native-error.log'), bundle, '--args', '--config', path.join(work, 'simulator.yaml'), '--no-glow', '--automation-port', String(simulatorPort), `http://127.0.0.1:${vite.httpServer.address().port}/tests/.orch-native.html`], { cwd: work, env: simulatorEnv, stdio: 'ignore' });
  await wait(async () => { try { return (await request(`http://127.0.0.1:${simulatorPort}/api/ping`)).ok; } catch { return false; } }, 'owned native simulator ready');
  nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.trim().split(/\s+/, 2)[1] === executable).map(l => Number(l.trim().split(/\s+/)[0]));
  assert.equal(nativePids.length, 1);
  await wait(() => latest?.preview?.includes('Orchestrator'), 'real Home rendered the pinned orchestrator');
  // Home -> the pinned orchestrator row -> its terminal page.
  for (let i = 0; i < 10 && !/^> .*Orchestrator/m.test(latest.preview); i++) await event('down');
  assert.match(latest.preview, /^> .*Orchestrator/m, 'cursor on the orchestrator row');
  await event('click');
  await wait(() => /ORCHESTRATOR/.test(latest?.preview || ''), 'orchestrator terminal page opened');
  assert.deepEqual(promptHits, [], 'opening the page sends nothing');
  proof.push('PASS Home pin opens the fixture orchestrator terminal page; nothing sent on open');
  // 1. A tap starts the microphone (synthetic PCM from the entry).
  await event('click');
  await wait(() => latest?.micOn === true && /Listening/.test(latest.preview || ''), 'tap started the orchestrator microphone');
  await frame('orch-listening.png'); proof.push('PASS tap starts orchestrator mic (synthetic PCM)');
  // 2. A plain second tap says hold to stop and sends nothing.
  await event('click');
  await wait(() => /hold to stop/i.test(latest?.preview || ''), 'plain tap shows hold to stop');
  assert.equal(latest.micOn, true, 'plain tap keeps the mic open');
  await sleep(300); assert.deepEqual(promptHits, [], 'plain tap sends nothing');
  await frame('orch-hold-to-stop.png'); proof.push('PASS plain tap shows "hold to stop", keeps listening, sends nothing');
  // 3. A long press stops the mic, transcribes the synthetic PCM via the fixture ASR, and shows the confirm screen.
  await event('long_press'); await event('long_press_release');
  await wait(() => latest?.micOn === false && /SEND TO/i.test(latest?.preview || '') && /Hold to send/i.test(latest?.preview || ''), 'long press stopped the mic and showed confirm');
  assert.equal(asrHits, 1, 'one transcription for one recording');
  assert.deepEqual(promptHits, [], 'stopping alone sends nothing');
  await frame('orch-confirm.png'); proof.push('PASS long press stops mic; fake ASR transcript shows confirm screen');
  // 4. A long press sends exactly once.
  await event('long_press'); await event('long_press_release');
  await wait(() => promptHits.length >= 1 && /sent to Claude|Sending/i.test(latest?.preview || ''), 'long press sent the prompt');
  await frame('orch-sent.png');
  await sleep(3500); // a duplicate would arrive by now
  assert.equal(promptHits.length, 1, 'exactly one POST to the fixture node');
  assert.equal(promptHits[0].pane, orchPane); assert.equal(promptHits[0].machine, 'Fixture'); assert.equal(promptHits[0].text, transcript);
  proof.push('PASS long press sent exactly once: one prompt POST to the fixture node, with the transcript text');
  assert.equal(latest.micOn, false, 'mic closed after sending');
  assert.deepEqual(unexpectedHits, [], 'no other network requests reached the fixture');
  const guard = await readFile(path.join(work, 'guard.log'), 'utf8').catch(() => ''); assert.equal(guard, '');
  const consoleRows = await request(`http://127.0.0.1:${simulatorPort}/api/console`).then(r => r.json());
  await writeFile(path.join(output, 'console.json'), JSON.stringify(consoleRows));
  assert.doesNotMatch(JSON.stringify(consoleRows), /\[uncaught\]|\[unhandledrejection\]/i);
  proof.push('PASS no unexpected requests, network denials or uncaught errors');
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
