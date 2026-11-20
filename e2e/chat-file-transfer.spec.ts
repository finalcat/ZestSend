import { createHash, randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const gif = Buffer.from("47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b", "hex");

type UploadAttempt = { name: string; bytes: number; nativeFile: boolean; status: number };
type AttachmentProbe = {
  uploads: UploadAttempt[];
  active: number;
  maxActive: number;
  fullFileReads: number;
  fetchDownloads: number;
  richSends: string[];
  reads: string[];
};

declare global {
  interface Window { __chatAttachmentProbe: AttachmentProbe }
}

const editor = (page: Page) => page.getByRole("textbox", { name: "Write a message", exact: true });
const send = (page: Page) => page.getByRole("button", { name: "Send message", exact: true });
const chooseFiles = (page: Page) => page.getByLabel("Choose files", { exact: true });
const fileCard = (page: Page, name: string) => page.locator("[data-chat-cloud-file]").filter({ has: page.getByText(name, { exact: true }) });
const message = (page: Page, text: string) => page.locator("[data-chat-entry-id]").filter({ hasText: text });
const file = (name: string, buffer = Buffer.from(name)) => ({ name, mimeType: "application/octet-stream", buffer });

async function installProbe(page: Page) {
  await page.addInitScript((largeFileBytes) => {
    const probe: AttachmentProbe = {
      uploads: [], active: 0, maxActive: 0, fullFileReads: 0, fetchDownloads: 0, richSends: [], reads: [],
    };
    window.__chatAttachmentProbe = probe;

    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (/^\/api\/chat-files\//.test(url.pathname)) {
        probe.fetchDownloads += 1;
        throw new Error("Chat files must use native browser downloads.");
      }
      if (init?.method !== "POST" || !/\/api\/rooms\/\d{4}\/chat-(?:images|files)$/.test(url.pathname)) return fetch(input, init);
      const headers = new Headers(init.headers);
      const name = decodeURIComponent(headers.get("X-File-Name") ?? headers.get("X-Image-Name") ?? "");
      const bytes = init.body instanceof File ? init.body.size : -1;
      const nativeFile = init.body instanceof File;
      probe.active += 1;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      try {
        const response = await fetch(input, init);
        probe.uploads.push({ name, bytes, nativeFile, status: response.status });
        return response;
      } finally {
        probe.active -= 1;
      }
    };

    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      if (this.size >= largeFileBytes) {
        probe.fullFileReads += 1;
        throw new Error("The application must not buffer a whole large file.");
      }
      return arrayBuffer.call(this);
    };
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = (object) => {
      if (object instanceof Blob && object.size >= largeFileBytes) {
        probe.fullFileReads += 1;
        throw new Error("A large chat file must not become an object URL.");
      }
      return createObjectURL.call(URL, object);
    };

    const send = RTCDataChannel.prototype.send as (data: unknown) => void;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
      if (typeof data === "string") {
        let value: { type?: string; id?: string; version?: number } | undefined;
        try { value = JSON.parse(data); } catch { /* Other application data may not be JSON. */ }
        if (this.label === "interactive" && value?.type === "chat-rich" && value.version === 3 && value.id) probe.richSends.push(value.id);
        if (this.label === "control" && value?.type === "chat-read" && value.id) probe.reads.push(value.id);
      }
      send.call(this, data);
    };
  }, LARGE_FILE_BYTES);
}

const test = base.extend<{ room: { alice: Page; bob: Page; path: string } }>({
  room: async ({ browser, baseURL }, use) => {
    const [sender, recipient] = await Promise.all([0, 1].map(() => browser.newContext({
      baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
    })));
    try {
      const [alice, bob] = await Promise.all([sender.newPage(), recipient.newPage()]);
      await Promise.all([installProbe(alice), installProbe(bob)]);
      await use({ alice, bob, path: "/en/room/" + randomInt(1000, 10000) + "#chat" });
    } finally {
      await Promise.allSettled([sender.close(), recipient.close()]);
    }
  },
});

async function enterChat(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(editor(page)).toBeEditable({ timeout: 30_000 });
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

async function createDiskFile(path: string, marker: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try {
    await handle.truncate(LARGE_FILE_BYTES);
    const bytes = Buffer.from(marker);
    await handle.write(bytes, 0, bytes.length, LARGE_FILE_BYTES - bytes.length);
  } finally {
    await handle.close();
  }
  return digest(path);
}

async function download(page: Page, name: string) {
  const href = page.url();
  const [result] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    fileCard(page, name).getByRole("button", { name: "Download: " + name, exact: true }).click(),
  ]);
  expect(result.suggestedFilename()).toBe(name);
  expect(new URL(result.url()).search).toBe("");
  expect(new URL(result.url()).pathname).toMatch(/^\/api\/chat-files\/[^/]+\/download$/);
  expect(page.url()).toBe(href);
  return result.path();
}

test("uploads a mixed message while alone and natively downloads two 50 MiB files after the peer joins", async ({ room: { alice, bob, path } }, info) => {
  test.setTimeout(180_000);
  const names = ["50MiB-first.bin", "中文附件-50MiB.bin"];
  const paths = names.map((name) => info.outputPath(name));
  const hashes = await Promise.all(paths.map((filePath, index) => createDiskFile(filePath, names[index])));
  await enterChat(alice, path);

  const text = "before-cloud-attachments";
  await editor(alice).fill(text);
  await editor(alice).press("End");
  const [chooser] = await Promise.all([
    alice.waitForEvent("filechooser"),
    alice.getByRole("button", { name: "Add files", exact: true }).click(),
  ]);
  await chooser.setFiles(paths);
  await expect(editor(alice).locator("[data-chat-file-draft]")).toHaveCount(2);
  await editor(alice).pressSequentially("between-files-and-image");
  await alice.getByLabel("Choose images", { exact: true }).setInputFiles({ name: "inside.gif", mimeType: "image/gif", buffer: gif });
  await editor(alice).pressSequentially("after-embedded-image");
  await expect(send(alice)).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads.length)).toBe(0);

  const imageButton = await alice.getByRole("button", { name: "Add images", exact: true }).boundingBox();
  const fileButton = await alice.getByRole("button", { name: "Add files", exact: true }).boundingBox();
  if (!imageButton || !fileButton) throw new Error("Attachment buttons are outside the composer.");
  expect(fileButton.x).toBeGreaterThanOrEqual(imageButton.x + imageButton.width - 1);
  expect(fileButton.y).toBeCloseTo(imageButton.y, 0);
  expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await send(alice).click();
  await expect(editor(alice).locator("[data-chat-file-draft]")).toHaveCount(0);
  await expect(message(alice, text)).toHaveCount(1);
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads), { timeout: 70_000 })
    .toEqual(expect.arrayContaining(names.map((name) => ({ name, bytes: LARGE_FILE_BYTES, nativeFile: true, status: 201 }))));
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads.length)).toBe(3);
  const probe = await alice.evaluate(() => window.__chatAttachmentProbe);
  expect(probe.uploads.every((attempt) => attempt.status === 201 && attempt.nativeFile)).toBe(true);
  expect(probe.maxActive).toBeGreaterThan(0);
  expect(probe.maxActive).toBeLessThanOrEqual(2);
  expect(probe.fullFileReads).toBe(0);
  expect(probe.richSends).toEqual([]);

  await enterChat(bob, path);
  const incoming = bob.locator('[data-chat-message-id][data-chat-kind="rich"]').filter({ hasText: text });
  await expect(incoming).toHaveCount(1, { timeout: 30_000 });
  await expect(incoming.locator("[data-chat-cloud-file]")).toHaveCount(2);
  expect(await incoming.locator('[data-chat-content="rich"]').evaluate((root) => [...root.children].flatMap((node) => {
    const attachment = node.querySelector("[data-chat-cloud-file]");
    if (attachment) return [attachment.querySelector("p")?.textContent];
    if (node.matches("[data-chat-image]")) return ["image"];
    const text = node.textContent?.trim();
    return node.tagName === "P" && text ? [text] : [];
  }))).toEqual([text, ...names, "between-files-and-image", "image", "after-embedded-image"]);
  const receivedId = await incoming.getAttribute("data-chat-entry-id");
  expect(await message(alice, text).getAttribute("data-chat-entry-id")).toBe(receivedId);
  expect(await alice.evaluate(() => [...new Set(window.__chatAttachmentProbe.richSends)])).toEqual([receivedId]);

  for (const [index, name] of names.entries()) {
    const savedPath = await download(bob, name);
    expect((await stat(savedPath)).size).toBe(LARGE_FILE_BYTES);
    expect(await digest(savedPath)).toBe(hashes[index]);
  }
  expect(await bob.evaluate(() => {
    const { fetchDownloads, fullFileReads } = window.__chatAttachmentProbe;
    return { fetchDownloads, fullFileReads };
  })).toEqual({ fetchDownloads: 0, fullFileReads: 0 });
});

test("removes draft files, sends a pure empty file and quotes it using another pure file", async ({ room: { alice, bob, path } }) => {
  await enterChat(alice, path);
  const name = "empty.bin";
  await chooseFiles(alice).setInputFiles([file(name, Buffer.alloc(0)), file("removed.bin")]);
  await expect(editor(alice).locator("[data-chat-file-draft]")).toHaveCount(2);
  await editor(alice).getByRole("button", { name: "Remove file removed.bin", exact: true }).click();
  await expect(editor(alice).locator("[data-chat-file-draft]")).toHaveCount(1);
  await expect(send(alice)).toBeEnabled();
  await editor(alice).press("Enter");
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads))
    .toEqual([{ name, bytes: 0, nativeFile: true, status: 201 }]);
  await enterChat(bob, path);

  const incoming = fileCard(bob, name);
  await expect(incoming).toBeVisible({ timeout: 30_000 });
  const entry = bob.locator("[data-chat-entry-id]").filter({ has: incoming });
  const id = await entry.getAttribute("data-chat-entry-id");
  await expect.poll(() => bob.evaluate(() => window.__chatAttachmentProbe.reads)).toContain(id);
  expect((await stat(await download(bob, name))).size).toBe(0);
  await entry.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(bob.locator("[data-chat-reply-draft]")).toContainText(name);
  await chooseFiles(bob).setInputFiles(file("reply-only.bin"));
  await expect(send(bob)).toBeEnabled();
  await send(bob).click();
  const quoted = alice.locator("[data-chat-entry-id]").filter({ has: fileCard(alice, "reply-only.bin") });
  await expect(quoted.locator("[data-chat-reply-target]")).toHaveText(/empty\.bin/);
});

test("inserts file blocks at the caret and drags them without copying", async ({ room: { alice, bob, path } }) => {
  await alice.setViewportSize({ width: 1440, height: 900 });
  await enterChat(alice, path);
  const before = "before-reordering-files";
  const after = "drop-after-the-file-blocks";
  const first = "move-this-file.bin";
  const second = "leave-this-file.bin";
  await editor(alice).fill(before + after);
  await editor(alice).locator("p").evaluate((paragraph, offset) => {
    const text = paragraph.firstChild;
    if (!text) throw new Error("The draft paragraph is empty.");
    window.getSelection()?.collapse(text, offset);
    document.dispatchEvent(new Event("selectionchange"));
  }, before.length);
  const [chooser] = await Promise.all([
    alice.waitForEvent("filechooser"),
    alice.getByRole("button", { name: "Add files", exact: true }).click(),
  ]);
  await chooser.setFiles([file(first), file(second)]);
  const nodes = editor(alice).locator("[data-chat-file-draft]");
  await expect(nodes).toHaveCount(2);
  await expect(nodes.first()).toContainText(first);
  const draftBlocks = editor(alice).locator(":scope > *");
  await expect(draftBlocks.first()).toHaveText(before);
  await expect(draftBlocks.last()).toHaveText(after);
  const initialIds = await nodes.evaluateAll((elements) => elements.map((node) => node.getAttribute("data-chat-file-id")));

  const source = nodes.filter({ hasText: first });
  const target = editor(alice).locator("p").filter({ hasText: after });
  await alice.keyboard.down("Control");
  try { await source.dragTo(target, { targetPosition: { x: 24, y: 4 } }); }
  finally { await alice.keyboard.up("Control"); }
  await expect(nodes).toHaveCount(2);
  await expect(nodes.first()).toContainText(second);
  expect(await nodes.evaluateAll((elements) => elements.map((node) => node.getAttribute("data-chat-file-id")))).toEqual([...initialIds].reverse());

  await send(alice).click();
  await enterChat(bob, path);
  const incoming = bob.locator('[data-chat-message-id][data-chat-kind="rich"]').filter({ hasText: before });
  const incomingNames = incoming.locator("[data-chat-cloud-file] p[title]");
  await expect(incomingNames).toHaveText([second, first], { timeout: 30_000 });
  expect(await digest(await download(bob, first))).toBe(createHash("sha256").update(first).digest("hex"));
});

test("retries only the failed attachment and shows a native download expiry", async ({ room: { alice, bob, path } }) => {
  await enterChat(alice, path);
  let rejectOnce = true;
  await alice.route(/\/api\/rooms\/\d{4}\/chat-files$/, (route) => {
    if (route.request().headers()["x-file-name"] === "recover.bin" && rejectOnce) {
      rejectOnce = false;
      return route.fulfill({ status: 503, json: { message: "Simulated temporary upload failure" } });
    }
    return route.continue();
  });
  await chooseFiles(alice).setInputFiles([file("kept.bin"), file("recover.bin")]);
  await send(alice).click();
  const retry = alice.getByRole("button", { name: "Retry message", exact: true });
  await expect(retry).toBeVisible();
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads.map(({ name, status }) => name + ":" + status).sort()))
    .toEqual(["kept.bin:201", "recover.bin:503"]);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads.map(({ name, status }) => name + ":" + status).sort()))
    .toEqual(["kept.bin:201", "recover.bin:201", "recover.bin:503"]);
  await enterChat(bob, path);
  const incoming = fileCard(bob, "recover.bin");
  await expect(incoming).toBeVisible({ timeout: 30_000 });
  const id = await incoming.getAttribute("data-chat-cloud-file");
  await bob.route("**/api/chat-files/" + id + "/download", (route) => route.fulfill({ status: 410, json: { status: 410 } }));
  await incoming.getByRole("button", { name: "Download: recover.bin", exact: true }).click();
  await expect(incoming.getByText("File expired", { exact: true })).toBeVisible();
  await expect(incoming.getByRole("button", { name: "Download: recover.bin", exact: true })).toHaveCount(0);
  await expect(bob).toHaveURL(/#chat$/);
});

test("retains a queued file when the peer lacks attachment support and still delivers text", async ({ room: { alice, bob, path } }) => {
  await bob.addInitScript(() => {
    const send = RTCDataChannel.prototype.send as (data: unknown) => void;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
      if (this.label === "control" && typeof data === "string") {
        try { if (JSON.parse(data).type === "chat-file-capabilities") return; }
        catch { /* Other control data is unrelated. */ }
      }
      send.call(this, data);
    };
  });
  await enterChat(alice, path);
  await chooseFiles(alice).setInputFiles(file("wait-for-upgrade.bin"));
  await send(alice).click();
  await expect.poll(() => alice.evaluate(() => window.__chatAttachmentProbe.uploads))
    .toEqual([expect.objectContaining({ name: "wait-for-upgrade.bin", status: 201 })]);
  await enterChat(bob, path);
  await expect(alice.getByText("The other participant needs to refresh before receiving chat files.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(fileCard(alice, "wait-for-upgrade.bin")).toBeVisible();
  await expect(alice.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
  await expect(fileCard(bob, "wait-for-upgrade.bin")).toHaveCount(0);
  expect(await alice.evaluate(() => window.__chatAttachmentProbe.richSends)).toEqual([]);

  await chooseFiles(alice).setInputFiles(file("keep-in-draft.bin"));
  await send(alice).click();
  await expect(editor(alice).locator("[data-chat-file-draft]")).toHaveCount(1);
  expect(await alice.evaluate(() => window.__chatAttachmentProbe.uploads.length)).toBe(1);
  await editor(alice).getByRole("button", { name: "Remove file keep-in-draft.bin", exact: true }).click();
  await editor(alice).fill("plain text remains compatible");
  await send(alice).click();
  await expect(message(bob, "plain text remains compatible")).toBeVisible();
});
