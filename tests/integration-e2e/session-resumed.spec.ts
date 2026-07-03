/**
 * TK-126 integration-e2e — session.resumed event (TC-12614, 12615, 12616, 12617)
 *
 * See loadSession.spec.ts for run instructions and prerequisites.
 */
import { test, expect, type Page } from "@playwright/test";
import { POC_PAGE_URL, POC_WS_URL } from "./helpers/setup.mjs";

async function gotoConnected(page: Page): Promise<void> {
  await page.goto(POC_PAGE_URL);
  await expect(page.locator("#status")).toHaveText(/connected/i, { timeout: 10_000 });
}

async function loadAndCollect(page: Page, sessionId: string) {
  return page.evaluate(async ({ wsUrl, sessionId }) => {
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
    ws.send(JSON.stringify({ kind: "command", command: "loadSession", id: "R1", args: { sessionId } }));
    const t0 = Date.now();
    while (!msgs.some((m: any) => m.kind === "response" && m.id === "R1") && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // additional history call for shape-equality check
    ws.send(JSON.stringify({ kind: "command", command: "history", id: "H1" }));
    const t1 = Date.now();
    while (!msgs.some((m: any) => m.kind === "response" && m.id === "H1") && Date.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300));
    const post = msgs.slice(offset);
    return {
      post,
      response: post.find((m: any) => m.kind === "response" && m.id === "R1"),
      historyResponse: post.find((m: any) => m.kind === "response" && m.id === "H1"),
      sessionResumedEvents: post.filter((m: any) => m.kind === "event" && m.event?.type === "session.resumed")
    };
  }, { wsUrl: POC_WS_URL, sessionId });
}

test.describe("TK-126 session.resumed event integration (@integration)", () => {
  test("TC-12614 — session.resumed is sent BEFORE the loadSession response", async ({ page }) => {
    await gotoConnected(page);
    const { post } = await loadAndCollect(page, "S-RESUME");
    const resumedIdx = post.findIndex((m: any) => m.kind === "event" && m.event?.type === "session.resumed");
    const responseIdx = post.findIndex((m: any) => m.kind === "response" && m.id === "R1");
    expect(resumedIdx).toBeGreaterThanOrEqual(0);
    expect(responseIdx).toBeGreaterThan(resumedIdx);
  });

  test("TC-12615 — session.resumed.event.messages is JSON-equal to history.transcript", async ({ page }) => {
    await gotoConnected(page);
    const { sessionResumedEvents, historyResponse } = await loadAndCollect(page, "S-CONS");
    expect(sessionResumedEvents).toHaveLength(1);
    const resumedMsgs = sessionResumedEvents[0].event.messages;
    const transcript = historyResponse?.result?.transcript;
    expect(JSON.stringify(resumedMsgs)).toBe(JSON.stringify(transcript));
    expect(resumedMsgs).toHaveLength(3);
  });

  test("TC-12616 — exactly one session.resumed event per loadSession", async ({ page }) => {
    await gotoConnected(page);
    const { sessionResumedEvents } = await loadAndCollect(page, "S-DUP");
    expect(sessionResumedEvents.length).toBe(1);
  });

  test("TC-12617 — empty session loads with messages=[] and messageCount=0", async ({ page }) => {
    await gotoConnected(page);
    const { sessionResumedEvents, response } = await loadAndCollect(page, "S-EMPTY");
    expect(sessionResumedEvents).toHaveLength(1);
    expect(Array.isArray(sessionResumedEvents[0].event.messages)).toBe(true);
    expect(sessionResumedEvents[0].event.messages).toHaveLength(0);
    expect(sessionResumedEvents[0].event.messageCount).toBe(0);
    expect(response?.ok).toBe(true);
    expect(response?.result?.sessionId).toBe("S-EMPTY");
    expect(response?.result?.messageCount).toBe(0);
  });
});
