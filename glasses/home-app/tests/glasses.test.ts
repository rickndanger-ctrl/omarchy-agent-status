import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glassesSafe } from '../src/glasses.ts';

test('only characters the glasses can draw reach them', () => {
  assert.equal(glassesSafe('Done ✅ 🎉 — “nice” café · ▲ older'), "Done   - \"nice\" café · ▲ older");
  assert.equal(glassesSafe('⏺ pong\n│ table │\t'), ' pong\n│ table │  ');
  assert.equal(glassesSafe('中文 ﬁx'), ' fix');
});
