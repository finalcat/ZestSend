import CharacterCount from "@tiptap/extension-character-count";
import {
  EditorContent, Node as TiptapNode, NodeViewWrapper, ReactNodeViewRenderer, useEditor,
  type Editor, type JSONContent, type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { RiAttachmentLine, RiCloseLine, RiFileLine, RiImageAddLine, RiSendPlane2Fill } from "@remixicon/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isChatFileName } from "../../shared/chat-file-limits";
import { CHAT_FILE_MAX_BYTES, CHAT_FILES_MAX_BYTES, CHAT_TEXT_MAX_LENGTH, type ChatBlock, type ChatReply } from "../../shared/chat-protocol";
import { useChatImageVisibility, useLocalChatImagePreview } from "./chat-image-message";
import { ChatReplyCard } from "./chat-reply-card";
import {
  ChatImageError, prepareChatImage, validateChatImageFiles,
  type ChatImageMemoryBudget, type PreparedChatImage,
} from "../lib/chat-images";

export type { PreparedChatImage } from "../lib/chat-images";

type PendingChatImage = {
  id: string;
  sourceFile: File;
  requestId: string;
  status: "processing" | "error";
  error?: string;
};

export type DraftChatFile = { id: string; file: File };

/** Kept by the Room owner, so switching workspaces does not discard the draft. */
export type ChatComposerState = {
  content: JSONContent;
  files: DraftChatFile[];
  images: PreparedChatImage[];
  pendingImages: PendingChatImage[];
  original: boolean;
  reply?: ChatReply;
};

export type ChatComposerSubmit = { blocks: ChatBlock[]; files: DraftChatFile[]; images: PreparedChatImage[]; reply?: ChatReply };

export type ChatComposerProps = {
  locale: "en" | "zh";
  accent: string;
  ready: boolean;
  imageBudget: ChatImageMemoryBudget;
  onTyping: () => void;
  onSend: (draft: ChatComposerSubmit) => boolean;
  state: ChatComposerState;
  onStateChange: (state: ChatComposerState) => void;
};

export function createEmptyChatComposerState(): ChatComposerState {
  return { content: { type: "doc", content: [{ type: "paragraph" }] }, files: [], images: [], pendingImages: [], original: false };
}

function paragraphText(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.type === "hardBreak" ? "\n" : child.text ?? "").join("");
}

export function chatComposerBlocks(content: JSONContent): ChatBlock[] {
  return (content.content ?? []).flatMap((node): ChatBlock[] => {
    if (node.type === "paragraph") return [{ type: "paragraph", text: paragraphText(node) }];
    if (node.type === "chatImage" && typeof node.attrs?.imageId === "string") return [{ type: "image", imageId: node.attrs.imageId }];
    if (node.type === "chatFile" && typeof node.attrs?.fileId === "string") return [{ type: "file", fileId: node.attrs.fileId }];
    return [];
  });
}

function textLength(content: JSONContent): number {
  return chatComposerBlocks(content).reduce((count, block) => count + (block.type === "paragraph" ? block.text.length : 0), 0);
}

function hasChatContent(blocks: readonly ChatBlock[]): boolean {
  return blocks.some((block) => block.type !== "paragraph" || block.text.trim().length > 0);
}

function insertAttachmentBlocks(editor: Editor, attachments: JSONContent[]): boolean {
  const { empty, $from } = editor.state.selection;
  const { parent, parentOffset } = $from;
  const chain = editor.chain().focus();
  if (!empty || parent.type.name !== "paragraph" || parentOffset === parent.content.size) {
    return chain.insertContent([...attachments, { type: "paragraph" }]).run();
  }

  const prefix = parentOffset ? [parent.cut(0, parentOffset)] : [];
  const suffix = parent.cut(parentOffset);
  const inserted = [...prefix, ...attachments.map((block) => editor.schema.nodeFromJSON(block))];
  const from = $from.before();
  const suffixStart = inserted.reduce((position, node) => position + node.nodeSize, from);
  return chain
    .insertContentAt({ from, to: $from.after() }, [...inserted, suffix].map((node) => node.toJSON()), { updateSelection: false })
    .setTextSelection(suffixStart + 1)
    .run();
}

function imageError(error: unknown, locale: "en" | "zh"): string {
  const code = error instanceof ChatImageError ? error.code : "decode-failed";
  const messages = {
    unsupported: ["支持 JPEG、PNG、WebP 和 GIF 图片。", "Choose a JPEG, PNG, WebP or GIF image."],
    "file-too-large": ["单张图片须大于 0 且不超过 20 MiB。", "Each image must be nonempty and no larger than 20 MiB."],
    "too-many-images": ["每条消息最多 10 张图片。", "A message can contain up to 10 images."],
    "total-too-large": ["图片原文件合计不能超过 50 MiB。", "Source images must total no more than 50 MiB."],
    "decode-failed": ["无法处理这张图片，请重试或选择其他图片。", "This image could not be processed. Retry or choose another image."],
    "image-too-large-to-preview": ["图片无法安全预览，可通过「添加文件」发送原件。", "This image cannot be safely previewed. Use Add files to send the original."],
    "preview-budget-full": ["当前图片占用较多，关闭其他预览后重试。", "Too much image data is open. Close another preview and retry."],
  };
  return messages[code][locale === "zh" ? 0 : 1];
}

function DraftImage({ node, deleteNode, extension, selected }: NodeViewProps) {
  const zh = extension.options.getLocale() === "zh";
  const attrs = node.attrs;
  const element = useRef<HTMLDivElement>(null);
  const visible = useChatImageVisibility(element);
  const prepared: PreparedChatImage | undefined = attrs.status === "ready" ? extension.options.getImage(attrs.imageId) : undefined;
  const budget: ChatImageMemoryBudget = extension.options.getImageBudget();
  const preview = useLocalChatImagePreview(prepared?.file, prepared?.decodedBytes ?? 0, budget, visible);
  return (
    <NodeViewWrapper ref={element} className={`group relative my-2 min-w-32 max-w-full w-fit overflow-hidden rounded-xl border ${selected ? "border-sky-300" : "border-white/15"}`} contentEditable={false} data-chat-image-id={attrs.imageId} data-drag-handle="">
      {preview ? (
        <img alt={attrs.name || (zh ? "待发送图片" : "Draft image")} className="max-h-40 max-w-full object-contain" draggable={false} src={preview} />
      ) : (
        <div className="flex min-h-20 max-w-60 items-center gap-2 px-3 pb-2 pt-7 text-xs text-[var(--zest-ink-muted)]">
          <RiImageAddLine aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate" title={attrs.name}>{attrs.name}</span>
        </div>
      )}
      <button aria-label={zh ? "删除图片" : "Remove image"} className="absolute right-1 top-1 rounded-full bg-black/65 p-1 text-[#fff] hover:bg-black/85" draggable={false} onClick={deleteNode} onMouseDown={(event) => event.preventDefault()} type="button">
        <RiCloseLine aria-hidden="true" className="size-4" />
      </button>
      {attrs.status === "processing" ? <span className="block bg-black/65 px-2 py-1 text-xs text-[#fff]" role="status">{zh ? "正在处理图片…" : "Preparing image…"}</span> : null}
      {attrs.status === "error" ? (
        <div className="bg-black/80 p-2 text-xs text-rose-200">
          <p>{attrs.error}</p>
          {attrs.errorCode !== "image-too-large-to-preview" ? <button className="mt-1 underline" onClick={() => extension.options.onRetry(attrs.imageId)} type="button">{zh ? "重试" : "Retry"}</button> : null}
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

function DraftFile({ node, deleteNode, extension, selected }: NodeViewProps) {
  const zh = extension.options.getLocale() === "zh";
  const { fileId, name, size } = node.attrs as { fileId: string; name: string; size: number };
  const sizeLabel = size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 ** 2).toFixed(1)} MiB`;
  return (
    <NodeViewWrapper
      className={`my-2 flex w-full max-w-sm items-center gap-2 rounded-xl border bg-white/5 px-3 py-2 text-xs text-[var(--zest-ink-muted)] ${selected ? "border-sky-300" : "border-white/15"}`}
      contentEditable={false}
      data-chat-file-draft=""
      data-chat-file-id={fileId}
      data-drag-handle=""
    >
      <RiFileLine aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
      <span className="shrink-0 tabular-nums">{sizeLabel}</span>
      <button
        aria-label={zh ? `移除文件 ${name}` : `Remove file ${name}`}
        className="shrink-0 rounded-md p-1.5 transition-colors hover:bg-white/10"
        draggable={false}
        onClick={deleteNode}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      ><RiCloseLine aria-hidden="true" className="size-4" /></button>
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
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const addImagesRef = useRef<(files: File[]) => void>(() => undefined);
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
      addOptions: () => ({
        getLocale: () => callbacks.current.locale,
        getImage: (id: string) => latest.current.images.find((image) => image.id === id),
        getImageBudget: () => callbacks.current.imageBudget,
        onRetry: (id: string) => retryRef.current(id),
      }),
      addAttributes: () => ({
        imageId: { default: "" }, name: { default: "" },
        status: { default: "processing" }, error: { default: "" }, errorCode: { default: "" },
      }),
      parseHTML: () => [{ tag: "div[data-chat-image-id]" }],
      renderHTML: ({ node }) => ["div", { "data-chat-image-id": node.attrs.imageId }],
      addNodeView: () => ReactNodeViewRenderer(DraftImage),
    }),
    TiptapNode.create({
      name: "chatFile", group: "block", atom: true, draggable: true, selectable: true,
      addOptions: () => ({ getLocale: () => callbacks.current.locale }),
      addAttributes: () => ({
        fileId: { default: "" }, name: { default: "" }, size: { default: 0 },
      }),
      renderHTML: ({ node }) => ["div", { "data-chat-file-id": node.attrs.fileId }],
      addNodeView: () => ReactNodeViewRenderer(DraftFile),
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
        if (files.length) { addImagesRef.current(files); return true; }
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
        addImagesRef.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: updated }) => {
      const content = updated.getJSON();
      const blocks = chatComposerBlocks(content);
      const imageIds = new Set(blocks.flatMap((block) => block.type === "image" ? [block.imageId] : []));
      const fileIds = new Set(blocks.flatMap((block) => block.type === "file" ? [block.fileId] : []));
      const current = latest.current;
      for (const image of current.pendingImages) {
        if (!imageIds.has(image.id)) jobs.current.get(image.requestId)?.abort();
      }
      commit({
        ...current,
        content,
        files: current.files.filter((file) => fileIds.has(file.id)),
        images: current.images.filter((image) => imageIds.has(image.id)),
        pendingImages: current.pendingImages.filter((image) => imageIds.has(image.id)),
      });
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

  addImagesRef.current = (files) => {
    if (!files.length || !editorRef.current) return;
    const current = latest.current;
    try { validateChatImageFiles(files, [...current.images, ...current.pendingImages].map((image) => image.sourceFile)); }
    catch (failure) { setError(imageError(failure, callbacks.current.locale)); return; }
    const pending: PendingChatImage[] = files.map((sourceFile) => ({
      id: crypto.randomUUID(), sourceFile, requestId: crypto.randomUUID(), status: "processing",
    }));
    commit({ ...current, pendingImages: [...current.pendingImages, ...pending] });
    const inserted = insertAttachmentBlocks(editorRef.current, pending.map((image) => ({
      type: "chatImage", attrs: { imageId: image.id, name: image.sourceFile.name, status: "processing" },
    })));
    if (!inserted) commit(current);
    setError("");
  };

  const addFiles = (files: File[]) => {
    const currentEditor = editorRef.current;
    if (!files.length || !currentEditor) return;
    const current = latest.current;
    const zh = callbacks.current.locale === "zh";
    if (files.some((file) => file.size > CHAT_FILE_MAX_BYTES)) {
      setError(zh ? "单个文件不能超过 50 MiB。" : "Each file must be no larger than 50 MiB.");
      return;
    }
    const attachedBytes = current.files.reduce((sum, entry) => sum + entry.file.size, 0);
    if (files.reduce((sum, file) => sum + file.size, attachedBytes) > CHAT_FILES_MAX_BYTES) {
      setError(zh ? "单条消息的文件合计不能超过 100 MiB。" : "Files in a message must total no more than 100 MiB.");
      return;
    }
    if (files.some((file) => !isChatFileName(file.name))) {
      setError(zh ? "文件名无效，请重命名后添加。" : "Rename the file before adding it.");
      return;
    }
    const additions = files.map((file) => ({ id: crypto.randomUUID(), file }));
    commit({ ...current, files: [...current.files, ...additions] });
    const inserted = insertAttachmentBlocks(currentEditor, additions.map(({ id, file }) => ({
      type: "chatFile", attrs: { fileId: id, name: file.name, size: file.size },
    })));
    if (!inserted) commit(current);
    setError("");
  };

  retryRef.current = (id) => {
    const current = latest.current;
    commit({ ...current, pendingImages: current.pendingImages.map((image) => image.id === id ? { ...image, requestId: crypto.randomUUID(), status: "processing", error: undefined } : image) });
    updateImageNode(id, { status: "processing", error: "", errorCode: "" });
  };

  submitRef.current = () => {
    const current = latest.current;
    const currentProps = callbacks.current;
    if (!currentProps.ready || current.pendingImages.length || !editorRef.current) return;
    const content = editorRef.current.getJSON();
    const blocks = chatComposerBlocks(content);
    if (!hasChatContent(blocks)) return;
    if (blocks.length > 256 || textLength(content) > CHAT_TEXT_MAX_LENGTH) {
      setError(callbacks.current.locale === "zh" ? "消息最多 4000 字、256 段。" : "Messages can contain up to 4000 characters and 256 blocks.");
      return;
    }
    const imageIds = blocks.flatMap((block) => block.type === "image" ? [block.imageId] : []);
    const fileIds = blocks.flatMap((block) => block.type === "file" ? [block.fileId] : []);
    const images = imageIds.map((id) => current.images.find((image) => image.id === id));
    const files = fileIds.map((id) => current.files.find((file) => file.id === id));
    if (images.some((image) => !image) || new Set(imageIds).size !== imageIds.length
      || files.some((file) => !file) || new Set(fileIds).size !== fileIds.length) return;
    try {
      if (!currentProps.onSend({ blocks, files: files as DraftChatFile[], images: images as PreparedChatImage[], ...(current.reply ? { reply: current.reply } : {}) })) return;
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

  // Selecting a reply changes only its snapshot, keeping the editor document,
  // selection, image processing jobs and existing draft previews intact.
  useEffect(() => {
    if (props.state.reply && editor && !editor.isDestroyed) editor.commands.focus();
  }, [editor, props.state.reply]);

  useEffect(() => {
    const pending = props.state.pendingImages.filter((image) => image.status === "processing");
    const active = new Set(pending.map((image) => image.requestId));
    for (const [id, controller] of jobs.current) {
      if (active.has(id)) continue;
      controller.abort();
      jobs.current.delete(id);
    }
    const image = pending[0];
    if (!image || jobs.current.size) return;
    const controller = new AbortController();
    jobs.current.set(image.requestId, controller);
    void prepareChatImage(image.sourceFile, {
      id: image.id, original: props.state.original, signal: controller.signal, budget: props.imageBudget,
    }).then((prepared) => {
      jobs.current.delete(image.requestId);
      const current = latest.current;
      if (!mounted.current || controller.signal.aborted || !current.pendingImages.some((entry) => entry.requestId === image.requestId)) return;
      commit({
        ...current,
        images: [...current.images, prepared],
        pendingImages: current.pendingImages.filter((entry) => entry.requestId !== image.requestId),
      });
      updateImageNode(image.id, { status: "ready", error: "", errorCode: "" });
    }).catch((failure) => {
      jobs.current.delete(image.requestId);
      if (!mounted.current || controller.signal.aborted) return;
      const current = latest.current;
      if (!current.pendingImages.some((entry) => entry.requestId === image.requestId)) return;
      const message = imageError(failure, callbacks.current.locale);
      commit({
        ...current,
        pendingImages: current.pendingImages.map((entry) => entry.requestId === image.requestId ? { ...entry, status: "error", error: message } : entry),
      });
      updateImageNode(image.id, { status: "error", error: message, errorCode: failure instanceof ChatImageError ? failure.code : "" });
      setError(message);
    });
  }, [props.imageBudget, props.state.pendingImages, props.state.original]);

  const setOriginal = (original: boolean) => {
    const current = latest.current;
    for (const controller of jobs.current.values()) controller.abort();
    jobs.current.clear();
    const pendingImages: PendingChatImage[] = [
      ...current.pendingImages.map((image) => ({ ...image, status: "processing" as const, requestId: crypto.randomUUID(), error: undefined })),
      ...current.images.map((image) => ({ id: image.id, sourceFile: image.sourceFile, requestId: crypto.randomUUID(), status: "processing" as const })),
    ];
    commit({ ...current, original, images: [], pendingImages });
    for (const image of pendingImages) updateImageNode(image.id, { status: "processing", error: "", errorCode: "" });
    setError("");
  };

  const zh = props.locale === "zh";
  const hasImages = props.state.images.length + props.state.pendingImages.length > 0;
  const hasContent = hasChatContent(chatComposerBlocks(props.state.content));
  const canSend = props.ready && !props.state.pendingImages.length && hasContent;
  return (
    <div data-chat-composer="" className="relative flex max-h-[300px] min-h-[112px] w-full flex-col rounded-2xl border border-white/10 bg-black/25 text-[var(--zest-ink-strong)] focus-within:border-sky-100/35">
      {props.state.reply ? <div className="shrink-0 px-3 pt-3"><ChatReplyCard
        locale={props.locale}
        onCancel={() => {
          const { reply: _reply, ...draft } = latest.current;
          commit(draft);
          editorRef.current?.commands.focus();
        }}
        reply={props.state.reply}
        replySender="local"
      /></div> : null}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {!hasContent ? <span aria-hidden="true" className="pointer-events-none absolute left-4 top-3 text-sm text-[var(--zest-ink-muted)]">{zh ? "输入消息" : "Write a message"}</span> : null}
        <EditorContent editor={editor} />
      </div>
      {error ? <p className="px-4 pb-1 text-xs text-rose-400" role="alert">{error}</p> : null}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2">
        <div className="flex items-center gap-1">
          <input accept="image/jpeg,image/png,image/webp,image/gif" aria-label={zh ? "选择图片" : "Choose images"} className="hidden" multiple onChange={(event) => { addImagesRef.current(Array.from(event.target.files ?? [])); event.target.value = ""; }} ref={imagePickerRef} type="file" />
          <button aria-label={zh ? "添加图片" : "Add images"} className="rounded-lg p-2 text-[var(--zest-ink-muted)] transition-colors hover:bg-white/10" onClick={() => imagePickerRef.current?.click()} type="button"><RiImageAddLine aria-hidden="true" className="size-5" /></button>
          <input aria-label={zh ? "选择文件" : "Choose files"} className="sr-only" multiple onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            addFiles(files);
          }} ref={filePickerRef} tabIndex={-1} type="file" />
          <button aria-label={zh ? "添加文件" : "Add files"} className="rounded-lg p-2 text-[var(--zest-ink-muted)] transition-colors hover:bg-white/10" onClick={() => filePickerRef.current?.click()} type="button"><RiAttachmentLine aria-hidden="true" className="size-5" /></button>
          {hasImages ? <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-[var(--zest-ink-muted)]"><input checked={props.state.original} onChange={(event) => setOriginal(event.target.checked)} type="checkbox" />{zh ? "原图" : "Original"}</label> : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-[var(--zest-ink-muted)]">{textLength(props.state.content)}/{CHAT_TEXT_MAX_LENGTH}</span>
          <button aria-label={zh ? "发送消息" : "Send message"} className="inline-flex size-9 items-center justify-center rounded-xl text-[#fff] transition-colors disabled:cursor-not-allowed disabled:opacity-35" disabled={!canSend} onClick={() => submitRef.current()} style={{ backgroundColor: canSend ? props.accent : "rgb(255 255 255 / 0.08)" }} type="button"><RiSendPlane2Fill aria-hidden="true" className="size-4" /></button>
        </div>
      </div>
      <p className="px-4 pb-2 text-[10px] leading-relaxed text-[var(--zest-ink-muted)]">{zh ? "图片和文件通过 HTTPS 临时存储于云端，24 小时后过期，不采用端对端加密。" : "Images and files use temporary cloud storage over HTTPS, expire after 24 hours and are not end-to-end encrypted."}</p>
    </div>
  );
}

export default ChatComposer;
