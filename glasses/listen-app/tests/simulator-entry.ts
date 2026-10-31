// Separate fixture entry: production entry never imports this module.
import { createListenApp } from '../src/main';
import { ListenHub } from '../src/hub';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

const base = new URL(new URLSearchParams(location.search).get('hub') ?? '');
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) throw new Error('Fixture requires a loopback hub');
let micOn = false, micStarts = 0, micStops = 0, injected = false;
const fixtureStart = Date.now();
const diagnostics: string[] = [];
const events: unknown[] = [];
const app = createListenApp({
  hub: () => new ListenHub({ url: base.href, token: 'synthetic-fixture-token' }),
  mount: document.getElementById('app')!,
  bridge: async () => {
    const sdk = await waitForEvenAppBridge();
    sdk.onEvenHubEvent(event => {
      if (!event.audioEvent && events.length < 32) events.push({ sysEvent: event.sysEvent, textEvent: event.textEvent, listEvent: event.listEvent });
    });
    return sdk;
  },
  now: () => 1_700_000_154_000 + Date.now() - fixtureStart,
  mic: {
    on: async () => { micOn = true; micStarts++; return true; },
    off: async () => { micOn = false; micStops++; return true; },
  },
  diag: (name: string) => { diagnostics.push(name); },
});
const connected = await app.connect();
let reporting = false;
setInterval(async () => {
  if (reporting) return;
  reporting = true;
  try {
    if (micOn && !injected) { injected = true; app.onAudio(new Uint8Array(288_000)); }
    await fetch(new URL('fixture/client', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected, micOn, micStarts, micStops, view: app.view(), diagnostics, events }),
    });
  } finally { reporting = false; }
}, 250);
