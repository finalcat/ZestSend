import { randomInt } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { RichChatMessage } from "../src/shared/chat-protocol";

type ImageMemoryProbe = {
  channels: RTCDataChannel[];
  bitmapDecodes: number;
  blobUrls: Set<string>;
  revoked: Set<string>;
};
declare global { interface Window { __imageMemoryProbe: ImageMemoryProbe } }

test.use({ trace: "off", video: "off" });

function pngChunk(name: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(name, "ascii"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function grayscalePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function manyFrameGif(): Buffer {
  // 193 one-pixel frames share a 256×256 logical canvas and exceed 12 Mi pixels.
  const header = Buffer.from("47494638396100010001800000000000ffffff", "hex");
  const frame = Buffer.from("21f90401050000002c0000000001000100000202440100", "hex");
  return Buffer.concat([header, ...Array.from({ length: 193 }, () => frame), Buffer.from([0x3b])]);
}

async function observeMemory(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: ImageMemoryProbe = { channels: [], bitmapDecodes: 0, blobUrls: new Set(), revoked: new Set() };
    window.__imageMemoryProbe = probe;
    window.createImageBitmap = new Proxy(window.createImageBitmap, {
      apply(target, thisArg, args) {
        probe.bitmapDecodes += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      if (object instanceof Blob) probe.blobUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (probe.blobUrls.has(url)) probe.revoked.add(url);
      revoke(url);
    };
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, [configuration], newTarget) {
        const peer = Reflect.construct(target, [{ ...configuration, iceServers: [] }], newTarget) as RTCPeerConnection;
        const createChannel = peer.createDataChannel.bind(peer);
        peer.createDataChannel = (...args) => {
          const channel = createChannel(...args);
          probe.channels.push(channel);
          return channel;
        };
        peer.addEventListener("datachannel", ({ channel }) => probe.channels.push(channel));
        return peer;
      },
    });
  });
}

function roomPath(): string {
  return `/en/room/${randomInt(1000, 10000)}#chat`;
}

async function visitChat(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "Write a message", exact: true })).toBeEditable({ timeout: 30_000 });
}

test("oversized images and animations are rejected before draft decoding", async ({ page }) => {
  await observeMemory(page);
  await visitChat(page, roomPath());
  const assets = [
    { name: "too-wide.png", mimeType: "image/png", buffer: grayscalePng(8193, 2) },
    { name: "frame-budget.gif", mimeType: "image/gif", buffer: manyFrameGif() },
  ];
  const chooser = page.getByLabel("Choose images", { exact: true });
  const composer = page.locator("[data-chat-composer]");
  await chooser.setInputFiles(assets);
  const rejected = composer.locator("[data-chat-image-id]").filter({ hasText: "This image cannot be safely previewed" });
  await expect(rejected).toHaveCount(2);
  await expect(rejected.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__imageMemoryProbe.bitmapDecodes)).toBe(0);
});

test("a narrow conversation fetches visible images lazily and releases previews when scrolled away", async ({ browser }) => {
  const sender = await browser.newContext();
  const reader = await browser.newContext({ viewport: { width: 375, height: 680 }, isMobile: true, hasTouch: true });
  try {
    const [alice, bob] = await Promise.all([sender.newPage(), reader.newPage()]);
    await Promise.all([observeMemory(alice), observeMemory(bob)]);
    const imageBytes = grayscalePng(320, 480);
    const oversized = grayscalePng(8193, 2);
    const expiresAt = Date.now() + 24 * 60 * 60 * 1_000;
    const images = Array.from({ length: 18 }, (_, index) => ({
      imageId: `${expiresAt}-${(index + 1).toString(16).padStart(32, "0")}`,
      readToken: "A".repeat(43), expiresAt,
      name: `history-${index}.png`, mimeType: "image/png" as const,
      size: index === 0 ? oversized.length : imageBytes.length,
      width: 320, height: 480, original: true,
    }));
    const requests: string[] = [];
    let activeRequests = 0;
    let maxConcurrent = 0;
    await bob.route("**/api/chat-images/*", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      activeRequests += 1;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      requests.push(id);
      try {
        // Hold briefly so the probe detects overlapping preview GETs.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await route.fulfill({ contentType: "image/png", body: id === images[0].imageId ? oversized : imageBytes });
      } finally {
        activeRequests -= 1;
      }
    });
    const path = roomPath();
    await visitChat(alice, path);
    await visitChat(bob, path);
    await alice.waitForFunction(() => window.__imageMemoryProbe.channels.some((channel) => channel.label === "interactive" && channel.readyState === "open"), undefined, { timeout: 45_000 });
    const messages = images.map((image, index): RichChatMessage => ({
      type: "chat-rich", version: 1,
      id: `memory-history-${String(index).padStart(3, "0")}`,
      blocks: [{ type: "image", imageId: image.imageId }], images: [image],
    }));
    // Insert older messages behind already-present recent content rather than scrolling them into view on arrival.
    await alice.evaluate((entries) => {
      const channel = window.__imageMemoryProbe.channels.find((item) => item.label === "interactive" && item.readyState === "open")!;
      for (const entry of [...entries].reverse()) channel.send(JSON.stringify(entry));
    }, messages);

    const picture = (index: number) => bob.locator(`[data-chat-image="${images[index].imageId}"]`);
    const old = picture(1);
    const newest = picture(images.length - 1);
    await expect(old).toHaveCount(1);
    await expect(newest.locator("img")).toBeVisible();
    expect(requests).not.toContain(images[0].imageId);
    expect(requests).not.toContain(images[1].imageId);
    const firstPreview = await newest.locator("img").getAttribute("src");
    expect(firstPreview).toMatch(/^blob:/);

    await old.scrollIntoViewIfNeeded();
    await expect(old.locator("img")).toBeVisible();
    await expect(newest.locator("img")).toHaveCount(0);
    await expect.poll(() => bob.evaluate((url) => window.__imageMemoryProbe.revoked.has(url), firstPreview!)).toBe(true);

    const invalid = picture(0);
    await invalid.scrollIntoViewIfNeeded();
    await expect(invalid).toContainText("This image cannot be previewed safely");
    await expect(invalid.locator("img")).toHaveCount(0);
    await expect(invalid.getByRole("button", { name: "Download image", exact: true })).toBeVisible();

    await newest.scrollIntoViewIfNeeded();
    await expect(newest.locator("img")).toBeVisible();
    expect(await newest.locator("img").getAttribute("src")).not.toBe(firstPreview);
    expect(maxConcurrent).toBe(1);
  } finally {
    await Promise.allSettled([sender.close(), reader.close()]);
  }
});
