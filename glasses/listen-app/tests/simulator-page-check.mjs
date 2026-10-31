// Native macOS simulator proof against the real stitched hub and loopback-only fixtures.
// Run: node tests/simulator-page-check.mjs (after installing listen-app dependencies).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

if (process.platform !== 'darwin') throw new Error('This isolated native simulator runner requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const glasses = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'output/simulator-page');
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-listen-page-')));
const home = path.join(work, 'home');
const bundle = path.join(work, 'ListenPageFixture.app');
const executable = path.join(bundle, 'Contents/MacOS/ListenPageFixture');
const token = 'synthetic-fixture-token';
const relayToken = 'synthetic-relay-token';
const transcript = 'We need a plan for the community garden and volunteers.';
const firstNote = 'Compare the raised bed sizes.';
const secondNote = 'Confirm Saturday pickup and tools.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
const relayHits = [], asrHits = [], proof = [];
let fixture, proxy, hub, vite, launcher, simulatorPort, hubPort, client = null, waiting = 0, nativePids = [];
let hubError = '';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function wait(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (hub && hub.exitCode !== null) throw new Error(`Fixture hub exited: ${hubError.slice(-1000)}`);
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}; hub: ${hubError.slice(-1000)}`);
}
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
};
async function bytes(req, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('Fixture request exceeds limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function frame(name) {
  await sleep(1200);
  const res = await request(`http://127.0.0.1:${simulatorPort}/api/screenshot/glasses`);
  assert.ok(res.ok, 'Native simulator screenshot accepted');
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 576); assert.equal(png.readUInt32BE(20), 288);
  assert.ok(png.length > 1000, 'Frame contains rendered text');
  const native = path.join(output, `native-${name}`);
  await writeFile(native, png);
  execFileSync('python3', ['-c', `from PIL import Image
import sys
im=Image.open(sys.argv[1]).convert('RGBA')
assert im.getchannel('A').getextrema()==(0,255), 'Blank native framebuffer'
opaque=sum(value>0 for value in im.getchannel('A').getdata())
assert 1000<opaque<im.width*im.height//2, 'Expected text framebuffer'
Image.alpha_composite(Image.new('RGBA',im.size,(0,0,0,255)),im).convert('RGB').save(sys.argv[2])
`, native, path.join(output, name)]);
}
async function event(action) {
  const res = await request(`http://127.0.0.1:${simulatorPort}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  assert.ok(res.ok, 'Simulator input accepted');
}
async function phone(input) {
  await wait(() => waiting > 0, 'phone receiver long poll open');
  const res = await request(`http://127.0.0.1:${hubPort}/api/input`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
  assert.ok(res.ok, 'Phone input accepted');
  const body = await res.json();
  assert.equal(body.delivered, true, 'Phone input reached the app');
}
try {
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(output, { recursive: true });
  await copyFile(path.join(root, 'node_modules/@evenrealities/sim-darwin-arm64/bin/evenhub-simulator'), executable);
  await chmod(executable, 0o755);
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>ListenPageFixture</string>
<key>CFBundleIdentifier</key><string>com.piebird.muselisten.page.fixture</string>
<key>CFBundleName</key><string>Listen Page Fixture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);

  // The fake relay logs every request, including selftest/reply, and never forwards.
  // The ASR endpoint accepts only the hub's fake-key multipart upload.
  fixture = http.createServer(async (req, res) => {
    try {
      if (req.url === '/asr' && req.method === 'POST') {
        assert.equal(req.headers.authorization, 'Bearer fake');
        const body = await bytes(req, 1_000_000);
        assert.ok(body.includes(Buffer.from('RIFF')), 'ASR received WAV audio');
        asrHits.push(body.length);
        return json(res, 200, { text: transcript });
      }
      relayHits.push({ method: req.method, path: req.url });
      req.resume();
      return json(res, 503, { error: 'Fake relay must not be called in page mode' });
    } catch { return json(res, 400, { error: 'Invalid fixture request' }); }
  });
  const fixturePort = await listen(fixture);
  hubPort = await freePort();
  simulatorPort = await freePort();
  assert.notEqual(hubPort, simulatorPort);
  const hubToken = path.join(work, 'hub.token');
  const relayTokenFile = path.join(work, 'relay.token');
  const config = path.join(work, 'hub.json');
  await writeFile(hubToken, token + '\n', { mode: 0o600 });
  await writeFile(relayTokenFile, relayToken + '\n', { mode: 0o600 });
  await writeFile(config, JSON.stringify({ nodes: [], peers: [], listen: { notesFrom: 'page' }, muse: [
    { name: 'fake-only', url: `http://127.0.0.1:${fixturePort}/relay`, tokenFile: relayTokenFile },
  ] }));
  // Do not inherit credentials, proxy settings, NODE_OPTIONS, or a real HOME.
  // The existing guard denies the hub any non-fixture network and child commands.
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: work,
    HUD_TOKEN_FILE: hubToken, HUD_HUB_CONFIG: config, HUD_TRANSCRIBE_URL: `http://127.0.0.1:${fixturePort}/asr`,
    GROQ_API_KEY: 'fake', LISTEN_TEST_ALLOW_PORTS: `${fixturePort},${hubPort}`,
    LISTEN_TEST_GUARD_LOG: path.join(work, 'guard.log') };
  hub = spawn(process.execPath, ['--import', path.join(glasses, 'test-helpers/listen-network-guard.mjs'),
    path.join(glasses, 'hud-server.mjs'), '--mode', 'hub', '--host', '127.0.0.1', '--port', String(hubPort), '--machine', 'Listen Page Fixture'],
  { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stdout.on('data', data => { hubError = (hubError + data).slice(-4000); });
  hub.stderr.on('data', data => { hubError = (hubError + data).slice(-4000); });
  hub.on('error', error => { hubError += String(error); });
  await wait(async () => { try { return (await request(`http://127.0.0.1:${hubPort}/api/health`)).ok; } catch { return false; } }, 'real hub ready');

  // simulator-entry.ts reports its state to /fixture/client. All app API requests
  // are streamed unchanged to the real hub; this adapter never serves /listen.
  proxy = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.url === '/fixture/client' && req.method === 'POST') {
      try { client = JSON.parse((await bytes(req, 1_000_000)).toString()); return json(res, 200, { ok: true }); }
      catch { return json(res, 400, { error: 'Invalid fixture report' }); }
    }
    if (!/^\/api\/(?:listen(?:\/|\?|$)|input(?:\/|\?|$))/.test(req.url ?? '')) return json(res, 404, { error: 'Not a fixture API' });
    const isWait = req.url.startsWith('/api/input/wait');
    if (isWait) { waiting++; res.once('close', () => { waiting--; }); }
    const upstream = http.request({ hostname: '127.0.0.1', port: hubPort, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${hubPort}` } }, response => {
      res.writeHead(response.statusCode, { ...response.headers, 'access-control-allow-origin': '*' });
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Fixture hub unavailable' }); else res.destroy(); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  const proxyPort = await listen(proxy);
  vite = await createServer({ configFile: false, root, appType: 'mpa', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await vite.listen();
  const fixtureUrl = `http://127.0.0.1:${vite.httpServer.address().port}/tests/simulator.html?hub=${encodeURIComponent(`http://127.0.0.1:${proxyPort}/`)}`;
  const simulatorEnv = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: work,
    XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache') };
  launcher = spawn('/usr/bin/open', ['-g', '-j', '-n', '-W', '--env', `HOME=${home}`,
    '--env', `XDG_CONFIG_HOME=${simulatorEnv.XDG_CONFIG_HOME}`, '--env', `XDG_CACHE_HOME=${simulatorEnv.XDG_CACHE_HOME}`,
    '--stdout', path.join(work, 'native.log'), '--stderr', path.join(work, 'native-error.log'), bundle,
    '--args', '--config', path.join(work, 'simulator.yaml'), '--no-glow', '--automation-port', String(simulatorPort), fixtureUrl],
  { env: simulatorEnv, stdio: 'ignore' });
  launcher.on('error', () => {});
  await wait(async () => { try { return (await request(`http://127.0.0.1:${simulatorPort}/api/ping`)).ok; } catch { return false; } }, 'native simulator ready');
  nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.trim().split(/\s+/, 2)[1] === executable).map(line => Number(line.trim().split(/\s+/)[0]));
  assert.equal(nativePids.length, 1, 'One owned simulator process');
  await wait(() => client?.connected, 'fixture app connected');
  await event('click');
  await wait(() => client?.micOn && client?.view?.model?.lines?.some(line => line.text === transcript) && asrHits.length > 0,
    'app started real session and fake microphone reached fake ASR');
  assert.equal(client.view.model.state, 'listening');
  assert.equal(client.view.model.notes.length, 0);
  await frame('listening.png');
  proof.push('PASS app started real hub session, fake PCM reached fake ASR, transcript rendered');

  const pageUrl = `http://127.0.0.1:${hubPort}/listen/note`;
  const form = await request(pageUrl, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ note: firstNote, about: '00:00', id: client.view.id }).toString() });
  assert.equal(form.status, 303, 'Form note accepted by real page route');
  const jsonNote = await request(pageUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: secondNote, about: '00:00', id: client.view.id }) });
  assert.equal(jsonNote.status, 200, 'JSON note accepted by real page route');
  const second = (await jsonNote.json()).note;
  const withNotes = await wait(() => client?.view?.model?.notes?.length === 2 && client.view.model.notes[0].text === firstNote
    && client.view.model.notes[1].text === secondNote && client, 'both page notes reached app');
  assert.equal(withNotes.view.model.notes[1].at_t, second.at_t);
  assert.match(withNotes.view.layout.right, /Confirm Saturday/);
  await frame('notes-arrived.png');
  proof.push('PASS form and JSON POST to real /listen/note appeared in app');

  await phone('down');
  await wait(() => client?.view?.layout?.selectedNoteIndex === 0, 'phone down selects first note');
  await sleep(700);
  await phone('down');
  const selected = await wait(() => client?.view?.layout?.selectedNoteIndex === 1 && client.view.layout.transcriptAt === second.at_t && client,
    'phone down twice selects second note and its transcript anchor');
  assert.match(selected.view.layout.right, />\s*\[/);
  assert.equal(selected.view.model.notes[selected.view.layout.selectedNoteIndex].text, secondNote);
  await frame('note-2-selected.png');
  proof.push('PASS phone down twice selected note two and its transcript anchor');
  assert.deepEqual(relayHits, [], 'Page mode made zero fake relay requests, including selftest/ask/reply');
  assert.ok(!client.diagnostics.some(name => /listen\.frame[.-](failed|deadline)/.test(name)), 'No renderer failure or deadline');
  proof.push('PASS zero fake relay requests; no renderer failure or deadline');
  await event('click');
  await wait(() => client?.micOn === false && client?.view?.phase === 'stopped', 'app stops microphone and real hub session');
  proof.push('PASS app stopped microphone and session');
  assert.deepEqual(relayHits, [], 'No relay request during shutdown');
} finally {
  // Only our copied executable is terminated; no installed app or other process.
  if (!nativePids.length) nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.trim().split(/\s+/, 2)[1] === executable).map(line => Number(line.trim().split(/\s+/)[0]));
  for (const pid of nativePids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  launcher?.kill();
  hub?.kill('SIGTERM');
  if (hub && hub.exitCode === null && hub.signalCode === null) await Promise.race([new Promise(resolve => hub.once('exit', resolve)), sleep(2000)]);
  if (hub && hub.exitCode === null && hub.signalCode === null) hub.kill('SIGKILL');
  await vite?.close();
  await closeServer(proxy);
  await closeServer(fixture);
  await writeFile(path.join(output, 'proof.txt'), proof.join('\n') + '\n').catch(() => {});
}
console.log(proof.join('\n'));
