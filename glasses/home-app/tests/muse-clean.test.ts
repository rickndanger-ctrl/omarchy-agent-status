// The shared chrome cutter (glasses/muse-clean.mjs): the hub and the app use the SAME file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeMuseReply, NO_TEXT } from '../../muse-clean.mjs';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');

test('variant 2 (Status / Approvals history / Fill saved credentials / Allowed once · … / Allow access to …) is cut back over its header', () => {
  const r = sanitizeMuseReply(fixture('muse-chrome2.txt'));
  assert.equal(r.text, 'Got it — test received.');
  assert.equal(r.anchor, 'Approvals history');
  assert.ok(r.trimmed > 100);
});

test('the earlier variant (Muse / Connected / Approvals history / …) is cut back over Muse and Connected', () => {
  const r = sanitizeMuseReply(fixture('muse-polluted.txt'));
  assert.equal(r.text, 'Yes, I can hear you. The connection looks good and everything is coming through fine.');
});

test('an answer followed by "Status" alone, one anchor alone, or a real sentence is kept whole', () => {
  for (const text of [
    'The build is green.\nStatus\n',
    'Approvals history\nNo approvals are pending.\n',
    'Approvals history shows two pending requests.\nAllow access to your calendar only after you review it.\nPlace this order? No, compare prices first.\n',
    'Allow access to your calendar only after you review it.',
    'Muse is a good name for it.',
    'Allowed once · 2h ago is how the row reads.',
  ]) assert.deepEqual(sanitizeMuseReply(text), { text, trimmed: 0, anchor: '' }, text);
});

test('the second anchor must follow within 6 lines', () => {
  const near = ['Answer.', 'Status', 'Approvals history', 'a', 'b', 'c', 'd', 'e', 'Allowed · 1h ago'].join('\n'); // second anchor 6 lines after the first
  assert.equal(sanitizeMuseReply(near).text, 'Answer.');
  const far = ['Answer.', 'Status', 'Approvals history', 'a', 'b', 'c', 'd', 'e', 'f', 'Allowed · 1h ago'].join('\n'); // 7 lines after: not chrome
  assert.equal(sanitizeMuseReply(far).trimmed, 0);
});

test('a PARTIAL reply: one anchor is enough (the chrome may be half typed); the final reply keeps the strict two-anchor rule', () => {
  const partial = 'Got it — test received.\nStatus\nApprovals history\n';
  assert.equal(sanitizeMuseReply(partial, { partial: true }).text, 'Got it — test received.');
  assert.equal(sanitizeMuseReply(partial).trimmed, 0, 'a final reply with one anchor is just text');
  // mid-chrome while streaming
  const mid = 'Answer\nStatus\nApprovals history\nFill sav';
  assert.equal(sanitizeMuseReply(mid, { partial: true }).text, 'Answer');
  assert.equal(sanitizeMuseReply(mid).trimmed, 0, 'the same text as a FINAL reply is kept whole');
  // a real sentence hidden while streaming comes back in the final
  const sentence = 'Allow access to [site]';
  assert.equal(sanitizeMuseReply(`Please note: ${sentence}`, { partial: true }).trimmed, 0, 'not at line start: not an anchor');
  assert.equal(sanitizeMuseReply(`Text.\n${sentence}`, { partial: true }).text, 'Text.');
  assert.equal(sanitizeMuseReply(`Text.\n${sentence}`).text, `Text.\n${sentence}`);
  assert.equal(sanitizeMuseReply('Almost there', { partial: true }).trimmed, 0);
});


test('review: only the exact headings are walked back over; a real "Yes"/"Done" line above them stays', () => {
  const r = sanitizeMuseReply('Yes\nStatus\nApprovals history\nAllowed · 1h ago');
  assert.equal(r.text, 'Yes');
  assert.equal(sanitizeMuseReply('Done\n\nMuse\nConnected\nApprovals history\nAllowed once · 2h ago').text, 'Done');
  assert.equal(sanitizeMuseReply('Status\nApprovals history\nAllowed · 1h ago').text, 'Status', 'the reply\'s first line is never walked back over (a one-word answer stays)');
  assert.equal(sanitizeMuseReply('Approvals history\nAllowed · 1h ago').text, NO_TEXT, 'an all-chrome final reply becomes the note, never the chrome');
  assert.equal(sanitizeMuseReply('Approvals history\nAllowed · 1h ago', { partial: true }).text, '', 'while streaming it is just empty so far');
  assert.equal(sanitizeMuseReply('Okay then\nApprovals history\nAllowed · 1h ago').text, 'Okay then', 'a Title-case line that is not a heading is kept');
});

test('review: prefix anchors must look like chrome labels, not prose', () => {
  const prose = 'Allow access to your calendar only after reviewing it.\nAllowed · 1h ago';
  assert.equal(sanitizeMuseReply(prose).trimmed, 0, 'one real anchor alone is not enough; the sentence is not an anchor');
  const prose2 = 'Fill saved credentials only when you trust the site, then continue.\nApprovals history\nAllowed · 2d ago';
  assert.equal(sanitizeMuseReply(prose2).text, 'Fill saved credentials only when you trust the site, then continue.');
  const labels = 'Answer.\nAllow access to [site]\nShare a one-time code in Browser\nAllowed once · 3h ago';
  assert.equal(sanitizeMuseReply(labels).text, 'Answer.');
  assert.equal(sanitizeMuseReply('Answer.\nFill saved credentials in Browser\nAllowed · 5m ago').text, 'Answer.');
});

test('PARTIAL: an unfinished label at the very end counts as an anchor; a real answer with one anchor-like line is hidden while streaming and whole in the final', () => {
  assert.equal(sanitizeMuseReply('Answer\nStatus\nFill sav', { partial: true }).text, 'Answer');
  assert.equal(sanitizeMuseReply('Answer\nStatus\nFill sav').trimmed, 0, 'final: kept');
  assert.equal(sanitizeMuseReply('Answer\nApprovals his', { partial: true }).text, 'Answer');
  assert.equal(sanitizeMuseReply('Fine so far\nAllo', { partial: true }).text, 'Fine so far', 'any length of an unfinished anchor is hidden while streaming');
  assert.equal(sanitizeMuseReply('Fine so far\nAllo').trimmed, 0, 'the final reply shows it again');
  assert.equal(sanitizeMuseReply('Not a prefix: Share the code', { partial: true }).trimmed, 0);
  const real = 'Your settings are ready.\nAllow access to [site]\nand then you are done.';
  assert.equal(sanitizeMuseReply(real, { partial: true }).text, 'Your settings are ready.', 'hidden while streaming');
  assert.equal(sanitizeMuseReply(real).text, real, 'whole in the final reply');
});

test('review: a FINAL reply needs a STRONG anchor in the block; two label anchors alone (a real answer listing two buttons) are kept, while streaming they still cut', () => {
  const real = 'You can try these:\nAllow access to [site]\nShare a one-time code in Browser\nThen come back.';
  assert.equal(sanitizeMuseReply(real).text, real, 'final: kept whole');
  assert.equal(sanitizeMuseReply(real, { partial: true }).text, 'You can try these:', 'streaming: hidden');
  const withStamp = 'Answer.\nAllow access to [site]\nShare a one-time code in Browser\nAllowed once · 3h ago';
  assert.equal(sanitizeMuseReply(withStamp).text, 'Answer.', 'a timestamp row in the block makes it chrome');
  const withHeading = 'Answer.\nAllow access to [site]\nApprovals history';
  assert.equal(sanitizeMuseReply(withHeading).text, 'Answer.', 'so does the exact heading');
});

test('review: a one-word answer that is also a heading ("Status") is never rolled back, even with chrome after it', () => {
  assert.equal(sanitizeMuseReply('Status\nApprovals history\nAllowed · 1h ago').text, 'Status');
  assert.equal(sanitizeMuseReply('\n\nMuse\nConnected\nApprovals history\nAllowed · 1h ago').text, '\n\nMuse', 'everything before the cut stays as it was; the first real line is not rolled back');
  assert.equal(sanitizeMuseReply('Fine.\nStatus\nApprovals history\nAllowed · 1h ago').text, 'Fine.', 'a heading below the first line still goes');
});

test('streaming: trailing exact headings and an unfinished anchor of ANY length are hidden; the final shows them if real; the first line is never hidden', () => {
  const p = (t: string) => sanitizeMuseReply(t, { partial: true }).text;
  assert.equal(p('Answer\nStatus\nApp'), 'Answer');
  assert.equal(p('Answer\nStatus'), 'Answer');
  assert.equal(p('Answer\nStatus\nMuse'), 'Answer');
  assert.equal(p('Answer\nA'), 'Answer');
  assert.equal(p('Answer\n\nStatus\n'), 'Answer');
  assert.equal(p('Status'), 'Status', 'a reply that is only a heading keeps its first line');
  assert.equal(p('A'), 'A');
  assert.equal(p('Answer\nStatus: green'), 'Answer\nStatus: green', 'not an exact heading');
  assert.equal(sanitizeMuseReply('Answer\nStatus').text, 'Answer\nStatus', 'final: shown again');
  assert.equal(sanitizeMuseReply('Answer\nStatus\nApp').text, 'Answer\nStatus\nApp');
  // a final reply that is ONLY chrome is cut to empty (correct)
  assert.equal(sanitizeMuseReply('Approvals history\nAllowed once · 2h ago').text, NO_TEXT);
});

test('streaming (frozen rule): an unfinished last line that is a prefix of a heading or of a timestamp row is hidden; the first line and the final reply are untouched', () => {
  const p = (t: string) => sanitizeMuseReply(t, { partial: true }).text;
  assert.equal(p('Answer\nSta'), 'Answer');
  assert.equal(p('Answer\nMu'), 'Answer');
  assert.equal(p('Answer\nConn'), 'Answer');
  assert.equal(p('Answer\nAllowed once · 2h'), 'Answer');
  assert.equal(p('Answer\nAllowed'), 'Answer');
  assert.equal(p('Answer\nAllowed once'), 'Answer');
  assert.equal(p('Answer\nStatus\nAllowed once · 2h'), 'Answer', 'with a heading above');
  assert.equal(p('Sta'), 'Sta', 'never the first line');
  assert.equal(p('Answer\nStatus is fine'), 'Answer\nStatus is fine', 'a sentence that merely starts like a heading stays');
  assert.equal(sanitizeMuseReply('Answer\nSta').text, 'Answer\nSta', 'final unchanged');
  assert.equal(sanitizeMuseReply('Answer\nAllowed once · 2h').text, 'Answer\nAllowed once · 2h', 'final unchanged');
});

// ---- the Mini hot patch (muse-clean.hotpatch.mjs): every real variant it handles must pass here ----
test('hot-patch variants: Status + Fill saved credentials + Allowed once, the earlier Muse/Connected/Approvals history block, headings above', () => {
  const cases: [string, string][] = [
    ['Okay.\nStatus\nFill saved credentials in Browser\nThe agent wants to sign in to [site] using your saved login de…\nAllowed once · 2h ago', 'Okay.'],
    ['Got it.\nStatus\nApprovals history\nFill saved credentials in Browser\nAllowed once · 19h ago', 'Got it.'],
    ['Yes.\nMuse\nConnected\nApprovals history\nShare a one-time code in Browser\nPlace this order?\nAllowed · 1d ago', 'Yes.'],
    ['Done.\nReceived\nStatus\nApprovals history\nAllowed once · 3h ago', 'Done.'],
    ['Fine.\n\nStatus\n\nApprovals history\nAllowed once · 3h ago', 'Fine.'],
    ['Ok\nShare a one-time code in Browser\nThe agent will see your one-time code…\nAllowed once · 19h ago', 'Ok'],
    ['Ok\nAllow access to [site]\nAllow this browser task to access this sensitive site…\nApprovals history', 'Ok'],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeMuseReply(input).text, want, input);
});

test('where the two rules still DISAGREE (hot patch vs the frozen rule), on purpose', () => {
  // 1. a standalone non-first "Approvals history" line cut by the hot patch: kept here (Codex false positive: "Approvals history\nNo approvals are pending.")
  assert.equal(sanitizeMuseReply('Answer.\nApprovals history\nNo approvals are pending.').text, 'Answer.\nApprovals history\nNo approvals are pending.');
  // 2. two headings/chrome without an anchor ("Status" + "Connected"): the hot patch cuts, the frozen rule needs an anchor
  assert.equal(sanitizeMuseReply('Answer.\nStatus\nConnected').text, 'Answer.\nStatus\nConnected');
  // 3. two label lines with no strong anchor: the hot patch cuts a final, the frozen rule keeps it (a real answer can list two buttons)
  const labels = 'Try:\nAllow access to [site]\nShare a one-time code in Browser';
  assert.equal(sanitizeMuseReply(labels).text, labels);
  // 4. prose that starts like a label next to chrome: the hot patch treats "Allow access to …" as chrome whatever it says
  const prose = 'Allow access to your calendar only after reviewing it.\nAllowed once · 2h ago';
  assert.equal(sanitizeMuseReply(prose).trimmed, 0);
  // 5. a timestamp row without "ago" ("Allowed once · 2h") counts as chrome for the hot patch; here only a finished "… ago" row is strong (partial rows are hidden while streaming)
  assert.equal(sanitizeMuseReply('Answer.\nApprovals history\nAllowed once · 2h').trimmed, 0, 'heading + an unfinished row is one anchor: kept as a final (the hot patch cuts it)');
  assert.equal(sanitizeMuseReply('Answer.\nFill saved credentials in Browser\nAllowed once · 2h').trimmed, 0, 'label + an unfinished row: kept (final)');
  // 6. the hot patch returns the ORIGINAL when only chrome is left; here the note
  assert.equal(sanitizeMuseReply('Approvals history\nAllowed once · 2h ago').text, NO_TEXT);
});
