/**
 * TK-126 integration-e2e Playwright config.
 * The ai-agent package itself does NOT depend on @playwright/test (FR-CONS-1),
 * and `@playwright/test` is not resolvable from files under ai-agent/, so this
 * directory is the REFERENCE copy. The runnable mirror lives at
 * dashboard/tests/procway-code/integration-e2e/ (sync enforced by
 * dashboard/tests/procway-code/sync.test.ts). Run from dashboard/:
 *
 *   npx playwright test --config=tests/procway-code/integration-e2e/playwright.config.ts
 *
 * Server lifecycle (seeding, starting `procway-code serve`, stopping) is
 * managed externally — this config does NOT spawn a webServer.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: process.env.PROCWAY_PW_HTML_DIR ?? "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.PROCWAY_POC_BASE_URL ?? "http://127.0.0.1:4004",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
