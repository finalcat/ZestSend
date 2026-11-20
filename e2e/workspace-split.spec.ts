import { randomInt } from "node:crypto";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";

type SplitProbe = {
  channels: Array<{ peer: RTCPeerConnection; channel: RTCDataChannel }>;
};
declare global { interface Window { __splitProbe: SplitProbe } }

async function probe(page: Page) {
  await page.addInitScript(() => {
    const state: SplitProbe = { channels: [] };
    window.__splitProbe = state;
    const observed = new WeakSet<RTCDataChannel>();
    const attach = (peer: RTCPeerConnection, channel: RTCDataChannel) => {
      if (observed.has(channel)) return;
      observed.add(channel); state.channels.push({ peer, channel });
    };
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      const create = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (...parameters) => { const channel = create(...parameters); attach(peer, channel); return channel; };
      peer.addEventListener("datachannel", ({ channel }) => attach(peer, channel));
      return peer;
    } });
  });
}

async function connected(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__splitProbe.channels
    .filter(({ peer, channel }) => peer.connectionState === "connected" && channel.readyState === "open")
    .map(({ channel }) => channel.label).sort()), { timeout: 40_000 })
    .toEqual(["bulk", "collaboration", "control", "interactive"]);
}

async function openChat(page: Page) {
  const input = page.getByRole("textbox", { name: "Write a message", exact: true });
  await expect(input).toBeEditable({ timeout: 30_000 });
  return input;
}

async function send(page: Page, text: string) {
  const input = await openChat(page);
  await input.fill(text);
  await input.press("Enter");
}

const message = (page: Page, text: string) => page.locator("[data-chat-entry-id]").filter({ hasText: text });
const dock = (page: Page) => page.locator(".zest-room-dock");
const dockButton = (page: Page, label: string) => dock(page).getByRole("button", { name: label, exact: true });
const chat = (page: Page) => page.getByRole("textbox", { name: "Write a message", exact: true });
const canvas = (page: Page) => page.locator(".zest-canvas-surface");
const collaboration = (page: Page) => page.locator('.zest-collaboration-editor[contenteditable="true"]');
const splitPane = (page: Page) => page.locator("[data-split-pane]");

async function openLegacyWorkspace(page: Page, hash: string) {
  await page.goto(new URL(hash, page.url()).href);
  await expect.poll(() => new URL(page.url()).hash).toBe(hash);
}

/** From the chat workspace, one Canvas dock click opens the split directly. */
async function enterCanvasSplit(page: Page) {
  await dockButton(page, "Canvas").click();
  await expect(page).toHaveURL(/#chat\+canvas$/);
  await expect(splitPane(page)).toHaveCount(1);
  // Wait for the cross-fade to settle so exactly one canvas exists.
  await expect(canvas(page)).toHaveCount(1);
}

const test = base.extend<{ pair: { alice: Page; bob: Page } }>({ pair: async ({ browser }, use) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const context = await browser.newContext({ viewport: { height: 860, width: 1440 } });
      contexts.push(context);
      const page = await context.newPage();
      await probe(page);
      pages.push(page);
    }
    const [alice, bob] = pages;
    const room = randomInt(1000, 10000);
    // A cold dev server compiles modules on demand: the first parallel
    // two-page load can spend most of a minute in vite transforms, so allow
    // ample navigation time (domcontentloaded is enough; the connected()
    // barrier below waits for the real app).
    const navigation = { timeout: 90_000, waitUntil: "domcontentloaded" as const };
    await bob.goto(`/en/room/${room}#chat`, navigation);
    await alice.goto(`/en/room/${room}#chat`, navigation);
    await Promise.all(pages.map(connected));
    // Cross-send barrier: both interactive channels are proven live once each
    // side sees the other's message.
    await send(alice, "alice-ready");
    await expect(message(bob, "alice-ready")).toBeVisible({ timeout: 30_000 });
    await send(bob, "bob-ready");
    await expect(message(alice, "bob-ready")).toBeVisible();
    await use({ alice, bob });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
} });

async function openSoloDesktopChat(page: Page) {
  await page.setViewportSize({ height: 860, width: 1440 });
  await page.goto(`/en/room/${randomInt(1000, 10000)}#chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await openChat(page);
}

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test("desktop dock opens, switches, and closes chat splits", async ({ pair: { alice } }) => {
  for (const label of ["Chat", "Collaborate", "Canvas", "Exit room"]) {
    await expect(dockButton(alice, label)).toBeVisible();
  }
  for (const label of ["Files", "Voice", "Video", "Watch together"]) {
    await expect(dockButton(alice, label)).toHaveCount(0);
  }

  await enterCanvasSplit(alice);
  await expect(chat(alice)).toHaveCount(1);
  await expect(chat(alice)).toBeVisible();
  await expect(canvas(alice)).toBeVisible();

  const dockBackground = (label: string) => dockButton(alice, label).locator("div").first().evaluate((node) => getComputedStyle(node).backgroundColor);
  const idleBackground = await dockBackground("Collaborate");
  for (const label of ["Chat", "Canvas"]) {
    await expect.poll(() => dockBackground(label), { message: `${label} should be highlighted` }).not.toBe(idleBackground);
  }

  await dockButton(alice, "Collaborate").click();
  await expect(alice).toHaveURL(/#chat\+collaborate$/);
  await expect(splitPane(alice)).toHaveCount(1);
  await expect(collaboration(alice)).toBeVisible();
  await expect(canvas(alice)).toHaveCount(0);
  await expect(chat(alice)).toBeVisible();

  await dockButton(alice, "Collaborate").click();
  await expect(alice).toHaveURL(/#chat$/);
  await expect(splitPane(alice)).toHaveCount(0);
  await expect(collaboration(alice)).toHaveCount(0);
  await expect(chat(alice)).toBeVisible();

  await dockButton(alice, "Collaborate").click();
  await expect(alice).toHaveURL(/#chat\+collaborate$/);
  await expect(collaboration(alice)).toBeVisible();
  await enterCanvasSplit(alice);
  await expect(collaboration(alice)).toHaveCount(0);
  await dockButton(alice, "Canvas").click();
  await expect(alice).toHaveURL(/#chat$/);
  await expect(splitPane(alice)).toHaveCount(0);
  await expect(canvas(alice)).toHaveCount(0);
  await expect(chat(alice)).toBeVisible();
});

test("drags the divider within limits and restores the ratio after reload", async ({ page: alice }) => {
  await openSoloDesktopChat(alice);
  await enterCanvasSplit(alice);
  const pane = alice.locator("[data-split-pane]");
  const divider = alice.getByRole("separator");
  await expect(divider).toHaveAttribute("aria-valuenow", "40");

  const chatColumn = pane.locator("section").first();
  const startWidth = await chatColumn.boundingBox();
  const dividerBox = await divider.boundingBox();
  const startX = dividerBox!.x + dividerBox!.width / 2;
  // Drag left by ~260px: the chat column must shrink but never below 25%.
  await alice.mouse.move(startX, dividerBox!.y + dividerBox!.height / 2);
  await alice.mouse.down();
  await alice.mouse.move(startX - 260, dividerBox!.y + dividerBox!.height / 2, { steps: 8 });
  await alice.mouse.up();
  const draggedWidth = await chatColumn.boundingBox();
  expect(draggedWidth!.width).toBeLessThan(startWidth!.width);
  expect(draggedWidth!.width / (await pane.boundingBox())!.width).toBeGreaterThan(0.2);

  const storedRatio = await divider.getAttribute("aria-valuenow");
  await alice.reload();
  await expect(alice.locator("[data-split-pane]")).toBeVisible();
  await expect(alice.getByRole("separator")).toHaveAttribute("aria-valuenow", storedRatio!);
});

test("incoming messages stay unread-free while the chat pane is visible, then rebadge after leaving", async ({ pair: { alice, bob } }) => {
  await enterCanvasSplit(alice);
  await expect(alice.locator("[data-split-pane]")).toBeVisible();

  await send(bob, "while-split");
  await expect(message(alice, "while-split")).toBeVisible();
  await expect(dockButton(alice, "Chat")).not.toContainText("1");

  await openLegacyWorkspace(alice, "#files");
  await expect(alice.getByRole("button", { name: "Drop, paste, or choose files", exact: true })).toBeVisible();
  await expect(alice.locator("[data-split-pane]")).toHaveCount(0);
  await send(bob, "after-split");
  await expect(dockButton(alice, "Chat")).toContainText("1");
  await dockButton(alice, "Chat").click();
  await expect(dockButton(alice, "Chat")).not.toContainText("1");
});

test("draws on the split canvas and strokes survive closing and reopening it", async ({ pair: { alice, bob } }) => {
  await enterCanvasSplit(bob);
  const bobSurface = bob.locator(".zest-canvas-surface");
  await expect(bobSurface).toBeVisible();

  await enterCanvasSplit(alice);
  const surface = alice.locator(".zest-canvas-surface").last();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();

  await alice.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await alice.mouse.down();
  await alice.mouse.move(box!.x + box!.width / 2 + 120, box!.y + box!.height / 2 + 40, { steps: 6 });
  await alice.mouse.up();

  // "> path" counts only stroke paths: the grid <defs><pattern> also contains
  // a path element inside the same svg.
  await expect(bobSurface.locator("> path")).toHaveCount(1, { timeout: 15_000 });
  await expect(surface.locator("> path")).toHaveCount(1);

  await dockButton(alice, "Canvas").click();
  await expect(alice).toHaveURL(/#chat$/);
  await expect(splitPane(alice)).toHaveCount(0);
  await expect(canvas(alice)).toHaveCount(0);

  await enterCanvasSplit(alice);
  await expect(alice.locator(".zest-canvas-surface > path")).toHaveCount(1);
});

test("falls back to a single pane below lg and restores the split when wide again", async ({ page: alice }) => {
  await openSoloDesktopChat(alice);
  await enterCanvasSplit(alice);
  await expect(alice.locator("[data-split-pane]")).toBeVisible();

  // Narrow: the split unmounts to the active workspace (chat) without
  // touching the hash; widening restores the split untouched.
  await alice.setViewportSize({ height: 860, width: 900 });
  await expect(alice.locator("[data-split-pane]")).toHaveCount(0);
  await expect(alice.getByRole("textbox", { name: "Write a message", exact: true }).last()).toBeVisible();
  await expect(alice.locator(".zest-canvas-surface")).toHaveCount(0);
  await expect(alice).toHaveURL(/#chat\+canvas$/);

  await alice.setViewportSize({ height: 860, width: 1440 });
  await expect(alice.locator("[data-split-pane]")).toBeVisible();
  await expect(alice.locator(".zest-canvas-surface").last()).toBeVisible();

  // Below lg a dock click is a plain switch: it drops the split hash, so
  // widening again stays in the single canvas workspace.
  await alice.setViewportSize({ height: 860, width: 900 });
  await expect(alice.locator("[data-split-pane]")).toHaveCount(0);
  await dockButton(alice, "Canvas").click();
  await expect(alice.locator(".zest-canvas-surface")).toHaveCount(1);
  await expect(alice).toHaveURL(/#canvas$/);
  await alice.setViewportSize({ height: 860, width: 1440 });
  await expect(alice.locator("[data-split-pane]")).toHaveCount(0);
  await expect(alice.locator(".zest-canvas-surface")).toHaveCount(1);
});

test("mobile dock keeps one pane and leaves the current pane open on repeat clicks", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { height: 812, width: 375 } });
  const page = await context.newPage();
  try {
    await page.goto(`/en/room/${randomInt(1000, 10000)}#chat+canvas`);
    await expect(chat(page)).toBeEditable({ timeout: 30_000 });
    await expect(splitPane(page)).toHaveCount(0);
    await expect(canvas(page)).toHaveCount(0);

    await dockButton(page, "Canvas").click();
    await expect(page).toHaveURL(/#canvas$/);
    await expect(canvas(page)).toBeVisible();
    await expect(chat(page)).toHaveCount(0);
    await dockButton(page, "Canvas").click();
    await expect(page).toHaveURL(/#canvas$/);
    await expect(canvas(page)).toBeVisible();

    await dockButton(page, "Collaborate").click();
    await expect(page).toHaveURL(/#collaborate$/);
    await expect(collaboration(page)).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    await dockButton(page, "Collaborate").click();
    await expect(page).toHaveURL(/#collaborate$/);
    await expect(collaboration(page)).toBeVisible();

    await dockButton(page, "Canvas").click();
    await expect(page).toHaveURL(/#canvas$/);
    await expect(canvas(page)).toBeVisible();
    await expect(collaboration(page)).toHaveCount(0);
    await expect(splitPane(page)).toHaveCount(0);
    await dockButton(page, "Chat").click();
    await expect(page).toHaveURL(/#chat$/);
    await expect(chat(page)).toBeEditable();
    await expect(canvas(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("legacy workspace links still open their panels without dock entries", async ({ pair: { alice } }) => {
  for (const [hash, button] of [
    ["#files", "Drop, paste, or choose files"],
    ["#voice", "Turn microphone on"],
    ["#video", "Turn camera on"],
    ["#watch", /^Choose local media\b/],
  ] as const) {
    await openLegacyWorkspace(alice, hash);
    await expect(alice.getByRole("button", { name: button, exact: true })).toBeVisible();
    await expect(chat(alice)).toHaveCount(0);
    await expect(splitPane(alice)).toHaveCount(0);
  }

  await dockButton(alice, "Collaborate").click();
  await expect(alice).toHaveURL(/#chat\+collaborate$/);
  await expect(collaboration(alice)).toBeVisible();
  await expect(chat(alice)).toBeVisible();

  await openLegacyWorkspace(alice, "#canvas");
  await expect(canvas(alice)).toBeVisible();
  await expect(splitPane(alice)).toHaveCount(0);
  await expect(chat(alice)).toHaveCount(0);

  await openLegacyWorkspace(alice, "#collaborate");
  await expect(collaboration(alice)).toBeVisible();
  await expect(splitPane(alice)).toHaveCount(0);
  await expect(chat(alice)).toHaveCount(0);
});
