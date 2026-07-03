import { ansiToPlaceholders } from "../../src/adapters/tui/ansi.mjs";

/**
 * Snapshot helper — converts ANSI escape sequences to readable placeholder
 * tokens (`[bold]...[/]` etc.) before passing the string to vitest's
 * `toMatchSnapshot`. Lets reviewers read the saved fixtures without ANSI
 * noise.
 */
export function asSnapshot(text) {
  return ansiToPlaceholders(text);
}
