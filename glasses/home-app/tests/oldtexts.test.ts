import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, recentChats, recentMessages, type Chat, type ChatMessage, type HomeData } from '../src/model.ts';
import { tileChats, widgetFor, DEFAULT_LAYOUT, type Layout, type TileContext } from '../src/tiles.ts';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const H = 3600;
const chat = (id: number, hoursAgo: number, over: Partial<Chat> = {}): Chat => ({ id, name: `Chat ${id}`, unread: false, when: NOW / 1000 - hoursAgo * H, snippet: `snippet ${id}`, fromMe: false, ...over });
const msg = (hoursAgo: number, text: string): ChatMessage => ({ from: 'Mom', fromMe: false, when: NOW / 1000 - hoursAgo * H, text });
const base = (messages: Chat[] | null): HomeData => ({ now: NOW, paused: false, machines: [], sessions: [], pending: [], messages, muse: false });

test('recentChats: 23 h shown, 25 h hidden, setting off shows everything', () => {
  const chats = [chat(1, 23), chat(2, 25), chat(3, 1)];
  assert.deepEqual(recentChats(chats, NOW, true).map(c => c.id), [1, 3]);
  assert.deepEqual(recentChats(chats, NOW, false).map(c => c.id), [1, 2, 3]);
});

test('recentMessages: older than 24 h hidden but the newest is kept, with a note', () => {
  const mixed = [msg(1, 'new'), msg(30, 'old')];
  assert.deepEqual(recentMessages(mixed, NOW, true), { messages: [mixed[0]], hidden: true });
  const quiet = [msg(30, 'last'), msg(50, 'older')];
  assert.deepEqual(recentMessages(quiet, NOW, true), { messages: [quiet[0]], hidden: true });
  assert.deepEqual(recentMessages([msg(2, 'a'), msg(5, 'b')], NOW, true).hidden, false);
  assert.deepEqual(recentMessages(mixed, NOW, false), { messages: mixed, hidden: false });
});

test('home summary, Messages list and open chat hide old texts (and say so)', () => {
  const m = new HomeModel();
  m.update(base([chat(1, 1, { unread: true }), chat(2, 30, { unread: true })]));
  assert.match(m.render(NOW), /Messages · 1 new · Chat 1: snippet 1/);
  m.hideOldTexts = false;
  assert.match(m.render(NOW), /Messages · 2 new/);
  m.hideOldTexts = true;
  m.goTo('messages');
  assert.match(m.render(NOW), /Chat 1/);
  assert.doesNotMatch(m.render(NOW), /Chat 2/);
  m.setChat([msg(1, 'fresh'), msg(40, 'ancient')], NOW);
});

test('open chat: old messages are dropped, the newest stays, a note says older ones are hidden', () => {
  const m = new HomeModel();
  m.update(base([chat(7, 1)]));
  m.openTarget({ kind: 'chat', id: 7, name: 'Chat 7' });
  m.setChat([msg(1, 'fresh'), msg(40, 'ancient')], NOW);
  const text = m.render(NOW);
  assert.match(text, /fresh/);
  assert.doesNotMatch(text, /ancient/);
  assert.match(text, /\(older messages hidden\)/);
  m.setChat([msg(40, 'only old'), msg(60, 'older')], NOW);
  assert.match(m.render(NOW), /only old/);
});

test('a new text still pops up with the setting on (model.data stays unfiltered)', () => {
  const m = new HomeModel();
  m.update(base([chat(7, 30, { unread: false })]));
  assert.equal(m.hideOldTexts, true);
  m.update(base([chat(7, 0, { unread: true, snippet: 'Call me' })]));
  assert.equal(m.screenKind, 'alert');
  assert.equal(m.data?.messages?.length, 1);
});

test('chat:recent with nothing recent says so', () => {
  const ctx = { data: { ...base([]) }, now: NOW, terminal: () => null, chat: () => null, muse: () => null, reminders: () => null, url: () => null } as TileContext;
  assert.deepEqual(widgetFor('chat:recent').body(ctx, 27), ['No recent chats.']);
});

test('a chat pinned by id keeps its last message and the note when it is 25 h old; chat:recent and the list skip it', () => {
  const layout: Layout = { pages: [{ left: 'chat:7', right: 'messages' }, ...DEFAULT_LAYOUT.pages.slice(1)] };
  const chats = [chat(7, 25, { name: 'Wife' }), chat(8, 30), chat(9, 2)];
  const shown = tileChats(chats, layout, NOW, true);
  assert.deepEqual(shown.map(c => [c.id, Boolean(c.old)]), [[7, true], [9, false]]); // 8 is old and not pinned: gone
  assert.deepEqual(tileChats(chats, layout, NOW, false), chats);
  const lines = (() => { const r = recentMessages([msg(25, 'last text'), msg(40, 'older one')], NOW, true); return [...(r.hidden ? ['(older messages hidden)'] : []), ...r.messages.map(m => m.text)]; })();
  const ctx = { data: { ...base(shown) }, now: NOW, terminal: () => null, chat: () => lines, muse: () => null, reminders: () => null, url: () => null } as TileContext;
  assert.equal(widgetFor('chat:7').title(ctx), 'Wife');
  assert.deepEqual(widgetFor('chat:7').body(ctx, 27), ['(older messages hidden)', 'last text']);
  assert.equal(widgetFor('chat:recent').title(ctx), 'Chat 9');
  assert.ok(!widgetFor('messages').body(ctx, 27).join('\n').includes('Wife'));
  const onlyPinned = { ...ctx, data: { ...base(tileChats([chat(7, 25)], layout, NOW, true)) } } as TileContext;
  assert.deepEqual(widgetFor('chat:recent').body(onlyPinned, 27), ['No recent chats.']);
});
