// Listen-only frame adaptation. Home owns the SDK, write pacing and recovery.
import { clockT, formatTime, layoutText, type ListenModel } from './model';
import type { SessionView } from './session';

export interface HomeListenFrame { left: string; right: string; key: string }

/** Fixed-font subset and both SDK byte/UTF16 budgets, ported from Listen. */
export function safeText(input: string): string {
  const clean = input.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\n\x20-\x7e\u00a0-\u00ff·•…›→←▲▼─│●○]/gu, '');
  const segments: Iterable<string> = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean), part => part.segment)
    : Array.from(clean);
  let text = '', bytes = 0;
  const encoder = new TextEncoder();
  for (const part of segments) {
    if (part.length === 1 && /[\ud800-\udfff]/.test(part)) continue;
    const size = encoder.encode(part).length;
    if (text.length + part.length > 950 || bytes + size > 950) break;
    text += part; bytes += size;
  }
  return text || ' ';
}

function noticeRows(notice: string): string[] {
  const rows: string[] = [];
  let row = '';
  for (const word of notice.replace(/\s+/g, ' ').trim().split(' ')) {
    if (row && row.length + word.length + 1 > 27) { rows.push(row); row = ''; }
    row += (row ? ' ' : '') + word;
  }
  if (row) rows.push(row);
  return rows.slice(0, 3);
}

export function renderListenFrame(model: ListenModel, view: SessionView, now: number, entry: number, notice = ''): HomeListenFrame {
  const layout = layoutText(model, now);
  if (view.micOn && (model.state !== 'listening' || view.warning || view.phase !== 'listening')) {
    const elapsed = view.id ? clockT({ id: view.id, startedAt: view.startedAt }, now) : model.nowT;
    layout.left = ['● Listening? ' + formatTime(elapsed), ...layout.left.split('\n').slice(1)].join('\n');
  } else if (!view.micOn && model.state === 'listening') {
    layout.left = ['○ Mic off ' + formatTime(model.nowT), ...layout.left.split('\n').slice(1)].join('\n');
  }
  const problem = view.warning || view.error || notice;
  if (problem) layout.left = [layout.left.split('\n')[0], ...noticeRows(problem), ...layout.left.split('\n').slice(1)].slice(0, 9).join('\n');
  return { left: safeText(layout.left), right: safeText(layout.right),
    key: `listen/${entry}/${view.id}/${view.phase}/${view.micOn ? 'mic-on' : 'mic-off'}` };
}
