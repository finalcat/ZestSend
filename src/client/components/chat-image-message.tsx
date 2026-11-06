import { useEffect, useState } from "react";
import { RiDownload2Line, RiImageLine, RiLoader4Line, RiRefreshLine } from "@remixicon/react";
import type { ChatBlock, CloudChatImage } from "../../shared/chat-protocol";
import { ChatImageAssetStore, chatImageErrorText } from "../lib/chat-image-client";
import { Dialog, DialogClose, DialogContent } from "./ui/dialog";

export type LocalChatImagePreview = { id: string; url: string; width: number; height: number; name: string; image?: CloudChatImage };

function ChatPicture({ image, local, store, locale }: { image?: CloudChatImage; local?: LocalChatImagePreview; store: ChatImageAssetStore; locale: "en" | "zh" }) {
  const [expanded, setExpanded] = useState(false);
  const [decodeError, setDecodeError] = useState(false);
  const [, refresh] = useState(0);
  useEffect(() => store.subscribe(() => refresh((value) => value + 1)), [store]);
  useEffect(() => { setDecodeError(false); if (image) void store.load(image); }, [image?.imageId, image?.readToken, store]);
  const asset = image ? store.snapshot(image) : local ? { state: "ready" as const, url: local.url } : { state: "error" as const };
  const name = image?.name ?? local?.name ?? (locale === "zh" ? "图片" : "Image");
  const width = Math.min(320, image?.width ?? local?.width ?? 240);
  const expired = asset.state === "expired";
  const failed = decodeError || asset.state === "error";
  const ready = asset.state === "ready" && Boolean(asset.url) && !failed;
  const retry = () => { setDecodeError(false); if (image) void store.load(image, true); };
  return <div className="my-1 max-w-full overflow-hidden rounded-xl" data-chat-image={image?.imageId ?? local?.id} style={{ width }}>
    {ready ? <button aria-label={`${locale === "zh" ? "查看图片" : "Preview image"}: ${name}`} className="block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300" onClick={() => setExpanded(true)} type="button">
      <img alt={name} className="max-h-80 w-full object-contain" height={image?.height ?? local?.height} onError={() => setDecodeError(true)} src={asset.url} width={image?.width ?? local?.width} />
    </button> : <div className="flex min-h-28 flex-col items-center justify-center gap-2 bg-black/10 p-4 text-center text-xs leading-relaxed" role={failed ? "alert" : undefined}>
      {expired || failed ? <RiImageLine aria-hidden="true" className="size-6 opacity-55" /> : <RiLoader4Line aria-hidden="true" className="size-5 animate-spin opacity-60" />}
      <span>{expired ? (locale === "zh" ? "图片已过期" : "Image expired") : failed ? chatImageErrorText("error" in asset ? asset.error : undefined, locale) : (locale === "zh" ? "正在加载图片…" : "Loading image…")}</span>
      {failed && image ? <button aria-label={locale === "zh" ? "重试加载图片" : "Retry loading image"} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10" onClick={retry} type="button"><RiRefreshLine aria-hidden="true" className="size-3" />{locale === "zh" ? "重试" : "Retry"}</button> : null}
    </div>}
    <Dialog open={expanded && ready} onOpenChange={setExpanded}>
      <DialogContent aria-label={locale === "zh" ? "图片预览" : "Image preview"} className="!max-w-[min(92vw,70rem)]">
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="truncate text-sm text-sky-50">{name}</span>
          <div className="flex shrink-0 items-center gap-3">
            <a aria-label={locale === "zh" ? "下载图片" : "Download image"} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-sky-100 hover:bg-white/10" download={name} href={ready ? asset.url : undefined}><RiDownload2Line aria-hidden="true" className="size-4" />{locale === "zh" ? "下载" : "Download"}</a>
            <DialogClose aria-label={locale === "zh" ? "关闭图片预览" : "Close image preview"} />
          </div>
        </div>
        {ready ? <img alt={name} className="mx-auto block max-h-[76dvh] max-w-full object-contain p-2" src={asset.url} /> : null}
      </DialogContent>
    </Dialog>
  </div>;
}

export function ChatImageMessage({ blocks, images = [], localImages = [], store, locale }: { blocks: ChatBlock[]; images?: CloudChatImage[]; localImages?: LocalChatImagePreview[]; store: ChatImageAssetStore; locale: "en" | "zh" }) {
  return <div className="space-y-2" data-chat-content="rich">{blocks.map((block, index) => block.type === "paragraph"
    ? <p className="whitespace-pre-wrap break-words" key={`paragraph-${index}`}>{block.text || "\u00a0"}</p>
    : <ChatPicture image={images.find((image) => image.imageId === block.imageId) ?? localImages.find((image) => image.id === block.imageId)?.image} key={block.imageId} local={localImages.find((image) => image.id === block.imageId)} locale={locale} store={store} />)}</div>;
}
