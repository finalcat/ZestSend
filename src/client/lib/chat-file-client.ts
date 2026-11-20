/** Submit only the read credential. The browser handles the attachment response. */
export function downloadChatAsset(
  kind: "images" | "files",
  id: string,
  readToken: string,
  onError?: (status: number) => void,
): () => void {
  const frame = document.createElement("iframe");
  frame.name = `chat-download-${crypto.randomUUID()}`;
  frame.hidden = true;
  frame.title = "Download";

  const cleanUp = () => {
    window.clearTimeout(timer);
    frame.remove();
  };
  const timer = window.setTimeout(cleanUp, 120_000);
  frame.addEventListener("load", () => {
    try {
      if (frame.contentWindow?.location.href === "about:blank") return;
      const body = frame.contentDocument?.body.textContent ?? "";
      const result = JSON.parse(body) as { status?: unknown } | null;
      if (typeof result?.status === "number") onError?.(result.status);
    } catch {
      onError?.(0);
    } finally {
      if (frame.contentDocument?.URL !== "about:blank") cleanUp();
    }
  });

  const form = document.createElement("form");
  form.hidden = true;
  form.method = "POST";
  form.action = `/api/chat-${kind}/${encodeURIComponent(id)}/download`;
  form.target = frame.name;
  const credential = document.createElement("input");
  credential.type = "hidden";
  credential.name = "readToken";
  credential.value = readToken;
  form.append(credential);
  document.body.append(frame, form);
  try {
    form.submit();
  } catch {
    cleanUp();
    onError?.(0);
  } finally {
    form.remove();
  }
  return cleanUp;
}
