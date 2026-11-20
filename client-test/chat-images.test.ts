import { describe, expect, it, vi } from "vitest";
import {
  ChatImageError, ChatImageMemoryBudget, fittedChatImageSize, prepareChatImage, validateChatImageFiles,
} from "../src/client/lib/chat-images";

function sourceFile(size = 1_000, width = 4_096, height = 2_048) {
  // The browser decoding is mocked here. Include the PNG container records
  // the pre-decode metadata guard needs to validate.
  const png = new Uint8Array(size);
  png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(33, size - 57);
  png.set([73, 68, 65, 84], 37);
  png.set([73, 69, 78, 68], size - 8);
  return new File([png], "drawing.png", { type: "image/png", lastModified: 42 });
}

function imageBrowser(width = 4_096, height = 2_048, encodedSize = 100) {
  const bitmap = { width, height, close: vi.fn() };
  const context = { drawImage: vi.fn() };
  const canvas = {
    width: 0, height: 0, getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(encodedSize)], { type: "image/webp" }))),
  };
  const createBitmap = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal("createImageBitmap", createBitmap);
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal("document", { createElement });
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prepared-image");
  return { bitmap, context, canvas, createBitmap, createElement, createUrl };
}

describe("chat image limits", () => {
  it("validates the whole source batch against per-file, count, and total limits", () => {
    const sized = (size: number, type = "image/png") => ({ size, type } as File);
    expect(() => validateChatImageFiles([sized(20 * 1024 * 1024)])).not.toThrow();
    expect(() => validateChatImageFiles([sized(20 * 1024 * 1024 + 1)])).toThrowError(new ChatImageError("file-too-large"));
    expect(() => validateChatImageFiles([sized(0)])).toThrowError(new ChatImageError("file-too-large"));
    expect(() => validateChatImageFiles([sized(1, "image/svg+xml")])).toThrowError(new ChatImageError("unsupported"));
    expect(() => validateChatImageFiles([sized(1)], Array.from({ length: 10 }, () => sized(1)))).toThrowError(new ChatImageError("too-many-images"));
    expect(() => validateChatImageFiles([sized(11 * 1024 * 1024)], [sized(20 * 1024 * 1024), sized(20 * 1024 * 1024)]))
      .toThrowError(new ChatImageError("total-too-large"));
    expect(() => validateChatImageFiles([sized(10 * 1024 * 1024)], [sized(20 * 1024 * 1024), sized(20 * 1024 * 1024)])).not.toThrow();
  });

  it("fits either orientation to 2048 without upscaling or zero dimensions", () => {
    expect(fittedChatImageSize(4_096, 2_048)).toEqual({ width: 2_048, height: 1_024 });
    expect(fittedChatImageSize(1_000, 4_000)).toEqual({ width: 512, height: 2_048 });
    expect(fittedChatImageSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(fittedChatImageSize(1, 60_000)).toEqual({ width: 1, height: 2_048 });
    expect(() => fittedChatImageSize(0, 50)).toThrowError(new ChatImageError("decode-failed"));
  });
});

describe("chat image preparation", () => {
  it("encodes a smaller WebP with alpha at .82 and reports encoded dimensions", async () => {
    const browser = imageBrowser();
    const source = sourceFile();
    const result = await prepareChatImage(source, { id: "draft-id" });
    expect(result).toMatchObject({ id: "draft-id", sourceFile: source, width: 2_048, height: 1_024, original: false });
    expect(result.file.type).toBe("image/webp");
    expect(result.file.name).toBe("drawing.webp");
    expect(result.file.size).toBe(100);
    expect(browser.canvas.getContext).toHaveBeenCalledWith("2d", { alpha: true });
    expect(browser.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.82);
    expect(browser.bitmap.close).toHaveBeenCalledOnce();
    expect(result.decodedBytes).toBe(2_048 * 1_024 * 4);
    expect(browser.createUrl).not.toHaveBeenCalled();
    expect(browser.canvas.width).toBe(0);
    expect(browser.canvas.height).toBe(0);
  });

  it.each(["gif", "original"])("preserves source bytes and dimensions for %s", async (mode) => {
    const browser = imageBrowser();
    const source = mode === "gif"
      ? new File([Uint8Array.from(Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex"))], "animated.gif", { type: "image/gif" })
      : sourceFile();
    const result = await prepareChatImage(source, { original: mode === "original" });
    expect(result.file).toBe(source);
    expect(result).toMatchObject(mode === "gif" ? { width: 1, height: 1, original: true } : { width: 4_096, height: 2_048, original: true });
    expect(browser.createElement).not.toHaveBeenCalled();
    expect(browser.createBitmap).not.toHaveBeenCalled();
  });

  it("retains the original file when encoding makes it larger", async () => {
    imageBrowser(4_096, 2_048, 2_000);
    const source = sourceFile(1_000);
    const result = await prepareChatImage(source);
    expect(result.file).toBe(source);
    expect(result).toMatchObject({ width: 4_096, height: 2_048, original: true });
  });

  it("closes decoded bitmap and creates no preview if cancelled during decode", async () => {
    const browser = imageBrowser();
    let finish: (bitmap: typeof browser.bitmap) => void = () => undefined;
    browser.createBitmap.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const preparation = prepareChatImage(sourceFile(), { signal: controller.signal });
    const rejected = expect(preparation).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(browser.createBitmap).toHaveBeenCalledOnce());
    controller.abort();
    finish(browser.bitmap);
    await rejected;
    expect(browser.bitmap.close).toHaveBeenCalledOnce();
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("does not publish a completed encoding after cancellation", async () => {
    const browser = imageBrowser();
    let finish: (blob: Blob) => void = () => undefined;
    browser.canvas.toBlob.mockImplementation((callback) => { finish = callback; });
    const controller = new AbortController();
    const preparation = prepareChatImage(sourceFile(), { signal: controller.signal });
    const rejected = expect(preparation).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(browser.canvas.toBlob).toHaveBeenCalled());
    controller.abort();
    finish(new Blob([new Uint8Array(100)], { type: "image/webp" }));
    await rejected;
    expect(browser.bitmap.close).toHaveBeenCalledOnce();
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("reports decode errors without allocating a preview", async () => {
    const browser = imageBrowser();
    browser.createBitmap.mockRejectedValue(new Error("bad image bytes"));
    await expect(prepareChatImage(sourceFile())).rejects.toThrowError(new ChatImageError("decode-failed"));
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("rejects oversized decode before opening an image decoder", async () => {
    const browser = imageBrowser();
    await expect(prepareChatImage(sourceFile(1_000, 4_096, 4_096))).rejects.toMatchObject({ code: "image-too-large-to-preview" });
    await expect(prepareChatImage(sourceFile(1_000, 8_193, 1), { original: true })).rejects.toMatchObject({ code: "image-too-large-to-preview" });
    expect(browser.createBitmap).not.toHaveBeenCalled();
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("serializes room preparation and releases the shared working budget", async () => {
    const browser = imageBrowser();
    const budget = new ChatImageMemoryBudget();
    let finish: (bitmap: typeof browser.bitmap) => void = () => undefined;
    browser.createBitmap.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = prepareChatImage(sourceFile(), { budget });
    const second = prepareChatImage(sourceFile(), { budget });
    await vi.waitFor(() => expect(browser.createBitmap).toHaveBeenCalledOnce());
    expect(budget.usedBytes).toBeGreaterThan(32 * 1_024 * 1_024);
    finish(browser.bitmap);
    await Promise.all([first, second]);
    expect(browser.createBitmap).toHaveBeenCalledTimes(2);
    expect(budget.usedBytes).toBe(0);
  });
});
