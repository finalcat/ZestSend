import {
  CHAT_IMAGE_ID_PATTERN, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MIME_TYPES,
  CHAT_IMAGE_TTL_MS, CHAT_IMAGE_UPLOAD_TIMEOUT_MS, type ChatImageMimeType,
} from "../shared/chat-image-limits";

const PREFIX = "chat-images/";
const READ_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

class ImageRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function jsonError(message: string, status: number, retryAfterMs?: number): Response {
  return Response.json({ message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }, {
    status,
    headers: { ...PRIVATE_HEADERS, ...(retryAfterMs === undefined ? {} : { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) }) },
  });
}

function bearer(request: Request): string | null {
  return /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function objectKey(imageId: string): string {
  const deadline = Number(imageId.slice(0, 13));
  return `${PREFIX}${new Date(deadline).toISOString().slice(0, 13)}/${imageId}`;
}

function signatureMatches(bytes: Uint8Array, mimeType: ChatImageMimeType): boolean {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (mimeType === "image/webp") return bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
  return bytes.length >= 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a");
}

/** Preserve a known stream length while enforcing the actual bytes and signature. */
async function copyImageBody(
  reader: ReadableStreamDefaultReader<Uint8Array>, firstChunk: Uint8Array, size: number,
  mimeType: ChatImageMimeType, writable: WritableStream, deadline: number, onBytes: (bytes: number) => void,
): Promise<void> {
  const writer = writable.getWriter();
  const prefix = new Uint8Array(12);
  let prefixLength = 0;
  let verified = false;
  let bytesRead = 0;
  let timeoutError: ImageRequestError | undefined;
  const timeout = setTimeout(() => {
    timeoutError = new ImageRequestError(408, "Image upload timed out.");
    void reader.cancel(timeoutError).catch(() => undefined);
    void writer.abort(timeoutError).catch(() => undefined);
  }, Math.max(1, deadline - Date.now()));
  try {
    let first = true;
    while (true) {
      const result = first ? { done: false, value: firstChunk } : await reader.read();
      first = false;
      if (timeoutError) throw timeoutError;
      if (result.done) break;
      const chunk = result.value;
      bytesRead += chunk.byteLength;
      onBytes(bytesRead);
      if (bytesRead > CHAT_IMAGE_MAX_BYTES) throw new ImageRequestError(413, "Images must be 20 MiB or smaller.");
      if (bytesRead > size) throw new ImageRequestError(400, "Image size does not match Content-Length.");
      let offset = 0;
      if (!verified) {
        offset = Math.min(12 - prefixLength, chunk.length);
        prefix.set(chunk.subarray(0, offset), prefixLength);
        prefixLength += offset;
        if (prefixLength === 12) {
          if (!signatureMatches(prefix, mimeType)) throw new ImageRequestError(415, "Image contents do not match its type.");
          verified = true;
          await writer.write(prefix);
        }
      }
      if (verified && offset < chunk.length) await writer.write(chunk.subarray(offset));
    }
    if (bytesRead !== size) throw new ImageRequestError(400, "Image size does not match Content-Length.");
    if (!verified) {
      const shortPrefix = prefix.subarray(0, prefixLength);
      if (!signatureMatches(shortPrefix, mimeType)) throw new ImageRequestError(415, "Image contents do not match its type.");
      await writer.write(shortPrefix);
    }
    await writer.close();
  } catch (error) {
    await Promise.allSettled([reader.cancel(error), writer.abort(error)]);
    throw timeoutError ?? error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    writer.releaseLock();
  }
}

export async function uploadChatImage(request: Request, env: Env, roomId: string): Promise<Response> {
  const token = bearer(request);
  if (!token) return jsonError("A valid room seat is required.", 401);
  const mimeType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!CHAT_IMAGE_MIME_TYPES.includes(mimeType as ChatImageMimeType)) return jsonError("Unsupported image type.", 415);
  const length = request.headers.get("Content-Length");
  if (!length || !/^\d+$/.test(length)) return jsonError("Content-Length is required.", 411);
  const size = Number(length);
  if (size > CHAT_IMAGE_MAX_BYTES) return jsonError("Images must be 20 MiB or smaller.", 413);
  if (!Number.isSafeInteger(size) || size <= 0 || !request.body) return jsonError("The image is empty.", 400);
  let name: string;
  try { name = decodeURIComponent(request.headers.get("X-Image-Name") ?? "image"); }
  catch { return jsonError("Invalid image name.", 400); }
  if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) return jsonError("Invalid image name.", 400);

  const room = env.ROOMS.getByName(roomId);
  const admission = await room.beginChatImageUpload(token, size);
  if (!admission.ok) return jsonError(admission.status === 401 ? "The room seat must be verified before uploading." : "Image upload limit reached.", admission.status, admission.retryAfterMs);
  let actualBytes = 0;
  let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const deadline = Date.now() + CHAT_IMAGE_UPLOAD_TIMEOUT_MS;
    source = request.body.getReader();
    let timedOut = false;
    const firstReadTimeout = setTimeout(() => { timedOut = true; void source?.cancel().catch(() => undefined); }, CHAT_IMAGE_UPLOAD_TIMEOUT_MS);
    let first: ReadableStreamReadResult<Uint8Array>;
    try { first = await source.read(); } finally { clearTimeout(firstReadTimeout); }
    if (timedOut) throw new ImageRequestError(408, "Image upload timed out.");
    if (first.done) throw new ImageRequestError(400, "The image is empty.");
    actualBytes = first.value.byteLength;
    if (actualBytes > CHAT_IMAGE_MAX_BYTES) throw new ImageRequestError(413, "Images must be 20 MiB or smaller.");
    if (actualBytes > size) throw new ImageRequestError(400, "Image size does not match Content-Length.");
    if ((actualBytes >= 12 || actualBytes === size) && !signatureMatches(first.value, mimeType as ChatImageMimeType)) {
      throw new ImageRequestError(415, "Image contents do not match its type.");
    }
    const expiresAt = Date.now() + CHAT_IMAGE_TTL_MS;
    const imageId = `${expiresAt}-${crypto.randomUUID().replace(/-/g, "")}`;
    const token = readToken();
    const key = objectKey(imageId);
    const stream = new FixedLengthStream(size);
    const stored = env.CHAT_IMAGES.put(key, stream.readable, {
      httpMetadata: { contentType: mimeType, cacheControl: "private, no-store" },
      customMetadata: { readTokenHash: await hash(token), expiresAt: String(expiresAt), name, ownerSlotId: admission.slotId },
    }).then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await copyImageBody(source, first.value, size, mimeType as ChatImageMimeType, stream.writable, deadline, (bytes) => { actualBytes = bytes; });
      source = undefined;
    } catch (error) {
      await stored;
      // FixedLengthStream may have delivered its declared length before a
      // dishonest source reveals extra bytes. Never retain a rejected upload.
      await env.CHAT_IMAGES.delete(key);
      throw error;
    }
    const result = await stored;
    if ("error" in result) throw result.error;
    if (!result.value) throw new Error("Image storage rejected the upload.");
    return Response.json({ imageId, readToken: token, expiresAt, mimeType, size }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof ImageRequestError) return jsonError(error.message, error.status);
    console.error(JSON.stringify({ event: "chat_image_upload_failed" }));
    return jsonError("The image could not be uploaded. Please retry.", 503);
  } finally {
    if (source) {
      await source.cancel().catch(() => undefined);
      source.releaseLock();
    }
    await room.finishChatImageUpload(admission.slotId, admission.uploadId, actualBytes).catch(() => {
      console.error(JSON.stringify({ event: "chat_image_upload_release_failed" }));
    });
  }
}

export async function downloadChatImage(request: Request, env: Env, imageId: string): Promise<Response> {
  const token = bearer(request);
  if (!token || !READ_TOKEN_PATTERN.test(token)) return jsonError("An image read credential is required.", 401);
  if (!CHAT_IMAGE_ID_PATTERN.test(imageId)) return jsonError("Image not found.", 404);
  const expiresAt = Number(imageId.slice(0, 13));
  if (expiresAt <= Date.now()) return jsonError("This image has expired.", 410);
  const metadata = await env.CHAT_IMAGES.head(objectKey(imageId));
  if (!metadata || metadata.customMetadata?.readTokenHash !== await hash(token)
    || metadata.customMetadata?.expiresAt !== String(expiresAt)) return jsonError("Image not found.", 404);
  const object = await env.CHAT_IMAGES.get(objectKey(imageId));
  if (!object) return jsonError("Image not found.", 404);
  const headers = new Headers(PRIVATE_HEADERS);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(object.customMetadata?.name ?? "image")}`);
  return new Response(object.body, { headers });
}

export async function cleanupExpiredChatImages(env: Pick<Env, "CHAT_IMAGES">, now = Date.now()): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.CHAT_IMAGES.list({ prefix: PREFIX, delimiter: "/", cursor, limit: 1_000 });
    for (const prefix of page.delimitedPrefixes) {
      const hour = prefix.slice(PREFIX.length, -1);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour) || Date.parse(`${hour}:00:00.000Z`) > now) continue;
      let imageCursor: string | undefined;
      do {
        const images = await env.CHAT_IMAGES.list({ prefix, cursor: imageCursor, limit: 1_000 });
        const expired = images.objects.filter((object) => {
          const imageId = object.key.slice(prefix.length);
          return CHAT_IMAGE_ID_PATTERN.test(imageId) && Number(imageId.slice(0, 13)) <= now;
        }).map((object) => object.key);
        if (expired.length) await env.CHAT_IMAGES.delete(expired);
        imageCursor = images.truncated ? images.cursor : undefined;
      } while (imageCursor);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
