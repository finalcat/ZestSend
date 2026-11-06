import {
  CHAT_IMAGE_ID_PATTERN,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MIME_TYPES,
  type ChatImageMimeType,
} from "./chat-image-limits";

export const CHAT_TEXT_MAX_LENGTH = 4_000;
export const CHAT_IMAGE_MAX_COUNT = 10;
export const CHAT_IMAGES_MAX_BYTES = 50 * 1024 * 1024;
export const CHAT_MESSAGE_MAX_BYTES = 64 * 1024;

export type ChatBlock = { type: "paragraph"; text: string } | { type: "image"; imageId: string };

export type CloudChatImage = {
  imageId: string;
  readToken: string;
  expiresAt: number;
  mimeType: ChatImageMimeType;
  size: number;
  width: number;
  height: number;
  name: string;
  original: boolean;
};

export const CHAT_REPLY_MAX_LENGTH = 200;
export type ChatReply = {
  messageId: string;
  /** Author of the original message, relative to the sender of this reply. */
  author: "sender" | "recipient";
  text: string;
  imageCount: number;
};

/** Copy only the target body, never its own quote or image credentials. */
export function createChatReply(message: {
  id: string; sender: "local" | "remote"; text: string; blocks?: ChatBlock[];
}): ChatReply {
  const text = message.blocks
    ? message.blocks.filter((block) => block.type === "paragraph").map((block) => block.text).join("\n")
    : message.text;
  return {
    messageId: message.id,
    author: message.sender === "local" ? "sender" : "recipient",
    text: Array.from(text.trim()).slice(0, CHAT_REPLY_MAX_LENGTH).join(""),
    imageCount: message.blocks?.filter((block) => block.type === "image").length ?? 0,
  };
}

export function getChatReplyAuthor(reply: ChatReply, replySender: "local" | "remote"): "local" | "remote" {
  return reply.author === "sender" ? replySender : replySender === "local" ? "remote" : "local";
}

export function isChatReply(value: unknown): value is ChatReply {
  return record(value) && exactKeys(value, ["messageId", "author", "text", "imageCount"])
    && messageId(value.messageId) && (value.author === "sender" || value.author === "recipient")
    && typeof value.text === "string" && Array.from(value.text).length <= CHAT_REPLY_MAX_LENGTH
    && Number.isInteger(value.imageCount) && (value.imageCount as number) >= 0 && (value.imageCount as number) <= CHAT_IMAGE_MAX_COUNT
    && (value.text.trim().length > 0 || (value.imageCount as number) > 0);
}

export type LegacyChatMessage = { type: "chat"; id: string; text: string };
export type RichChatMessage = {
  type: "chat-rich";
  id: string;
  blocks: ChatBlock[];
  images: CloudChatImage[];
} & ({ version: 1 } | { version: 2; reply: ChatReply });
export type InteractiveMessage = LegacyChatMessage | RichChatMessage;
export type ChatImageSupport = "unknown" | "supported" | "unsupported";
export type ChatReplySupport = ChatImageSupport;
export type ChatReplyCapabilitiesMessage = { type: "chat-reply-capabilities"; version: 1; replies: true };
export type ChatCapabilitiesMessage = { type: "chat-capabilities"; version: 1; richImages: true };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const names = Object.keys(value);
  return names.length === keys.length && names.every((name) => keys.includes(name));
}

function messageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function boundedWireSize(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= CHAT_MESSAGE_MAX_BYTES; }
  catch { return false; }
}

export function isCloudChatImage(value: unknown): value is CloudChatImage {
  if (!record(value) || !exactKeys(value, ["imageId", "readToken", "expiresAt", "mimeType", "size", "width", "height", "name", "original"])) return false;
  return typeof value.imageId === "string" && CHAT_IMAGE_ID_PATTERN.test(value.imageId)
    && positiveInteger(value.expiresAt) && Number(value.imageId.split("-")[0]) === value.expiresAt
    && typeof value.readToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.readToken)
    && typeof value.mimeType === "string" && (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(value.mimeType)
    && positiveInteger(value.size, CHAT_IMAGE_MAX_BYTES)
    && positiveInteger(value.width, 65_535) && positiveInteger(value.height, 65_535)
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 255 && !/[\u0000\r\n]/.test(value.name)
    && typeof value.original === "boolean";
}

export function isRichChatMessage(value: unknown): value is RichChatMessage {
  if (!record(value) || !exactKeys(value, value.version === 2 ? ["type", "version", "id", "blocks", "images", "reply"] : ["type", "version", "id", "blocks", "images"])
    || value.type !== "chat-rich" || (value.version !== 1 && value.version !== 2) || !messageId(value.id)
    || (value.version === 2 && !isChatReply(value.reply))
    || !Array.isArray(value.blocks) || value.blocks.length === 0
    || !Array.isArray(value.images) || value.images.length > CHAT_IMAGE_MAX_COUNT || !boundedWireSize(value)) return false;
  const images = new Set<string>();
  let imageBytes = 0;
  for (const image of value.images) {
    if (!isCloudChatImage(image) || images.has(image.imageId)) return false;
    images.add(image.imageId);
    imageBytes += image.size;
  }
  if (imageBytes > CHAT_IMAGES_MAX_BYTES) return false;
  const references = new Set<string>();
  let textLength = 0;
  let hasText = false;
  for (const block of value.blocks) {
    if (!record(block)) return false;
    if (block.type === "paragraph") {
      if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") return false;
      textLength += block.text.length;
      if (block.text.trim()) hasText = true;
    } else if (block.type === "image") {
      if (!exactKeys(block, ["type", "imageId"]) || typeof block.imageId !== "string"
        || !images.has(block.imageId) || references.has(block.imageId)) return false;
      references.add(block.imageId);
    } else return false;
  }
  return textLength <= CHAT_TEXT_MAX_LENGTH && references.size === images.size
    && (hasText || references.size > 0);
}

export function isInteractiveMessage(value: unknown): value is InteractiveMessage {
  if (!record(value)) return false;
  if (value.type === "chat-rich") return isRichChatMessage(value);
  return value.type === "chat" && exactKeys(value, ["type", "id", "text"])
    && messageId(value.id) && typeof value.text === "string" && value.text.trim().length > 0
    && value.text.length <= CHAT_TEXT_MAX_LENGTH && boundedWireSize(value);
}

export function isChatCapabilitiesMessage(value: unknown): value is ChatCapabilitiesMessage {
  return record(value) && exactKeys(value, ["type", "version", "richImages"])
    && value.type === "chat-capabilities" && value.version === 1 && value.richImages === true;
}

export function isChatReplyCapabilitiesMessage(value: unknown): value is ChatReplyCapabilitiesMessage {
  return record(value) && exactKeys(value, ["type", "version", "replies"])
    && value.type === "chat-reply-capabilities" && value.version === 1 && value.replies === true;
}
