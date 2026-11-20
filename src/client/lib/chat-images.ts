import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MIME_TYPES } from "../../shared/chat-image-limits";
import { CHAT_IMAGE_MAX_COUNT, CHAT_IMAGES_MAX_BYTES } from "../../shared/chat-protocol";
import { ImageInspectionError, inspectChatImage } from "./chat-image-inspection";

export const CHAT_IMAGE_MAX_EDGE = 2_048;
export const CHAT_IMAGE_WEBP_QUALITY = 0.82;
export const CHAT_IMAGE_ROOM_BUDGET_BYTES = 96 * 1_024 * 1_024;
export const CHAT_IMAGE_INSPECTION_BYTES = 128 * 1_024;

export type ImageMemoryReservation = { resize: (bytes: number) => boolean; release: () => void };

/** The room shares preview, download and preparation reservations. */
export class ChatImageMemoryBudget {
  private used = 0;
  private preparation = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(readonly capacity = CHAT_IMAGE_ROOM_BUDGET_BYTES) {}

  get usedBytes(): number { return this.used; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reserve(bytes: number): ImageMemoryReservation | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > this.capacity) return null;
    this.used += bytes;
    let held = bytes;
    let released = false;
    const update = (next: number) => {
      this.used += next - held;
      const freed = next < held;
      held = next;
      if (freed) for (const listener of this.listeners) listener();
    };
    return {
      resize: (next) => {
        if (released || !Number.isSafeInteger(next) || next < 0 || this.used - held + next > this.capacity) return false;
        update(next);
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        update(0);
      },
    };
  }

  async prepare<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.preparation;
    let finish!: () => void;
    const turn = new Promise<void>((resolve) => { finish = resolve; });
    this.preparation = previous.then(() => turn);
    try {
      await previous;
      signal?.throwIfAborted();
      return await job();
    } finally {
      finish();
    }
  }
}

const fallbackBudget = new ChatImageMemoryBudget();

export type PreparedChatImage = {
  id: string;
  file: File;
  sourceFile: File;
  decodedBytes: number;
  width: number;
  height: number;
  original: boolean;
};

export type ChatImageErrorCode = "unsupported" | "file-too-large" | "too-many-images" | "total-too-large" | "decode-failed" | "image-too-large-to-preview" | "preview-budget-full";

export class ChatImageError extends Error {
  constructor(public readonly code: ChatImageErrorCode) {
    super(code);
    this.name = "ChatImageError";
  }
}

export function validateChatImageFiles(files: readonly File[], existing: readonly File[] = []): void {
  if (files.length + existing.length > CHAT_IMAGE_MAX_COUNT) throw new ChatImageError("too-many-images");
  for (const file of files) {
    if (!(CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) throw new ChatImageError("unsupported");
    if (!file.size || file.size > CHAT_IMAGE_MAX_BYTES) throw new ChatImageError("file-too-large");
  }
  if ([...existing, ...files].reduce((sum, file) => sum + file.size, 0) > CHAT_IMAGES_MAX_BYTES) {
    throw new ChatImageError("total-too-large");
  }
}

export function fittedChatImageSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new ChatImageError("decode-failed");
  const ratio = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Image preparation was cancelled.", "AbortError");
}

type DecodedImage = { image: CanvasImageSource; width: number; height: number; close: () => void };

async function decodeImage(file: File, signal?: AbortSignal): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    if (signal?.aborted) {
      bitmap.close();
      checkAbort(signal);
    }
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(new DOMException("Image preparation was cancelled.", "AbortError"));
      image.onload = () => resolve();
      image.onerror = () => reject(new ChatImageError("decode-failed"));
      signal?.addEventListener("abort", abort, { once: true });
      image.src = url;
      if (signal?.aborted) abort();
    });
    checkAbort(signal);
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => image.removeAttribute("src") };
  } catch (error) {
    image.removeAttribute("src");
    throw error;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
  }
}

/** Validated originals and animations retain their source bytes. */
export async function prepareChatImage(
  sourceFile: File,
  options: { id?: string; original?: boolean; signal?: AbortSignal; budget?: ChatImageMemoryBudget } = {},
): Promise<PreparedChatImage> {
  validateChatImageFiles([sourceFile]);
  const { signal, budget = fallbackBudget } = options;
  return budget.prepare(async () => {
    const reservation = budget.reserve(CHAT_IMAGE_INSPECTION_BYTES);
    if (!reservation) throw new ChatImageError("preview-budget-full");
    let decoded: DecodedImage | undefined;
    let canvas: HTMLCanvasElement | undefined;
    try {
      const info = await inspectChatImage(sourceFile, signal);
      const id = options.id ?? crypto.randomUUID();
      const original = { id, file: sourceFile, sourceFile, width: info.width, height: info.height, decodedBytes: info.decodedBytes, original: true };
      if (options.original || info.frames > 1 || sourceFile.type === "image/gif") return original;
      const fitted = fittedChatImageSize(info.width, info.height);
      const canvasBytes = fitted.width * fitted.height * 4;
      const processingBytes = sourceFile.size + info.decodedBytes + 2 * canvasBytes;
      if (processingBytes > budget.capacity) return original;
      if (!reservation.resize(processingBytes)) throw new ChatImageError("preview-budget-full");
      decoded = await decodeImage(sourceFile, signal);
      checkAbort(signal);
      if (decoded.width * decoded.height * 4 !== info.decodedBytes) throw new ChatImageError("decode-failed");
      const size = fittedChatImageSize(decoded.width, decoded.height);
      canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new ChatImageError("decode-failed");
      context.drawImage(decoded.image, 0, 0, size.width, size.height);
      const encodingCanvas = canvas;
      const blob = await new Promise<Blob | null>((resolve) => encodingCanvas.toBlob(resolve, "image/webp", CHAT_IMAGE_WEBP_QUALITY));
      checkAbort(signal);
      if (blob?.type !== "image/webp" || blob.size >= sourceFile.size) return original;
      const file = new File([blob], `${sourceFile.name.replace(/\.[^.]+$/, "") || "image"}.webp`, {
        type: "image/webp", lastModified: sourceFile.lastModified,
      });
      return { id, file, sourceFile, ...size, decodedBytes: canvasBytes, original: false };
    } catch (error) {
      if (error instanceof ChatImageError || (error instanceof DOMException && error.name === "AbortError")) throw error;
      if (error instanceof ImageInspectionError && error.limited) throw new ChatImageError("image-too-large-to-preview");
      throw new ChatImageError("decode-failed");
    } finally {
      decoded?.close();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      reservation.release();
    }
  }, signal);
}
