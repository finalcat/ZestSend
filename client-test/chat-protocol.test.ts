import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_MAX_BYTES, createChatReply, getChatReplyAuthor, isChatReply, isChatCapabilitiesMessage, isChatReplyCapabilitiesMessage, isCloudChatImage, isInteractiveMessage, isRichChatMessage, type CloudChatImage, type RichChatMessage } from "../src/shared/chat-protocol";

function image(index = 1): CloudChatImage {
  const expiresAt = 1_794_027_600_000;
  return {
    imageId: `${expiresAt}-${index.toString(16).padStart(32, "0")}`,
    readToken: "r".repeat(43), expiresAt, mimeType: "image/png", size: 1_024,
    width: 100, height: 80, name: "screenshot.png", original: false,
  };
}

function rich(): RichChatMessage {
  const resource = image();
  return { type: "chat-rich", version: 1, id: "message-1", blocks: [
    { type: "paragraph", text: "Before the image" }, { type: "image", imageId: resource.imageId },
    { type: "paragraph", text: "After the image\nnext line" },
  ], images: [resource] };
}

describe("versioned rich chat protocol", () => {
  it("accepts ordered text/image composition and leaves its structure unchanged", () => {
    const message = rich();
    const before = JSON.stringify(message);
    expect(isInteractiveMessage(message)).toBe(true);
    expect(JSON.stringify(message)).toBe(before);
    expect(isRichChatMessage({ ...message, blocks: [{ type: "image", imageId: message.images[0].imageId }] })).toBe(true);
  });

  it("keeps legacy text messages compatible, bounded and non-empty", () => {
    expect(isInteractiveMessage({ type: "chat", id: "legacy", text: "word\nnext line" })).toBe(true);
    expect(isInteractiveMessage({ type: "chat", id: "legacy", text: "文".repeat(4_000) })).toBe(true);
    expect(isInteractiveMessage({ type: "chat", id: "legacy", text: "x".repeat(4_001) })).toBe(false);
    expect(isInteractiveMessage({ type: "chat", id: "legacy", text: " \n " })).toBe(false);
    expect(isInteractiveMessage({ type: "chat", id: "", text: "text" })).toBe(false);
  });

  it("rejects duplicated, missing and unreferenced image identities", () => {
    const message = rich();
    expect(isRichChatMessage({ ...message, images: [...message.images, ...message.images] })).toBe(false);
    expect(isRichChatMessage({ ...message, blocks: [...message.blocks, message.blocks[1]] })).toBe(false);
    expect(isRichChatMessage({ ...message, images: [] })).toBe(false);
    expect(isRichChatMessage({ ...message, images: [...message.images, image(2)] })).toBe(false);
  });

  it("rejects unsupported structure, raw HTML, URLs and inline image data", () => {
    const message = rich();
    expect(isRichChatMessage({ ...message, version: 2 })).toBe(false);
    expect(isRichChatMessage({ ...message, html: "<img src=x>" })).toBe(false);
    expect(isRichChatMessage({ ...message, blocks: [{ type: "html", html: "<p>raw HTML</p>" }] })).toBe(false);
    for (const src of ["https://example.com/image.png", "blob:https://example.com/1", "data:image/png;base64,eA=="]) {
      expect(isRichChatMessage({ ...message, images: [{ ...image(), src }] })).toBe(false);
      expect(isRichChatMessage({ ...message, blocks: [{ type: "image", imageId: src }] })).toBe(false);
    }
    // Text stays plain text: URLs and markup written by a user are not HTML nodes.
    expect(isInteractiveMessage({ type: "chat", id: "literal", text: "<b>https://example.com</b>" })).toBe(true);
  });

  it("validates server expiry identity, read credentials, MIME and dimensions", () => {
    expect(isCloudChatImage(image())).toBe(true);
    for (const change of [
      { expiresAt: image().expiresAt + 1 }, { imageId: "https://example.com/file" }, { readToken: "short" },
      { mimeType: "image/svg+xml" }, { size: 0 }, { size: 20 * 1024 * 1024 + 1 },
      { width: 0 }, { height: Infinity }, { name: "header\r\ninjection.png" }, { original: "true" },
    ]) expect(isCloudChatImage({ ...image(), ...change })).toBe(false);
    // Expired resources still need to render an explicit expiration placeholder.
    expect(isCloudChatImage({ ...image(), imageId: "1000000000000-" + "a".repeat(32), expiresAt: 1_000_000_000_000 })).toBe(true);
  });

  it("enforces image count, aggregate byte limits and combined text length", () => {
    const images = Array.from({ length: 10 }, (_, index) => image(index + 1));
    const valid: RichChatMessage = { type: "chat-rich", version: 1, id: "many", images, blocks: images.map(({ imageId }) => ({ type: "image", imageId })) };
    expect(isRichChatMessage(valid)).toBe(true);
    const eleven = [...images, image(11)];
    expect(isRichChatMessage({ ...valid, images: eleven, blocks: eleven.map(({ imageId }) => ({ type: "image", imageId })) })).toBe(false);
    expect(isRichChatMessage({ ...valid, images: images.map((resource) => ({ ...resource, size: 6 * 1024 * 1024 })) })).toBe(false);
    expect(isRichChatMessage({ ...rich(), blocks: [
      { type: "paragraph", text: "x".repeat(2_001) }, ...rich().blocks.slice(1),
      { type: "paragraph", text: "x".repeat(2_000) },
    ] })).toBe(false);
  });

  it("rejects oversized JSON independently of the character and image limits", () => {
    const message = rich();
    const oversized = { ...message, blocks: [
      ...Array.from({ length: 2_200 }, () => ({ type: "paragraph", text: "" })),
      { type: "image", imageId: message.images[0].imageId },
    ] };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(CHAT_MESSAGE_MAX_BYTES);
    expect(isRichChatMessage(oversized)).toBe(false);
    expect(isRichChatMessage({ type: "chat-rich", version: 1, id: "empty", blocks: [{ type: "paragraph", text: " " }], images: [] })).toBe(false);
  });
});

describe("message reply snapshots", () => {
  const reply = { messageId: "original", author: "recipient" as const, text: "Quoted text", imageCount: 0 };

  it("accepts v2 text and image replies without modifying legacy formats", () => {
    expect(isInteractiveMessage({ ...rich(), version: 2, reply })).toBe(true);
    expect(isInteractiveMessage({ type: "chat-rich", version: 2, id: "text-reply", blocks: [{ type: "paragraph", text: "Answer" }], images: [], reply })).toBe(true);
    expect(isInteractiveMessage({ ...rich(), reply })).toBe(false);
    expect(isInteractiveMessage({ type: "chat", id: "legacy", text: "answer", reply })).toBe(false);
    expect(isInteractiveMessage({ ...rich(), version: 2 })).toBe(false);
    expect(isInteractiveMessage({ type: "chat-rich", version: 2, id: "empty", blocks: [{ type: "paragraph", text: " " }], images: [], reply })).toBe(false);
  });

  it("bounds Unicode snapshots and rejects nested quotes, credentials and malformed fields", () => {
    expect(isChatReply({ ...reply, text: "😀".repeat(200) })).toBe(true);
    expect(isChatReply({ ...reply, text: "😀".repeat(201) })).toBe(false);
    expect(isChatReply({ ...reply, text: "", imageCount: 10 })).toBe(true);
    for (const change of [
      { messageId: "" }, { messageId: "x".repeat(129) }, { author: "local" },
      { imageCount: -1 }, { imageCount: 11 }, { imageCount: 0.5 }, { imageCount: NaN },
      { text: " " }, { text: null }, { readToken: "secret" }, { reply }, { src: "https://example.com" },
    ]) {
      expect(isChatReply({ ...reply, ...change })).toBe(false);
      expect(isInteractiveMessage({ ...rich(), version: 2, reply: { ...reply, ...change } })).toBe(false);
    }
  });

  it("copies only the target body once and truncates by Unicode codepoint", () => {
    const target = { id: "original", sender: "remote" as const, text: "ignored", blocks: [
      { type: "paragraph" as const, text: "  " + "😀".repeat(201) },
      { type: "image" as const, imageId: image().imageId },
    ], images: [image()], reply };
    const snapshot = createChatReply(target);
    target.blocks[0].text = "Changed later";
    expect(snapshot).toEqual({ messageId: "original", author: "recipient", text: "😀".repeat(200), imageCount: 1 });
    expect(Object.keys(snapshot).sort()).toEqual(["author", "imageCount", "messageId", "text"]);
    expect(createChatReply({ id: "own", sender: "local", text: "body" })).toEqual({ messageId: "own", author: "sender", text: "body", imageCount: 0 });
    expect(createChatReply({ id: "picture", sender: "remote", text: "", blocks: [{ type: "image", imageId: image().imageId }] })).toMatchObject({ text: "", imageCount: 1 });
  });

  it("translates author for both viewers and keeps image and reply declarations separate", () => {
    expect(getChatReplyAuthor(reply, "local")).toBe("remote");
    expect(getChatReplyAuthor(reply, "remote")).toBe("local");
    expect(getChatReplyAuthor({ ...reply, author: "sender" }, "local")).toBe("local");
    expect(getChatReplyAuthor({ ...reply, author: "sender" }, "remote")).toBe("remote");
    const images = { type: "chat-capabilities", version: 1, richImages: true };
    const replies = { type: "chat-reply-capabilities", version: 1, replies: true };
    expect(isChatCapabilitiesMessage(images)).toBe(true);
    expect(isChatReplyCapabilitiesMessage(replies)).toBe(true);
    expect(isChatCapabilitiesMessage(replies)).toBe(false);
    expect(isChatCapabilitiesMessage({ ...images, replies: true })).toBe(false);
    expect(isChatReplyCapabilitiesMessage({ ...replies, replies: false })).toBe(false);
    expect(isChatReplyCapabilitiesMessage({ ...replies, version: 2 })).toBe(false);
  });

  it("includes the reply in the total wire budget", () => {
    const message = { ...rich(), version: 2, reply, blocks: [
      ...Array.from({ length: 2_200 }, () => ({ type: "paragraph", text: "" })),
      { type: "image", imageId: rich().images[0].imageId },
    ] };
    expect(isRichChatMessage(message)).toBe(false);
  });
});
