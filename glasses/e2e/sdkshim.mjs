// Stands in for @evenrealities/even_hub_sdk for src/glasses.ts only: the real exports plus a fake bridge (taps are injected by the driver).
export * from '../home-app/node_modules/@evenrealities/even_hub_sdk/dist/index.js';
export const fakeBridge = globalThis.__fakeBridge ??= { handlers: [], calls: [], drawn: [] };
const textsOf = c => (c?.textObject ?? []).map(t => t.content ?? '').join('\n');
export const waitForEvenAppBridge = async () => ({
  onEvenHubEvent: h => { fakeBridge.handlers.push(h); return () => {}; },
  onDeviceStatusChanged: () => () => {},
  getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
  createStartUpPageContainer: async c => { fakeBridge.drawn.push({ at: Date.now(), kind: 'startup', text: textsOf(c) }); return 0; },
  rebuildPageContainer: async c => { fakeBridge.calls.push('rebuild'); fakeBridge.drawn.push({ at: Date.now(), kind: 'rebuild', text: textsOf(c) }); return true; },
  textContainerUpgrade: async u => { fakeBridge.calls.push('upgrade'); fakeBridge.drawn.push({ at: Date.now(), kind: 'upgrade', text: u?.content ?? '' }); return true; },
  audioControl: async () => true, shutDownPageContainer: async () => true, imuControl: async () => true,
});
