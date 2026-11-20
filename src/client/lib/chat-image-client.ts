import { isCloudChatFile, type CloudChatFile, type CloudChatImage } from "../../shared/chat-protocol";
import { CHAT_FILE_MAX_BYTES, isChatFileName } from "../../shared/chat-file-limits";
import { CHAT_IMAGE_ID_PATTERN, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_CONCURRENT_UPLOADS, CHAT_IMAGE_MIME_TYPES } from "../../shared/chat-image-limits";
import { ImageInspectionError, inspectChatImage } from "./chat-image-inspection";
import { CHAT_IMAGE_INSPECTION_BYTES, ChatImageMemoryBudget, type ImageMemoryReservation } from "./chat-images";

export interface ChatImageAuthorization {
  getImageUploadAuthorization(): string | null;
  waitForImageUploadAuthorization(previousToken: string, signal?: AbortSignal): Promise<string | null>;
}

export class ChatImageRequestError extends Error {
  constructor(readonly status: number, readonly kind: "image" | "file" = "image") {
    super(`${kind === "image" ? "Image" : "File"} request failed (${status}).`);
    this.name = "ChatImageRequestError";
  }
}

export function chatImageErrorText(error: unknown, locale: "en" | "zh"): string {
  const status = error instanceof ChatImageRequestError ? error.status : 0;
  if (error instanceof ChatImageRequestError && error.kind === "file") {
    const messages: Record<number, [string, string]> = {
      400: ["Invalid file or file name.", "文件或文件名无效。"],
      401: ["Reconnect to the room before uploading files.", "请等待房间连接恢复后重试上传。"],
      410: ["File expired. Choose it again to send a new copy.", "文件已过期，请重新选择文件发送。"],
      413: ["Each file must be 50 MiB or smaller.", "单个文件不能超过 50 MiB。"],
      429: ["Too many uploads. Please try again later.", "上传过于频繁，请稍后重试。"],
    };
    return (messages[status] ?? ["File upload failed. Please retry.", "文件上传失败，请重试。"])[locale === "zh" ? 1 : 0];
  }
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
    const value = await this.send("image", roomId, file, authorization, signal) as Partial<CloudChatImage> | null;
    if (!value || typeof value.imageId !== "string" || !CHAT_IMAGE_ID_PATTERN.test(value.imageId)
      || typeof value.readToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.readToken)
      || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
      || Number(value.imageId.slice(0, 13)) !== value.expiresAt || value.expiresAt <= Date.now()
      || value.mimeType !== file.type || !CHAT_IMAGE_MIME_TYPES.includes(value.mimeType as typeof CHAT_IMAGE_MIME_TYPES[number])
      || value.size !== file.size) throw new ChatImageRequestError(502);
    return value as Pick<CloudChatImage, "imageId" | "readToken" | "expiresAt" | "mimeType" | "size">;
  }

  async uploadFile(roomId: string, file: File, authorization: ChatImageAuthorization, signal: AbortSignal): Promise<CloudChatFile> {
    if (signal.aborted) throw abortError();
    if (file.size > CHAT_FILE_MAX_BYTES) throw new ChatImageRequestError(413, "file");
    if (!isChatFileName(file.name)) throw new ChatImageRequestError(400, "file");
    const value = await this.send("file", roomId, file, authorization, signal);
    if (!isCloudChatFile(value) || value.expiresAt <= Date.now() || value.size !== file.size || value.name !== file.name) {
      throw new ChatImageRequestError(502, "file");
    }
    return value;
  }

  private async send(kind: "image" | "file", roomId: string, file: File, authorization: ChatImageAuthorization, signal: AbortSignal): Promise<unknown> {
    await new Promise<void>((resolve, reject) => {
      const begin = () => { signal.removeEventListener("abort", cancel); this.active += 1; resolve(); };
      const cancel = () => { this.waiting = this.waiting.filter((entry) => entry !== begin); reject(abortError()); };
      if (this.active < CHAT_IMAGE_MAX_CONCURRENT_UPLOADS) begin();
      else { this.waiting.push(begin); signal.addEventListener("abort", cancel, { once: true }); }
    });
    try {
      if (signal.aborted) throw abortError();
      let token = authorization.getImageUploadAuthorization();
      if (!token) throw new ChatImageRequestError(401, kind);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/chat-${kind}s`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": kind === "image" ? file.type : "application/octet-stream",
            [kind === "image" ? "X-Image-Name" : "X-File-Name"]: encodeURIComponent(file.name),
          },
          body: file, signal,
        });
        if (response.status === 401 && attempt === 0) {
          token = await authorization.waitForImageUploadAuthorization(token, signal);
          if (!token) throw new ChatImageRequestError(401, kind);
          continue;
        }
        if (!response.ok) throw new ChatImageRequestError(response.status, kind);
        try { return await response.json(); }
        catch { throw new ChatImageRequestError(502, kind); }
      }
      throw new ChatImageRequestError(401, kind);
    } catch (error) {
      if (signal.aborted || error instanceof ChatImageRequestError) throw error;
      throw new ChatImageRequestError(0, kind);
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export type ChatImageAsset = {
  state: "idle" | "loading" | "ready" | "error" | "expired" | "limited" | "unavailable";
  url?: string;
  error?: unknown;
};

type AssetEntry = {
  image: CloudChatImage;
  snapshot: ChatImageAsset;
  visible: number;
  presented: boolean;
  requiredBytes?: number;
  reservation?: ImageMemoryReservation;
  controller?: AbortController;
  promise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

async function readPreview(response: Response, image: CloudChatImage): Promise<Blob> {
  const mime = response.headers.get("Content-Type")?.split(";", 1)[0];
  const declaredSize = response.headers.get("Content-Length");
  if (mime !== image.mimeType || !response.body || (declaredSize !== null && Number(declaredSize) !== image.size)) {
    throw new ChatImageRequestError(502);
  }
  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          if (received !== image.size) throw new ChatImageRequestError(502);
          controller.close();
          return;
        }
        received += chunk.value.byteLength;
        if (received > image.size) throw new ChatImageRequestError(502);
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => undefined);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { headers: { "Content-Type": mime } }).blob();
}

/** One fetch at a time. Only the visible chat and explicit preview keep bytes resident. */
export class ChatImageAssetStore {
  private readonly entries = new Map<string, AssetEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly unlistenBudget: () => void;
  private previewQueue = Promise.resolve();
  private disposed = false;
  private reconsiderScheduled = false;

  constructor(readonly budget = new ChatImageMemoryBudget()) {
    this.unlistenBudget = budget.subscribe(() => this.reconsiderLimited());
  }

  private key(image: CloudChatImage): string { return `${image.imageId}:${image.readToken}`; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }

  snapshot(image: CloudChatImage): ChatImageAsset {
    if (image.expiresAt <= Date.now()) return { state: "expired" };
    return this.entries.get(this.key(image))?.snapshot ?? { state: "idle" };
  }

  isReadBlocked(image: CloudChatImage, visible?: boolean): boolean {
    const entry = this.entries.get(this.key(image));
    if (!(visible ?? Boolean(entry?.visible)) || image.expiresAt <= Date.now()) return false;
    return !entry?.presented && !["expired", "limited", "unavailable"].includes(entry?.snapshot.state ?? "idle");
  }

  markPresented(image: CloudChatImage): void {
    const entry = this.entries.get(this.key(image));
    if (!entry || entry.presented || entry.snapshot.state !== "ready") return;
    entry.presented = true;
    this.notify();
  }

  markUnavailable(image: CloudChatImage): void {
    const entry = this.entries.get(this.key(image));
    if (!entry || entry.snapshot.state !== "ready") return;
    this.releasePreview(entry);
    entry.snapshot = { state: "unavailable" };
    this.notify();
  }

  retain(image: CloudChatImage): () => void {
    if (this.disposed || image.expiresAt <= Date.now()) return () => undefined;
    const entry = this.entry(image);
    entry.visible += 1;
    void this.load(image);
    return () => {
      entry.visible -= 1;
      if (entry.visible > 0) return;
      entry.controller?.abort();
      entry.controller = undefined;
      entry.promise = undefined;
      this.releasePreview(entry);
      if (entry.snapshot.state === "ready" || entry.snapshot.state === "loading" || entry.snapshot.state === "limited") {
        entry.snapshot = { state: "idle" };
      }
    };
  }

  private entry(image: CloudChatImage): AssetEntry {
    const key = this.key(image);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: AssetEntry = { image, snapshot: { state: "idle" }, visible: 0, presented: false };
    this.entries.set(key, entry);
    entry.timer = setTimeout(() => {
      entry.controller?.abort();
      this.releasePreview(entry);
      entry.snapshot = { state: "expired" };
      this.notify();
    }, Math.max(0, image.expiresAt - Date.now()));
    return entry;
  }

  private releasePreview(entry: AssetEntry): void {
    if (entry.snapshot.url) URL.revokeObjectURL(entry.snapshot.url);
    entry.reservation?.release();
    entry.reservation = undefined;
  }

  private reconsiderLimited(): void {
    if (this.reconsiderScheduled || this.disposed) return;
    this.reconsiderScheduled = true;
    queueMicrotask(() => {
      this.reconsiderScheduled = false;
      if (this.disposed) return;
      const free = this.budget.capacity - this.budget.usedBytes;
      const next = [...this.entries.values()].find((entry) =>
        entry.visible > 0 && !entry.promise && entry.snapshot.state === "limited" && (entry.requiredBytes ?? Infinity) <= free);
      if (next) void this.load(next.image, true);
    });
  }

  async load(image: CloudChatImage, retry = false): Promise<void> {
    if (this.disposed || image.expiresAt <= Date.now()) return;
    const entry = this.entry(image);
    if (entry.promise) return entry.promise;
    if (entry.snapshot.state === "expired" || entry.snapshot.state === "unavailable"
      || (!retry && (entry.snapshot.state === "ready" || entry.snapshot.state === "error"))) return;
    if (!Number.isSafeInteger(image.size) || image.size <= 0 || image.size > CHAT_IMAGE_MAX_BYTES) {
      entry.snapshot = { state: "unavailable" };
      this.notify();
      return;
    }
    this.releasePreview(entry);
    const controller = new AbortController();
    entry.controller = controller;
    entry.snapshot = { state: "loading" };
    const active = () => !this.disposed && !controller.signal.aborted && entry.controller === controller && image.expiresAt > Date.now();
    const run = this.previewQueue.then(async () => {
      if (!active()) return;
      const readingBytes = 2 * image.size + CHAT_IMAGE_INSPECTION_BYTES;
      const reservation = this.budget.reserve(readingBytes);
      if (!reservation) {
        entry.requiredBytes = Math.max(readingBytes, entry.requiredBytes ?? 0);
        entry.snapshot = { state: "limited" };
        return;
      }
      try {
        const response = await fetch(`/api/chat-images/${encodeURIComponent(image.imageId)}`, {
          headers: { Authorization: `Bearer ${image.readToken}` }, cache: "no-store", signal: controller.signal,
        });
        if (!active()) {
          void response.body?.cancel().catch(() => undefined);
          return;
        }
        if (!response.ok) throw new ChatImageRequestError(response.status);
        const blob = await readPreview(response, image);
        if (!active()) return;
        const info = await inspectChatImage(blob, controller.signal);
        if (!active()) return;
        const previewBytes = image.size + info.decodedBytes;
        if (!reservation.resize(previewBytes)) {
          entry.requiredBytes = Math.max(readingBytes, previewBytes);
          entry.snapshot = { state: "limited" };
          return;
        }
        entry.snapshot = { state: "ready", url: URL.createObjectURL(blob) };
        entry.reservation = reservation;
      } catch (error) {
        if (!active()) return;
        if (error instanceof ImageInspectionError) entry.snapshot = { state: "unavailable" };
        else if (error instanceof ChatImageRequestError && error.status === 410) entry.snapshot = { state: "expired" };
        else entry.snapshot = { state: "error", error };
        controller.abort();
      } finally {
        if (entry.reservation !== reservation) reservation.release();
      }
    }).finally(() => {
      if (entry.controller !== controller) return;
      entry.controller = undefined;
      entry.promise = undefined;
      if (!this.disposed) this.notify();
    });
    entry.promise = run;
    this.previewQueue = run.catch(() => undefined);
    this.notify();
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.unlistenBudget();
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      if (entry.timer) clearTimeout(entry.timer);
      this.releasePreview(entry);
    }
    this.entries.clear();
    this.listeners.clear();
  }
}
