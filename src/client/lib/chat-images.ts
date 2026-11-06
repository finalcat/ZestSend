import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MIME_TYPES } from "../../shared/chat-image-limits";
import { CHAT_IMAGE_MAX_COUNT, CHAT_IMAGES_MAX_BYTES } from "../../shared/chat-protocol";

export const CHAT_IMAGE_MAX_EDGE = 2_048;
export const CHAT_IMAGE_WEBP_QUALITY = 0.82;

export type PreparedChatImage = {
  id: string;
  file: File;
  sourceFile: File;
  previewUrl: string;
  width: number;
  height: number;
  original: boolean;
};

export type ChatImageErrorCode = "unsupported" | "file-too-large" | "too-many-images" | "total-too-large" | "decode-failed";

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
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException("Image preparation was cancelled.", "AbortError"));
      image.onload = () => { signal?.removeEventListener("abort", abort); resolve(); };
      image.onerror = () => { signal?.removeEventListener("abort", abort); reject(new ChatImageError("decode-failed")); };
      signal?.addEventListener("abort", abort, { once: true });
      image.src = url;
      if (signal?.aborted) abort();
    });
    checkAbort(signal);
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined };
  } finally {
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
  }
}

/** GIFs stay animated; the canvas remains transparent when encoding other formats. */
export async function prepareChatImage(
  sourceFile: File,
  options: { id?: string; original?: boolean; signal?: AbortSignal } = {},
): Promise<PreparedChatImage> {
  validateChatImageFiles([sourceFile]);
  const { signal } = options;
  checkAbort(signal);
  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImage(sourceFile, signal);
    checkAbort(signal);
    const sourceWidth = decoded.width;
    const sourceHeight = decoded.height;
    fittedChatImageSize(sourceWidth, sourceHeight);
    // The wire format bounds dimensions even when the original option is used.
    if (sourceWidth > 65_535 || sourceHeight > 65_535) throw new ChatImageError("decode-failed");
    let file = sourceFile;
    let width = sourceWidth;
    let height = sourceHeight;
    if (!options.original && sourceFile.type !== "image/gif") {
      const size = fittedChatImageSize(sourceWidth, sourceHeight);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new ChatImageError("decode-failed");
      context.drawImage(decoded.image, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", CHAT_IMAGE_WEBP_QUALITY));
      checkAbort(signal);
      if (blob?.type === "image/webp" && blob.size < sourceFile.size) {
        file = new File([blob], `${sourceFile.name.replace(/\.[^.]+$/, "") || "image"}.webp`, {
          type: "image/webp", lastModified: sourceFile.lastModified,
        });
        width = size.width;
        height = size.height;
      }
    }
    checkAbort(signal);
    return {
      id: options.id ?? crypto.randomUUID(), file, sourceFile, width, height,
      previewUrl: URL.createObjectURL(file), original: file === sourceFile,
    };
  } catch (error) {
    if (error instanceof ChatImageError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new ChatImageError("decode-failed");
  } finally {
    decoded?.close();
  }
}

export function disposePreparedChatImage(image: PreparedChatImage): void {
  URL.revokeObjectURL(image.previewUrl);
}
