import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const roomNumber = () => String(randomInt(1000, 10000));

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
  test("keeps the simplified connection controls usable in both languages and light/dark narrow layouts", async ({ browser }, info) => {
    for (const locale of ["en", "zh"] as const) for (const theme of ["midnight-drift", "seeker-blue"]) {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      const page = await context.newPage();
      try {
        // ThemeProvider reads this stored theme and exposes data-theme on html.
        await page.addInitScript((id) => localStorage.setItem("zestsend-theme", id), theme);
        await page.goto(`/${locale}/room/${roomNumber()}#status`);
        await expect(page).toHaveURL(/#chat$/);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await editor(page, locale);
        const card = page.getByRole("complementary", { name: locale === "zh" ? "正在建立端对端连接" : "Establishing an end-to-end connection", exact: true });
        await expect(card).toBeVisible();
        await expect(card.getByRole("button", { name: /^(Share|分享|Exit|退出)$/ })).toHaveCount(0);
        await expect(card.getByText(locale === "zh" ? "数据通道" : "Data channel", { exact: true })).toBeVisible();
        const dock = page.locator(".zest-room-dock");
        await expect(dock.getByRole("button", { name: /^(Connection status|连接状态)$/ })).toHaveCount(0);
        const exit = dock.getByRole("button", { name: locale === "zh" ? "退出房间" : "Exit room", exact: true });
        await expect(exit).toBeVisible();
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
        await info.attach(`${locale}-${theme}-375x812`, { body: await page.screenshot(), contentType: "image/png" });
        await card.getByRole("button", { name: locale === "zh" ? "收起连接状态" : "Hide connection status", exact: true }).click();
        await expect(card.getByRole("button", { name: locale === "zh" ? "展开连接状态" : "Show connection status", exact: true })).toBeVisible();
        await exit.click();
        await expect(page.getByRole("heading", { name: locale === "zh" ? "确认退出房间？" : "Leave this room?", exact: true })).toBeVisible();
        await page.getByRole("button", { name: locale === "zh" ? "留在房间" : "Stay in room", exact: true }).click();
        await expect(await editor(page, locale)).toBeVisible();
      } finally { await context.close(); }
    }
  });

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
