// Native simulator framebuffer evidence using a separate, hidden fixture app.
// Never opens/focuses/quits another app; only this run's copied executable is terminated.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { startFakeHub } from './simulator-hub.mjs';

if (process.platform !== 'darwin') throw new Error('This isolated native simulator runner requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'output/simulator');
const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'muse-listen-simulator-')));
const bundle = path.join(work, 'ListenFixtureSimulator.app');
const executable = path.join(bundle, 'Contents/MacOS/ListenFixtureSimulator');
await mkdir(path.dirname(executable), { recursive: true });
await mkdir(output, { recursive: true });
await copyFile(path.join(root, 'node_modules/@evenrealities/sim-darwin-arm64/bin/evenhub-simulator'), executable);
await chmod(executable, 0o755);
await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>ListenFixtureSimulator</string>
<key>CFBundleIdentifier</key><string>com.piebird.muselisten.fixture.simulator</string>
<key>CFBundleName</key><string>Listen Fixture Simulator</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
await mkdir(path.join(work, 'home'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let hub, vite, launcher, proof = [], nativePids = [];
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
const event = async action => {
  const r = await request(`http://127.0.0.1:${port}/api/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  assert.ok(r.ok, 'Simulator input accepted');
};
const state = async () => (await request(new URL('fixture/state', hub.url))).json();
const wait = async (predicate, label, timeout = 30_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const value = await state(); if (predicate(value)) return value; } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
};
const frame = async name => {
  await sleep(1200);
  const r = await request(`http://127.0.0.1:${port}/api/screenshot/glasses`);
  assert.ok(r.ok, 'Native simulator screenshot accepted');
  const png = Buffer.from(await r.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 576); assert.equal(png.readUInt32BE(20), 288);
  assert.ok(png.length > 1000, 'Frame contains rendered text');
  // The native PNG uses constant green RGB and carries the framebuffer in alpha.
  // Keep it verbatim, then flatten only transparency onto black for ordinary viewers.
  const nativePath = path.join(output, `native-${name}`);
  await writeFile(nativePath, png);
  execFileSync('python3', ['-c', `from PIL import Image
import sys
im=Image.open(sys.argv[1]).convert('RGBA')
assert im.getchannel('A').getextrema()==(0,255), 'Blank native framebuffer'
opaque=sum(value>0 for value in im.getchannel('A').getdata())
assert 1000<opaque<im.width*im.height//2, 'Expected text framebuffer'
Image.alpha_composite(Image.new('RGBA',im.size,(0,0,0,255)),im).convert('RGB').save(sys.argv[2])
`, nativePath, path.join(output, name)]);
};
const phone = async input => {
  await wait(s => s.waiting, 'phone receiver long poll open');
  const r = await request(new URL('api/input', hub.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
  assert.ok(r.ok, 'Fake phone input accepted');
};
try {
  hub = await startFakeHub();
  vite = await createServer({ configFile: false, root, appType: 'mpa', server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await vite.listen();
  const fixtureUrl = `http://127.0.0.1:${vite.httpServer.address().port}/tests/simulator.html?hub=${encodeURIComponent(hub.url)}`;
  const inherited = { ...process.env, HOME: path.join(work, 'home'), XDG_CONFIG_HOME: path.join(work, 'config'), XDG_CACHE_HOME: path.join(work, 'cache') };
  for (const key of Object.keys(inherited)) if (/TOKEN|SECRET|API_KEY|STUDIO_SEAL/i.test(key)) delete inherited[key];
  // -g: do not activate; -j: launch hidden. This is our copied fixture app, never an installed user app.
  launcher = spawn('/usr/bin/open', ['-g', '-j', '-n', '-W', '--env', `HOME=${inherited.HOME}`, '--env', `XDG_CONFIG_HOME=${inherited.XDG_CONFIG_HOME}`, '--env', `XDG_CACHE_HOME=${inherited.XDG_CACHE_HOME}`, '--stdout', path.join(work, 'native.log'), '--stderr', path.join(work, 'native-error.log'), bundle, '--args', '--config', path.join(work, 'simulator.yaml'), '--no-glow', '--automation-port', String(port), fixtureUrl], { env: inherited, stdio: 'ignore' });
  launcher.on('error', () => {});
  let ping = false;
  for (let i = 0; i < 100; i++) { try { ping = (await request(`http://127.0.0.1:${port}/api/ping`)).ok; } catch {} if (ping) break; await sleep(250); }
  assert.ok(ping, 'Owned native simulator automation API started');
  nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.trim().split(/\s+/, 2)[1] === executable).map(line => Number(line.trim().split(/\s+/)[0]));
  assert.equal(nativePids.length, 1, 'One owned simulator process');
  await wait(s => s.client, 'fixture app connected');
  await event('click');
  await wait(s => s.client?.micOn && s.client?.view?.model?.notes?.length === 2, 'listening with transcript and two notes');
  await frame('listening.png');
  proof.push('PASS actual evenhub-simulator 0.9.5 automation API; SDK framebuffer 576x288');
  proof.push('CAPTURE native RGBA files retained verbatim; readable copies flatten alpha onto black with Pillow, no text/content edits');
  proof.push('PASS listening indicator, transcript and two notes from loopback fake hub; injected fake microphone only');
  await phone('down'); await sleep(700); await phone('down');
  const selected = await wait(s => s.client?.view?.layout?.selectedNoteIndex === 1 && s.client?.view?.layout?.transcriptAt === 90_000, 'phone down twice selects note two and transcript at_t');
  assert.match(selected.client.view.layout.left, /\[01:30\]/);
  assert.match(selected.client.view.layout.right, />.*\[01:40\]/);
  await frame('note-selected.png');
  proof.push('PASS phone /api/input down twice selects note 2; arrival 01:40, transcript anchor 01:30');
  await sleep(700); await event('up');
  await wait(s => s.client?.view?.layout?.selectedNoteIndex === 0, 'touch up selects previous note');
  await sleep(700); await event('down');
  await wait(s => s.client?.view?.layout?.selectedNoteIndex === 1, 'touch down selects next note');
  await sleep(700); await phone('down'); await sleep(100); await phone('down');
  await wait(s => s.client?.view?.layout?.selectedNoteIndex === null, 'double-down returns to newest');
  proof.push('PASS touch up/down uses same selection; double-down returns to newest');
  await event('click');
  const stopped = await wait(s => s.client?.micOn === false && s.listening === false, 'select stops mic and hub');
  assert.ok(stopped.client.micStarts === 1 && stopped.client.micStops >= 1);
  assert.ok(stopped.calls.some(c => c.path === '/api/listen/chunk' && c.bytes === 288_000));
  assert.ok(!stopped.client.diagnostics.some(name => /listen\.frame[.-](failed|deadline)/.test(name)), 'No renderer failure or deadline diagnostics');
  proof.push('PASS PCM16 fake chunk uploaded through HTTP; select stops fake microphone and hub session');
  const logs = await request(`http://127.0.0.1:${port}/api/console`).then(r => r.json());
  await writeFile(path.join(work, 'console.json'), JSON.stringify(logs));
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /\[uncaught\]|\[unhandledrejection\]|listen\.frame[.-](failed|deadline)/i, 'No uncaught or frame failures');
  proof.push('PASS no uncaught JavaScript errors or SDK frame failures');
} finally {
  if (hub) {
    try { await writeFile(path.join(work, 'last-state.json'), JSON.stringify(await state(), null, 2)); } catch {}
    try { await writeFile(path.join(work, 'console.json'), JSON.stringify(await request(`http://127.0.0.1:${port}/api/console`).then(r => r.json()), null, 2)); } catch {}
  }
  // Exact executable match only. Never kill by generic app name or use GUI quit.
  if (!nativePids.length) nativePids = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.trim().split(/\s+/, 2)[1] === executable).map(line => Number(line.trim().split(/\s+/)[0]));
  for (const pid of nativePids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  launcher?.kill();
  await vite?.close(); await hub?.close();
  proof.push('CLEANUP owned simulator process and loopback fixture servers only');
  await writeFile(path.join(output, 'proof.txt'), proof.join('\n') + '\n');
}
console.log(proof.join('\n'));
