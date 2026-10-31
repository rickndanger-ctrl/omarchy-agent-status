import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { ListenGlasses } from './glasses';
import type { ListenHubPort } from './hub';
import { InputMapper, RemoteInput, type ListenAction } from './input';
import { applySnapshot, backToNewest, clockT, createModel, formatTime, layoutText, selectNote } from './model';
import { ListenSession } from './session';

export interface ListenAppOptions {
  hub(): ListenHubPort;
  bridge?: () => Promise<EvenAppBridge>;
  mic?: { on(): Promise<boolean>; off(): Promise<boolean> };
  mount?: HTMLElement;
  now?: () => number;
  diag?(name: string): void;
}

/** Importing this module does nothing. The production and simulator entries
 * explicitly create/connect their own app; only a user toggle starts a session.
 */
export function createListenApp(o: ListenAppOptions) {
  const now = o.now ?? Date.now;
  let model = createModel();
  let closed = false, foreground = true;
  let status = 'Connect the glasses, then Select or Start to listen.';
  let timer: ReturnType<typeof setInterval> | undefined;
  let controlHub: ListenHubPort | null = null;
  let ui: ReturnType<typeof createUI> | undefined;
  const glasses = new ListenGlasses({
    bridge: o.bridge,
    onInput: input => mapper.press(input),
    onAudio: pcm => session.onAudio(pcm),
    onStatus: value => { status = value; paint(); },
    diag: o.diag,
    onLifecycle: event => {
      foreground = event === 'foreground';
      mapper.reset(); remote.sync();
      if (event === 'exit') void close();
      else if (event === 'background') void session.stop();
      paint();
    },
  });
  const session = new ListenSession({
    hub: () => { if (!controlHub) throw new Error('Hub not configured'); return controlHub; },
    mic: o.mic ?? { on: () => glasses.microphone(true), off: () => glasses.microphone(false) },
    publish: value => {
      if (closed && value.state !== 'stopped') return;
      if (!model.session || model.session.id !== value.id || model.session.startedAt !== value.startedAt) model = createModel();
      model = applySnapshot(model, value); paint();
    },
    changed: () => paint(), now, diag: o.diag,
  });
  // Both sources use local monotonic receipt time. Remote server event.at is
  // deliberately not mixed with the session's epoch or simulator clock.
  const mapper = new InputMapper(value => { void action(value); }, () => performance.now());
  const remote = new RemoteInput({
    hub: () => { if (!controlHub) throw new Error('Hub not configured'); return controlHub; },
    active: () => !closed && foreground && glasses.isConnected && controlHub !== null,
    apply: input => mapper.press(input),
  });
  function frame(): ReturnType<typeof layoutText> {
    const layout = layoutText(model, now()), state = session.view();
    // Mic acknowledgement is authoritative. A hub's stopped snapshot is not
    // evidence that local recording stopped; retain a visible warning meanwhile.
    if (state.micOn && (model.state !== 'listening' || state.warning || state.phase !== 'listening')) {
      const elapsed = state.id ? clockT({ id: state.id, startedAt: state.startedAt }, now()) : model.nowT;
      layout.left = ['● Listening? ' + formatTime(elapsed), ...layout.left.split('\n').slice(1)].join('\n');
    } else if (!state.micOn && model.state === 'listening') {
      layout.left = ['○ Mic off ' + formatTime(model.nowT), ...layout.left.split('\n').slice(1)].join('\n');
    }
    return layout;
  }
  function paint(): void {
    const layout = frame(), state = session.view();
    glasses.setFrame(layout, `${state.id}:${state.micOn ? 'mic-on' : 'mic-off'}`);
    if (ui) {
      ui.left.textContent = layout.left; ui.right.textContent = layout.right;
      ui.status.textContent = state.warning || state.error || status;
      ui.indicator.textContent = state.micOn ? state.warning ? 'Listening · mic state uncertain' : 'Listening · microphone on' : 'Microphone off';
      ui.indicator.dataset.listening = String(state.micOn);
      ui.toggle.textContent = state.micOn || state.phase === 'starting' ? 'Stop listening' : 'Start listening';
      ui.toggle.disabled = closed || !glasses.isConnected || !controlHub || state.phase === 'stopping';
    }
  }
  async function action(value: ListenAction): Promise<void> {
    if (closed || !foreground) return;
    if (value === 'previous') model = selectNote(model, 'up');
    else if (value === 'next') model = selectNote(model, 'down');
    else if (value === 'newest') model = backToNewest(model);
    else if (glasses.isConnected) {
      const state = session.view();
      if (state.micOn || state.phase === 'starting') await session.stop();
      else if (controlHub) await session.start();
      else status = 'Configure a Listen hub before starting.';
    }
    paint();
  }
  async function connect(): Promise<boolean> {
    if (closed) return false;
    const ok = await glasses.connect();
    if (!ok || closed) return false;
    if (!session.view().micOn && !['starting', 'stopping'].includes(session.view().phase)) {
      remote.stop();
      try { controlHub = o.hub(); }
      catch { controlHub = null; status = 'Configure a valid Listen hub and token on the phone.'; }
    }
    remote.sync();
    if (!timer) timer = setInterval(() => { void tick(); }, 1000);
    paint(); return true;
  }
  async function tick(): Promise<void> { if (!closed) { paint(); await session.tick(); } }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true; clearInterval(timer); timer = undefined; remote.close(); mapper.reset();
    try { await session.close(); } finally {
      paint();
      // If still visible, deliver the stopped/uncertain indicator before
      // detaching the transport. Native exit already makes settled not-visible.
      await glasses.settled(1600);
      glasses.dispose(); ui?.dispose();
    }
  }
  if (o.mount) ui = createUI(o.mount, value => { void action(value); }, () => { void close(); });
  paint();
  return {
    connect, action, close, tick,
    poll: () => closed ? Promise.resolve() : session.poll(),
    onAudio: (pcm: Uint8Array) => { if (!closed) session.onAudio(pcm); },
    view: () => ({ ...session.view(), model: structuredClone(model), layout: frame(),
      selectedNoteIndex: frame().selectedNoteIndex, transcriptAt: frame().transcriptAt,
      transcriptIndex: frame().transcriptIndex, connected: glasses.isConnected, remoteWaiting: remote.waiting, foreground, closed }),
    settled: (timeoutMs?: number) => glasses.settled(timeoutMs),
  };
}

function createUI(mount: HTMLElement, act: (value: ListenAction) => void, close: () => void) {
  const doc = mount.ownerDocument;
  const title = doc.createElement('h1'); title.textContent = 'Muse Listen';
  const indicator = doc.createElement('p'); indicator.className = 'mic-state'; indicator.setAttribute('role', 'status');
  const status = doc.createElement('p'); status.className = 'status'; status.setAttribute('aria-live', 'polite');
  const boxes = doc.createElement('div'); boxes.className = 'boxes';
  const left = doc.createElement('pre'), right = doc.createElement('pre');
  left.id = 'transcript-preview'; right.id = 'notes-preview'; boxes.append(left, right);
  const controls = doc.createElement('div'); controls.className = 'controls';
  const cleanup: (() => void)[] = [];
  const button = (label: string, callback: () => void) => {
    const element = doc.createElement('button'); element.type = 'button'; element.textContent = label;
    element.addEventListener('click', callback); cleanup.push(() => element.removeEventListener('click', callback)); controls.append(element); return element;
  };
  const toggle = button('Start listening', () => act('toggle'));
  button('Previous note', () => act('previous')); button('Next note', () => act('next'));
  button('Back to newest', () => act('newest')); button('Close session', close);
  mount.replaceChildren(title, indicator, status, boxes, controls);
  return { indicator, status, left, right, toggle, dispose: () => cleanup.forEach(remove => remove()) };
}
