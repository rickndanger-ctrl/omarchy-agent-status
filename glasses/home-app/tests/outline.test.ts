// Tile outlines: both tiles always have a border, faint for the unlit one and full brightness for the lit one; a focus change is one page rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StartUpPageCreateResult, validateEvenHubPageContainer, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Glasses, DEFAULT_OUTLINE, OUTLINE_FULL } from '../src/glasses';
import { GLASSES_MENU } from '../src/menu';

type Box = { containerName: string; borderWidth: number; borderColor: number };
function setup() {
  const pages: Box[][] = [];
  const upgrades: unknown[] = [];
  const invalid: unknown[] = [];
  const grab = (c: { textObject?: Box[] }) => {
    const r = validateEvenHubPageContainer(c as Parameters<typeof validateEvenHubPageContainer>[0]);
    if (!('valid' in r) || r.valid) { pages.push((c.textObject ?? []).map(t => ({ containerName: t.containerName, borderWidth: t.borderWidth, borderColor: t.borderColor }))); return true; }
    invalid.push(c);
    return false;
  };
  const bridge = {
    onEvenHubEvent: () => () => {}, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async (c: never) => (grab(c) ? StartUpPageCreateResult.success : StartUpPageCreateResult.invalid),
    rebuildPageContainer: async (c: never) => grab(c),
    textContainerUpgrade: async (u: unknown) => { upgrades.push(u); return true; },
    audioControl: async () => true, shutDownPageContainer: async () => true,
  } as unknown as EvenAppBridge;
  const g = new Glasses({ onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, bridge: async () => bridge }, GLASSES_MENU);
  return { g, pages, upgrades, invalid };
}

test('both tiles have an outline: faint when unlit (also at page level), full brightness when lit; every page passes the SDK validation', async () => {
  const { g, pages, invalid } = setup();
  try {
    await g.connect();
    const at = async (focus: 'page' | 'choose-left' | 'choose-right' | 'left' | 'right') => {
      g.setTiles('p1', focus, `l ${focus}`, `r ${focus}`);
      assert.equal(await g.settled(5000), 'rendered', focus);
      return pages.at(-1)!;
    };
    let [l, r] = await at('page');
    assert.deepEqual([l.borderWidth, l.borderColor, r.borderWidth, r.borderColor], [1, DEFAULT_OUTLINE, 1, DEFAULT_OUTLINE], 'page level: both faint');
    [l, r] = await at('choose-left');
    assert.deepEqual([l.borderWidth, l.borderColor, r.borderWidth, r.borderColor], [1, OUTLINE_FULL, 1, DEFAULT_OUTLINE]);
    [l, r] = await at('left');
    assert.deepEqual([l.borderWidth, l.borderColor, r.borderWidth, r.borderColor], [2, OUTLINE_FULL, 1, DEFAULT_OUTLINE], 'inside the left tile');
    [l, r] = await at('right');
    assert.deepEqual([l.borderWidth, l.borderColor, r.borderWidth, r.borderColor], [1, DEFAULT_OUTLINE, 2, OUTLINE_FULL]);
    assert.ok(DEFAULT_OUTLINE < OUTLINE_FULL && DEFAULT_OUTLINE >= 1);
    assert.deepEqual(invalid, []);
  } finally { g.dispose(); }
});

test('the outline slider changes the faint level (clamped 1..15); a focus change is exactly one rebuild and text changes never rebuild', async () => {
  const { g, pages, upgrades } = setup();
  try {
    await g.connect();
    g.setTiles('p1', 'page', 'a', 'b');
    await g.settled(5000);
    g.setOutline(9);
    await g.settled(5000);
    assert.equal(pages.at(-1)![1].borderColor, 9);
    g.setOutline(99);
    await g.settled(5000);
    assert.equal(pages.at(-1)![1].borderColor, OUTLINE_FULL);
    g.setOutline(0);
    await g.settled(5000);
    assert.equal(pages.at(-1)![1].borderColor, 1, 'never invisible');
    const before = pages.length;
    g.setTiles('p1', 'choose-left', 'a', 'b');
    await g.settled(5000);
    assert.equal(pages.length, before + 1, 'a focus change = one rebuildPageContainer');
    g.setTiles('p1', 'choose-left', 'a2', 'b');
    await g.settled(5000);
    assert.equal(pages.length, before + 1, 'a text change does not rebuild');
    assert.equal(upgrades.length, 1);
  } finally { g.dispose(); }
});
