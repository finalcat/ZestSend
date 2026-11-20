import { cleanupExpiredChatAttachments, previewChatImage, uploadChatAttachment } from "./chat-attachments";

export function uploadChatImage(request: Request, env: Env, roomId: string): Promise<Response> {
  return uploadChatAttachment(request, env, roomId, "image");
}

export function downloadChatImage(request: Request, env: Env, imageId: string): Promise<Response> {
  return previewChatImage(request, env, imageId);
}

export function cleanupExpiredChatImages(env: Pick<Env, "CHAT_IMAGES">, now = Date.now()): Promise<void> {
  return cleanupExpiredChatAttachments(env, "image", now);
}
