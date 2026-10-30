// What the Muse relay returns as a "reply" can carry the Muse window's own chrome after the answer
// (a "Muse" heading, "Connected", "Approvals history", approval rows…). The hub cuts the reply at the first such line.
// Pure and small on purpose: nothing here talks to Muse.
// A line that is Muse window chrome. One of these alone is not enough to cut: a real answer can say "Allow access to your calendar only after…".
const CHROME = [/^connected$/i, /^approvals history$/i, /^share a one-time code.*$/i, /^allowed · .*$/i, /^allow access to .*$/i, /^place this order\?$/i]
const isChrome = line => CHROME.some(re => re.test(line.trim()))

/** The answer without Muse's window chrome. Returns { text, trimmed } (trimmed = characters removed).
 * Cut at: a lone "Muse" line followed by chrome, or a chrome line (incl. the exact heading "Approvals history") followed by another chrome line.
 * Everything before stays exactly as it was. */
export function sanitizeMuseReply(reply) {
  const original = String(reply ?? '')
  const lines = original.replace(/\r/g, '').split('\n')
  const nextNonEmpty = i => { for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j]; return '' }
  let cut = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^muse$/i.test(line) && isChrome(nextNonEmpty(i))) { cut = i; break }
    if (isChrome(line) && isChrome(nextNonEmpty(i))) { cut = i; break }
  }
  if (cut < 0) return { text: original, trimmed: 0 }
  const text = lines.slice(0, cut).join('\n').replace(/\s+$/, '')
  return { text, trimmed: original.length - text.length }
}
