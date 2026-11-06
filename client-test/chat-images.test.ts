import { describe, expect, it, vi } from "vitest";
import {
  ChatImageError, disposePreparedChatImage, fittedChatImageSize, prepareChatImage, validateChatImageFiles,
} from "../src/client/lib/chat-images";

function sourceFile(size = 1_000, type = "image/png") {
  return new File([new Uint8Array(size)], "drawing.png", { type, lastModified: 42 });
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
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return { bitmap, context, canvas, createBitmap, createElement, createUrl, revokeUrl };
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
    expect(browser.createUrl).toHaveBeenCalledWith(result.file);
    disposePreparedChatImage(result);
    expect(browser.revokeUrl).toHaveBeenCalledWith(result.previewUrl);
  });

  it.each(["gif", "original"])("preserves source bytes and dimensions for %s", async (mode) => {
    const browser = imageBrowser();
    const source = sourceFile(1_000, mode === "gif" ? "image/gif" : "image/png");
    const result = await prepareChatImage(source, { original: mode === "original" });
    expect(result.file).toBe(source);
    expect(result).toMatchObject({ width: 4_096, height: 2_048, original: true });
    expect(browser.createElement).not.toHaveBeenCalled();
    expect(browser.bitmap.close).toHaveBeenCalledOnce();
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
});
