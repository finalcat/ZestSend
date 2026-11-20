export const CHAT_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const CHAT_FILES_MAX_BYTES = 100 * 1024 * 1024;
export const CHAT_ROOM_PENDING_FILE_BYTES = 200 * 1024 * 1024;
export const CHAT_FILE_ID_PATTERN = /^\d{13}-[0-9a-f]{32}$/;

export function isChatFileName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 255
    && !/[\x00-\x1f\x7f/\\]/.test(name) && name !== "." && name !== "..";
}
