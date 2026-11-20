export const CHAT_IMAGE_MAX_SOURCE_EDGE = 8_192;
export const CHAT_IMAGE_MAX_FRAME_PIXELS = 12 * 1_024 * 1_024;
const WINDOW_BYTES = 64 * 1_024;
const MAX_RECORDS = 262_144;

export type ChatImageInfo = { width: number; height: number; frames: number; decodedBytes: number };

export class ImageInspectionError extends Error {
  constructor(readonly limited: boolean) {
    super(limited ? "Image exceeds the preview limit." : "Image metadata cannot be verified.");
  }
}

function requireImage(condition: unknown): asserts condition {
  if (!condition) throw new ImageInspectionError(false);
}

function imageInfo(width: number, height: number, frames = 1): ChatImageInfo {
  requireImage(width > 0 && height > 0 && frames > 0);
  if (width > CHAT_IMAGE_MAX_SOURCE_EDGE || height > CHAT_IMAGE_MAX_SOURCE_EDGE
    || width * height * frames > CHAT_IMAGE_MAX_FRAME_PIXELS) throw new ImageInspectionError(true);
  return { width, height, frames, decodedBytes: width * height * frames * 4 };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256;
}

function u24(bytes: Uint8Array, offset: number): number {
  return u16(bytes, offset) + bytes[offset + 2] * 65_536;
}

function u32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

/** Walk container records without reading compressed image payloads into JS. */
class ImageReader {
  private window = new Uint8Array();
  private windowStart = 0;
  private records = 0;

  constructor(readonly blob: Blob, private readonly signal?: AbortSignal) {}

  countRecord(): void {
    this.signal?.throwIfAborted();
    this.records += 1;
    if (this.records > MAX_RECORDS) throw new ImageInspectionError(true);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.signal?.throwIfAborted();
    requireImage(offset >= 0 && offset + length <= this.blob.size);
    if (offset < this.windowStart || offset + length > this.windowStart + this.window.length) {
      this.window = new Uint8Array(await this.blob.slice(offset, offset + WINDOW_BYTES).arrayBuffer());
      this.signal?.throwIfAborted();
      this.windowStart = offset;
    }
    return this.window.subarray(offset - this.windowStart, offset - this.windowStart + length);
  }
}

const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

async function inspectJpeg(reader: ImageReader): Promise<ChatImageInfo> {
  let offset = 2;
  while (offset < reader.blob.size) {
    reader.countRecord();
    let [prefix, marker] = await reader.read(offset, 2);
    requireImage(prefix === 0xff);
    while (marker === 0xff) {
      reader.countRecord();
      offset += 1;
      [, marker] = await reader.read(offset, 2);
    }
    requireImage(marker !== 0 && marker !== 0xd9 && marker !== 0xda);
    const lengthBytes = await reader.read(offset + 2, 2);
    const length = lengthBytes[0] * 256 + lengthBytes[1];
    requireImage(length >= 2 && offset + 2 + length <= reader.blob.size);
    if (JPEG_FRAME.has(marker)) {
      requireImage(length >= 11);
      const frame = await reader.read(offset + 4, 6);
      requireImage(frame[0] > 0 && frame[5] > 0 && length === 8 + 3 * frame[5]);
      return imageInfo(frame[3] * 256 + frame[4], frame[1] * 256 + frame[2]);
    }
    offset += 2 + length;
  }
  throw new ImageInspectionError(false);
}

async function inspectPng(reader: ImageReader): Promise<ChatImageInfo> {
  const header = await reader.read(8, 21);
  requireImage(u32(header, 0) === 13 && ascii(header, 4, 4) === "IHDR");
  const width = u32(header, 8);
  const height = u32(header, 12);
  imageInfo(width, height);
  let offset = 33;
  let declaredFrames = 0;
  let frames = 0;
  let sawImageData = false;
  let separateDefault = false;
  while (offset < reader.blob.size) {
    reader.countRecord();
    const chunk = await reader.read(offset, 8);
    const length = u32(chunk, 0);
    const kind = ascii(chunk, 4, 4);
    const end = offset + 12 + length;
    requireImage(end <= reader.blob.size);
    if (kind === "acTL") {
      requireImage(length === 8 && !declaredFrames && !sawImageData);
      declaredFrames = u32(await reader.read(offset + 8, 8), 0);
      requireImage(declaredFrames > 0);
      imageInfo(width, height, declaredFrames);
    } else if (kind === "fcTL") {
      requireImage(declaredFrames && length === 26 && frames < declaredFrames);
      const frame = await reader.read(offset + 8, 26);
      const frameWidth = u32(frame, 4);
      const frameHeight = u32(frame, 8);
      requireImage(frameWidth > 0 && frameHeight > 0 && frameWidth + u32(frame, 12) <= width && frameHeight + u32(frame, 16) <= height);
      if (!frames && sawImageData) separateDefault = true;
      frames += 1;
    } else if (kind === "fdAT") {
      requireImage(declaredFrames && frames && length >= 4);
    } else if (kind === "IDAT") {
      sawImageData = true;
    } else if (kind === "IEND") {
      requireImage(length === 0 && sawImageData && frames === declaredFrames);
      return imageInfo(width, height, (frames || 1) + Number(separateDefault));
    } else requireImage(kind !== "IHDR");
    offset = end;
  }
  throw new ImageInspectionError(false);
}

async function skipGifData(reader: ImageReader, offset: number): Promise<number> {
  while (true) {
    reader.countRecord();
    const [length] = await reader.read(offset, 1);
    offset += 1 + length;
    requireImage(offset <= reader.blob.size);
    if (!length) return offset;
  }
}

function gifColorTableBytes(flags: number): number {
  return flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0;
}

async function inspectGif(reader: ImageReader): Promise<ChatImageInfo> {
  const screen = await reader.read(6, 7);
  const width = u16(screen, 0);
  const height = u16(screen, 2);
  imageInfo(width, height);
  let offset = 13 + gifColorTableBytes(screen[4]);
  let frames = 0;
  while (offset < reader.blob.size) {
    reader.countRecord();
    const [kind] = await reader.read(offset, 1);
    if (kind === 0x3b) return imageInfo(width, height, frames);
    if (kind === 0x21) {
      const [label] = await reader.read(offset + 1, 1);
      // Plain Text Extensions are graphic-rendering blocks as well.
      if (label === 0x01) imageInfo(width, height, ++frames);
      offset = await skipGifData(reader, offset + 2);
    } else {
      requireImage(kind === 0x2c);
      const frame = await reader.read(offset + 1, 9);
      const frameWidth = u16(frame, 4);
      const frameHeight = u16(frame, 6);
      requireImage(frameWidth > 0 && frameHeight > 0 && frameWidth + u16(frame, 0) <= width && frameHeight + u16(frame, 2) <= height);
      imageInfo(width, height, ++frames);
      const start = offset + 10 + gifColorTableBytes(frame[8]);
      const [codeSize] = await reader.read(start, 1);
      requireImage(codeSize >= 2 && codeSize <= 8);
      offset = await skipGifData(reader, start + 1);
    }
  }
  throw new ImageInspectionError(false);
}

async function webpBitstreamSize(reader: ImageReader, kind: string, start: number, length: number): Promise<ChatImageInfo> {
  if (kind === "VP8L") {
    requireImage(length >= 5);
    const info = await reader.read(start, 5);
    const dimensions = u32(info, 1, true);
    requireImage(info[0] === 0x2f && dimensions >>> 29 === 0);
    return imageInfo((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1);
  }
  requireImage(kind === "VP8 " && length >= 10);
  const info = await reader.read(start, 10);
  requireImage((info[0] & 1) === 0 && info[3] === 0x9d && info[4] === 1 && info[5] === 0x2a);
  return imageInfo(u16(info, 6) & 0x3fff, u16(info, 8) & 0x3fff);
}

async function inspectWebpFrame(reader: ImageReader, start: number, end: number, canvas: ChatImageInfo): Promise<void> {
  requireImage(end - start >= 16);
  const frame = await reader.read(start, 16);
  const width = u24(frame, 6) + 1;
  const height = u24(frame, 9) + 1;
  requireImage(width + 2 * u24(frame, 0) <= canvas.width && height + 2 * u24(frame, 3) <= canvas.height);
  let foundImage = false;
  let offset = start + 16;
  while (offset < end) {
    reader.countRecord();
    requireImage(offset + 8 <= end);
    const chunk = await reader.read(offset, 8);
    const kind = ascii(chunk, 0, 4);
    const length = u32(chunk, 4, true);
    const next = offset + 8 + length + (length & 1);
    requireImage(next <= end);
    if (kind === "VP8 " || kind === "VP8L") {
      requireImage(!foundImage);
      const info = await webpBitstreamSize(reader, kind, offset + 8, length);
      requireImage(info.width === width && info.height === height);
      foundImage = true;
    } else requireImage(kind === "ALPH");
    offset = next;
  }
  requireImage(foundImage);
}

async function inspectWebp(reader: ImageReader): Promise<ChatImageInfo> {
  const header = await reader.read(0, 12);
  const end = u32(header, 4, true) + 8;
  requireImage(end === reader.blob.size);
  let canvas: ChatImageInfo | undefined;
  let still: ChatImageInfo | undefined;
  let animated = false;
  let animationHeader = false;
  let frames = 0;
  let offset = 12;
  while (offset < end) {
    reader.countRecord();
    const chunk = await reader.read(offset, 8);
    const kind = ascii(chunk, 0, 4);
    const length = u32(chunk, 4, true);
    const start = offset + 8;
    const next = start + length + (length & 1);
    requireImage(next <= end);
    if (kind === "VP8X") {
      requireImage(offset === 12 && length === 10);
      const extended = await reader.read(start, 10);
      animated = (extended[0] & 2) !== 0;
      canvas = imageInfo(u24(extended, 4) + 1, u24(extended, 7) + 1);
    } else if (kind === "ANIM") {
      requireImage(animated && !animationHeader && length === 6);
      animationHeader = true;
    } else if (kind === "ANMF") {
      requireImage(animated && canvas && animationHeader);
      imageInfo(canvas.width, canvas.height, ++frames);
      await inspectWebpFrame(reader, start, start + length, canvas);
    } else if (kind === "VP8 " || kind === "VP8L") {
      requireImage(!animated && !still);
      still = await webpBitstreamSize(reader, kind, start, length);
      requireImage(!canvas || (canvas.width === still.width && canvas.height === still.height));
    }
    offset = next;
  }
  if (animated && canvas && animationHeader) return imageInfo(canvas.width, canvas.height, frames);
  requireImage(still);
  return still;
}

export async function inspectChatImage(blob: Blob, signal?: AbortSignal): Promise<ChatImageInfo> {
  const reader = new ImageReader(blob, signal);
  const header = await reader.read(0, 12);
  if (blob.type === "image/jpeg" && header[0] === 0xff && header[1] === 0xd8) return inspectJpeg(reader);
  if (blob.type === "image/png" && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)) return inspectPng(reader);
  if (blob.type === "image/gif" && ["GIF87a", "GIF89a"].includes(ascii(header, 0, 6))) return inspectGif(reader);
  if (blob.type === "image/webp" && ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "WEBP") return inspectWebp(reader);
  throw new ImageInspectionError(false);
}
