// Reviewed literal additive hooks only. Changing any byte requires review.
export const hooks = {
  "live-paint": "  // Muse Listen hook BEGIN live-paint\n  const live = showingListen();\n  if (live && !listenVisible) {\n    listenVisible = true; listenHoldToken = {};\n    if (recording !== null) void run({ kind: 'cancelMic' });\n    homeListen.enter();\n  }\n  if (!live && listenVisible) { listenVisible = false; void homeListen.leave(); }\n  if (live) {\n    const frame = homeListen.frame();\n    glasses.setListenFrame(frame.key, frame.left, frame.right);\n    $('glass').textContent = `${frame.left}\\n\\n${frame.right}`;\n    $('status').textContent = status;\n    syncAgentConfirmExpiry();\n    return;\n  }\n  // Muse Listen hook END live-paint\n",
  "live-menu": "  // Muse Listen hook BEGIN live-menu\n  if (model.screenKind === 'museListen') { await homeListen.leave(); listenVisible = false; }\n  if (id === MENU.listen) {\n    if (blank) { wake(); return; }\n    leaveDesk(); tilesActive = false; fromTiles = false;\n    model.goListen(); paint(); return;\n  }\n  // Muse Listen hook END live-menu\n"
};
export function stripHook(source, name) {
  const text = hooks[name];
  const marker = `// Muse Listen hook BEGIN ${name}`;
  if (!source.includes(marker)) return source;
  if (source.split(marker).length !== 2 || source.split(text).length !== 2) throw new Error(`unreviewed or ambiguous Listen hook: ${name}`);
  return source.replace(text, "");
}
