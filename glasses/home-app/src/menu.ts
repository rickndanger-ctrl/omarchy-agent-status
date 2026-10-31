// The glasses long-press menu. The Even SDK refuses a startup page with more than 10 items (TOO_MANY_MENU_ITEMS), and
// then the app does not start at all, so main.ts takes the list from here and a test checks the limit.
export const MENU = { pause: 2, home: 4, agents: 5, messages: 6, muse: 7, tiles: 8, tilesOn: 9, editPage: 10, hideOldTexts: 1 };
/** Not in the glasses menu (the SDK allows 10 items): the phone remote's "settings" button arrives through the queue as this id. */
export const INTERNAL_MENU = { settings: 12 };
export const GLASSES_MENU_MAX = 10;
export const GLASSES_MENU: { id: number; name: string }[] = [
  { id: MENU.home, name: 'Home' },
  { id: MENU.agents, name: 'Agents' },
  { id: MENU.messages, name: 'Messages' },
  { id: MENU.muse, name: 'Muse' },
  { id: MENU.tiles, name: 'Tiles' },
  { id: MENU.tilesOn, name: 'Start in Tiles' },
  { id: MENU.editPage, name: 'Edit page' },
  { id: MENU.hideOldTexts, name: 'Hide old texts on/off' },
  { id: MENU.pause, name: 'Pause/resume approvals' },
];

/** The phone page's "Hide finished agents" checkbox (it used to be a glasses menu item): flips the model and remembers it. */
export function setHideDone(model: { hideDone: boolean }, store: { set(key: string, value: string): void }, on: boolean): void {
  model.hideDone = on;
  store.set('home.hideDone', on ? '1' : '0');
}
