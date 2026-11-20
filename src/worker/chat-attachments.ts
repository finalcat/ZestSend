import { CHAT_FILE_ID_PATTERN, CHAT_FILE_MAX_BYTES, isChatFileName } from "../shared/chat-file-limits";
import {
  CHAT_IMAGE_ID_PATTERN, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MIME_TYPES,
  CHAT_IMAGE_TTL_MS, CHAT_IMAGE_UPLOAD_TIMEOUT_MS, type ChatImageMimeType,
} from "../shared/chat-image-limits";

export type ChatAttachmentKind = "file" | "image";

const policies = {
  file: { prefix: "chat-files/", pattern: CHAT_FILE_ID_PATTERN, maxBytes: CHAT_FILE_MAX_BYTES, limit: "Files must be 50 MiB or smaller.", label: "File" },
  image: { prefix: "chat-images/", pattern: CHAT_IMAGE_ID_PATTERN, maxBytes: CHAT_IMAGE_MAX_BYTES, limit: "Images must be 20 MiB or smaller.", label: "Image" },
} as const;
type AttachmentPolicy = typeof policies[ChatAttachmentKind];

const BINARY_MIME = "application/octet-stream";
const READ_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

class AttachmentRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function jsonError(message: string, status: number, retryAfterMs?: number): Response {
  return Response.json({ message, status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }, {
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

function createReadToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function objectKey(policy: AttachmentPolicy, id: string): string {
  const deadline = Number(id.slice(0, 13));
  return `${policy.prefix}${new Date(deadline).toISOString().slice(0, 13)}/${id}`;
}

function signatureMatches(bytes: Uint8Array, mimeType: ChatImageMimeType): boolean {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (mimeType === "image/webp") return bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
  return bytes.length >= 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a");
}

async function readInitialChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>, policy: AttachmentPolicy, deadline: number,
): Promise<Uint8Array> {
  const timeoutError = new AttachmentRequestError(408, `${policy.label} upload timed out.`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel(timeoutError).catch(() => undefined);
  }, Math.max(1, deadline - Date.now()));
  try {
    const result = await reader.read();
    if (timedOut) throw timeoutError;
    if (result.done) throw new AttachmentRequestError(400, `The ${policy.label.toLowerCase()} is empty.`);
    return result.value;
  } catch (error) {
    throw timedOut ? timeoutError : error;
  } finally {
    clearTimeout(timer);
  }
}

/** Verifies length while passing each chunk to R2 with backpressure. Images additionally verify their signature. */
async function copyAttachmentBody(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined, writable: WritableStream<Uint8Array> | undefined,
  policy: AttachmentPolicy, size: number, imageType: ChatImageMimeType | undefined,
  deadline: number, onBytes: (bytes: number) => void, firstChunk?: Uint8Array, signal?: AbortSignal,
): Promise<void> {
  const writer = writable?.getWriter();
  const prefix = new Uint8Array(12);
  let prefixLength = 0;
  let verified = !imageType;
  let bytesRead = 0;
  let timeoutError: AttachmentRequestError | undefined;
  const cancel = (error: unknown) => {
    void reader?.cancel(error).catch(() => undefined);
    void writer?.abort(error).catch(() => undefined);
  };
  const abort = () => cancel(signal?.reason);
  const timeout = setTimeout(() => {
    timeoutError = new AttachmentRequestError(408, `${policy.label} upload timed out.`);
    cancel(timeoutError);
  }, Math.max(1, deadline - Date.now()));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  const verify = (bytes: Uint8Array) => {
    if (imageType && !signatureMatches(bytes, imageType)) throw new AttachmentRequestError(415, "Image contents do not match its type.");
  };
  try {
    let pendingChunk = firstChunk;
    while (reader) {
      const { done, value } = pendingChunk ? { done: false, value: pendingChunk } : await reader.read();
      pendingChunk = undefined;
      if (timeoutError) throw timeoutError;
      signal?.throwIfAborted();
      if (done) break;
      bytesRead += value.byteLength;
      onBytes(bytesRead);
      if (bytesRead > policy.maxBytes) throw new AttachmentRequestError(413, policy.limit);
      if (bytesRead > size) throw new AttachmentRequestError(400, `${policy.label} size does not match Content-Length.`);
      let offset = 0;
      if (!verified) {
        offset = Math.min(prefix.length - prefixLength, value.byteLength);
        prefix.set(value.subarray(0, offset), prefixLength);
        prefixLength += offset;
        if (prefixLength === prefix.length) {
          verify(prefix);
          verified = true;
          await writer?.write(prefix);
        }
      }
      if (verified && offset < value.byteLength) await writer?.write(value.subarray(offset));
    }
    signal?.throwIfAborted();
    if (bytesRead !== size) throw new AttachmentRequestError(400, `${policy.label} size does not match Content-Length.`);
    if (!verified) {
      const shortPrefix = prefix.subarray(0, prefixLength);
      verify(shortPrefix);
      await writer?.write(shortPrefix);
    }
    await writer?.close();
  } catch (error) {
    await Promise.allSettled([reader?.cancel(error), writer?.abort(error)]);
    throw timeoutError ?? error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
    writer?.releaseLock();
  }
}

export async function uploadChatAttachment(request: Request, env: Env, roomId: string, kind: ChatAttachmentKind): Promise<Response> {
  const token = bearer(request);
  if (!token) return jsonError("A valid room seat is required.", 401);
  const policy = policies[kind];
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const imageType = kind === "image" ? CHAT_IMAGE_MIME_TYPES.find((type) => type === contentType) : undefined;
  if (kind === "image" && !imageType) return jsonError("Unsupported image type.", 415);
  const length = request.headers.get("Content-Length");
  if (length === null || !/^\d+$/.test(length)) return jsonError("Content-Length is required.", 411);
  const size = Number(length);
  if (size > policy.maxBytes) return jsonError(policy.limit, 413);
  if (!Number.isSafeInteger(size) || (!size && kind === "image") || (size > 0 && !request.body)) {
    return jsonError(`The ${kind} is empty.`, 400);
  }
  let name: string;
  try { name = decodeURIComponent(request.headers.get(`X-${policy.label}-Name`) ?? kind); }
  catch { return jsonError(`Invalid ${kind} name.`, 400); }
  if (kind === "file" ? !isChatFileName(name) : !name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) {
    return jsonError(`Invalid ${kind} name.`, 400);
  }

  const room = env.ROOMS.getByName(roomId);
  const admission = kind === "image" ? await room.beginChatImageUpload(token, size) : await room.beginChatFileUpload(token, size);
  if (!admission.ok) {
    return jsonError(admission.status === 401 ? "The room seat must be verified before uploading." : `${policy.label} upload limit reached.`, admission.status, admission.retryAfterMs);
  }

  let actualBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const deadline = Date.now() + CHAT_IMAGE_UPLOAD_TIMEOUT_MS;
    reader = request.body?.getReader();
    const initial = size && reader ? await readInitialChunk(reader, policy, deadline) : undefined;
    if (initial) {
      actualBytes = initial.byteLength;
      if (actualBytes > policy.maxBytes) throw new AttachmentRequestError(413, policy.limit);
      if (actualBytes > size) throw new AttachmentRequestError(400, `${policy.label} size does not match Content-Length.`);
      if (imageType && (actualBytes >= 12 || actualBytes === size) && !signatureMatches(initial, imageType)) {
        throw new AttachmentRequestError(415, "Image contents do not match its type.");
      }
    }
    const expiresAt = Date.now() + CHAT_IMAGE_TTL_MS;
    const id = `${expiresAt}-${crypto.randomUUID().replace(/-/g, "")}`;
    const readToken = createReadToken();
    const key = objectKey(policy, id);
    const mimeType = imageType ?? BINARY_MIME;
    const metadata = {
      httpMetadata: { contentType: mimeType, cacheControl: PRIVATE_HEADERS["Cache-Control"] },
      customMetadata: { readTokenHash: await hash(readToken), expiresAt: String(expiresAt), name, ownerSlotId: admission.slotId },
    };
    const recordBytes = (bytes: number) => { actualBytes = bytes; };
    let object: R2Object | null;
    if (size === 0) {
      const copying = copyAttachmentBody(reader, undefined, policy, size, imageType, deadline, recordBytes);
      reader = undefined;
      await copying;
      object = await env.CHAT_IMAGES.put(key, new Uint8Array(0), metadata);
    } else {
      const stream = new FixedLengthStream(size);
      const storageAbort = new AbortController();
      const storing = env.CHAT_IMAGES.put(key, stream.readable, metadata).catch((error: unknown) => {
        storageAbort.abort(error);
        throw error;
      });
      // Preserve copy errors such as wrong size when aborting the stream also rejects R2.put.
      const copying = copyAttachmentBody(reader, stream.writable, policy, size, imageType, deadline, recordBytes, initial, storageAbort.signal);
      reader = undefined;
      const [copied, stored] = await Promise.allSettled([copying, storing]);
      if (copied.status === "rejected" || stored.status === "rejected") {
        // A complete-length prefix can be committed before an oversized source is detected.
        await env.CHAT_IMAGES.delete(key).catch(() => console.error(JSON.stringify({ event: `chat_${kind}_failed_upload_cleanup` })));
      }
      if (copied.status === "rejected") throw copied.reason;
      if (stored.status === "rejected") throw stored.reason;
      object = stored.value;
    }
    if (!object) throw new Error(`${policy.label} storage rejected the upload.`);
    const reference = { readToken, expiresAt, size };
    return Response.json(kind === "image" ? { ...reference, imageId: id, mimeType } : { ...reference, fileId: id, name }, {
      status: 201, headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    if (error instanceof AttachmentRequestError) return jsonError(error.message, error.status);
    console.error(JSON.stringify({ event: `chat_${kind}_upload_failed` }));
    return jsonError(`The ${kind} could not be uploaded. Please retry.`, 503);
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    await room.finishChatAttachmentUpload(admission.slotId, admission.uploadId, actualBytes).catch(() => {
      console.error(JSON.stringify({ event: `chat_${kind}_upload_release_failed` }));
    });
  }
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename*=UTF-8''${encoded}`;
}

async function readAttachment(env: Env, id: string, token: string | null, kind: ChatAttachmentKind, attachment: boolean): Promise<Response> {
  if (!token || !READ_TOKEN_PATTERN.test(token)) return jsonError(`${kind === "image" ? "An image" : "A file"} read credential is required.`, 401);
  const policy = policies[kind];
  if (!policy.pattern.test(id)) return jsonError(`${policy.label} not found.`, 404);
  const expiresAt = Number(id.slice(0, 13));
  if (expiresAt <= Date.now()) return jsonError(`This ${kind} has expired.`, 410);
  const key = objectKey(policy, id);
  const metadata = await env.CHAT_IMAGES.head(key);
  if (!metadata || metadata.customMetadata?.readTokenHash !== await hash(token)
    || metadata.customMetadata?.expiresAt !== String(expiresAt)) return jsonError(`${policy.label} not found.`, 404);
  const object = await env.CHAT_IMAGES.get(key);
  if (!object) return jsonError(`${policy.label} not found.`, 404);
  const headers = new Headers(PRIVATE_HEADERS);
  headers.set("Content-Type", attachment ? BINARY_MIME : object.httpMetadata?.contentType ?? BINARY_MIME);
  headers.set("Content-Length", String(object.size));
  headers.set("Content-Disposition", contentDisposition(attachment ? "attachment" : "inline", object.customMetadata?.name ?? kind));
  return new Response(object.body, { headers });
}

export function previewChatImage(request: Request, env: Env, id: string): Promise<Response> {
  return readAttachment(env, id, bearer(request), "image", false);
}

// A native download submits only a bounded credential form, never the file payload.
async function readCredentialForm(request: Request): Promise<string | null> {
  const limit = 512;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(limit);
  let used = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - used) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      bytes.set(value, used);
      used += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes.subarray(0, used)));
  return form.size === 1 ? form.get("readToken") : null;
}

export async function downloadChatAttachment(request: Request, env: Env, id: string, kind: ChatAttachmentKind): Promise<Response> {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return jsonError("This download must come from the room page.", 403);
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return jsonError("The download credential form is invalid.", 415);
  }
  try {
    return await readAttachment(env, id, await readCredentialForm(request), kind, true);
  } catch {
    console.error(JSON.stringify({ event: `chat_${kind}_download_failed` }));
    return jsonError(`The ${kind} could not be downloaded. Please retry.`, 503);
  }
}

export async function cleanupExpiredChatAttachments(env: Pick<Env, "CHAT_IMAGES">, kind: ChatAttachmentKind, now: number): Promise<void> {
  const policy = policies[kind];
  let cursor: string | undefined;
  do {
    const page = await env.CHAT_IMAGES.list({ prefix: policy.prefix, delimiter: "/", cursor, limit: 1_000 });
    for (const prefix of page.delimitedPrefixes) {
      const hour = prefix.slice(policy.prefix.length, -1);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour) || Date.parse(`${hour}:00:00.000Z`) > now) continue;
      let attachmentCursor: string | undefined;
      do {
        const attachments = await env.CHAT_IMAGES.list({ prefix, cursor: attachmentCursor, limit: 1_000 });
        const expired = attachments.objects.filter((object) => {
          const id = object.key.slice(prefix.length);
          return policy.pattern.test(id) && Number(id.slice(0, 13)) <= now;
        }).map((object) => object.key);
        if (expired.length) await env.CHAT_IMAGES.delete(expired);
        attachmentCursor = attachments.truncated ? attachments.cursor : undefined;
      } while (attachmentCursor);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
