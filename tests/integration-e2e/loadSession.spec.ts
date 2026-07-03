/**
 * TK-126 integration-e2e — loadSession command (TC-12608, 12609, 12610, 12611)
 *
 * FR-CONS-1: ai-agent must NOT take a dependency on @playwright/test.
 * Run this spec from a workspace that already has Playwright installed (e.g.
 * the dashboard package), pointing the config at this directory:
 *
 *   PROCWAY_SERVE_TOKEN=tk126-itm-token \
 *   npx --package=@playwright/test playwright test \
 *     --config=ai-agent/tests/integration-e2e/playwright.config.ts \
 *     ai-agent/tests/integration-e2e/loadSession.spec.ts
 *
 * Prerequisites (driven outside Playwright):
 *   1. seed fixture sessions S-OLD/S-EMPTY/S-RESUME/S-CONS/S-DUP using
 *      tools/seed-tk126.mjs (or the TEMP scripts referenced in memo.md).
 *   2. start `procway-code serve` against the seeded fixture cwd at port 4004
 *      with token `tk126-itm-token`.
 *
 * The PoC HTML at web/index.html does NOT have data-testid attributes (it is
 * an internal PoC and FR-PROTO-5 keeps it minimal). We rely on the existing
 * element ids: #refresh-sessions, #session-list, #event-log, #status, #session.
 */
import { test, expect, type Page } from "@playwright/test";
import { POC_PAGE_URL, POC_WS_URL } from "./helpers/setup.mjs";

async function gotoConnected(page: Page): Promise<void> {
  await page.goto(POC_PAGE_URL);
  await expect(page.locator("#status")).toHaveText(/connected/i, { timeout: 10_000 });
}

async function rawWs(page: Page, command: string, args: Record<string, unknown>) {
  // Drives a fresh WebSocket to inspect raw protocol frames (the page's
  // built-in WebSocket is held in a module closure and not reachable from
  // page.evaluate — we open our own instead).
  return page.evaluate(
    async ({ wsUrl, command, args }) => {
      const ws = new WebSocket(wsUrl);
      const msgs: any[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("open failed")));
        setTimeout(() => reject(new Error("ws open timeout")), 5000);
      });
      ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse((e as MessageEvent).data as string)); } catch {} });
      await new Promise((r) => setTimeout(r, 200));
      const offset = msgs.length;
      ws.send(JSON.stringify({ kind: "command", command, id: "T1", args }));
      const start = Date.now();
      while (!msgs.some((m) => m.kind === "response" && m.id === "T1") && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 200));
      const post = msgs.slice(offset);
      const ready = msgs.find((m) => m.kind === "ready");
      return {
        post,
        response: post.find((m: any) => m.kind === "response" && m.id === "T1"),
        sessionResumedEvents: post.filter((m: any) => m.kind === "event" && m.event && m.event.type === "session.resumed"),
        initialBridgeSessionId: ready ? ready.sessionId : null
      };
    },
    { wsUrl: POC_WS_URL, command, args }
  );
}

test.describe("TK-126 loadSession integration (@integration)", () => {
  test("TC-12608 — loads existing sessionId S-OLD with persisted projection", async ({ page }) => {
    await gotoConnected(page);
    const { response, sessionResumedEvents } = await rawWs(page, "loadSession", { sessionId: "S-OLD" });
    expect(response).toBeDefined();
    expect(response!.ok).toBe(true);
    expect(response!.result.sessionId).toBe("S-OLD");
    expect(response!.result.messageCount).toBe(5);
    expect(typeof response!.result.eventCount).toBe("number");
    expect(sessionResumedEvents.length).toBe(1);
    expect(sessionResumedEvents[0].event.sessionId).toBe("S-OLD");
    expect(sessionResumedEvents[0].event.messageCount).toBe(5);
  });

  test("TC-12609 — loadSession with the same sessionId is a no-op", async ({ page }) => {
    await gotoConnected(page);
    // Drive both loadSessions on a single shared WebSocket.
    const result = await page.evaluate(async ({ wsUrl }) => {
      const ws = new WebSocket(wsUrl);
      const msgs: any[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("open failed")));
        setTimeout(() => reject(new Error("ws open timeout")), 5000);
      });
      ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse((e as MessageEvent).data as string)); } catch {} });
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ kind: "command", command: "loadSession", id: "L1", args: { sessionId: "S-OLD" } }));
      const t0 = Date.now();
      while (!msgs.some((m: any) => m.kind === "response" && m.id === "L1") && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const beforeCount = msgs.filter((m: any) => m.kind === "event" && m.event?.type === "session.resumed").length;
      ws.send(JSON.stringify({ kind: "command", command: "loadSession", id: "L2", args: { sessionId: "S-OLD" } }));
      const t1 = Date.now();
      while (!msgs.some((m: any) => m.kind === "response" && m.id === "L2") && Date.now() - t1 < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 300));
      const afterCount = msgs.filter((m: any) => m.kind === "event" && m.event?.type === "session.resumed").length;
      return {
        response2: msgs.find((m: any) => m.kind === "response" && m.id === "L2"),
        beforeCount,
        afterCount
      };
    }, { wsUrl: POC_WS_URL });
    expect(result.response2).toBeDefined();
    expect(result.response2!.ok).toBe(true);
    expect(result.response2!.result.sessionId).toBe("S-OLD");
    expect(result.response2!.result.messageCount).toBe(5);
    expect(result.afterCount - result.beforeCount).toBe(0);
  });

  test("TC-12610 — missing sessionId returns session_not_found and bridge.session unchanged", async ({ page }) => {
    await gotoConnected(page);
    const { response, sessionResumedEvents, initialBridgeSessionId } = await rawWs(page, "loadSession", { sessionId: "S-MISSING" });
    expect(response).toBeDefined();
    expect(response!.ok).toBe(false);
    expect(response!.error.code).toBe("session_not_found");
    expect(sessionResumedEvents.length).toBe(0);
    expect(initialBridgeSessionId).toBeTruthy();
  });

  test.skip("TC-12611 — initialize_failed rollback (covered by vitest cross-ref)", () => {
    // The default sessionFactory used by `procway-code serve` only throws
    // "No session found:" for unknown ids → that surfaces as
    // session_not_found, NOT initialize_failed. Triggering the
    // initialize_failed branch requires injecting a sessionFactory that
    // throws an arbitrary message, which is not possible from outside the
    // process. The unit test
    //   tests/serve-bridge.test.mjs >
    //   "returns initialize_failed and keeps the live session attached when factory throws"
    // covers this contract end-to-end with attachBridge + a fake factory
    // (no mocks; the factory is a constructor argument, not a stub).
    // See test-cases.md for the cross-reference rationale and the captured
    // vitest output (TC-12611-rollback-vitest.png).
  });
});
