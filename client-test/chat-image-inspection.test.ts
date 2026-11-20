import { describe, expect, it } from "vitest";
import { inspectChatImage } from "../src/client/lib/chat-image-inspection";

const text = (value: string) => new TextEncoder().encode(value);

function integer(value: number, littleEndian = false) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, littleEndian);
  return bytes;
}

function pngChunk(name: string, data = new Uint8Array()): Blob {
  return new Blob([integer(data.length), text(name), data, integer(0)]);
}

function png(width: number, height: number, frameCount?: number): Blob {
  const dimensions = new Uint8Array(13);
  dimensions.set(integer(width), 0);
  dimensions.set(integer(height), 4);
  dimensions.set([8, 6], 8);
  const chunks = [pngChunk("IHDR", dimensions)];
  if (frameCount !== undefined) {
    const animation = new Uint8Array(8);
    animation.set(integer(frameCount), 0);
    chunks.push(pngChunk("acTL", animation));
    const frame = new Uint8Array(26);
    frame.set(integer(width), 4);
    frame.set(integer(height), 8);
    for (let index = 0; index < Math.min(frameCount, 3); index += 1) chunks.push(pngChunk("fcTL", frame));
  }
  chunks.push(pngChunk("IDAT"), pngChunk("IEND"));
  return new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...chunks], { type: "image/png" });
}

function gif(width: number, height: number, frames: number): Blob {
  const screen = Uint8Array.of(width & 255, width >>> 8, height & 255, height >>> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255);
  const frame = Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0);
  return new Blob([text("GIF89a"), screen, ...Array.from({ length: frames }, () => frame), Uint8Array.of(0x3b)], { type: "image/gif" });
}

function webpChunk(name: string, payload: Blob): Blob {
  const padding = new Uint8Array(payload.size & 1);
  return new Blob([text(name), integer(payload.size, true), payload, padding]);
}

function animatedWebp(frames: number): Blob {
  const canvas = new Uint8Array(10);
  canvas.set([2, 0, 0, 0, 0xff, 0x0f, 0, 0xff, 0x07, 0]);
  const bitstream = webpChunk("VP8L", new Blob([Uint8Array.of(0x2f, 0, 0, 0, 0)]));
  const frame = webpChunk("ANMF", new Blob([new Uint8Array(16), bitstream]));
  const payload = new Blob([
    text("WEBP"), webpChunk("VP8X", new Blob([canvas])), webpChunk("ANIM", new Blob([new Uint8Array(6)])),
    ...Array.from({ length: frames }, () => frame),
  ]);
  return new Blob([text("RIFF"), integer(payload.size, true), payload], { type: "image/webp" });
}

describe("pre-decode image metadata", () => {
  it("validates the PNG canvas and APNG frame budget", async () => {
    await expect(inspectChatImage(png(4_096, 3_072))).resolves.toMatchObject({ frames: 1, decodedBytes: 48 * 1_024 * 1_024 });
    await expect(inspectChatImage(png(512, 512, 2))).resolves.toMatchObject({ frames: 2, decodedBytes: 2 * 1_024 * 1_024 });
    await expect(inspectChatImage(png(8_193, 1))).rejects.toMatchObject({ limited: true });
    await expect(inspectChatImage(png(4_096, 2_048, 2))).rejects.toMatchObject({ limited: true });
  });

  it("counts GIF animations and charges their full logical canvas", async () => {
    await expect(inspectChatImage(gif(64, 64, 3))).resolves.toEqual({ width: 64, height: 64, frames: 3, decodedBytes: 49_152 });
    await expect(inspectChatImage(gif(4_096, 2_048, 2))).rejects.toMatchObject({ limited: true });
  });

  it("validates the animated WebP container and each frame header", async () => {
    await expect(inspectChatImage(animatedWebp(1))).resolves.toMatchObject({ width: 4_096, height: 2_048, frames: 1 });
    await expect(inspectChatImage(animatedWebp(2))).rejects.toMatchObject({ limited: true });
  });

  it("reads JPEG frame dimensions after a large metadata segment without decoding", async () => {
    const metadata = new Uint8Array(65_538);
    metadata.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xfe]);
    const frame = Uint8Array.of(0xff, 0xc0, 0, 11, 8, 0, 32, 0, 64, 1, 1, 0x11, 0);
    const image = new Blob([metadata, frame], { type: "image/jpeg" });
    await expect(inspectChatImage(image)).resolves.toEqual({ width: 64, height: 32, frames: 1, decodedBytes: 8_192 });
    await expect(inspectChatImage(image.slice(0, -1, "image/jpeg"))).rejects.toMatchObject({ limited: false });
  });
});
