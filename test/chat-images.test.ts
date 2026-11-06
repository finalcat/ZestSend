import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { cleanupExpiredChatImages } from "../src/worker/chat-images";
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TTL_MS } from "../src/shared/chat-image-limits";

type Welcome = { type: string; resumeToken: string; slotId: string; peerSessionId: string; epoch: number };
type UploadedImage = { imageId: string; readToken: string; expiresAt: number; mimeType: string; size: number };
const sockets = new Set<WebSocket>();
let nextRoom = 9300;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 1, 2, 3, 4]);

async function seat(roomId = String(nextRoom++), mode = "new", resumeToken?: string) {
  const stub = env.ROOMS.getByName(roomId);
  const response = await stub.fetch("https://room.test/api/rooms/1234/ws", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  socket.accept();
  sockets.add(socket);
  const welcome = new Promise<Welcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No welcome received.")), 2_000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Welcome;
      if (message.type === "welcome") { clearTimeout(timer); resolve(message); }
    });
  });
  socket.send(JSON.stringify({ type: "hello", mode, ...(resumeToken ? { resumeToken } : {}) }));
  return { roomId, socket, stub, welcome: await welcome };
}

async function api(path: string, init?: RequestInit) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://zestsend.test${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}

function upload(roomId: string, token: string, body: Uint8Array<ArrayBuffer> = png, headers: Record<string, string> = {}) {
  return api(`/api/rooms/${roomId}/chat-images`, {
    method: "POST", body,
    headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "image/png", "Content-Length": String(body.byteLength),
      "X-Image-Name": encodeURIComponent("测试 image.png"), ...headers,
    },
  });
}

function key(imageId: string) {
  return `chat-images/${new Date(Number(imageId.slice(0, 13))).toISOString().slice(0, 13)}/${imageId}`;
}

afterEach(async () => {
  for (const socket of sockets) { try { socket.close(1000, "Test cleanup"); } catch { /* Already replaced. */ } }
  sockets.clear();
  const page = await env.CHAT_IMAGES.list();
  if (page.objects.length) await env.CHAT_IMAGES.delete(page.objects.map((object) => object.key));
});

describe("private temporary chat image API", () => {
  it("authenticates uploads without modifying signaling identity, and requires the separate read credential", async () => {
    const client = await seat();
    const before = await runInDurableObject(client.stub, (_instance, state) => state.storage.get("room-state-v2"));
    expect((await upload(client.roomId, "wrong-token")).status).toBe(401);
    const startedAt = Date.now();
    const response = await upload(client.roomId, client.welcome.resumeToken);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const image = await response.json<UploadedImage>();
    expect(image).toMatchObject({ mimeType: "image/png", size: png.byteLength });
    expect(image.imageId).toMatch(/^\d{13}-[0-9a-f]{32}$/);
    expect(image.readToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number(image.imageId.slice(0, 13))).toBe(image.expiresAt);
    expect(image.expiresAt).toBeGreaterThanOrEqual(startedAt + CHAT_IMAGE_TTL_MS);
    expect(image.expiresAt).toBeLessThanOrEqual(Date.now() + CHAT_IMAGE_TTL_MS);
    const after = await runInDurableObject(client.stub, (_instance, state) => state.storage.get("room-state-v2"));
    expect(after).toEqual(before);
    const stored = await env.CHAT_IMAGES.head(key(image.imageId));
    expect(stored?.customMetadata?.readTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored?.customMetadata)).not.toContain(image.readToken);
    expect((await api(`/api/chat-images/${image.imageId}`)).status).toBe(401);
    expect((await api(`/api/chat-images/${image.imageId}`, { headers: { Authorization: `Bearer ${client.welcome.resumeToken}` } })).status).toBe(404);
    const downloaded = await api(`/api/chat-images/${image.imageId}`, { headers: { Authorization: `Bearer ${image.readToken}` } });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("Content-Type")).toBe("image/png");
    expect(downloaded.headers.get("Cache-Control")).toBe("private, no-store");
    expect(downloaded.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(png);
  });

  it("rejects unsupported types, forged signatures, declared oversize and mismatched actual length", async () => {
    const { roomId, welcome } = await seat();
    expect((await upload(roomId, welcome.resumeToken, png, { "Content-Type": "image/svg+xml" })).status).toBe(415);
    expect((await upload(roomId, welcome.resumeToken, new TextEncoder().encode("<script>bad</script>"))).status).toBe(415);
    expect((await upload(roomId, welcome.resumeToken, png, { "Content-Length": String(CHAT_IMAGE_MAX_BYTES + 1) })).status).toBe(413);
    expect((await upload(roomId, welcome.resumeToken, png, { "Content-Length": "12" })).status).toBe(400);
    expect((await upload(roomId, welcome.resumeToken, new Uint8Array())).status).toBe(400);
    const valid = await upload(roomId, welcome.resumeToken);
    expect(valid.status).toBe(201); // Failed bodies released both concurrent-upload slots.
  });

  it("checks actual body bytes against 20 MiB even when the claimed length is smaller", async () => {
    const { roomId, welcome } = await seat();
    const oversized = new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1);
    oversized.set(png);
    const response = await upload(roomId, welcome.resumeToken, oversized, { "Content-Length": String(CHAT_IMAGE_MAX_BYTES) });
    expect(response.status).toBe(413);
    expect((await env.CHAT_IMAGES.list()).objects).toHaveLength(0);
  });

  it("accepts each supported image signature including headers split into tiny chunks", async () => {
    const { roomId, welcome } = await seat();
    const formats = [
      ["image/jpeg", new Uint8Array([255, 216, 255])],
      ["image/gif", new TextEncoder().encode("GIF89a")],
      ["image/webp", new TextEncoder().encode("RIFF0000WEBP")],
    ] as const;
    for (const [mimeType, bytes] of formats) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      } });
      const response = await api(`/api/rooms/${roomId}/chat-images`, {
        method: "POST", body,
        headers: { Authorization: `Bearer ${welcome.resumeToken}`, "Content-Type": mimeType, "Content-Length": String(bytes.length) },
      });
      expect(response.status).toBe(201);
    }
  });

  it("keeps prior image reads valid after token rotation but rejects new uploads using the old room token", async () => {
    const first = await seat();
    const image = await (await upload(first.roomId, first.welcome.resumeToken)).json<UploadedImage>();
    const authorized = await first.stub.beginChatImageUpload(first.welcome.resumeToken, png.length);
    expect(authorized.ok).toBe(true);
    const second = await seat(first.roomId, "resume-signaling", first.welcome.resumeToken);
    expect(second.welcome.resumeToken).not.toBe(first.welcome.resumeToken);
    expect((await upload(first.roomId, first.welcome.resumeToken)).status).toBe(401);
    // Completing an already-authorized request does not reauthenticate the rotated token.
    if (authorized.ok) await first.stub.finishChatImageUpload(authorized.slotId, authorized.uploadId, png.length);
    expect((await upload(first.roomId, second.welcome.resumeToken)).status).toBe(201);
    const response = await api(`/api/chat-images/${image.imageId}`, { headers: { Authorization: `Bearer ${image.readToken}` } });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("allows an unexpired disconnected lease, rejects expired-seat uploads, and never gates existing reads on that lease", async () => {
    const client = await seat();
    const image = await (await upload(client.roomId, client.welcome.resumeToken)).json<UploadedImage>();
    client.socket.close(1000, "Signaling interrupted");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const disconnected = await runInDurableObject(client.stub, async (_instance, state) => {
        const room = await state.storage.get<{ slots: Array<{ connectionId: string | null }> }>("room-state-v2");
        return room?.slots[0]?.connectionId === null;
      });
      if (disconnected) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await upload(client.roomId, client.welcome.resumeToken)).status).toBe(201);
    await runInDurableObject(client.stub, async (_instance, state) => {
      const room = await state.storage.get<{ slots: Array<{ leaseExpiresAt: number | null }> }>("room-state-v2");
      room!.slots[0].leaseExpiresAt = Date.now() - 1;
      await state.storage.put("room-state-v2", room);
    });
    expect((await upload(client.roomId, client.welcome.resumeToken)).status).toBe(401);
    const response = await api(`/api/chat-images/${image.imageId}`, { headers: { Authorization: `Bearer ${image.readToken}` } });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("enforces concurrent admission atomically and makes reservation release idempotent", async () => {
    const { stub, welcome } = await seat();
    const admissions = await Promise.all(Array.from({ length: 3 }, () => stub.beginChatImageUpload(welcome.resumeToken, png.length)));
    const accepted = admissions.filter((admission) => admission.ok);
    expect(accepted).toHaveLength(2);
    expect(admissions.filter((admission) => !admission.ok)).toEqual([{ ok: false, status: 429, retryAfterMs: 1_000 }]);
    for (const admission of accepted) {
      await stub.finishChatImageUpload(admission.slotId, admission.uploadId, png.length);
      await stub.finishChatImageUpload(admission.slotId, admission.uploadId, 0);
    }
    expect((await stub.beginChatImageUpload(welcome.resumeToken, png.length)).ok).toBe(true);
  });

  it("applies per-slot request and byte quotas independently of upload concurrency", async () => {
    const requests = await seat();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const admission = await requests.stub.beginChatImageUpload(requests.welcome.resumeToken, 1);
      expect(admission.ok).toBe(true);
      if (admission.ok) await requests.stub.finishChatImageUpload(admission.slotId, admission.uploadId, 1);
    }
    expect(await requests.stub.beginChatImageUpload(requests.welcome.resumeToken, 1)).toMatchObject({ ok: false, status: 429 });
    const bytes = await seat();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const admission = await bytes.stub.beginChatImageUpload(bytes.welcome.resumeToken, CHAT_IMAGE_MAX_BYTES);
      expect(admission.ok).toBe(true);
      if (admission.ok) await bytes.stub.finishChatImageUpload(admission.slotId, admission.uploadId, CHAT_IMAGE_MAX_BYTES);
    }
    expect(await bytes.stub.beginChatImageUpload(bytes.welcome.resumeToken, 1)).toMatchObject({ ok: false, status: 429 });
  });

  it("expires at the server deadline and physically cleans only expired objects on the hourly scheduled handler", async () => {
    const now = Date.now();
    const expiredId = `${now - 1}-${"a".repeat(32)}`;
    const futureId = `${now + 10_000}-${"b".repeat(32)}`;
    await env.CHAT_IMAGES.put(key(expiredId), png);
    await env.CHAT_IMAGES.put(key(futureId), png);
    const context = createExecutionContext();
    worker.scheduled(createScheduledController({ cron: "0 * * * *", scheduledTime: now }), env, context);
    await waitOnExecutionContext(context);
    expect(await env.CHAT_IMAGES.head(key(expiredId))).toBeNull();
    expect(await env.CHAT_IMAGES.head(key(futureId))).not.toBeNull();
    expect((await api(`/api/chat-images/${expiredId}`, { headers: { Authorization: `Bearer ${"x".repeat(43)}` } })).status).toBe(410);
  });

  it("enforces a real upload's exact 24-hour deadline independently of cleanup, then reclaims the unsent orphan", async () => {
    const client = await seat();
    // This successful upload is never referenced by a P2P message.
    const uploadedAt = Date.now();
    const image = await (await upload(client.roomId, client.welcome.resumeToken)).json<UploadedImage>();
    expect(image.expiresAt - uploadedAt).toBeGreaterThanOrEqual(CHAT_IMAGE_TTL_MS);
    const imageKey = key(image.imageId);
    const read = () => api(`/api/chat-images/${image.imageId}`, { headers: { Authorization: `Bearer ${image.readToken}` } });
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(image.expiresAt - 1);
      const justBefore = await read();
      expect(justBefore.status).toBe(200);
      expect(new Uint8Array(await justBefore.arrayBuffer())).toEqual(png);

      clock.mockReturnValue(image.expiresAt);
      expect((await read()).status).toBe(410);
      expect(await env.CHAT_IMAGES.head(imageKey)).not.toBeNull();

      const failedDelete = vi.fn(async () => { throw new Error("Temporary R2 delete failure"); });
      const failingBucket = {
        list: (options: R2ListOptions) => env.CHAT_IMAGES.list(options),
        delete: failedDelete,
      } as unknown as R2Bucket;
      await expect(cleanupExpiredChatImages({ CHAT_IMAGES: failingBucket }, image.expiresAt)).rejects.toThrow("Temporary R2 delete failure");
      expect(failedDelete).toHaveBeenCalledWith([imageKey]);
      expect((await read()).status).toBe(410);
      expect(await env.CHAT_IMAGES.head(imageKey)).not.toBeNull();

      await cleanupExpiredChatImages(env, image.expiresAt);
      expect(await env.CHAT_IMAGES.head(imageKey)).toBeNull();
      expect((await read()).status).toBe(410);
    } finally {
      clock.mockRestore();
    }
  });

  it("paginates both expiry-hour prefixes and image batches during cleanup", async () => {
    const now = Date.now();
    const prefix = `chat-images/${new Date(now).toISOString().slice(0, 13)}/`;
    const expiredKey = `${prefix}${now - 1}-${"c".repeat(32)}`;
    const list = vi.fn(async (options: R2ListOptions) => {
      if (options.delimiter) return options.cursor
        ? { objects: [], delimitedPrefixes: [], truncated: false }
        : { objects: [], delimitedPrefixes: [prefix], truncated: true, cursor: "hours-next" };
      return options.cursor
        ? { objects: [{ key: expiredKey }], delimitedPrefixes: [], truncated: false }
        : { objects: [{ key: expiredKey }], delimitedPrefixes: [], truncated: true, cursor: "images-next" };
    });
    const remove = vi.fn(async () => {});
    const bucket = { list, delete: remove } as unknown as R2Bucket;
    await cleanupExpiredChatImages({ CHAT_IMAGES: bucket }, now);
    expect(list).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "images-next", prefix }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "hours-next", delimiter: "/" }));
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
