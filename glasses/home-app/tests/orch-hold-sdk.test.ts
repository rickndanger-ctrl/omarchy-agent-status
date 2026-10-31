import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OsEventTypeList, StartUpPageCreateResult, validateEvenHubPageContainer,
  type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { GLASSES_MENU, MENU } from '../src/menu';
import type { Input } from '../src/model';

async function rig(withHold = true) {
  const inputs: Input[] = [], menus: number[] = [], holds: number[] = [];
  const handlers: ((event: EvenHubEvent) => void)[] = [];
  const bridge = {
    onEvenHubEvent: (handler: (event: EvenHubEvent) => void) => { handlers.push(handler); return () => {}; },
    onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async (page: Parameters<typeof validateEvenHubPageContainer>[0]) => {
      const check = validateEvenHubPageContainer(page);
      assert.ok(!('valid' in check) || check.valid);
      return StartUpPageCreateResult.success;
    },
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
  } as unknown as EvenAppBridge;
  const glasses = new Glasses({
    onInput: input => inputs.push(input), onMenu: id => menus.push(id),
    onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    ...(withHold ? { onLongPress: () => { holds.push(Date.now()); } } : {}),
    bridge: async () => bridge,
  }, GLASSES_MENU);
  assert.equal(await glasses.connect(), true);
  const emit = (eventType: OsEventTypeList) => handlers.at(-1)!({ sysEvent: { eventType } } as EvenHubEvent);
  return { glasses, handlers, inputs, menus, holds, emit };
}

test('SDK long press is separate from taps and fires once per physical press across duplicate envelopes', async () => {
  const r = await rig();
  try {
    r.handlers[0]({
      sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT },
      textEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT },
    } as EvenHubEvent);
    r.emit(OsEventTypeList.LONG_PRESS_EVENT);
    r.emit(OsEventTypeList.CLICK_EVENT);
    assert.equal(r.holds.length, 1);
    assert.deepEqual(r.inputs, []);
    r.emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    r.emit(OsEventTypeList.LONG_PRESS_EVENT);
    assert.equal(r.holds.length, 2);
    r.emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    r.emit(OsEventTypeList.CLICK_EVENT);
    assert.deepEqual(r.inputs, ['select']);
  } finally { r.glasses.dispose(); }
});

test('quiet-window or background hold never dispatches, but its release still clears tap suppression', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const r = await rig();
  try {
    r.emit(OsEventTypeList.FOREGROUND_EXIT_EVENT);
    r.emit(OsEventTypeList.LONG_PRESS_EVENT);
    r.emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    assert.deepEqual(r.holds, []);
    r.emit(OsEventTypeList.FOREGROUND_ENTER_EVENT);
    r.emit(OsEventTypeList.LONG_PRESS_EVENT);
    r.emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    assert.deepEqual(r.holds, []);
    context.mock.timers.tick(1001);
    r.emit(OsEventTypeList.CLICK_EVENT);
    assert.deepEqual(r.inputs, ['select']);
    r.emit(OsEventTypeList.LONG_PRESS_EVENT);
    assert.equal(r.holds.length, 1);
  } finally { r.glasses.dispose(); }
});

test('an omitted hold callback keeps the existing long-press suppression and menu choices', async () => {
  const r = await rig(false);
  try {
    r.emit(OsEventTypeList.LONG_PRESS_EVENT);
    r.emit(OsEventTypeList.CLICK_EVENT);
    r.handlers[0]({ menuItemClickEvent: { itemID: MENU.home } } as EvenHubEvent);
    assert.deepEqual(r.inputs, []);
    assert.deepEqual(r.menus, [MENU.home]);
    r.emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    r.emit(OsEventTypeList.CLICK_EVENT);
    assert.deepEqual(r.inputs, ['select']);
  } finally { r.glasses.dispose(); }
});

test('callbacks belonging to a disposed SDK connection cannot dispatch new presses or holds', async () => {
  const r = await rig();
  r.glasses.dispose();
  r.emit(OsEventTypeList.CLICK_EVENT);
  r.emit(OsEventTypeList.LONG_PRESS_EVENT);
  assert.deepEqual(r.inputs, []);
  assert.deepEqual(r.holds, []);
});
