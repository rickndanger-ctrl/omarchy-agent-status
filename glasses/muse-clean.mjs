// What the Muse relay returns as a "reply" can carry the Muse window's own chrome after the answer
// (a "Muse" heading, "Connected", "Approvals history", approval rows…). The hub cuts the reply at the first such line.
// Pure and small on purpose: nothing here talks to Muse.
const ALONE = /^(connected|approvals history.*|share a one-time code.*)$/i
const ANYWHERE = [/^Allowed · /, /^Allow access to /, /^Place this order\?/, /^Share a one-time code/i]

/** The answer without Muse's window chrome. Returns { text, trimmed } (trimmed = characters removed). Text before the first chrome line is kept as it is. */
export function sanitizeMuseReply(reply) {
  const original = String(reply ?? '')
  const lines = original.replace(/\r/g, '').split('\n')
  const nextNonEmpty = i => { for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j].trim(); return '' }
  let cut = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    // A line that is exactly "Muse", followed by chrome (a mid-line "Muse" in the answer is just text).
    if (/^muse$/i.test(line) && (ALONE.test(nextNonEmpty(i)) || ANYWHERE.some(re => re.test(nextNonEmpty(i))))) { cut = i; break }
    if (ANYWHERE.some(re => re.test(line))) { cut = i; break }
    if (/^approvals history/i.test(line)) { cut = i; break }
  }
  if (cut < 0) return { text: original, trimmed: 0 }
  const text = lines.slice(0, cut).join('\n').replace(/\s+$/, '')
  return { text, trimmed: original.length - text.length }
}
