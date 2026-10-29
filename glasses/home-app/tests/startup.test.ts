// Startup smoke test. The Even SDK refuses a startup page that breaks its rules (for example more than 10 menu items:
// TOO_MANY_MENU_ITEMS), and then G2 OMAC does not start at all. This boots the real Glasses transport against a fake
// bridge that applies the SDK's own validateEvenHubPageContainer to every page the app builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  StartUpPageCreateResult, validateEvenHubPageContainer, formatEvenHubPageContainerValidationError,
  isValidMenuItemID, isMenuNameWithinLimit, type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { GLASSES_MENU, GLASSES_MENU_MAX, MENU } from '../src/menu';

test('the long-press menu has at most 10 items, valid unique ids and names', () => {
  assert.ok(GLASSES_MENU.length <= GLASSES_MENU_MAX, `${GLASSES_MENU.length} items`);
  assert.equal(new Set(GLASSES_MENU.map(m => m.id)).size, GLASSES_MENU.length);
  for (const m of GLASSES_MENU) {
    assert.ok(isValidMenuItemID(m.id), `id ${m.id}`);
    assert.ok(isMenuNameWithinLimit(m.name), `name ${m.name}`);
  }
  assert.deepEqual(Object.values(MENU).sort((a, b) => a - b), GLASSES_MENU.map(m => m.id).sort((a, b) => a - b)); // nothing in MENU is missing from the menu
});

test('main.ts builds the glasses with that menu list', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(src, /\}, GLASSES_MENU\);/);
});

/** A bridge that checks every page like the Even app's SDK does. `errors` collects what it would have refused. */
function fakeBridge(errors: string[], pages: string[]) {
  const check = (kind: string, container: unknown) => {
    const result = validateEvenHubPageContainer(container as Parameters<typeof validateEvenHubPageContainer>[0]);
    if (!('valid' in result) || result.valid) { pages.push(kind); return true; }
    errors.push(`${kind}: ${formatEvenHubPageContainerValidationError(result)}`);
    return false;
  };
  return {
    onEvenHubEvent: () => () => {}, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async (c: unknown) => (check('startup', c) ? StartUpPageCreateResult.success : StartUpPageCreateResult.invalid),
    rebuildPageContainer: async (c: unknown) => check('rebuild', c),
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
  } as unknown as EvenAppBridge;
}

async function boot(menu: { id: number; name: string }[]) {
  const errors: string[] = []; const pages: string[] = []; const statuses: string[] = [];
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onStatus: s => statuses.push(s), onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    bridge: async () => fakeBridge(errors, pages),
  }, menu);
  const connected = await g.connect();
  return { g, connected, errors, pages, statuses };
}

test('startup reaches the first glasses frame, and every page it builds (single and all tile focuses) passes the SDK validation', async () => {
  const { g, connected, errors, pages, statuses } = await boot(GLASSES_MENU);
  try {
    assert.deepEqual(errors, []);
    assert.equal(connected, true, statuses.join(' | '));
    assert.equal(statuses.at(-1), 'G2 OMAC is showing on your glasses.');
    assert.deepEqual(pages, ['startup']);
    // Every page shape main.ts can ask for: full-screen text, then Tiles at each focus (each focus change rebuilds the page).
    g.setText('HOME\n\nAgents');
    for (const focus of ['page', 'choose-left', 'choose-right', 'left', 'right'] as const) {
      g.setTiles('p1', focus, 'left tile', 'right tile');
      assert.equal(await g.settled(5000), 'rendered', focus);
    }
    g.setText('back to home');
    assert.equal(await g.settled(5000), 'rendered');
    assert.deepEqual(errors, []);
    assert.ok(pages.filter(p => p === 'rebuild').length >= 5);
  } finally { g.dispose(); }
});

test('the harness catches the 0.4.9 failure: 11 menu items are refused and the app reports it', async () => {
  const { g, connected, errors, statuses } = await boot([...GLASSES_MENU, { id: 11, name: 'Listen' }]);
  try {
    assert.equal(connected, false);
    assert.match(errors.join(' '), /TOO_MANY_MENU_ITEMS|11 menuItems/);
    assert.match(statuses.at(-1) ?? '', /Glasses display .* failed/);
  } finally { g.dispose(); }
});
