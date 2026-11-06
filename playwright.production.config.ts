import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "output", "playwright", "production-1736995");

/** The production target is intentionally fixed and has no local server fallback. */
export default defineConfig({
  testDir: join(root, "e2e"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: join(output, "results"),
  reporter: [
    ["list"],
    ["html", { outputFolder: join(output, "report"), open: "never" }],
    ["json", { outputFile: join(output, "results.json") }],
  ],
  metadata: {
    accountId: "65640594e6a974afde8dc8b6cfdfe935",
    worker: "zestsend",
    environment: "production",
    site: "https://zestsend.1736995.workers.dev",
    realTurn: true,
  },
  use: {
    baseURL: "https://zestsend.1736995.workers.dev",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      channel: "chromium",
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox"],
    },
  },
  projects: [
    { name: "rich-chat-production", testMatch: "rich-chat.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "chat-interface-production", testMatch: "chat-interface.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "chat-reply-production", testMatch: "chat-reply.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "signaling-production",
      testMatch: "signaling-recovery.spec.ts",
      grep: /full page refresh|5s signaling interruption|20s signaling interruption|ICE failure/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
