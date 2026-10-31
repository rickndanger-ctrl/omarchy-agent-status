/** Muse Listen's pure session clock, incremental history and two-box text model.
 * No SDK, DOM, fetch, wall-clock reads, timers or microphone operations live here.
 */
export interface Session { id: string; startedAt: number }
export interface TranscriptLine { t: number; text: string }
export interface MuseNote { t: number; at_t: number; text: string }
export type Note = MuseNote;
export interface MuseState { state: 'idle' | 'thinking' | 'busy' | 'unavailable'; reason?: string }
export interface ListenSnapshot extends Session {
  state: 'listening' | 'stopped';
  now_t: number;
  lines: TranscriptLine[];
  notes: MuseNote[];
  muse: MuseState;
}
export interface ListenModel {
  session: Session | null;
  state: 'listening' | 'stopped';
  nowT: number;
  lines: TranscriptLine[];
  notes: MuseNote[];
  muse: MuseState;
  selectedNoteKey: string | null;
  /** Requested transcript anchor: note.at_t, never the note arrival timestamp. */
  transcriptAt: number | null;
}
export interface ListenLayout {
  left: string;
  right: string;
  selectedNoteIndex: number | null;
  transcriptAt: number | null;
  /** Index of the transcript line at or immediately before the requested anchor. */
  transcriptIndex: number | null;
}
export const BOX_COLUMNS = 27;
export const BOX_LINES = 9;
export const MAX_UPDATE_CHARS = 950;
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validSession = (session: Session): boolean => typeof session?.id === 'string' && session.id.trim().length > 0 && validTime(session.startedAt);
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim();
const noteKey = (note: MuseNote): string => JSON.stringify([note.t, note.at_t, note.text]);
const lineKey = (line: TranscriptLine): string => JSON.stringify([line.t, line.text]);

export function createModel(session?: Session): ListenModel {
  const accepted = session && validSession(session) ? { id: session.id, startedAt: session.startedAt } : null;
  return { session: accepted, state: accepted ? 'listening' : 'stopped', nowT: 0, lines: [], notes: [],
    muse: { state: 'idle' }, selectedNoteKey: null, transcriptAt: null };
}

/** Explicit epoch input; an invalid or backward clock never creates negative time. */
export function clockT(session: Session, epochMs: number): number {
  return validSession(session) && validTime(epochMs) ? Math.max(0, epochMs - session.startedAt) : 0;
}

/** All transcript, note and timer labels use milliseconds on the same session clock. */
export function formatTime(t: number): string {
  const seconds = validTime(t) ? Math.floor(t / 1000) : 0;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return seconds < 3600 ? `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
    : `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function merge<T extends { t: number }>(old: T[], incoming: T[], key: (record: T) => string): T[] {
  const records = new Map<string, T>();
  for (const record of [...old, ...incoming]) records.set(key(record), { ...record });
  // Stable sort preserves two distinct lines/notes that happen at the same time.
  return [...records.values()].sort((a, b) => a.t - b.t);
}

export function applySnapshot(model: ListenModel, snapshot: ListenSnapshot): ListenModel {
  if (!snapshot || !validSession(snapshot) || !validTime(snapshot.now_t)
      || !['listening', 'stopped'].includes(snapshot.state) || !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.notes)
      || !snapshot.muse || !['idle', 'thinking', 'busy', 'unavailable'].includes(snapshot.muse.state)) return model;
  if (model.session && (model.session.id !== snapshot.id || model.session.startedAt !== snapshot.startedAt)) return model;
  // A delayed listening response must never restart a session already stopped.
  if (model.session && model.state === 'stopped' && snapshot.state === 'listening') return model;
  const lines = snapshot.lines.filter(line => line && validTime(line.t) && typeof line.text === 'string' && clean(line.text))
    .map(line => ({ t: line.t, text: clean(line.text) }));
  const notes = snapshot.notes.filter(note => note && validTime(note.t) && validTime(note.at_t)
    && typeof note.text === 'string' && clean(note.text) && clean(note.text) !== '—')
    .map(note => ({ t: note.t, at_t: note.at_t, text: clean(note.text) }));
  const allLines = merge(model.lines, lines, lineKey);
  const allNotes = merge(model.notes, notes, noteKey);
  const selected = allNotes.find(note => noteKey(note) === model.selectedNoteKey);
  const muse: MuseState = { state: snapshot.muse.state };
  if (typeof snapshot.muse.reason === 'string' && clean(snapshot.muse.reason)) muse.reason = clean(snapshot.muse.reason);
  return { session: { id: snapshot.id, startedAt: snapshot.startedAt }, state: snapshot.state,
    nowT: [...lines, ...notes].reduce((time, record) => Math.max(time, record.t), Math.max(model.nowT, snapshot.now_t)),
    lines: allLines, notes: allNotes, muse, selectedNoteKey: selected ? noteKey(selected) : null,
    transcriptAt: selected ? selected.at_t : null };
}

export function selectNote(model: ListenModel, direction: 'up' | 'down'): ListenModel {
  if (!model.notes.length) return model;
  const current = model.notes.findIndex(note => noteKey(note) === model.selectedNoteKey);
  const index = current < 0 ? direction === 'down' ? 0 : model.notes.length - 1
    : Math.max(0, Math.min(model.notes.length - 1, current + (direction === 'down' ? 1 : -1)));
  const selected = model.notes[index];
  if (noteKey(selected) === model.selectedNoteKey) return model;
  return { ...model, selectedNoteKey: noteKey(selected), transcriptAt: selected.at_t };
}

export function backToNewest(model: ListenModel): ListenModel {
  return model.selectedNoteKey === null && model.transcriptAt === null ? model
    : { ...model, selectedNoteKey: null, transcriptAt: null };
}

export function navigate(model: ListenModel, action: 'previous' | 'next' | 'newest'): ListenModel {
  return action === 'newest' ? backToNewest(model) : selectNote(model, action === 'previous' ? 'up' : 'down');
}

/** Segment whole graphemes so a narrow display never gets half an emoji/mark. */
function graphemes(text: string): string[] {
  return [...SEGMENTER.segment(text)].map(part => part.segment);
}

function width(cluster: string): number {
  const point = cluster.codePointAt(0) ?? 0;
  if (/^\p{Mark}/u.test(cluster)) return 0;
  return point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf
    || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff
    || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60
    || point >= 0xffe0 && point <= 0xffe6 || point >= 0x1f000) ? 2 : 1;
}

function wrap(text: string): string[] {
  const rows: string[] = [];
  let row = '', columns = 0;
  for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
    const clusters = graphemes(word);
    const wordColumns = clusters.reduce((count, cluster) => count + width(cluster), 0);
    if (row && columns + 1 + wordColumns <= BOX_COLUMNS) {
      row += ` ${word}`; columns += 1 + wordColumns;
      continue;
    }
    if (row) { rows.push(row); row = ''; columns = 0; }
    if (wordColumns <= BOX_COLUMNS) {
      row = word; columns = wordColumns;
      continue;
    }
    // Only an over-wide token needs hard wrapping; keep complete graphemes.
    for (const cluster of clusters) {
      const size = width(cluster);
      if (columns + size > BOX_COLUMNS && row) { rows.push(row); row = ''; columns = 0; }
      row += cluster;
      columns += size;
    }
  }
  if (row) rows.push(row);
  return rows.length ? rows : [''];
}

function cap(text: string): string {
  let result = '';
  for (const cluster of graphemes(text)) {
    if (result.length + cluster.length > MAX_UPDATE_CHARS) break;
    result += cluster;
  }
  return result;
}

function viewport(records: string[], anchor: number | null): string[] {
  const available = BOX_LINES - 1;
  const rowsFor = (record: string): string[] => {
    const wrapped = wrap(record);
    return wrapped.length <= available ? wrapped : [...wrapped.slice(0, available - 1), '…'];
  };
  // Keep whole records. A long record starts at its timestamp/highlight, never
  // at an anonymous continuation swallowed by a flattened tail slice.
  const result: string[] = [];
  if (anchor !== null) {
    for (let i = anchor; i < records.length && result.length < available; i++) {
      const rows = rowsFor(records[i]);
      if (result.length + rows.length > available) break;
      result.push(...rows);
    }
  } else {
    for (let i = records.length - 1; i >= 0 && result.length < available; i--) {
      const rows = rowsFor(records[i]);
      if (result.length + rows.length > available) break;
      result.unshift(...rows);
    }
  }
  return result;
}

export function layoutText(model: ListenModel, epochMs?: number): ListenLayout {
  const elapsed = model.state === 'listening' && model.session && epochMs !== undefined
    ? Math.max(model.nowT, clockT(model.session, epochMs)) : model.nowT;
  const leftHeader = `${model.state === 'listening' ? '● Listening' : model.session ? '○ Stopped' : '○ Ready'} ${formatTime(elapsed)}`;
  const selected = model.notes.findIndex(note => noteKey(note) === model.selectedNoteKey);
  let transcriptIndex: number | null = null;
  if (selected >= 0 && model.lines.length) {
    transcriptIndex = 0;
    for (let i = 0; i < model.lines.length && model.lines[i].t <= model.notes[selected].at_t; i++) transcriptIndex = i;
  }
  const transcript = model.lines.map(line => `[${formatTime(line.t)}] ${line.text}`);
  const notes = model.notes.map((note, index) => `${index === selected ? '> ' : ''}[${formatTime(note.t)}] ${note.text}`);
  const leftRows = transcript.length ? viewport(transcript, transcriptIndex) : wrap(model.state === 'listening' ? 'Waiting for speech…' : 'Select to start listening');
  const rightRows = notes.length ? viewport(notes, selected >= 0 ? selected : null)
    : wrap(model.muse.reason ?? (model.muse.state === 'unavailable' ? 'Muse unavailable' : 'No notes yet')).slice(0, BOX_LINES - 1);
  const rightHeader = model.muse.state === 'idle' ? 'MUSE' : `MUSE · ${model.muse.state}`;
  return { left: cap([leftHeader, ...leftRows].join('\n')), right: cap([rightHeader, ...rightRows].join('\n')),
    selectedNoteIndex: selected >= 0 ? selected : null, transcriptAt: selected >= 0 ? model.notes[selected].at_t : null, transcriptIndex };
}
