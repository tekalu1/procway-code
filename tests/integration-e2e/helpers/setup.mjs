// TK-126 integration-e2e helpers (no Playwright dep imported here — used as data shared
// across the .spec.ts files which DO import @playwright/test from a sibling workspace.
// FR-CONS-1 keeps ai-agent dep-free; specs are run via:
//   npx --package=@playwright/test playwright test \
//       --config=tests/integration-e2e/playwright.config.ts \
//       tests/integration-e2e/<spec>.spec.ts
// from a workspace that has @playwright/test installed (e.g. dashboard/).

export const POC_BASE_URL = process.env.PROCWAY_POC_BASE_URL ?? "http://127.0.0.1:4004";
export const POC_TOKEN = process.env.PROCWAY_SERVE_TOKEN ?? "tk126-itm-token";
export const POC_PAGE_URL = `${POC_BASE_URL}/?token=${encodeURIComponent(POC_TOKEN)}`;
export const POC_WS_URL = `${POC_BASE_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(POC_TOKEN)}`;

/**
 * In-page helper: opens a fresh WebSocket on the PoC origin, collects all
 * incoming JSON frames into an array, and returns a small driver that
 * `send`s commands and `waitFor`s a predicate. Designed to be passed to
 * `page.evaluate(...)` so we drive the bridge without depending on the
 * client.mjs internal WebSocket (which is held in a closure).
 *
 * Returns an async-string-evaluate-friendly factory function source so that
 * specs can do:
 *   const driver = await page.evaluate(`(${createWsDriver.toString()})()`);
 * — but in practice the specs below copy this function inline for clarity.
 */
export function createWsDriverSource() {
  return `async () => {
    const ws = new WebSocket(${JSON.stringify(POC_WS_URL)});
    const msgs = [];
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
      setTimeout(() => reject(new Error('ws open timeout')), 5000);
    });
    ws.addEventListener('message', (e) => { try { msgs.push(JSON.parse(e.data)); } catch {} });
    return { ws, msgs };
  }`;
}
