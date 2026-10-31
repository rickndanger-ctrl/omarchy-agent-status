// Loopback-only fake contract server. No hub, relay, transcription or microphone access.
import http from 'node:http';

export const STARTED_AT = 1_700_000_000_000;
export const NOW = STARTED_AT + 154_000;
export const FIXTURE = {
  id: 'simulator-session', state: 'listening', startedAt: STARTED_AT, now_t: 154_000,
  lines: [
    { t: 0, text: 'We need a simple plan for the community garden.' },
    { t: 12_000, text: 'First, measure the sunny corner beside the gate.' },
    { t: 45_000, text: 'Let us compare the cost of two raised beds.' },
    { t: 60_000, text: 'Reclaimed wood could reduce the material cost.' },
    { t: 90_000, text: 'Saturday is best for collecting the materials.' },
    { t: 110_000, text: 'We should ask two volunteers to bring tools.' },
    { t: 135_000, text: 'Then we can share the final plan with everyone.' },
    { t: 150_000, text: 'The next step is checking the measurements.' },
  ],
  notes: [
    { t: 50_000, at_t: 45_000, text: 'Compare both bed sizes before buying wood.' },
    { t: 100_000, at_t: 90_000, text: 'Confirm Saturday pickup and who can bring tools.' },
  ], muse: { state: 'idle' },
};

export async function startFakeHub() {
  let listening = false, seq = 0, client = null;
  const calls = [], inputs = [], waiters = new Set();
  const reply = (res, body, status = 200) => {
    if (!res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) { reply(res, { error: 'Fixture body too large' }, 413); return; } chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    let body = {};
    try { if (bytes.length && req.headers['content-type']?.includes('application/json')) body = JSON.parse(bytes.toString()); }
    catch { reply(res, { error: 'Invalid fixture JSON' }, 400); return; }
    if (url.pathname === '/fixture/client') {
      if (req.method === 'POST') client = body;
      reply(res, { client, listening, waiting: waiters.size > 0, calls }); return;
    }
    if (url.pathname === '/fixture/state') { reply(res, { client, listening, waiting: waiters.size > 0, calls }); return; }
    if (!url.pathname.startsWith('/api/listen') && !url.pathname.startsWith('/api/input')) { reply(res, { error: 'Not a fixture endpoint' }, 404); return; }
    calls.push({ method: req.method, path: url.pathname, seq: url.searchParams.get('seq'), bytes: bytes.length });
    if (url.pathname === '/api/listen/start' && req.method === 'POST') {
      listening = true; reply(res, { id: FIXTURE.id, startedAt: STARTED_AT }); return;
    }
    if (url.pathname === '/api/listen/stop' && req.method === 'POST') {
      listening = false; reply(res, { ok: true }); return;
    }
    if (url.pathname === '/api/listen/chunk' && req.method === 'POST') { reply(res, { ok: true, lines: [] }); return; }
    if (url.pathname === '/api/listen' && req.method === 'GET') {
      reply(res, { ...FIXTURE, state: listening ? 'listening' : 'stopped' }); return;
    }
    if (url.pathname === '/api/input' && req.method === 'POST') {
      if (!['up', 'down', 'select', 'back', 'settings'].includes(body.input)) { reply(res, { error: 'Invalid input' }, 400); return; }
      const delivered = waiters.size > 0;
      inputs.push({ input: body.input, seq: ++seq, at: Date.now() });
      for (const wake of [...waiters]) wake();
      reply(res, { ok: true, delivered, seq }); return;
    }
    if (url.pathname === '/api/input/wait' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || seq;
      let timer;
      const wake = () => {
        const available = inputs.filter(x => x.seq > after);
        if (!available.length) return;
        clearTimeout(timer); waiters.delete(wake); reply(res, { seq, inputs: available });
      };
      waiters.add(wake);
      timer = setTimeout(() => { waiters.delete(wake); reply(res, { seq, inputs: [] }); }, 1000);
      res.on('close', () => { clearTimeout(timer); waiters.delete(wake); });
      wake(); return;
    }
    reply(res, { error: 'Not a fixture endpoint' }, 404);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
