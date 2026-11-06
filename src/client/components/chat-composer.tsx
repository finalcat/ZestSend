import CharacterCount from "@tiptap/extension-character-count";
import {
  EditorContent, Node as TiptapNode, NodeViewWrapper, ReactNodeViewRenderer, useEditor,
  type Editor, type JSONContent, type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { RiImageAddLine, RiSendPlane2Fill, RiCloseLine } from "@remixicon/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CHAT_TEXT_MAX_LENGTH, type ChatBlock } from "../../shared/chat-protocol";
import {
  ChatImageError, disposePreparedChatImage, prepareChatImage, validateChatImageFiles,
  type PreparedChatImage,
} from "../lib/chat-images";

export type { PreparedChatImage } from "../lib/chat-images";

type PendingChatImage = {
  id: string;
  sourceFile: File;
  previewUrl: string;
  requestId: string;
  status: "processing" | "error";
  error?: string;
};

/** Kept by the Room owner, so switching workspaces does not discard the draft. */
export type ChatComposerState = {
  content: JSONContent;
  images: PreparedChatImage[];
  pendingImages: PendingChatImage[];
  original: boolean;
};

export type ChatComposerSubmit = { blocks: ChatBlock[]; images: PreparedChatImage[] };

export type ChatComposerProps = {
  locale: "en" | "zh";
  accent: string;
  ready: boolean;
  onTyping: () => void;
  onSend: (draft: ChatComposerSubmit) => boolean;
  state: ChatComposerState;
  onStateChange: (state: ChatComposerState) => void;
};

export function createEmptyChatComposerState(): ChatComposerState {
  return { content: { type: "doc", content: [{ type: "paragraph" }] }, images: [], pendingImages: [], original: false };
}

/** Call on leaving the room; component unmount alone intentionally retains URLs. */
export function disposeChatComposerState(state: ChatComposerState): void {
  const urls = new Set([...state.images, ...state.pendingImages].map((image) => image.previewUrl));
  for (const url of urls) URL.revokeObjectURL(url);
}

function paragraphText(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.type === "hardBreak" ? "\n" : child.text ?? "").join("");
}

export function chatComposerBlocks(content: JSONContent): ChatBlock[] {
  return (content.content ?? []).flatMap((node): ChatBlock[] => {
    if (node.type === "paragraph") return [{ type: "paragraph", text: paragraphText(node) }];
    if (node.type === "chatImage" && typeof node.attrs?.imageId === "string") return [{ type: "image", imageId: node.attrs.imageId }];
    return [];
  });
}

function textLength(content: JSONContent): number {
  return chatComposerBlocks(content).reduce((count, block) => count + (block.type === "paragraph" ? block.text.length : 0), 0);
}

function imageError(error: unknown, locale: "en" | "zh"): string {
  const code = error instanceof ChatImageError ? error.code : "decode-failed";
  const messages = {
    unsupported: ["支持 JPEG、PNG、WebP 和 GIF 图片。", "Choose a JPEG, PNG, WebP or GIF image."],
    "file-too-large": ["单张图片须大于 0 且不超过 20 MiB。", "Each image must be nonempty and no larger than 20 MiB."],
    "too-many-images": ["每条消息最多 10 张图片。", "A message can contain up to 10 images."],
    "total-too-large": ["图片原文件合计不能超过 50 MiB。", "Source images must total no more than 50 MiB."],
    "decode-failed": ["无法处理这张图片，请重试或选择其他图片。", "This image could not be processed. Retry or choose another image."],
  };
  return messages[code][locale === "zh" ? 0 : 1];
}

function DraftImage({ node, deleteNode, extension, selected }: NodeViewProps) {
  const zh = extension.options.getLocale() === "zh";
  const attrs = node.attrs;
  return (
    <NodeViewWrapper className={`group relative my-2 w-fit max-w-full overflow-hidden rounded-xl border ${selected ? "border-sky-300" : "border-white/15"}`} contentEditable={false} data-drag-handle="">
      <img alt={attrs.name || (zh ? "待发送图片" : "Draft image")} className="max-h-40 max-w-full object-contain" draggable={false} src={attrs.src} />
      <button aria-label={zh ? "删除图片" : "Remove image"} className="absolute right-1 top-1 rounded-full bg-black/65 p-1 text-[#fff] hover:bg-black/85" draggable={false} onClick={deleteNode} onMouseDown={(event) => event.preventDefault()} type="button">
        <RiCloseLine aria-hidden="true" className="size-4" />
      </button>
      {attrs.status === "processing" ? <span className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1 text-xs text-[#fff]" role="status">{zh ? "正在处理图片…" : "Preparing image…"}</span> : null}
      {attrs.status === "error" ? <div className="absolute inset-x-0 bottom-0 bg-black/80 p-2 text-xs text-rose-200"><p>{attrs.error}</p><button className="mt-1 underline" onClick={() => extension.options.onRetry(attrs.imageId)} type="button">{zh ? "重试" : "Retry"}</button></div> : null}
    </NodeViewWrapper>
  );
}

export function ChatComposer(props: ChatComposerProps) {
  const latest = useRef(props.state);
  const callbacks = useRef(props);
  latest.current = props.state;
  callbacks.current = props;
  const mounted = useRef(true);
  const jobs = useRef(new Map<string, AbortController>());
  const editorRef = useRef<Editor | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const submitRef = useRef<() => void>(() => undefined);
  const retryRef = useRef<(id: string) => void>(() => undefined);
  const [error, setError] = useState("");

  const commit = (state: ChatComposerState) => {
    latest.current = state;
    callbacks.current.onStateChange(state);
  };

  const extensions = useMemo(() => [
    StarterKit.configure({
      blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false,
      heading: false, horizontalRule: false, italic: false, link: false, listItem: false,
      orderedList: false, strike: false, underline: false, undoRedo: false,
    }),
    CharacterCount.extend({
      onBeforeCreate(event) {
        this.parent?.(event);
        this.storage.characters = ({ node = this.editor.state.doc } = {}) => {
          let count = 0;
          node.descendants((child) => {
            if (child.isText) count += child.text?.length ?? 0;
            else if (child.type.name === "hardBreak") count += 1;
          });
          return count;
        };
      },
    }).configure({ limit: CHAT_TEXT_MAX_LENGTH, autoTrim: false }),
    TiptapNode.create({
      name: "chatImage", group: "block", atom: true, draggable: true, selectable: true,
      addOptions: () => ({ getLocale: () => callbacks.current.locale, onRetry: (id: string) => retryRef.current(id) }),
      addAttributes: () => ({
        imageId: { default: "" }, src: { default: "" }, name: { default: "" },
        status: { default: "processing" }, error: { default: "" },
      }),
      parseHTML: () => [{ tag: "div[data-chat-image-id]" }],
      renderHTML: ({ node }) => ["div", { "data-chat-image-id": node.attrs.imageId }],
      addNodeView: () => ReactNodeViewRenderer(DraftImage),
    }),
  ], []);

  const editor = useEditor({
    extensions, content: props.state.content, immediatelyRender: false,
    editorProps: {
      // Keep the editor's native node-move transaction, including Ctrl-drag.
      dragCopies: () => false,
      attributes: {
        role: "textbox", "aria-multiline": "true", "aria-label": props.locale === "zh" ? "输入消息" : "Write a message",
        class: "min-h-[64px] w-full whitespace-pre-wrap break-words px-4 py-3 text-sm font-medium leading-relaxed outline-none",
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          if (event.isComposing || view.composing || event.keyCode === 229) return false;
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
      handleTextInput: (view, from, to, text) => {
        const selected = view.state.doc.textBetween(from, to, "", "\n").length;
        if (textLength(view.state.doc.toJSON()) - selected + text.length <= CHAT_TEXT_MAX_LENGTH) return false;
        setError(callbacks.current.locale === "zh" ? "消息最多 4000 字。" : "Messages can contain up to 4000 characters.");
        return true;
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        event.preventDefault();
        if (files.length) { addFilesRef.current(files); return true; }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const selected = view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, "", "\n").length;
        if (textLength(view.state.doc.toJSON()) - selected + text.length > CHAT_TEXT_MAX_LENGTH || text.split(/\r?\n/).length + view.state.doc.childCount > 256) {
          setError(callbacks.current.locale === "zh" ? "消息最多 4000 字、256 段。" : "Messages can contain up to 4000 characters and 256 blocks.");
          return true;
        }
        if (text) editorRef.current?.commands.insertContent(text.split(/\r?\n/).map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })));
        return true;
      },
      handleDrop: (view, event) => {
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (view.dragging) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        // External HTML cannot introduce image nodes or remote preview URLs.
        if (!files.length) { event.preventDefault(); return true; }
        event.preventDefault();
        if (position) editorRef.current?.commands.setTextSelection(position.pos);
        addFilesRef.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: updated }) => {
      const content = updated.getJSON();
      const ids = new Set(chatComposerBlocks(content).flatMap((block) => block.type === "image" ? [block.imageId] : []));
      const current = latest.current;
      for (const image of current.images) if (!ids.has(image.id)) disposePreparedChatImage(image);
      for (const image of current.pendingImages) if (!ids.has(image.id)) {
        jobs.current.get(image.requestId)?.abort();
        URL.revokeObjectURL(image.previewUrl);
      }
      commit({ ...current, content, images: current.images.filter((image) => ids.has(image.id)), pendingImages: current.pendingImages.filter((image) => ids.has(image.id)) });
      setError("");
      callbacks.current.onTyping();
    },
  });
  editorRef.current = editor;

  const updateImageNode = (id: string, attributes: Record<string, unknown>) => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed) return;
    const transaction = currentEditor.state.tr;
    currentEditor.state.doc.descendants((node, position) => {
      if (node.type.name === "chatImage" && node.attrs.imageId === id) transaction.setNodeMarkup(position, undefined, { ...node.attrs, ...attributes });
    });
    if (transaction.docChanged) currentEditor.view.dispatch(transaction);
  };

  addFilesRef.current = (files) => {
    if (!files.length || !editorRef.current) return;
    const current = latest.current;
    try { validateChatImageFiles(files, [...current.images, ...current.pendingImages].map((image) => image.sourceFile)); }
    catch (failure) { setError(imageError(failure, callbacks.current.locale)); return; }
    const pending: PendingChatImage[] = files.map((sourceFile) => ({
      id: crypto.randomUUID(), sourceFile, previewUrl: URL.createObjectURL(sourceFile),
      requestId: crypto.randomUUID(), status: "processing",
    }));
    commit({ ...current, pendingImages: [...current.pendingImages, ...pending] });
    const inserted = editorRef.current.chain().focus().insertContent([
      ...pending.map((image) => ({ type: "chatImage", attrs: { imageId: image.id, src: image.previewUrl, name: image.sourceFile.name, status: "processing" } })),
      { type: "paragraph" },
    ]).run();
    if (!inserted) {
      for (const image of pending) URL.revokeObjectURL(image.previewUrl);
      commit(current);
    }
    setError("");
  };

  retryRef.current = (id) => {
    const current = latest.current;
    commit({ ...current, pendingImages: current.pendingImages.map((image) => image.id === id ? { ...image, requestId: crypto.randomUUID(), status: "processing", error: undefined } : image) });
    updateImageNode(id, { status: "processing", error: "" });
  };

  submitRef.current = () => {
    const current = latest.current;
    if (!callbacks.current.ready || current.pendingImages.length || !editorRef.current) return;
    const blocks = chatComposerBlocks(editorRef.current.getJSON());
    if (!blocks.some((block) => block.type === "image" || block.text.trim())) return;
    if (blocks.length > 256 || textLength(editorRef.current.getJSON()) > CHAT_TEXT_MAX_LENGTH) {
      setError(callbacks.current.locale === "zh" ? "消息最多 4000 字、256 段。" : "Messages can contain up to 4000 characters and 256 blocks.");
      return;
    }
    const ids = blocks.flatMap((block) => block.type === "image" ? [block.imageId] : []);
    const images = ids.map((id) => current.images.find((image) => image.id === id));
    if (images.some((image) => !image) || new Set(ids).size !== ids.length) return;
    try {
      if (!callbacks.current.onSend({ blocks, images: images as PreparedChatImage[] })) return;
      disposeChatComposerState(current);
      commit(createEmptyChatComposerState());
      editorRef.current.commands.clearContent();
      setError("");
    } catch {
      setError(callbacks.current.locale === "zh" ? "未能发送，草稿已保留。" : "Could not send. Your draft has been kept.");
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of jobs.current.values()) controller.abort();
      jobs.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: {
      ...editor.options.editorProps.attributes,
      "aria-label": props.locale === "zh" ? "输入消息" : "Write a message",
    } } });
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(props.state.content)) editor.commands.setContent(props.state.content, { emitUpdate: false });
  }, [editor, props.state.content, props.locale]);

  useEffect(() => {
    const pending = props.state.pendingImages;
    const active = new Set(pending.filter((image) => image.status === "processing").map((image) => image.requestId));
    for (const [id, controller] of jobs.current) if (!active.has(id)) { controller.abort(); jobs.current.delete(id); }
    for (const image of pending) {
      if (image.status !== "processing" || jobs.current.has(image.requestId)) continue;
      const controller = new AbortController();
      jobs.current.set(image.requestId, controller);
      void prepareChatImage(image.sourceFile, { id: image.id, original: props.state.original, signal: controller.signal }).then((prepared) => {
        const current = latest.current;
        if (!mounted.current || controller.signal.aborted || !current.pendingImages.some((entry) => entry.requestId === image.requestId)) {
          disposePreparedChatImage(prepared);
          return;
        }
        commit({ ...current, images: [...current.images, prepared], pendingImages: current.pendingImages.filter((entry) => entry.requestId !== image.requestId) });
        updateImageNode(image.id, { src: prepared.previewUrl, status: "ready", error: "" });
        URL.revokeObjectURL(image.previewUrl);
      }).catch((failure) => {
        if (!mounted.current || controller.signal.aborted) return;
        const current = latest.current;
        if (!current.pendingImages.some((entry) => entry.requestId === image.requestId)) return;
        const message = imageError(failure, callbacks.current.locale);
        commit({ ...current, pendingImages: current.pendingImages.map((entry) => entry.requestId === image.requestId ? { ...entry, status: "error", error: message } : entry) });
        updateImageNode(image.id, { status: "error", error: message });
        setError(message);
      }).finally(() => { jobs.current.delete(image.requestId); });
    }
  }, [props.state.pendingImages, props.state.original]);

  const setOriginal = (original: boolean) => {
    const current = latest.current;
    for (const controller of jobs.current.values()) controller.abort();
    jobs.current.clear();
    const pendingImages: PendingChatImage[] = [
      ...current.pendingImages.map((image) => ({ ...image, status: "processing" as const, requestId: crypto.randomUUID(), error: undefined })),
      ...current.images.map((image) => ({ id: image.id, sourceFile: image.sourceFile, previewUrl: URL.createObjectURL(image.sourceFile), requestId: crypto.randomUUID(), status: "processing" as const })),
    ];
    commit({ ...current, original, images: [], pendingImages });
    for (const image of pendingImages) updateImageNode(image.id, { src: image.previewUrl, status: "processing", error: "" });
    for (const image of current.images) disposePreparedChatImage(image);
    setError("");
  };

  const zh = props.locale === "zh";
  const hasImages = props.state.images.length + props.state.pendingImages.length > 0;
  const hasContent = chatComposerBlocks(props.state.content).some((block) => block.type === "image" || block.text.trim());
  const canSend = props.ready && !props.state.pendingImages.length && hasContent;
  return (
    <div data-chat-composer="" className="relative flex max-h-[300px] min-h-[112px] w-full flex-col rounded-2xl border border-white/10 bg-black/25 text-[var(--zest-ink-strong)] focus-within:border-sky-100/35">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {!hasContent ? <span aria-hidden="true" className="pointer-events-none absolute left-4 top-3 text-sm text-[var(--zest-ink-muted)]">{zh ? "输入消息" : "Write a message"}</span> : null}
        <EditorContent editor={editor} />
      </div>
      {error ? <p className="px-4 pb-1 text-xs text-rose-400" role="alert">{error}</p> : null}
      <div className="flex shrink-0 items-center gap-3 px-3 pb-2">
        <input accept="image/jpeg,image/png,image/webp,image/gif" aria-label={zh ? "选择图片" : "Choose images"} className="hidden" multiple onChange={(event) => { addFilesRef.current(Array.from(event.target.files ?? [])); event.target.value = ""; }} ref={inputRef} type="file" />
        <button aria-label={zh ? "添加图片" : "Add images"} className="rounded-lg p-2 text-[var(--zest-ink-muted)] transition-colors hover:bg-white/10" onClick={() => inputRef.current?.click()} type="button"><RiImageAddLine aria-hidden="true" className="size-5" /></button>
        {hasImages ? <label className="inline-flex items-center gap-1.5 text-xs text-[var(--zest-ink-muted)]"><input checked={props.state.original} onChange={(event) => setOriginal(event.target.checked)} type="checkbox" />{zh ? "原图" : "Original"}</label> : null}
        <span className="ml-auto text-xs tabular-nums text-[var(--zest-ink-muted)]">{textLength(props.state.content)}/{CHAT_TEXT_MAX_LENGTH}</span>
        <button aria-label={zh ? "发送消息" : "Send message"} className="inline-flex size-9 items-center justify-center rounded-xl text-[#fff] transition-colors disabled:cursor-not-allowed disabled:opacity-35" disabled={!canSend} onClick={() => submitRef.current()} style={{ backgroundColor: canSend ? props.accent : "rgb(255 255 255 / 0.08)" }} type="button"><RiSendPlane2Fill aria-hidden="true" className="size-4" /></button>
      </div>
      <p className="px-4 pb-2 text-[10px] leading-relaxed text-[var(--zest-ink-muted)]">{zh ? "图片通过 HTTPS 临时存储于云端，24 小时后过期，不采用端对端加密。" : "Images use temporary cloud storage over HTTPS, expire after 24 hours and are not end-to-end encrypted."}</p>
    </div>
  );
}

export default ChatComposer;
