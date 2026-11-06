import { RiCloseLine, RiReplyLine } from "@remixicon/react";
import { getChatReplyAuthor, type ChatReply } from "../../shared/chat-protocol";

export type ChatReplyCardProps = {
  reply: ChatReply;
  replySender: "local" | "remote";
  locale: "en" | "zh";
  onClick?: () => void;
  onCancel?: () => void;
};

/** A text-only snapshot: quoted images never fetch or extend an image's lifetime. */
export function ChatReplyCard({ reply, replySender, locale, onClick, onCancel }: ChatReplyCardProps) {
  const zh = locale === "zh";
  const authorIsLocal = getChatReplyAuthor(reply, replySender) === "local";
  const author = authorIsLocal ? (zh ? "你" : "You") : (zh ? "对方" : "Other participant");
  const imageLabel = reply.imageCount === 1
    ? (zh ? "[图片]" : "[Image]")
    : (zh ? `[${reply.imageCount} 张图片]` : `[${reply.imageCount} images]`);
  const summary = [reply.text, reply.imageCount ? imageLabel : ""].filter(Boolean).join(" ");
  const content = <>
    <span className="flex items-center gap-1.5 text-xs font-semibold leading-5">
      <RiReplyLine aria-hidden="true" className="size-3.5 shrink-0 opacity-65" />
      <span>{onCancel ? (zh ? `回复 ${author}` : `Replying to ${author}`) : author}</span>
    </span>
    <span className="line-clamp-2 whitespace-pre-wrap break-words text-xs font-normal leading-relaxed opacity-75">{summary}</span>
  </>;

  return <div className="relative flex min-w-0 items-start gap-1 overflow-hidden rounded-lg border-l-2 border-current bg-black/10 text-inherit" data-chat-reply={reply.messageId} data-chat-reply-target={reply.messageId} data-chat-reply-draft={onCancel ? "" : undefined}>
    {onClick ? <button
      aria-label={zh ? `定位原消息：${author}，${summary}` : `Go to original message: ${author}, ${summary}`}
      className="block min-w-0 flex-1 px-3 py-2 text-left transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 motion-reduce:transition-none"
      onClick={onClick}
      type="button"
    >{content}</button> : <div className="min-w-0 flex-1 px-3 py-2">{content}</div>}
    {onCancel ? <button
      aria-label={zh ? "取消引用回复" : "Cancel reply"}
      className="m-1.5 shrink-0 rounded-md p-1.5 opacity-70 transition-colors hover:bg-white/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 motion-reduce:transition-none"
      onClick={onCancel}
      type="button"
    ><RiCloseLine aria-hidden="true" className="size-4" /></button> : null}
  </div>;
}
