/**
 * P1-5 — the single entry point for "replay a session into the terminal".
 *
 * `procway-code resume <id>`, `/resume`, `/checkout <id>` and `/history` used
 * to each build their own recap, and they disagreed on every option: two
 * passed `markdown`, two did not; none passed `maxChars`; none re-printed the
 * welcome card after a session swap, so the header kept showing the OLD
 * session id. Everything now goes through `printSessionRecap`, which owns the
 * defaults (welcome card, width, colorize, maxMessages, per-tool clipping).
 */

import { renderWelcome } from "./shell.mjs";
import { resolveHyperlinks, supportsColor, terminalWidth } from "./ansi.mjs";
import { renderTranscript, RECAP_MAX_MESSAGES } from "./transcript-node-render.mjs";
import { resolveActiveModel } from "../../config/active-model.mjs";

/**
 * @param {object} params
 * @param {object} params.session   an agent session (`sessionId`, `messages`, `settings`)
 * @param {string} [params.cwd]
 * @param {object} [params.settings] falls back to `session.settings`
 * @param {boolean} [params.welcome] print the session header card (default true)
 * @param {number}  [params.width]
 * @param {boolean} [params.colorize]
 * @returns {string}
 */
export function renderSessionRecap({
  session,
  cwd,
  settings,
  welcome = true,
  width = 80,
  colorize = false,
  hyperlinks = false,
  maxMessages = RECAP_MAX_MESSAGES
} = {}) {
  const effectiveSettings = settings ?? session?.settings ?? {};
  const parts = [];
  if (welcome) {
    parts.push(renderWelcome({
      sessionId: session?.sessionId,
      cwd: cwd ?? session?.cwd,
      provider: effectiveSettings.defaultProvider,
      model: resolveActiveModel(effectiveSettings),
      approvalMode: effectiveSettings.approvalMode,
      width,
      color: colorize
    }));
  }
  parts.push(renderTranscript(Array.isArray(session?.messages) ? session.messages : [], {
    maxMessages,
    width,
    colorize,
    hyperlinks
  }));
  return parts.join("\n");
}

/**
 * Write the recap to `output`, deriving width and colour from the stream.
 * `colorize` comes from `supportsColor` (never `isTTY` directly) so `NO_COLOR`
 * and a piped stdout behave the same on every route (P1-3).
 */
export function printSessionRecap({ session, output = process.stdout, cwd, settings, welcome = true }) {
  const effectiveSettings = settings ?? session?.settings ?? {};
  output.write(renderSessionRecap({
    session,
    cwd,
    settings,
    welcome,
    width: terminalWidth(output),
    colorize: supportsColor(output),
    // Same decision the live renderer makes (cli.mjs), from the same inputs:
    // a replayed message must be byte-identical to the one that streamed.
    hyperlinks: resolveHyperlinks(effectiveSettings?.ui?.hyperlinks, output)
  }));
}
