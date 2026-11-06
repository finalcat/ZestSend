import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImageAssetStore, ChatImageRequestError, ChatImageUploadQueue, type ChatImageAuthorization } from "../src/client/lib/chat-image-client";
import type { CloudChatImage } from "../src/shared/chat-protocol";

const clock = 1_794_000_000_000;
const stores: ChatImageAssetStore[] = [];
const controllers: AbortController[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

async function settle() { for (let turn = 0; turn < 30; turn += 1) await Promise.resolve(); }
function controller() { const value = new AbortController(); controllers.push(value); return value; }
function store() { const value = new ChatImageAssetStore(); stores.push(value); return value; }
function png(name = "screen shot.png") { return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" }); }
function authorization(): ChatImageAuthorization {
  return { getImageUploadAuthorization: vi.fn(() => "room-token"), waitForImageUploadAuthorization: vi.fn(async () => "rotated-token") };
}

function resource(file = png(), index = 1, ttl = 10_000): CloudChatImage {
  const expiresAt = Date.now() + ttl;
  return { imageId: `${expiresAt}-${index.toString(16).padStart(32, "0")}`, readToken: "r".repeat(43),
    expiresAt, mimeType: "image/png", size: file.size, width: 100, height: 80, name: file.name, original: false };
}

function uploadResponse(file = png(), index = 1) {
  const { imageId, readToken, expiresAt, mimeType, size } = resource(file, index);
  return Response.json({ imageId, readToken, expiresAt, mimeType, size });
}

function imageResponse(file = png()) {
  return new Response(file, { headers: { "Content-Type": file.type } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${Math.random()}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const value of controllers.splice(0)) value.abort();
  for (const value of stores.splice(0)) value.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("room-wide image upload queue", () => {
  it("shares the two-upload limit across messages and advances waiting work when a slot completes", async () => {
    const queue = new ChatImageUploadQueue();
    const pending = Array.from({ length: 5 }, () => deferred<Response>());
    let active = 0;
    let maximum = 0;
    let next = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const index = next++;
      active += 1; maximum = Math.max(maximum, active);
      try { return await pending[index].promise; } finally { active -= 1; }
    });
    vi.stubGlobal("fetch", fetcher);
    const uploads = Array.from({ length: 5 }, (_, index) => queue.upload("1024", png(`message-${index}.png`), authorization(), controller().signal));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    pending[0].resolve(uploadResponse(png("message-0.png"), 1));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    pending[1].resolve(uploadResponse(png("message-1.png"), 2));
    pending[2].resolve(uploadResponse(png("message-2.png"), 3));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(5);
    pending[3].resolve(uploadResponse(png("message-3.png"), 4));
    pending[4].resolve(uploadResponse(png("message-4.png"), 5));
    expect(await Promise.all(uploads)).toHaveLength(5);
    expect(maximum).toBe(2);
  });

  it("removes cancelled queued work without sending it or consuming the next available slot", async () => {
    const queue = new ChatImageUploadQueue();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(uploadResponse());
    vi.stubGlobal("fetch", fetcher);
    const one = queue.upload("1024", png(), authorization(), controller().signal);
    const two = queue.upload("1024", png(), authorization(), controller().signal);
    const cancelled = controller();
    const rejected = queue.upload("1024", png("cancelled.png"), authorization(), cancelled.signal).catch((error: unknown) => error);
    const four = queue.upload("1024", png("fourth.png"), authorization(), controller().signal);
    await settle();
    cancelled.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    first.resolve(uploadResponse());
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    const names = fetcher.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(names.map((headers) => headers["X-Image-Name"])).not.toContain("cancelled.png");
    second.resolve(uploadResponse());
    await Promise.all([one, two, four]);
  });

  it("retries one rejected authorization with the new welcome token and never loops on another 401", async () => {
    const queue = new ChatImageUploadQueue();
    const auth = authorization();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(uploadResponse());
    vi.stubGlobal("fetch", fetcher);
    await queue.upload("1024", png(), auth, controller().signal);
    expect(auth.waitForImageUploadAuthorization).toHaveBeenCalledTimes(1);
    expect(auth.waitForImageUploadAuthorization).toHaveBeenCalledWith("room-token", expect.any(AbortSignal));
    expect(fetcher.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>).Authorization))
      .toEqual(["Bearer room-token", "Bearer rotated-token"]);
    fetcher.mockReset().mockResolvedValue(new Response(null, { status: 401 }));
    vi.mocked(auth.waitForImageUploadAuthorization).mockClear();
    await expect(queue.upload("1024", png(), auth, controller().signal)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.waitForImageUploadAuthorization).toHaveBeenCalledTimes(1);
  });

  it("requires room admission before any upload and keeps authorization out of the URL", async () => {
    const queue = new ChatImageUploadQueue();
    const fetcher = vi.fn().mockResolvedValue(uploadResponse());
    vi.stubGlobal("fetch", fetcher);
    const auth = authorization();
    vi.mocked(auth.getImageUploadAuthorization).mockReturnValue(null);
    await expect(queue.upload("1024", png(), auth, controller().signal)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(auth.getImageUploadAuthorization).mockReturnValue("room-token");
    await queue.upload("1024", png(), auth, controller().signal);
    expect(fetcher.mock.calls[0][0]).toBe("/api/rooms/1024/chat-images");
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer room-token", "X-Image-Name": "screen%20shot.png" });
  });

  it("rejects a file larger than 20 MiB before sending its bytes", async () => {
    const queue = new ChatImageUploadQueue();
    const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "too-large.png", { type: "image/png" });
    const fetcher = vi.fn().mockResolvedValue(uploadResponse(file));
    vi.stubGlobal("fetch", fetcher);
    await expect(queue.upload("1024", file, authorization(), controller().signal)).rejects.toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { imageId: "https://example.com/image" }, { readToken: "short" }, { expiresAt: clock - 1 },
    { mimeType: "image/jpeg" }, { size: 99 },
  ])("rejects malformed or mismatched successful upload metadata: %j", async (change) => {
    const queue = new ChatImageUploadQueue();
    const valid = await uploadResponse().json();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...valid, ...change })));
    await expect(queue.upload("1024", png(), authorization(), controller().signal)).rejects.toMatchObject({ status: 502 });
  });
});

describe("room-owned cloud image assets", () => {
  it("deduplicates concurrent loads and sends read capabilities only in the Authorization header", async () => {
    const assets = store();
    const image = resource();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const first = assets.load(image);
    const duplicate = assets.load({ ...image });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/chat-images/${image.imageId}`);
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: `Bearer ${image.readToken}` });
    expect(init.cache).toBe("no-store");
    pending.resolve(imageResponse());
    await Promise.all([first, duplicate]);
    expect(assets.snapshot(image)).toMatchObject({ state: "ready", url: expect.stringMatching(/^blob:/) });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await assets.load(image);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains a failed load until explicitly retried and can recover", async () => {
    const assets = store();
    const image = resource();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetcher);
    await assets.load(image);
    expect(assets.snapshot(image)).toMatchObject({ state: "error", error: expect.any(ChatImageRequestError) });
    await assets.load(image);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await assets.load(image, true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(assets.snapshot(image).state).toBe("ready");
  });

  it("revokes an already displayed URL at expiry and does not fetch an expired reference", async () => {
    const assets = store();
    const image = resource(png(), 1, 1_000);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    assets.prime(image, "blob:preview");
    await vi.advanceTimersByTimeAsync(999);
    expect(assets.snapshot(image)).toEqual({ state: "ready", url: "blob:preview" });
    await vi.advanceTimersByTimeAsync(1);
    expect(assets.snapshot(image)).toEqual({ state: "expired" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    await assets.load(image, true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats a server 410 as expired without automatically fetching the same reference again", async () => {
    const assets = store();
    const image = resource();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 410 }));
    vi.stubGlobal("fetch", fetcher);
    await assets.load(image);
    expect(assets.snapshot(image).state).toBe("expired");
    await assets.load(image);
    await assets.load(image, true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates downloaded content metadata before creating a preview URL", async () => {
    const assets = store();
    const image = resource();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("wrong-size", { headers: { "Content-Type": "image/png" } })));
    await assets.load(image);
    expect(assets.snapshot(image)).toMatchObject({ state: "error", error: expect.objectContaining({ status: 502 }) });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("aborts disposed work and ignores a late successful response without creating a URL", async () => {
    const assets = store();
    const image = resource();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    assets.subscribe(changed);
    const loading = assets.load(image);
    const signal = (fetcher.mock.calls[0][1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    assets.dispose();
    const callsAtDisposal = changed.mock.calls.length;
    expect(signal.aborted).toBe(true);
    pending.resolve(imageResponse());
    await loading;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(callsAtDisposal);
  });

  it("keeps room-owned primed previews cached and prevents an old load from replacing them", async () => {
    const assets = store();
    const image = resource();
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const loading = assets.load(image);
    assets.prime(image, "blob:room-owned");
    const cachedLoading = assets.load(image);
    // A primed asset remains local even though the old aborted request settles later.
    pending.resolve(imageResponse());
    await Promise.all([loading, cachedLoading]);
    expect(assets.snapshot(image)).toEqual({ state: "ready", url: "blob:room-owned" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    assets.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:room-owned");
  });
});
