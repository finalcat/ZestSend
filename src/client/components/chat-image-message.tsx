import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { RiDownload2Line, RiImageLine, RiLoader4Line, RiRefreshLine } from "@remixicon/react";
import type { ChatBlock, CloudChatImage } from "../../shared/chat-protocol";
import { downloadChatAsset } from "../lib/chat-file-client";
import { ChatImageAssetStore, ChatImageRequestError, chatImageErrorText } from "../lib/chat-image-client";
import type { ChatImageMemoryBudget, ImageMemoryReservation } from "../lib/chat-images";
import { Dialog, DialogClose, DialogContent } from "./ui/dialog";

export type LocalChatImagePreview = {
  id: string;
  file?: File;
  decodedBytes?: number;
  width: number;
  height: number;
  name: string;
  image?: CloudChatImage;
};

export const CHAT_IMAGE_MIN_VISIBLE_RATIO = 0.001;

export function useChatImageVisibility(ref: RefObject<HTMLElement>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A positive threshold reports movement from touching the clipped edge to actual visibility.
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      setVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio >= CHAT_IMAGE_MIN_VISIBLE_RATIO));
    }, { threshold: CHAT_IMAGE_MIN_VISIBLE_RATIO });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

/** A prepared local image holds decoded space and an object URL only while presented. */
export function useLocalChatImagePreview(
  file: File | undefined,
  decodedBytes: number | undefined,
  budget: ChatImageMemoryBudget,
  visible: boolean,
): string | undefined {
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  useEffect(() => {
    if (!visible || !file || !decodedBytes) {
      setPreview(undefined);
      return;
    }
    let reservation: ImageMemoryReservation | null = null;
    let url: string | undefined;
    const acquire = () => {
      if (reservation) return;
      reservation = budget.reserve(file.size + decodedBytes);
      if (!reservation) return;
      try {
        url = URL.createObjectURL(file);
        setPreview({ file, url });
      } catch {
        const failed = reservation;
        failed.release();
        reservation = null;
      }
    };
    acquire();
    const unsubscribe = budget.subscribe(acquire);
    return () => {
      unsubscribe();
      if (url) URL.revokeObjectURL(url);
      reservation?.release();
    };
  }, [file, decodedBytes, budget, visible]);
  return visible && preview?.file === file ? preview?.url : undefined;
}

function ChatPicture({ image, local, store, locale }: { image?: CloudChatImage; local?: LocalChatImagePreview; store: ChatImageAssetStore; locale: "en" | "zh" }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useChatImageVisibility(ref);
  const [expanded, setExpanded] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [, refresh] = useState(0);
  const active = visible || expanded;
  const localFile = local?.file;
  const localUrl = useLocalChatImagePreview(localFile, local?.decodedBytes, store.budget, active);
  const imageId = image?.imageId;
  const readToken = image?.readToken;

  useEffect(() => store.subscribe(() => refresh((value) => value + 1)), [store]);
  useEffect(() => {
    if (!image || localFile || !active) return;
    return store.retain(image);
  }, [imageId, readToken, store, active, localFile]);

  const asset = image ? store.snapshot(image) : undefined;
  const name = image?.name ?? local?.name ?? (locale === "zh" ? "图片" : "Image");
  const width = Math.min(320, image?.width ?? local?.width ?? 240);
  const height = image?.height ?? local?.height ?? 120;
  const ratio = (image?.width ?? local?.width ?? width) / height;
  const previewHeight = Math.min(320, Math.max(1, Math.round(width / ratio)));
  const url = active ? (localFile ? localUrl : asset?.url) : undefined;
  const expired = asset?.state === "expired";
  const unavailable = asset?.state === "unavailable";
  const limited = asset?.state === "limited" || (active && localFile && !localUrl);
  const failed = asset?.state === "error";
  const canDownload = Boolean(image && !expired);
  const retry = () => { if (image) void store.load(image, true); };
  const download = () => {
    if (!image) return;
    setDownloadError("");
    downloadChatAsset("images", image.imageId, image.readToken, (status) => {
      setDownloadError(chatImageErrorText(new ChatImageRequestError(status), locale));
    });
  };
  const downloadLabel = locale === "zh" ? "下载图片" : "Download image";
  const presented = () => { if (image && !localFile) store.markPresented(image); };
  const broken = () => { if (image && !localFile) store.markUnavailable(image); };
  const placeholder = expired ? (locale === "zh" ? "图片已过期" : "Image expired")
    : unavailable ? (locale === "zh" ? "此图片无法安全预览" : "This image cannot be previewed safely")
    : limited ? (locale === "zh" ? "图片预览已达内存上限" : "Image preview memory is full")
    : failed ? chatImageErrorText(asset?.error, locale)
    : visible ? (locale === "zh" ? "正在加载图片…" : "Loading image…")
    : (locale === "zh" ? "图片" : "Image");

  return (
    <div ref={ref} className="my-1 max-w-full overflow-hidden rounded-xl" data-chat-image={imageId ?? local?.id} style={{ width }}>
      {url && !expanded ? (
        <button
          aria-label={`${locale === "zh" ? "查看图片" : "Preview image"}: ${name}`}
          className="block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          onClick={() => setExpanded(true)}
          type="button"
        >
          <img alt={name} className="max-h-80 w-full object-contain" height={height} onError={broken} onLoad={presented} src={url} width={image?.width ?? local?.width} />
        </button>
      ) : (
        <div
          className="flex min-h-20 flex-col items-center justify-center gap-2 bg-black/10 p-2 text-center text-xs leading-relaxed"
          role={failed ? "alert" : undefined}
          style={{ minHeight: Math.max(80, previewHeight) }}
        >
          {asset?.state === "loading" && visible ? <RiLoader4Line aria-hidden="true" className="size-5 animate-spin opacity-60" /> : <RiImageLine aria-hidden="true" className="size-6 opacity-55" />}
          <span>{expanded && url ? name : placeholder}</span>
          {failed ? <button aria-label={locale === "zh" ? "重试加载图片" : "Retry loading image"} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10" onClick={retry} type="button"><RiRefreshLine aria-hidden="true" className="size-3" />{locale === "zh" ? "重试" : "Retry"}</button> : null}
          {canDownload && (limited || unavailable || failed) ? (
            <button className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10" onClick={download} type="button">
              <RiDownload2Line aria-hidden="true" className="size-4" />{downloadLabel}
            </button>
          ) : null}
        </div>
      )}
      {downloadError && !expanded ? <p role="alert" className="p-2 text-xs">{downloadError}</p> : null}
      <Dialog open={expanded && Boolean(url)} onOpenChange={setExpanded}>
        <DialogContent aria-label={locale === "zh" ? "图片预览" : "Image preview"} className="!max-w-[min(92vw,70rem)]">
          <div className="flex items-center justify-between gap-3 p-4">
            <span className="truncate text-sm text-sky-50">{name}</span>
            <div className="flex shrink-0 items-center gap-3">
              {canDownload ? <button aria-label={downloadLabel} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-sky-100 hover:bg-white/10" onClick={download} type="button"><RiDownload2Line aria-hidden="true" className="size-4" />{locale === "zh" ? "下载" : "Download"}</button> : null}
              <DialogClose aria-label={locale === "zh" ? "关闭图片预览" : "Close image preview"} />
            </div>
          </div>
          {downloadError ? <p role="alert" className="px-4 pb-2 text-xs">{downloadError}</p> : null}
          {expanded && url ? <img alt={name} className="mx-auto block max-h-[76dvh] max-w-full object-contain p-2" onError={broken} onLoad={presented} src={url} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ChatImageMessage({ blocks, images = [], localImages = [], store, locale, renderFile }: {
  blocks: ChatBlock[];
  images?: CloudChatImage[];
  localImages?: LocalChatImagePreview[];
  store: ChatImageAssetStore;
  locale: "en" | "zh";
  renderFile?: (fileId: string) => ReactNode;
}) {
  return (
    <div className="space-y-2" data-chat-content="rich">
      {blocks.map((block, index) => {
        if (block.type === "paragraph") return <p className="whitespace-pre-wrap break-words" key={`paragraph-${index}`}>{block.text || "\u00a0"}</p>;
        if (block.type === "file") return <div key={block.fileId}>{renderFile?.(block.fileId)}</div>;
        const local = localImages.find((image) => image.id === block.imageId);
        return <ChatPicture image={images.find((image) => image.imageId === block.imageId) ?? local?.image} key={block.imageId} local={local} locale={locale} store={store} />;
      })}
    </div>
  );
}
