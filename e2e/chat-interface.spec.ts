import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const roomNumber = () => String(randomInt(1000, 10000));

const connectionLabels = {
  en: {
    room: "Room",
    waiting: "Waiting for the other participant",
    connected: "Peer-to-peer connection established",
    steps: ["Request server connection information", "WebSocket signaling", "STUN server", "TURN server", "P2P connection", "Data channel"],
  },
  zh: {
    room: "房间",
    waiting: "等待对方加入",
    connected: "端对端连接已建立",
    steps: ["请求服务器连接信息", "WebSocket 信令", "STUN 服务器", "TURN 服务器", "P2P 连接", "数据通道"],
  },
} as const;

const statusTrigger = (page: Page) => page.locator("header [data-room-status-trigger]");
const statusPanel = (page: Page) => page.locator("[data-room-status-panel]");
const connectionToggle = (page: Page) => page.locator("header [data-room-connection-toggle]");

async function editor(page: Page, locale: "en" | "zh" = "en") {
  const input = page.getByRole("textbox", { name: locale === "zh" ? "输入消息" : "Write a message", exact: true });
  if (!await input.isVisible()) await page.getByRole("button", { name: locale === "zh" ? "聊天" : "Chat", exact: true }).click();
  await expect(input).toBeVisible();
  return input;
}

// Two complete 1x1 GIF frames with a loop extension. Keeping exact bytes proves
// the default image path preserves GIF animation rather than using the canvas.
const animatedGif = Buffer.from(
  "47494638396101000100800000000000ffffff"
  + "21ff0b4e45545343415045322e300301000000"
  + "21f904000a0000002c0000000001000100000202440100"
  + "21f904000a0000002c00000000010001000002024c01003b",
  "hex",
);

test.describe("chat interface and solo image queue", () => {
  test("keeps room status aligned with the independent connection display at all widths", async ({ browser }, info) => {
    for (const locale of ["en", "zh"] as const) for (const theme of ["midnight-drift", "seeker-blue"]) {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      const page = await context.newPage();
      try {
        // ThemeProvider reads this stored theme and exposes data-theme on html.
        await page.addInitScript((id) => localStorage.setItem("zestsend-theme", id), theme);
        const roomId = roomNumber();
        await page.goto(`/${locale}/room/${roomId}#status`);
        await expect(page).toHaveURL(/#chat$/);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const input = await editor(page, locale);
        const trigger = statusTrigger(page);
        const panel = statusPanel(page);
        const rates = connectionToggle(page);
        const logo = page.locator("header").getByRole("link", { name: "ZestSend", exact: true });
        const labels = connectionLabels[locale];
        await expect(trigger).toHaveAccessibleName(new RegExp(`${labels.room}\\s+${roomId}`, "i"));
        expect(await trigger.evaluate((button) => button.tagName)).toBe("BUTTON");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(panel).toBeHidden();
        await expect(rates).toHaveAccessibleName("Show transfer rates");

        for (const width of [320, 375, 1280]) {
          await page.setViewportSize({ width, height: 812 });
          const [logoBounds, triggerBounds, rateBounds] = await Promise.all([logo.boundingBox(), trigger.boundingBox(), rates.boundingBox()]);
          if (!logoBounds || !triggerBounds || !rateBounds) throw new Error("The room header controls are missing.");
          expect(triggerBounds.x + triggerBounds.width).toBeLessThanOrEqual(rateBounds.x + 1);
          expect(rateBounds.x + rateBounds.width).toBeLessThanOrEqual(width + 1);
          const controlsTop = Math.max(triggerBounds.y, rateBounds.y);
          const controlsBottom = Math.min(triggerBounds.y + triggerBounds.height, rateBounds.y + rateBounds.height);
          expect(controlsTop).toBeLessThan(controlsBottom);
          if (width === 1280) {
            expect(triggerBounds.x).toBeGreaterThanOrEqual(logoBounds.x + logoBounds.width - 1);
            expect(Math.max(controlsTop, logoBounds.y)).toBeLessThan(Math.min(controlsBottom, logoBounds.y + logoBounds.height));
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        }

        await page.setViewportSize({ width: 375, height: 812 });
        await rates.click();
        await expect(rates).toHaveAccessibleName("Show connection quality");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(panel).toBeHidden();

        await trigger.click();
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(panel).toBeVisible();
        await expect(panel.getByText(labels.waiting, { exact: true })).toBeVisible();
        await expect(rates).toHaveAccessibleName("Show connection quality");
        for (const label of labels.steps) await expect(panel.getByText(label, { exact: true })).toBeVisible();
        await expect(panel.getByRole("button", { name: /^(Share|分享|Exit|退出)$/ })).toHaveCount(0);
        const dock = page.locator(".zest-room-dock");
        await expect(dock.getByRole("button", { name: /^(Connection status|连接状态)$/ })).toHaveCount(0);
        const exit = dock.getByRole("button", { name: locale === "zh" ? "退出房间" : "Exit room", exact: true });
        await expect(exit).toBeVisible();
        const bounds = await panel.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
        await info.attach(`${locale}-${theme}-375x812`, { body: await page.screenshot(), contentType: "image/png" });

        await rates.click();
        await expect(rates).toHaveAccessibleName("Show transfer rates");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(panel).toBeVisible();

        if (locale === "en" && theme === "seeker-blue") {
          await page.setViewportSize({ width: 320, height: 440 });
          const shortBounds = await panel.boundingBox();
          if (!shortBounds) throw new Error("The room status panel is missing.");
          expect(shortBounds.x).toBeGreaterThanOrEqual(0);
          expect(shortBounds.y).toBeGreaterThanOrEqual(0);
          expect(shortBounds.x + shortBounds.width).toBeLessThanOrEqual(321);
          expect(shortBounds.y + shortBounds.height).toBeLessThanOrEqual(441);
          await panel.hover();
          await page.mouse.wheel(0, 300);
          await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          await page.setViewportSize({ width: 375, height: 812 });
        }

        await panel.focus();
        await page.keyboard.press("Escape");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(panel).toBeHidden();
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(panel).toBeVisible();
        await page.mouse.click(2, 2);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(panel).toBeHidden();
        await expect(rates).toHaveAccessibleName("Show transfer rates");

        await input.click();
        await input.pressSequentially("Ready to chat");
        await expect(input).toHaveText("Ready to chat");
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          page.getByRole("button", { name: locale === "zh" ? "添加文件" : "Add files", exact: true }).click(),
        ]);
        await chooser.setFiles({ name: "header-status.txt", mimeType: "text/plain", buffer: Buffer.from("header status") });
        await expect(page.locator("[data-chat-file-draft]").getByText("header-status.txt", { exact: true })).toBeVisible();

        await exit.click();
        await expect(page.getByRole("heading", { name: locale === "zh" ? "确认退出房间？" : "Leave this room?", exact: true })).toBeVisible();
        await page.getByRole("button", { name: locale === "zh" ? "留在房间" : "Stay in room", exact: true }).click();
        await expect(await editor(page, locale)).toBeVisible();
      } finally { await context.close(); }
    }
  });

  for (const firstLocale of ["en", "zh"] as const) {
    test(`keeps the ${firstLocale} room status open while a peer joins`, async ({ browser }) => {
      const secondLocale = firstLocale === "en" ? "zh" : "en";
      const [firstContext, secondContext] = await Promise.all([browser.newContext(), browser.newContext()]);
      try {
        const [first, second] = await Promise.all([firstContext.newPage(), secondContext.newPage()]);
        const roomId = roomNumber();
        await first.goto(`/${firstLocale}/room/${roomId}#chat`);
        await editor(first, firstLocale);
        await statusTrigger(first).click();
        await expect(statusTrigger(first)).toHaveAttribute("aria-expanded", "true");
        await expect(statusPanel(first).getByText(connectionLabels[firstLocale].waiting, { exact: true })).toBeVisible();

        await second.goto(`/${secondLocale}/room/${roomId}#chat`);
        await editor(second, secondLocale);
        await statusTrigger(second).click();
        for (const [page, locale] of [[first, firstLocale], [second, secondLocale]] as const) {
          await expect(statusPanel(page).getByText(connectionLabels[locale].connected, { exact: true })).toBeVisible({ timeout: 40_000 });
          await expect(statusTrigger(page)).toHaveAttribute("aria-expanded", "true");
          await statusTrigger(page).click();
          await expect(statusPanel(page)).toBeHidden();
        }

        const input = await editor(first, firstLocale);
        await input.click();
        await input.fill("Chat after checking the connection");
        await input.press("Enter");
        await expect(second.locator("[data-chat-message-id]").getByText("Chat after checking the connection", { exact: true })).toBeVisible();
      } finally { await Promise.allSettled([firstContext.close(), secondContext.close()]); }
    });
  }

  test("uploads a pure GIF while alone, delivers it to a later participant, and preserves text send shortcuts", async ({ browser }, info) => {
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    try {
      const roomId = roomNumber();
      await alice.goto(`/en/room/${roomId}#chat`);
      await editor(alice);
      await expect(alice.getByText("The other participant has not joined yet — messages will sync once they join.", { exact: true })).toBeVisible();
      await alice.getByLabel("Choose images", { exact: true }).setInputFiles({ name: "solo-animation.gif", mimeType: "image/gif", buffer: animatedGif });
      const send = alice.getByRole("button", { name: "Send message", exact: true });
      await expect((await editor(alice)).locator("img")).toHaveCount(1);
      await expect((await editor(alice)).locator('[role="status"]')).toHaveCount(0, { timeout: 30_000 });
      await expect(send).toBeEnabled();
      const uploaded = alice.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/rooms/${roomId}/chat-images`);
      await send.click();
      const response = await uploaded;
      expect(response.status()).toBe(201);
      const { mimeType, size } = await response.json();
      expect({ mimeType, size }).toEqual({ mimeType: "image/gif", size: animatedGif.length });
      await expect(alice.getByText(/^(Uploading images|Images queued until the room reconnects)/)).toHaveCount(0);
      await expect(alice.locator('[data-chat-kind="rich"]')).toHaveCount(1);
      await info.attach("solo-uploaded-before-peer", { body: await alice.screenshot(), contentType: "image/png" });

      await bob.goto(`/en/room/${roomId}#chat`);
      await editor(bob);
      const received = bob.locator('[data-chat-message-id][data-chat-kind="rich"]');
      await expect(received).toHaveCount(1, { timeout: 40_000 });
      await expect(received.getByRole("button", { name: "Preview image: solo-animation.gif", exact: true })).toBeVisible({ timeout: 30_000 });
      expect((await received.locator('[data-chat-content="rich"] > p').allTextContents()).filter((text) => text.replace(/\u00a0/g, "").trim())).toEqual([]);
      const bytes = await received.locator("img").evaluate(async (image: HTMLImageElement) =>
        Array.from(new Uint8Array(await (await fetch(image.src)).arrayBuffer())));
      expect(Buffer.from(bytes).equals(animatedGif)).toBe(true);

      // A response from Bob is a stronger connection barrier than ready labels.
      const reply = `solo-reply-${roomId}`;
      await (await editor(bob)).fill(reply);
      await (await editor(bob)).press("Enter");
      await expect(alice.locator('[data-chat-message-id][data-chat-kind="text"]').filter({ hasText: reply })).toBeVisible();
      const input = await editor(alice);
      const first = `line-one-${roomId}`;
      const second = `line-two-${roomId}`;
      await input.fill(first);
      await input.press("Shift+Enter");
      await input.pressSequentially(second);
      expect((await input.innerText()).trim()).toBe(`${first}\n${second}`);
      await expect(bob.locator('[data-chat-kind="text"]').filter({ hasText: first })).toHaveCount(0);
      await input.press("Enter");
      const text = bob.locator('[data-chat-message-id][data-chat-kind="text"]').filter({ hasText: first });
      await expect(text).toBeVisible();
      await expect(text).toContainText(second);
      await expect(text.locator('[data-chat-content="rich"]')).toHaveCount(0);
      await expect(input).toBeEmpty();
      await info.attach("late-peer-gif-and-text", { body: await bob.screenshot(), contentType: "image/png" });
    } finally { await Promise.allSettled([aliceContext.close(), bobContext.close()]); }
  });
});
