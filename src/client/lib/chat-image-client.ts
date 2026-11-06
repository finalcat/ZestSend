import type { CloudChatImage } from "../../shared/chat-protocol";
import { CHAT_IMAGE_ID_PATTERN, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MIME_TYPES } from "../../shared/chat-image-limits";

export interface ChatImageAuthorization {
  getImageUploadAuthorization(): string | null;
  waitForImageUploadAuthorization(previousToken: string, signal?: AbortSignal): Promise<string | null>;
}

export class ChatImageRequestError extends Error {
  constructor(readonly status: number) {
    super(`Image request failed (${status}).`);
    this.name = "ChatImageRequestError";
  }
}

export function chatImageErrorText(error: unknown, locale: "en" | "zh"): string {
  const status = error instanceof ChatImageRequestError ? error.status : 0;
  const messages: Record<number, [string, string]> = {
    401: ["Reconnect to the room before uploading images.", "请等待房间连接恢复后重试上传。"],
    403: ["This image is unavailable.", "无权读取此图片。"],
    404: ["This image is unavailable.", "图片暂不可用，请重试。"],
    410: ["Image expired. Choose it again to send a new copy.", "图片已过期，请重新选择图片发送。"],
    413: ["Each image must be 20 MB or smaller.", "单张图片不能超过 20MB。"],
    415: ["Choose a JPEG, PNG, WebP or GIF image.", "请选择 JPEG、PNG、WebP 或 GIF 图片。"],
    429: ["Too many image uploads. Please try again later.", "图片上传过于频繁，请稍后重试。"],
    503: ["Image storage is not available yet.", "图片存储暂不可用，请稍后重试。"],
  };
  return (messages[status] ?? ["Image request failed. Please retry.", "图片处理失败，请重试。"])[locale === "zh" ? 1 : 0];
}

function abortError(): DOMException { return new DOMException("The room was closed.", "AbortError"); }

/** The limit is shared by all messages in a room, not only one selection. */
export class ChatImageUploadQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  async upload(roomId: string, file: File, authorization: ChatImageAuthorization, signal: AbortSignal): Promise<Pick<CloudChatImage, "imageId" | "readToken" | "expiresAt" | "mimeType" | "size">> {
    if (signal.aborted) throw abortError();
    if (file.size > CHAT_IMAGE_MAX_BYTES) throw new ChatImageRequestError(413);
    if (!CHAT_IMAGE_MIME_TYPES.includes(file.type as typeof CHAT_IMAGE_MIME_TYPES[number])) throw new ChatImageRequestError(415);
    await new Promise<void>((resolve, reject) => {
      const begin = () => { signal.removeEventListener("abort", cancel); this.active += 1; resolve(); };
      const cancel = () => { this.waiting = this.waiting.filter((entry) => entry !== begin); reject(abortError()); };
      if (this.active < 2) begin();
      else { this.waiting.push(begin); signal.addEventListener("abort", cancel, { once: true }); }
    });
    try {
      if (signal.aborted) throw abortError();
      let token = authorization.getImageUploadAuthorization();
      if (!token) throw new ChatImageRequestError(401);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/chat-images`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type, "X-Image-Name": encodeURIComponent(file.name) },
          body: file, signal,
        });
        if (response.status === 401 && attempt === 0) {
          token = await authorization.waitForImageUploadAuthorization(token, signal);
          if (!token) throw new ChatImageRequestError(401);
          continue;
        }
        if (!response.ok) throw new ChatImageRequestError(response.status);
        const value = await response.json() as Partial<CloudChatImage>;
        if (typeof value.imageId !== "string" || !CHAT_IMAGE_ID_PATTERN.test(value.imageId)
          || typeof value.readToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.readToken)
          || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
          || Number(value.imageId.slice(0, 13)) !== value.expiresAt
          || value.expiresAt <= Date.now() || value.mimeType !== file.type
          || !CHAT_IMAGE_MIME_TYPES.includes(value.mimeType as typeof CHAT_IMAGE_MIME_TYPES[number])
          || value.size !== file.size || value.size > CHAT_IMAGE_MAX_BYTES) throw new ChatImageRequestError(502);
        return value as Pick<CloudChatImage, "imageId" | "readToken" | "expiresAt" | "mimeType" | "size">;
      }
      throw new ChatImageRequestError(401);
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export type ChatImageAsset = { state: "idle" | "loading" | "ready" | "error" | "expired"; url?: string; error?: unknown };
type AssetEntry = { image: CloudChatImage; snapshot: ChatImageAsset; controller?: AbortController; promise?: Promise<void>; timer?: ReturnType<typeof setTimeout> };

/** Room-owned URLs survive PC replacement and are revoked at expiry or room disposal. */
export class ChatImageAssetStore {
  private entries = new Map<string, AssetEntry>();
  private listeners = new Set<() => void>();
  private disposed = false;

  private key(image: CloudChatImage): string { return `${image.imageId}:${image.readToken}`; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) listener(); }

  snapshot(image: CloudChatImage): ChatImageAsset {
    if (image.expiresAt <= Date.now()) return { state: "expired" };
    return this.entries.get(this.key(image))?.snapshot ?? { state: "idle" };
  }

  private entry(image: CloudChatImage): AssetEntry {
    const key = this.key(image);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { image, snapshot: { state: "idle" } };
      this.entries.set(key, entry);
      entry.timer = setTimeout(() => {
        entry!.controller?.abort();
        if (entry!.snapshot.url) URL.revokeObjectURL(entry!.snapshot.url);
        entry!.snapshot = { state: "expired" };
        this.notify();
      }, Math.max(0, image.expiresAt - Date.now()));
    }
    return entry;
  }

  prime(image: CloudChatImage, url: string): void {
    if (this.disposed || image.expiresAt <= Date.now()) { URL.revokeObjectURL(url); return; }
    const entry = this.entry(image);
    entry.controller?.abort();
    if (entry.snapshot.url && entry.snapshot.url !== url) URL.revokeObjectURL(entry.snapshot.url);
    entry.snapshot = { state: "ready", url };
    this.notify();
  }

  async load(image: CloudChatImage, retry = false): Promise<void> {
    if (this.disposed || image.expiresAt <= Date.now()) return;
    const entry = this.entry(image);
    if (entry.snapshot.state === "expired") return;
    if (entry.promise) return entry.promise;
    if ((entry.snapshot.state === "ready" || entry.snapshot.state === "error") && !retry) return;
    if (entry.snapshot.url) URL.revokeObjectURL(entry.snapshot.url);
    const controller = new AbortController();
    entry.controller = controller;
    entry.snapshot = { state: "loading" };
    this.notify();
    entry.promise = (async () => {
      try {
        const response = await fetch(`/api/chat-images/${encodeURIComponent(image.imageId)}`, {
          headers: { Authorization: `Bearer ${image.readToken}` }, cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new ChatImageRequestError(response.status);
        const blob = await response.blob();
        if (blob.size !== image.size || blob.size > CHAT_IMAGE_MAX_BYTES || blob.type.split(";")[0] !== image.mimeType) throw new ChatImageRequestError(502);
        if (this.disposed || controller.signal.aborted || image.expiresAt <= Date.now()) return;
        entry.snapshot = { state: "ready", url: URL.createObjectURL(blob) };
      } catch (error) {
        if (this.disposed || controller.signal.aborted) return;
        entry.snapshot = error instanceof ChatImageRequestError && error.status === 410 ? { state: "expired" } : { state: "error", error };
      } finally {
        entry.promise = undefined;
        if (!this.disposed) this.notify();
      }
    })();
    return entry.promise;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.snapshot.url) URL.revokeObjectURL(entry.snapshot.url);
    }
    this.entries.clear(); this.listeners.clear();
  }
}
