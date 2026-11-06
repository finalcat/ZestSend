import { createHash, randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { expect, test as base, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { RichChatMessage } from "../src/shared/chat-protocol";

type UploadRecord = { name: string; mimeType: string; bytes: number; digest: string };
type NetworkRecord = { method: string; path: string; status: number };
type RichProbe = {
  peers: RTCPeerConnection[];
  channels: Array<{ peer: RTCPeerConnection; channel: RTCDataChannel }>;
  sent: RichChatMessage[];
  receivedIds: string[];
  duplicateRich: boolean;
  duplicated: number;
  revokedUrls: Set<string>;
};
declare global { interface Window { __richChatProbe: RichProbe; __recordChatUpload: (record: UploadRecord) => Promise<void> } }

type RichPair = { alice: Page; bob: Page; uploads: UploadRecord[]; network: NetworkRecord[] };
type TestImage = { name: string; mimeType: string; buffer: Buffer };

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit += 1) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});
function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function image(name: string, width = 96, height = 64, noise = false): TestImage {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[offset] = noise ? seed >>> 24 : x % 256;
    pixels[offset + 1] = noise ? seed >>> 16 : y % 256;
    pixels[offset + 2] = noise ? seed >>> 8 : (x + y) % 256;
    pixels[offset + 3] = (x + y) % 3 ? 255 : 128;
  }
  return { name, mimeType: "image/png", buffer: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 1 })), pngChunk("IEND", Buffer.alloc(0)),
  ]) };
}

async function installProbe(page: Page, uploads: UploadRecord[]) {
  await page.exposeFunction("__recordChatUpload", (record: UploadRecord) => { uploads.push(record); });
  await page.addInitScript(() => {
    const probe: RichProbe = { peers: [], channels: [], sent: [], receivedIds: [], duplicateRich: false, duplicated: 0, revokedUrls: new Set() };
    window.__richChatProbe = probe;
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (init?.method?.toUpperCase() === "POST" && /\/api\/rooms\/\d{4}\/chat-images$/.test(url.pathname) && init.body instanceof Blob) {
        // Chromium does not expose File upload bytes through request.postDataBuffer().
        // Sample the actual body before fetch, retaining only size/type/name/hash.
        const body = init.body;
        const headers = new Headers(init.headers);
        const digest = await crypto.subtle.digest("SHA-256", await body.arrayBuffer());
        await window.__recordChatUpload({
          name: decodeURIComponent(headers.get("X-Image-Name") ?? "image"),
          mimeType: body.type, bytes: body.size,
          digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        });
      }
      return fetch(input, init);
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { probe.revokedUrls.add(url); revoke(url); };
    const observed = new WeakSet<RTCDataChannel>();
    const attach = (peer: RTCPeerConnection, channel: RTCDataChannel) => {
      if (observed.has(channel)) return;
      observed.add(channel); probe.channels.push({ peer, channel });
      if (channel.label !== "interactive") return;
      const send = channel.send.bind(channel) as (data: unknown) => void;
      Object.defineProperty(channel, "send", { value(data: unknown) {
        let rich: RichChatMessage | undefined;
        if (typeof data === "string") try {
          const value = JSON.parse(data);
          if (value.type === "chat-rich") { rich = value; probe.sent.push(value); }
        } catch { /* Binary application payloads are not chat. */ }
        send(data);
        if (rich && probe.duplicateRich) { send(data); probe.duplicated += 1; }
      } });
      channel.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") return;
        try { const value = JSON.parse(data); if (value.type === "chat-rich") probe.receivedIds.push(value.id); }
        catch { /* Ignore unrelated interactive payloads. */ }
      });
    };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      probe.peers.push(peer);
      const create = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (...parameters) => { const channel = create(...parameters); attach(peer, channel); return channel; };
      peer.addEventListener("datachannel", ({ channel }) => attach(peer, channel));
      return peer;
    } });
  });
}

function observeImageApi(page: Page, network: NetworkRecord[]) {
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    // Vite serves /src/client/lib/chat-images.ts in development; it is not an image API read.
    if (path.startsWith("/api/chat-images/") || /^\/api\/rooms\/\d{4}\/chat-images$/.test(path)) {
      network.push({ path, method: response.request().method(), status: response.status() });
    }
  });
}

async function diagnostics(info: TestInfo, pages: Page[], network: NetworkRecord[], uploads: UploadRecord[]) {
  const peers = await Promise.all(pages.map((page) => page.evaluate(() => ({
    peers: window.__richChatProbe?.peers.map((peer, index) => ({ id: index + 1, connection: peer.connectionState, signaling: peer.signalingState })),
    channels: window.__richChatProbe?.channels.map(({ channel }) => ({ label: channel.label, state: channel.readyState })),
    sentRichIds: window.__richChatProbe?.sent.map((message) => message.id),
    receivedRichIds: window.__richChatProbe?.receivedIds,
  })).catch(() => ({ pageClosed: true }))));
  const path = info.outputPath("rich-chat-diagnostics.json");
  await writeFile(path, `${JSON.stringify({ peers, network, uploads }, null, 2)}\n`, "utf8");
  await info.attach("rich-chat-diagnostics", { path, contentType: "application/json" });
}

async function fourChannels(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__richChatProbe.channels
    .filter(({ peer, channel }) => peer.connectionState === "connected" && channel.readyState === "open" && channel.label !== "probe")
    .map(({ channel }) => channel.label).sort()), { timeout: 40_000 }).toEqual(["bulk", "collaboration", "control", "interactive"]);
}
async function openChat(page: Page) {
  await page.bringToFront();
  const editor = page.getByRole("textbox", { name: "Write a message", exact: true });
  // An exiting Chat editor remains visible during the workspace crossfade.
  // The selected workspace and the departing Files surface must settle first.
  if (new URL(page.url()).hash !== "#chat") {
    await page.getByRole("button", { name: "Chat", exact: true }).click({ timeout: 10_000 });
  }
  await expect.poll(() => new URL(page.url()).hash, { timeout: 10_000 }).toBe("#chat");
  await expect(page.getByRole("button", { name: "Drop, paste, or choose files", exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toBeEditable({ timeout: 10_000 });
  await editor.click({ trial: true, timeout: 10_000 });
  return editor;
}
async function sendText(page: Page, text: string) {
  const editor = await openChat(page);
  await editor.fill(text); await editor.press("Enter");
}
async function readyDraft(page: Page, images: number) {
  const editor = await openChat(page);
  await expect(editor.locator("img")).toHaveCount(images);
  await expect(editor.locator('[role="status"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
}
async function sendDraft(page: Page) {
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Write a message", exact: true }).locator("img")).toHaveCount(0);
}
function richMessage(page: Page, text: string) { return page.locator('[data-chat-kind="rich"]').filter({ hasText: text }); }
async function sentImageMetadata(page: Page) {
  return page.evaluate(() => window.__richChatProbe.sent.at(-1)?.images.map(({ width, height, mimeType, size, original, name }) => ({ width, height, mimeType, size, original, name })) ?? []);
}

const test = base.extend<{ pair: RichPair }>({ pair: async ({ browser }, use, info) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const uploads: UploadRecord[] = [];
  const network: NetworkRecord[] = [];
  let setupFailed = false;
  try {
    const aliceContext = await browser.newContext(); contexts.push(aliceContext);
    const bobContext = await browser.newContext(); contexts.push(bobContext);
    const alice = await aliceContext.newPage(); pages.push(alice);
    const bob = await bobContext.newPage(); pages.push(bob);
    await Promise.all(pages.map((page) => installProbe(page, uploads)));
    for (const page of pages) observeImageApi(page, network);
    const roomId = String(randomInt(1000, 10000));
    await bob.goto(`/en/room/${roomId}`);
    await alice.goto(`/en/room/${roomId}`);
    await Promise.all(pages.map(fourChannels));
    const unique = `rich-pair-${roomId}-${Date.now()}`;
    await sendText(alice, `${unique}-alice`); await expect(bob.getByText(`${unique}-alice`, { exact: true })).toBeVisible();
    await sendText(bob, `${unique}-bob`); await expect(alice.getByText(`${unique}-bob`, { exact: true })).toBeVisible();
    await use({ alice, bob, uploads, network });
  } catch (error) { setupFailed = true; throw error; }
  finally {
    if (setupFailed || info.status !== info.expectedStatus) await diagnostics(info, pages, network, uploads).catch(() => undefined);
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
} });

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

test.describe("rich chat with the real local image API", () => {
  test("keeps paragraph/image order and downloads the exact uploaded bytes", async ({ pair }) => {
    const { alice, bob, uploads, network } = pair;
    const editor = await openChat(alice);
    await editor.fill("before-first-image"); await editor.press("End");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("first.png"));
    await readyDraft(alice, 1); await editor.pressSequentially("between-images");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("second.png", 48, 72));
    await readyDraft(alice, 2); await editor.pressSequentially("after-last-image");
    await sendDraft(alice);
    const message = richMessage(bob, "before-first-image");
    await expect(message.getByRole("button", { name: /^Preview image:/ })).toHaveCount(2, { timeout: 30_000 });
    expect(await message.locator('[data-chat-content="rich"]').evaluate((element) => Array.from(element.children)
      .filter((child) => child.tagName !== "P" || child.textContent?.trim().replace(/\u00a0/g, ""))
      .map((child) => child.tagName === "P" ? child.textContent : "image")))
      .toEqual(["before-first-image", "image", "between-images", "image", "after-last-image"]);
    await message.getByRole("button", { name: /^Preview image:/ }).first().click();
    await expect(bob.getByRole("dialog", { name: "Image preview", exact: true })).toBeVisible();
    const downloading = bob.waitForEvent("download");
    await bob.getByRole("link", { name: "Download image", exact: true }).click();
    const download = await downloading;
    const path = await download.path(); expect(path).not.toBeNull();
    const uploaded = uploads.find((item) => item.name === download.suggestedFilename());
    expect(uploaded?.bytes).toBeGreaterThan(0);
    expect(createHash("sha256").update(await readFile(path!)).digest("hex")).toBe(uploaded?.digest);
    expect(network.filter((item) => item.method === "POST" && item.status >= 200 && item.status < 300)).toHaveLength(2);
    expect(network.filter((item) => item.method === "GET" && item.status === 200)).toHaveLength(2);
  });

  test("resizes static images and applies Original to every current image", async ({ pair }) => {
    const { alice, bob, uploads } = pair;
    const large = image("large-alpha.png", 2560, 1280, true);
    const small = image("small-alpha.png", 80, 40);
    expect(large.buffer.length).toBeLessThan(20 * 1024 * 1024);
    await (await openChat(alice)).fill("all-originals");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles([large, small]);
    await readyDraft(alice, 2);
    const preview = (await openChat(alice)).locator("img").first();
    await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2048);
    expect(await preview.evaluate((element: HTMLImageElement) => {
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0);
      return context.getImageData(0, 0, 1, 1).data[3];
    })).toBeLessThan(255);
    await expect(alice.getByRole("checkbox", { name: "Original", exact: true })).not.toBeChecked();
    await alice.getByRole("checkbox", { name: "Original", exact: true }).check();
    await readyDraft(alice, 2);
    await expect.poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2560);
    await sendDraft(alice);
    await expect(richMessage(bob, "all-originals").getByRole("button", { name: /^Preview image:/ })).toHaveCount(2, { timeout: 30_000 });
    expect(await sentImageMetadata(alice)).toEqual([
      { name: large.name, width: 2560, height: 1280, mimeType: "image/png", size: large.buffer.length, original: true },
      { name: small.name, width: 80, height: 40, mimeType: "image/png", size: small.buffer.length, original: true },
    ]);
    expect(uploads.map((upload) => upload.digest).sort()).toEqual([large, small].map((file) => createHash("sha256").update(file.buffer).digest("hex")).sort());
  });

  test("accepts pasted/dropped images, moves without copying, and retains the draft across workspaces", async ({ pair }) => {
    const { alice, uploads } = pair;
    const editor = await openChat(alice);
    await editor.fill("draft-survives-switch");
    const pasted = image("pasted.png");
    await editor.evaluate((element, file) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, { name: pasted.name, bytes: Array.from(pasted.buffer) });
    await readyDraft(alice, 1);
    const dropped = image("dropped.png", 50, 90);
    await editor.evaluate((element, file) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: "image/png" }));
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + 12, clientY: bounds.bottom - 8 }));
    }, { name: dropped.name, bytes: Array.from(dropped.buffer) });
    await readyDraft(alice, 2);
    await editor.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData("text/html", '<div data-chat-image-id="untrusted" imageid="untrusted" src="https://images.invalid/tracker.png"></div>');
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + 12, clientY: bounds.bottom - 8 }));
    });
    await expect(editor.locator("img")).toHaveCount(2);
    const orderBefore = await editor.locator("img").evaluateAll((elements) => elements.map((element) => element.getAttribute("src")));
    await editor.press("Control+End");
    await editor.pressSequentially("drag-destination");
    const source = editor.locator("[data-drag-handle]").first();
    const target = editor.locator("p").filter({ hasText: "drag-destination" }).last();
    await alice.keyboard.down("Control");
    try { await source.dragTo(target, { targetPosition: { x: 24, y: 4 } }); }
    finally { await alice.keyboard.up("Control"); }
    await expect(editor.locator("img")).toHaveCount(2);
    expect(await editor.locator("img").evaluateAll((elements) => elements.map((element) => element.getAttribute("src")))).toEqual([...orderBefore].reverse());
    await alice.getByRole("button", { name: "Files", exact: true }).click();
    await openChat(alice); await expect(editor).toContainText("draft-survives-switch"); await expect(editor.locator("img")).toHaveCount(2);
    await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    await expect(editor.locator("img")).toHaveCount(2); expect(uploads).toHaveLength(0);
    await editor.evaluate((element) => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "x".repeat(4001));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(alice.getByRole("alert")).toContainText("4000");
    const removedUrl = await editor.locator("img").first().getAttribute("src");
    await editor.getByRole("button", { name: "Remove image", exact: true }).first().click();
    await expect(editor.locator("img")).toHaveCount(1);
    expect(await alice.evaluate((url) => window.__richChatProbe.revokedUrls.has(url!), removedUrl)).toBe(true);
  });

  test("retries one failed upload and deduplicates repeated rich messages without another upload", async ({ pair }) => {
    const { alice, bob, uploads } = pair;
    let failed = false;
    await alice.route(/\/api\/rooms\/\d{4}\/chat-images$/, async (route) => {
      if (route.request().method() === "POST" && !failed) { failed = true; await route.fulfill({ status: 503, json: { message: "Injected temporary storage outage." } }); }
      else await route.continue();
    });
    await alice.evaluate(() => { window.__richChatProbe.duplicateRich = true; });
    await (await openChat(alice)).fill("retry-without-duplicate-bubble");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("retry.png"));
    await readyDraft(alice, 1); await sendDraft(alice);
    await expect(alice.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    expect(uploads).toHaveLength(1);
    await alice.getByRole("button", { name: "Retry message", exact: true }).click();
    const message = richMessage(bob, "retry-without-duplicate-bubble");
    await expect(message.getByRole("button", { name: /^Preview image:/ })).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => bob.evaluate(() => window.__richChatProbe.receivedIds.length)).toBeGreaterThanOrEqual(2);
    await expect(message).toHaveCount(1); expect(uploads).toHaveLength(2);
  });

  test("keeps image history usable after peer replacement without uploading or fetching it again", async ({ pair }) => {
    const { alice, bob, uploads, network } = pair;
    await (await openChat(alice)).fill("history-survives-peer-restart");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("history.png"));
    await readyDraft(alice, 1); await sendDraft(alice);
    const message = richMessage(bob, "history-survives-peer-restart");
    await expect(message.getByRole("button", { name: /^Preview image:/ })).toBeVisible({ timeout: 30_000 });
    const reads = network.filter((entry) => entry.method === "GET").length;
    const peers = await alice.evaluate(() => window.__richChatProbe.peers.length);
    await alice.evaluate(() => {
      const peer = window.__richChatProbe.peers.find((candidate) => candidate.connectionState === "connected");
      if (!peer) throw new Error("No connected RTC peer to fail.");
      Object.defineProperty(peer, "connectionState", { configurable: true, value: "failed" });
      peer.close(); peer.dispatchEvent(new Event("connectionstatechange"));
    });
    await expect.poll(() => alice.evaluate(() => window.__richChatProbe.peers.length), { timeout: 40_000 }).toBeGreaterThan(peers);
    await Promise.all([fourChannels(alice), fourChannels(bob)]);
    await sendText(bob, "after-rich-peer-restart"); await expect(alice.getByText("after-rich-peer-restart", { exact: true })).toBeVisible();
    await expect(message.getByRole("button", { name: /^Preview image:/ })).toBeVisible();
    await message.getByRole("button", { name: /^Preview image:/ }).click();
    await expect(bob.getByRole("link", { name: "Download image", exact: true })).toBeVisible();
    expect(uploads).toHaveLength(1); expect(network.filter((entry) => entry.method === "GET")).toHaveLength(reads);
  });

  test("shows expiry for cached images and for a real fetch returning 410", async ({ pair }) => {
    const { alice, bob } = pair;
    await (await openChat(alice)).fill("cached-before-expiry");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("cached.png"));
    await readyDraft(alice, 1); await sendDraft(alice);
    await expect(richMessage(bob, "cached-before-expiry").getByRole("button", { name: /^Preview image:/ })).toBeVisible({ timeout: 30_000 });
    await bob.route(/\/api\/chat-images\//, (route) => route.fulfill({ status: 410, json: { message: "Image expired." } }));
    await (await openChat(alice)).fill("already-expired-at-server");
    await alice.getByLabel("Choose images", { exact: true }).setInputFiles(image("gone.png"));
    await readyDraft(alice, 1); await sendDraft(alice);
    await expect(richMessage(bob, "already-expired-at-server").getByText("Image expired", { exact: true })).toBeVisible({ timeout: 30_000 });
    // Only Date is fixed; RTC/heartbeat timers are never advanced by 24 hours.
    await bob.clock.setFixedTime(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
    await bob.getByRole("button", { name: "Files", exact: true }).click(); await openChat(bob);
    await expect(richMessage(bob, "cached-before-expiry").getByText("Image expired", { exact: true })).toBeVisible();
    await expect(bob.getByRole("button", { name: /^Preview image:/ })).toHaveCount(0);
  });

  test("opens chat from the home code entry and normalizes the legacy status entry", async ({ browser }) => {
    const contexts: BrowserContext[] = [];
    try {
      const fromHome = await browser.newContext(); contexts.push(fromHome);
      const page = await fromHome.newPage(); await page.goto("/en");
      const roomId = String(randomInt(1000, 10000));
      for (let index = 0; index < roomId.length; index += 1) {
        await page.getByRole("textbox", { name: `Connection code digit ${index + 1}`, exact: true }).fill(roomId[index]);
      }
      await expect(page).toHaveURL(new RegExp(`/en/room/${roomId}(?:#chat)?$`));
      await expect(page.getByRole("textbox", { name: "Write a message", exact: true })).toBeVisible();
      expect(new URL(page.url()).hash).not.toBe("#status");
      const legacyContext = await browser.newContext(); contexts.push(legacyContext);
      const legacy = await legacyContext.newPage(); await legacy.goto(`/zh/room/${randomInt(1000, 10000)}#status`);
      await expect(legacy.getByRole("textbox", { name: "输入消息", exact: true })).toBeVisible();
      await expect(legacy).toHaveURL(/#chat$/);
    } finally { await Promise.allSettled(contexts.map((context) => context.close())); }
  });
});
