import { randomInt } from "node:crypto";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import type { ChatReply, InteractiveMessage } from "../src/shared/chat-protocol";

type ReplyProbe = {
  peers: RTCPeerConnection[];
  channels: Array<{ peer: RTCPeerConnection; channel: RTCDataChannel }>;
  sent: InteractiveMessage[];
  duplicate: boolean;
  dropReceipts: boolean;
  uploads: number;
  replyCapabilityAnnouncedAt?: number;
};
declare global { interface Window { __replyProbe: ReplyProbe } }

const gif = Buffer.from("47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b", "hex");
const image = (name = "reply.gif") => ({ name, mimeType: "image/gif", buffer: gif });

async function probe(page: Page, legacyReplies = false) {
  await page.addInitScript((legacy) => {
    const state: ReplyProbe = { peers: [], channels: [], sent: [], duplicate: false, dropReceipts: false, uploads: 0 };
    window.__replyProbe = state;
    if (legacy) {
      const send = RTCDataChannel.prototype.send as (data: unknown) => void;
      Object.defineProperty(RTCDataChannel.prototype, "send", { value(this: RTCDataChannel, data: unknown) {
        if (typeof data === "string") try { if (JSON.parse(data).type === "chat-reply-capabilities") return; } catch { /* non-JSON */ }
        send.call(this, data);
      } });
    }
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (init?.method === "POST" && /\/api\/rooms\/\d{4}\/chat-images$/.test(url.pathname)) state.uploads += 1;
      return fetch(input, init);
    };
    const observed = new WeakSet<RTCDataChannel>();
    const attach = (peer: RTCPeerConnection, channel: RTCDataChannel) => {
      if (observed.has(channel)) return;
      observed.add(channel); state.channels.push({ peer, channel });
      if (channel.label === "control") {
        const send = channel.send.bind(channel) as (data: unknown) => void;
        Object.defineProperty(channel, "send", { value(data: unknown) {
          if (typeof data === "string") try {
            if (JSON.parse(data).type === "chat-reply-capabilities") state.replyCapabilityAnnouncedAt = performance.now();
          } catch { /* unrelated control data */ }
          if (state.dropReceipts && typeof data === "string") try {
            const message = JSON.parse(data);
            if (message.type === "chat-received" || message.type === "chat-read") return;
          } catch { /* unrelated control data */ }
          send(data);
        } });
      }
      if (channel.label !== "interactive") return;
      const send = channel.send.bind(channel) as (data: unknown) => void;
      Object.defineProperty(channel, "send", { value(data: unknown) {
        let reply = false;
        if (typeof data === "string") try {
          const message = JSON.parse(data);
          if (message.type === "chat" || message.type === "chat-rich") state.sent.push(message);
          reply = message.type === "chat-rich" && message.version === 2;
        } catch { /* unrelated interactive data */ }
        send(data);
        if (reply && state.duplicate) send(data);
      } });
    };
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      state.peers.push(peer);
      const create = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (...parameters) => { const channel = create(...parameters); attach(peer, channel); return channel; };
      peer.addEventListener("datachannel", ({ channel }) => attach(peer, channel));
      return peer;
    } });
  }, legacyReplies);
}

async function connected(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__replyProbe.channels
    .filter(({ peer, channel }) => peer.connectionState === "connected" && channel.readyState === "open")
    .map(({ channel }) => channel.label).sort()), { timeout: 40_000 })
    .toEqual(["bulk", "collaboration", "control", "interactive"]);
}
async function editor(page: Page) {
  await page.bringToFront();
  if (new URL(page.url()).hash !== "#chat") await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe("#chat");
  await expect(page.getByRole("button", { name: "Drop, paste, or choose files", exact: true })).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "Write a message", exact: true });
  await expect(input).toBeEditable();
  return input;
}
const entry = (page: Page, id: string) => page.locator("[data-chat-entry-id]").filter({ has: page.locator(`[data-chat-reply-target="${id}"]`) });
const message = (page: Page, text: string) => page.locator("[data-chat-entry-id]").filter({ hasText: text });
async function send(page: Page, text: string) { const input = await editor(page); await input.fill(text); await input.press("Enter"); }
async function reply(page: Page, text: string) {
  const original = message(page, text);
  await original.hover();
  await original.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.locator("[data-chat-reply-draft]")).toContainText(text);
  await expect(await editor(page)).toBeFocused();
  return original.getAttribute("data-chat-entry-id") as Promise<string>;
}
async function latestReply(page: Page) {
  return page.evaluate(() => {
    const value = window.__replyProbe.sent.filter((item) => item.type === "chat-rich" && item.version === 2).at(-1);
    return value?.type === "chat-rich" && value.version === 2 ? value : null;
  });
}

const test = base.extend<{ pair: { alice: Page; bob: Page } }>({ pair: async ({ browser }, use, info) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(); pages.push(page); await probe(page);
    }
    const [alice, bob] = pages;
    const room = randomInt(1000, 10000);
    await bob.goto(`/en/room/${room}#chat`); await alice.goto(`/en/room/${room}#chat`);
    await Promise.all(pages.map(connected));
    await send(alice, "alice-ready"); await expect(message(bob, "alice-ready")).toBeVisible();
    await send(bob, "bob-ready"); await expect(message(alice, "bob-ready")).toBeVisible();
    await use({ alice, bob });
  } finally {
    if (info.status !== info.expectedStatus) await info.attach("reply-diagnostics", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(await Promise.all(pages.map((page) => page.evaluate(() => ({
        sent: window.__replyProbe?.sent.map((item) => ({ id: item.id, type: item.type, version: item.type === "chat-rich" ? item.version : undefined })),
        peers: window.__replyProbe?.peers.map((peer) => ({ state: peer.connectionState, signaling: peer.signalingState })),
      })).catch(() => ({ closed: true })))), null, 2)),
    }).catch(() => undefined);
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
} });

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test("quotes either participant with one snapshot level and preserves plain text wire format", async ({ pair: { alice, bob } }) => {
  const originalId = await reply(bob, "alice-ready");
  await send(bob, "bob-replies-to-alice");
  const received = entry(alice, originalId);
  await expect(received).toContainText("bob-replies-to-alice");
  await expect(received.locator("[data-chat-reply-target]")).toContainText("You");
  expect((await latestReply(bob))?.reply).toEqual({ messageId: originalId, author: "recipient", text: "alice-ready", imageCount: 0 });
  await reply(alice, "bob-replies-to-alice");
  await send(alice, "alice-replies-to-reply");
  const nested = await latestReply(alice);
  expect(nested?.reply.text).toBe("bob-replies-to-alice");
  expect(nested?.reply).not.toHaveProperty("reply");
  await expect(message(bob, "alice-replies-to-reply").locator("[data-chat-reply-target]")).toContainText("You");
  await reply(alice, "alice-replies-to-reply"); await send(alice, "self-reply");
  expect((await latestReply(alice))?.reply.author).toBe("sender");
  await expect(message(bob, "self-reply").locator("[data-chat-reply-target]")).toContainText("Other participant");
  await send(bob, "still-legacy-plain-text");
  expect(await bob.evaluate(() => window.__replyProbe.sent.at(-1))).toMatchObject({ type: "chat", text: "still-legacy-plain-text" });
});

test("replaces and cancels a reply without clearing image drafts, workspace changes or composing Enter", async ({ pair: { alice, bob } }) => {
  await reply(alice, "bob-ready");
  let input = await editor(alice);
  await input.fill("preserved-draft");
  await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image());
  await expect(input.locator("img")).toHaveCount(1);
  await expect(input.locator('[role="status"]')).toHaveCount(0);
  await alice.getByRole("button", { name: "Files", exact: true }).click();
  input = await editor(alice);
  await expect(input).toContainText("preserved-draft");
  await expect(input.locator("img")).toHaveCount(1);
  await expect(alice.locator("[data-chat-reply-draft]")).toContainText("bob-ready");
  await reply(alice, "alice-ready");
  await expect(alice.locator("[data-chat-reply-draft]")).not.toContainText("bob-ready");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  await expect(alice.locator("[data-chat-reply-draft]")).toBeVisible();
  expect(await alice.evaluate(() => window.__replyProbe.uploads)).toBe(0);
  await alice.getByRole("button", { name: "Cancel reply", exact: true }).click();
  await expect(alice.locator("[data-chat-reply-draft]")).toHaveCount(0);
  await expect(input).toContainText("preserved-draft"); await expect(input.locator("img")).toHaveCount(1);
  await reply(alice, "bob-ready");
  await input.press("Control+End"); await input.press("Shift+Enter"); await input.pressSequentially("next-line");
  await input.press("Enter");
  const sent = message(bob, "preserved-draft");
  await expect(sent).toContainText("next-line");
  await expect(sent.getByRole("button", { name: /^Preview image:/ })).toBeVisible({ timeout: 30_000 });
  await expect(alice.locator("[data-chat-reply-draft]")).toHaveCount(0);
});

test("reveals quoted history beyond the render window and handles missing history after refresh", async ({ pair: { alice, bob } }) => {
  await alice.evaluate(() => {
    const channel = window.__replyProbe.channels.find(({ peer, channel }) => peer.connectionState === "connected" && channel.label === "interactive")!.channel;
    channel.send(JSON.stringify({ type: "chat", id: "a-original", text: "older-than-render-window" }));
  });
  await expect(message(bob, "older-than-render-window")).toBeVisible();
  await reply(bob, "older-than-render-window");
  await alice.evaluate(() => {
    const channel = window.__replyProbe.channels.find(({ peer, channel }) => peer.connectionState === "connected" && channel.label === "interactive")!.channel;
    for (let index = 0; index < 55; index += 1) channel.send(JSON.stringify({ type: "chat", id: `b-filler-${String(index).padStart(3, "0")}`, text: `history-filler-${index}` }));
  });
  await expect(message(bob, "history-filler-54")).toBeVisible();
  await expect(bob.locator('[data-chat-entry-id="a-original"]')).toHaveCount(0);
  await alice.reload(); await Promise.all([connected(alice), connected(bob)]);
  await send(bob, "jump-to-old-original");
  const reference = bob.locator('[data-chat-entry-id] [data-chat-reply-target="a-original"]');
  await expect(reference).toBeVisible();
  const scrollY = await bob.evaluate(() => window.scrollY);
  await reference.click();
  await expect(bob.locator('[data-chat-entry-id="a-original"]')).toBeVisible();
  await expect.poll(() => bob.locator('[data-chat-entry-id="a-original"]').evaluate((element) => {
    const viewport = element.closest("[data-overlayscrollbars-viewport]") ?? element.closest("[data-workspace-scroll]");
    if (!viewport) return false;
    const target = element.getBoundingClientRect(); const bounds = viewport.getBoundingClientRect();
    return target.top >= bounds.top && target.bottom <= bounds.bottom;
  })).toBe(true);
  expect(await bob.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(entry(alice, "a-original")).toContainText("older-than-render-window");
  await entry(alice, "a-original").locator("[data-chat-reply-target]").click();
  await expect(alice.getByText("The original message is not in this chat history.", { exact: true })).toBeVisible();
});

test("retries a quoted image upload once, deduplicates delivery and keeps the snapshot through ICE recovery", async ({ pair: { alice, bob } }) => {
  const reads: string[] = [];
  bob.on("response", (response) => { if (response.request().method() === "GET" && new URL(response.url()).pathname.startsWith("/api/chat-images/")) reads.push(response.url()); });
  await (await editor(bob)).fill("image-source");
  await bob.getByLabel("Choose images", { exact: true }).setInputFiles(image("source.gif"));
  await expect((await editor(bob)).locator('[role="status"]')).toHaveCount(0);
  await bob.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(message(alice, "image-source").getByRole("button", { name: /^Preview image:/ })).toBeVisible({ timeout: 30_000 });
  const originalId = await reply(alice, "image-source");
  let failed = false;
  await alice.route(/\/api\/rooms\/\d{4}\/chat-images$/, async (route) => {
    if (route.request().method() === "POST" && !failed) { failed = true; await route.fulfill({ status: 503, json: { message: "Injected image upload failure." } }); }
    else await route.continue();
  });
  await alice.evaluate(() => { window.__replyProbe.duplicate = true; });
  await bob.evaluate(() => { window.__replyProbe.dropReceipts = true; });
  await (await editor(alice)).fill("retry-quoted-image");
  await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("retry.gif"));
  await expect((await editor(alice)).locator('[role="status"]')).toHaveCount(0);
  await alice.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(alice.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
  await alice.getByRole("button", { name: "Retry message", exact: true }).click();
  const received = message(bob, "retry-quoted-image");
  await expect(received.getByRole("button", { name: /^Preview image:/ })).toBeVisible({ timeout: 30_000 });
  await expect(received).toHaveCount(1);
  await expect(received.locator("[data-chat-reply-target] img")).toHaveCount(0);
  const snapshot: ChatReply = { messageId: originalId, author: "recipient", text: "image-source", imageCount: 1 };
  expect((await latestReply(alice))?.reply).toEqual(snapshot);
  expect(await alice.evaluate(() => window.__replyProbe.uploads)).toBe(2);
  const peers = await alice.evaluate(() => window.__replyProbe.peers.length);
  const sentReply = await latestReply(alice);
  const attempts = await alice.evaluate((id) => window.__replyProbe.sent.filter((item) => item.id === id).length, sentReply!.id);
  await bob.evaluate(() => { window.__replyProbe.dropReceipts = false; });
  await alice.evaluate(() => {
    const peer = window.__replyProbe.peers.find((peer) => peer.connectionState === "connected")!;
    Object.defineProperty(peer, "connectionState", { configurable: true, value: "failed" });
    peer.close(); peer.dispatchEvent(new Event("connectionstatechange"));
  });
  await expect.poll(() => alice.evaluate(() => window.__replyProbe.peers.length), { timeout: 40_000 }).toBeGreaterThan(peers);
  await Promise.all([connected(alice), connected(bob)]);
  await expect.poll(() => alice.evaluate((id) => window.__replyProbe.sent.filter((item) => item.id === id).length, sentReply!.id)).toBeGreaterThan(attempts);
  expect(await alice.evaluate((id) => window.__replyProbe.sent.filter((item) => item.id === id), sentReply!.id)).toEqual(expect.arrayContaining([sentReply, sentReply]));
  await expect(received).toHaveCount(1);
  await send(bob, "after-quoted-ice-recovery"); await expect(message(alice, "after-quoted-ice-recovery")).toBeVisible();
  await expect(received.locator(`[data-chat-reply-target="${originalId}"]`)).toContainText("image-source");
  expect(await alice.evaluate(() => window.__replyProbe.uploads)).toBe(2);
  expect((await latestReply(alice))?.reply).toEqual(snapshot);
  const readCount = reads.length;
  await bob.clock.setFixedTime(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
  await bob.getByRole("button", { name: "Files", exact: true }).click(); await editor(bob);
  await expect(received.getByText("Image expired", { exact: true })).toBeVisible();
  await expect(received.locator(`[data-chat-reply-target="${originalId}"]`)).toContainText("image-source");
  await expect(received.locator("[data-chat-reply-target] img")).toHaveCount(0);
  expect(reads).toHaveLength(readCount);
});

test("keeps ordinary images compatible with an older peer and retains a rejected reply draft", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [alice, bob] = await Promise.all(contexts.map((context) => context.newPage()));
    await Promise.all([probe(alice, true), probe(bob, true)]);
    const room = randomInt(1000, 10000);
    await bob.goto(`/en/room/${room}#chat`); await alice.goto(`/en/room/${room}#chat`);
    await Promise.all([connected(alice), connected(bob)]);
    await send(bob, "legacy-source"); await expect(message(alice, "legacy-source")).toBeVisible();
    await (await editor(alice)).fill("legacy-image-still-supported");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image());
    await expect((await editor(alice)).locator('[role="status"]')).toHaveCount(0);
    await alice.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(message(bob, "legacy-image-still-supported").getByRole("button", { name: /^Preview image:/ })).toBeVisible({ timeout: 30_000 });
    expect(await alice.evaluate(() => window.__replyProbe.sent.at(-1))).toMatchObject({ type: "chat-rich", version: 1 });
    // This scenario exercises an explicitly unsupported peer, rather than a
    // reply legitimately queued while capability discovery is still pending.
    await expect.poll(() => alice.evaluate(() => {
      const announced = window.__replyProbe.replyCapabilityAnnouncedAt;
      return announced !== undefined && performance.now() - announced > 2_100;
    })).toBe(true);
    await reply(alice, "legacy-source");
    await send(alice, "rejected-quote-kept-in-editor");
    await expect(alice.getByRole("alert")).toContainText("refresh before receiving replies");
    await expect(alice.locator("[data-chat-reply-draft]")).toContainText("legacy-source");
    await expect(await editor(alice)).toContainText("rejected-quote-kept-in-editor");
    await expect(message(bob, "rejected-quote-kept-in-editor")).toHaveCount(0);
  } finally { await Promise.allSettled(contexts.map((context) => context.close())); }
});

test("shows accessible replies in English dark desktop and Chinese light touch layouts with native scrolling", async ({ browser }, info) => {
  for (const appearance of [
    { locale: "en", theme: "midnight-drift", width: 1280, height: 900, touch: false },
    { locale: "zh", theme: "seeker-blue", width: 375, height: 812, touch: true },
  ] as const) {
    const context = await browser.newContext({ viewport: { width: appearance.width, height: appearance.height }, hasTouch: appearance.touch, reducedMotion: "reduce" });
    const otherContext = await browser.newContext();
    try {
      const page = await context.newPage(); const other = await otherContext.newPage();
      await Promise.all([probe(page), probe(other)]);
      await page.addInitScript(({ theme, native }) => {
        localStorage.setItem("zestsend-theme", theme);
        if (native) {
          Object.defineProperty(navigator, "platform", { value: "MacIntel" });
          Object.defineProperty(navigator, "userAgentData", { value: { platform: "macOS" } });
        }
      }, { theme: appearance.theme, native: appearance.touch });
      const room = randomInt(1000, 10000);
      await other.goto(`/en/room/${room}#chat`); await page.goto(`/${appearance.locale}/room/${room}#chat`);
      await Promise.all([connected(page), connected(other)]);
      await send(other, "localized-reply-original");
      await expect(message(page, "localized-reply-original")).toBeVisible();
      const originalId = await message(page, "localized-reply-original").getAttribute("data-chat-entry-id");
      const target = page.locator(`[data-chat-entry-id="${originalId}"]`);
      const replyButton = target.getByRole("button", { name: appearance.locale === "zh" ? "回复" : "Reply", exact: true });
      if (appearance.touch) await expect(replyButton).toHaveCSS("opacity", "1");
      else { await replyButton.focus(); await expect(replyButton).toBeFocused(); }
      await replyButton.click();
      const input = page.getByRole("textbox", { name: appearance.locale === "zh" ? "输入消息" : "Write a message", exact: true });
      await expect(input).toBeFocused();
      await input.fill("localized-reply-body"); await input.press("Enter");
      await expect(message(other, "localized-reply-body")).toBeVisible();
      const received = message(page, "localized-reply-body");
      await received.locator("[data-chat-reply-target] button").click();
      await expect(target).toHaveAttribute("data-chat-highlighted", "true");
      await expect.poll(() => target.evaluate((element) => {
        const viewport = element.closest("[data-overlayscrollbars-viewport]") ?? element.closest("[data-workspace-scroll]");
        const bounds = viewport!.getBoundingClientRect(); const rect = element.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      })).toBe(true);
      await other.getByLabel("Choose images", { exact: true }).setInputFiles(image("pure-image.gif"));
      await expect((await editor(other)).locator('[role="status"]')).toHaveCount(0);
      await other.getByRole("button", { name: "Send message", exact: true }).click();
      const pureImage = page.getByRole("button", { name: appearance.locale === "zh" ? "查看图片: pure-image.gif" : "Preview image: pure-image.gif", exact: true });
      await expect(pureImage).toBeVisible({ timeout: 30_000 });
      const pureMessage = pureImage.locator("xpath=ancestor::*[@data-chat-entry-id]");
      await pureMessage.getByRole("button", { name: appearance.locale === "zh" ? "回复" : "Reply", exact: true }).click();
      const draft = page.locator("[data-chat-reply-draft]");
      await expect(draft).toContainText(appearance.locale === "zh" ? "[图片]" : "[Image]");
      await expect(draft.locator("img")).toHaveCount(0);
      await expect(page.getByRole("button", { name: appearance.locale === "zh" ? "发送消息" : "Send message", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(appearance.width);
      const screenshot = info.outputPath(`reply-${appearance.locale}-${appearance.theme}-${appearance.width}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach(`reply-${appearance.locale}-${appearance.theme}-${appearance.width}`, { path: screenshot, contentType: "image/png" });
    } finally { await Promise.allSettled([context.close(), otherContext.close()]); }
  }
});
