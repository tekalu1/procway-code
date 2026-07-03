/**
 * TK-126 integration-e2e — listSessions performance (TC-12640, 12641)
 *
 * See loadSession.spec.ts for run instructions. The two tests need DIFFERENT
 * fixture cwds (50 vs 200 sessions). Set PROCWAY_FIXTURE_SESSION_COUNT to
 * decide which cwd the bridge is pointed at, and run only the matching test
 * via -g, or run them serially after restarting the server.
 *
 * Manual procedure used by integration-test-manual:
 *   1. seed perf-50 in <TEMP>/tk126-itm/fixture-50  (50 sessions)
 *   2. start `procway-code serve --cwd <TEMP>/tk126-itm/fixture-50 --port 4004`
 *   3. run `playwright test -g 'TC-12640'`
 *   4. stop server, reseed/swap to fixture-200, restart serve
 *   5. run `playwright test -g 'TC-12641'`
 *
 * Each measurement runs listSessions 5 times after a single warm-up call to
 * absorb JIT and any first-call index-rebuild noise. p95 of 5 samples is
 * `Math.ceil(5 * 0.95) - 1 = 4` → the highest sample (worst case).
 */
import { test, expect, type Page } from "@playwright/test";
import { POC_PAGE_URL, POC_WS_URL } from "./helpers/setup.mjs";

async function gotoConnected(page: Page): Promise<void> {
  await page.goto(POC_PAGE_URL);
  await expect(page.locator("#status")).toHaveText(/connected/i, { timeout: 10_000 });
}

async function measureListSessions(page: Page, limit: number): Promise<{ durationsMs: number[]; p95Ms: number; sessionsReturned: number | null }> {
  return page.evaluate(async ({ wsUrl, limit }) => {
    const ws = new WebSocket(wsUrl);
    const msgs: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("open failed")));
      setTimeout(() => reject(new Error("ws open timeout")), 5000);
    });
    ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse((e as MessageEvent).data as string)); } catch {} });
    await new Promise((r) => setTimeout(r, 200));
    // warm-up
    ws.send(JSON.stringify({ kind: "command", command: "listSessions", id: "warmup", args: { limit } }));
    const tw = Date.now();
    while (!msgs.some((m: any) => m.kind === "response" && m.id === "warmup") && Date.now() - tw < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const durations: number[] = [];
    let sessionsReturned: number | null = null;
    for (let i = 0; i < 5; i += 1) {
      const id = `L${i}`;
      const t0 = performance.now();
      ws.send(JSON.stringify({ kind: "command", command: "listSessions", id, args: { limit } }));
      while (!msgs.some((m: any) => m.kind === "response" && m.id === id) && performance.now() - t0 < 10000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const t1 = performance.now();
      durations.push(t1 - t0);
      const resp = msgs.find((m: any) => m.kind === "response" && m.id === id);
      if (resp?.result && Array.isArray(resp.result.sessions)) {
        sessionsReturned = resp.result.sessions.length;
      }
    }
    const sorted = durations.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    return { durationsMs: durations.map((d) => Math.round(d * 100) / 100), p95Ms: Math.round(p95 * 100) / 100, sessionsReturned };
  }, { wsUrl: POC_WS_URL, limit });
}

test.describe("TK-126 listSessions performance integration (@integration)", () => {
  test("TC-12640 — 50 persisted sessions, listSessions(limit=50) p95 <= 200ms", async ({ page }) => {
    test.skip(process.env.PROCWAY_FIXTURE_SESSION_COUNT !== "50", "TC-12640 requires PROCWAY_FIXTURE_SESSION_COUNT=50");
    await gotoConnected(page);
    const { durationsMs, p95Ms, sessionsReturned } = await measureListSessions(page, 50);
    expect(sessionsReturned).toBe(50);
    expect(p95Ms).toBeLessThanOrEqual(200);
    test.info().annotations.push({ type: "perf", description: `durations=${JSON.stringify(durationsMs)} p95=${p95Ms}ms threshold=200ms` });
  });

  test("TC-12641 — 200 persisted sessions, listSessions(limit=200) p95 <= 500ms", async ({ page }) => {
    test.skip(process.env.PROCWAY_FIXTURE_SESSION_COUNT !== "200", "TC-12641 requires PROCWAY_FIXTURE_SESSION_COUNT=200");
    await gotoConnected(page);
    const { durationsMs, p95Ms, sessionsReturned } = await measureListSessions(page, 200);
    expect(sessionsReturned).toBe(200);
    expect(p95Ms).toBeLessThanOrEqual(500);
    test.info().annotations.push({ type: "perf", description: `durations=${JSON.stringify(durationsMs)} p95=${p95Ms}ms threshold=500ms` });
  });
});
