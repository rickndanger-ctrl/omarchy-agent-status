// What the Muse relay returns as a "reply" can carry the Muse window's own chrome after the answer (headings, "Approvals history", approval rows…).
// This module cuts it. Pure and small on purpose: nothing here talks to Muse. The hub applies it to every reply it serves (final and partial) and
// the app applies the SAME function again as a second guard (home-app imports this file; there is no copy).
//
// Anchors: a line exactly "Approvals history", a timestamp row /^Allowed( once)? · .+ ago$/, a line starting "Fill saved credentials",
// "Share a one-time code" or "Allow access to", or exactly "Place this order?". One anchor alone is just a sentence; it counts only when a
// SECOND anchor follows within the next 6 lines (while a reply is still streaming, a single anchor is enough: the chrome may be half typed). The cut point is the first counted anchor, moved back over the exact headings
// "Status", "Muse", "Connected", "Received" and blank lines above it. Everything before stays exactly as it was.
const ANCHOR_EXACT = [/^approvals history$/i, /^place this order\?$/i]
const ANCHOR_STAMP = /^allowed( once)? · .+ ago$/i
const ANCHOR_START = [/^fill saved credentials/i, /^share a one-time code/i, /^allow access to/i]
// A line that starts like chrome is chrome only if it looks like a button label, not a sentence: it ends "in Browser", or it is at most 6 words
// with no sentence-ending punctuation ("Allow access to [site]"). "Allow access to your calendar only after reviewing it." is prose.
const looksLikeLabel = t => /\bin Browser$/i.test(t) || (t.split(/\s+/).length <= 6 && !/[.!?]$/.test(t))
const isAnchor = line => {
  const t = line.trim()
  return ANCHOR_EXACT.some(re => re.test(t)) || ANCHOR_STAMP.test(t) || (ANCHOR_START.some(re => re.test(t)) && looksLikeLabel(t))
}
// Only these exact headings are walked back over (a real "Yes" or "Done" line above them stays).
const HEADINGS = new Set(['Status', 'Muse', 'Connected', 'Received'])
const isHeader = line => HEADINGS.has(line.trim())
/** What a FINAL reply that was only window chrome becomes (never the chrome: approval history must not reach the glasses). */
export const NO_TEXT = 'Muse sent no text'
const FOLLOW = 6
// A FINAL reply is cut only when the block holds a STRONG anchor: the exact heading "Approvals history" or a timestamp row. Label anchors alone
// ("Allow access to [site]" + "Share a one-time code in Browser") can be a real answer that lists two buttons.
const isStrong = line => /^approvals history$/i.test(line.trim()) || ANCHOR_STAMP.test(line.trim())
// While streaming, the very last line may be a label that is still being typed ("Fill sav"): it counts as an anchor too.
const LABEL_LITERALS = ['approvals history', 'place this order?', 'fill saved credentials', 'share a one-time code', 'allow access to']
const HEADING_LITERALS = ['status', 'muse', 'connected', 'received']
const unfinishedLabel = t => {
  const l = t.trim().toLowerCase()
  if (!l) return false
  return LABEL_LITERALS.some(x => x.startsWith(l) && x !== l)             // a label anchor still being typed
    || HEADING_LITERALS.some(x => x.startsWith(l))                         // a heading still being typed (or just typed)
    || (/^allowed( once)?( · .*)?$/.test(l) && !ANCHOR_STAMP.test(t.trim())) // a timestamp row still being typed ("Allowed once · 2h")
}

/** The answer without Muse's window chrome. Returns { text, trimmed, anchor } (trimmed = characters removed, anchor = the line that was cut at).
 * `partial`: the reply is still being typed; one anchor is enough to cut. A FINAL reply needs two anchors within 6 lines, at least one of them strong
 * (exact "Approvals history" or a timestamp row), and the reply's own first line is never cut away. */
export function sanitizeMuseReply(reply, { partial = false } = {}) {
  const original = String(reply ?? '')
  const lines = original.replace(/\r/g, '').split('\n')
  let at = -1
  const firstReal = lines.findIndex(l => l.trim())
  let lastReal = lines.length - 1
  while (lastReal >= 0 && !lines[lastReal].trim()) lastReal--
  for (let i = 0; i < lines.length; i++) {
    if (!isAnchor(lines[i]) && !(partial && i === lastReal && i !== firstReal && unfinishedLabel(lines[i]))) continue
    let second = false
    let strong = isStrong(lines[i])
    for (let j = i + 1; j < lines.length && j <= i + FOLLOW; j++) if (isAnchor(lines[j])) { second = true; if (isStrong(lines[j])) strong = true }
    if (second && !strong && !partial) continue // final: label anchors alone never cut
    if (second || partial) { at = i; break } // streaming: the chrome may be only half typed, one anchor is enough (a real sentence comes back in the final reply)
  }
  if (at < 0) {
    // Streaming: a heading typed at the end (or just before it) is the start of the chrome, not the answer; the final reply shows it again if it was real.
    if (partial) {
      let end = lines.length
      while (end > 0 && !lines[end - 1].trim()) end--
      let stripped = end
      while (stripped - 1 > firstReal && isHeader(lines[stripped - 1])) { stripped--; while (stripped - 1 > firstReal && !lines[stripped - 1].trim()) stripped-- }
      if (stripped < end) {
        const text = lines.slice(0, stripped).join('\n').replace(/\s+$/, '')
        return { text, trimmed: original.length - text.length, anchor: lines[end - 1].trim().slice(0, 30) }
      }
    }
    return { text: original, trimmed: 0, anchor: '' }
  }
  let cut = at
  // the reply's own first line is never walked back over (a one-word answer "Status" stays)
  while (cut > 0 && cut - 1 !== firstReal && (isHeader(lines[cut - 1]) || !lines[cut - 1].trim())) cut--
  let text = lines.slice(0, cut).join('\n').replace(/\s+$/, '')
  if (!text.trim() && !partial) text = NO_TEXT // only chrome was left: a short note, never the chrome itself
  return { text, trimmed: Math.max(0, original.length - text.length), anchor: lines[at].trim().slice(0, 30) }
}
