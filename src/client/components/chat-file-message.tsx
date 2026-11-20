import { useEffect, useState } from "react";
import { RiDownload2Line, RiFileLine } from "@remixicon/react";
import type { CloudChatFile } from "../../shared/chat-protocol";
import { downloadChatAsset } from "../lib/chat-file-client";

export type LocalChatFile = { id: string; name: string; size: number };

export function ChatFileMessage({ file, local, locale }: {
  file?: CloudChatFile;
  local?: LocalChatFile;
  locale: "en" | "zh";
}) {
  const [error, setError] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const zh = locale === "zh";
  const expiresAt = file?.expiresAt;

  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const name = file?.name ?? local?.name;
  const bytes = file?.size ?? local?.size;
  if (name === undefined || bytes === undefined) return null;
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const unavailable = expired || error === 410 || (expiresAt !== undefined && expiresAt <= Date.now());
  const status = unavailable ? (zh ? "文件已过期" : "File expired") : error !== null ? (zh ? "下载失败，请重试" : "Download failed. Try again.") : null;

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2" data-chat-cloud-file={file?.fileId ?? local?.id}>
      <RiFileLine aria-hidden="true" className="size-5 shrink-0 opacity-65" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={name}>{name}</p>
        <p className="text-xs opacity-65">{size}</p>
        {status ? <p className="text-xs opacity-80" role="status">{status}</p> : null}
      </div>
      {file && !unavailable ? (
        <button aria-label={`${zh ? "下载" : "Download"}: ${name}`} className="shrink-0 rounded-lg p-2 hover:bg-white/10 focus-visible:outline focus-visible:outline-1" onClick={() => {
          setError(null);
          downloadChatAsset("files", file.fileId, file.readToken, setError);
        }} type="button"><RiDownload2Line aria-hidden="true" className="size-5" /></button>
      ) : null}
    </div>
  );
}
