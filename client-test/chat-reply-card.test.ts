import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatReplyCard, type ChatReplyCardProps } from "../src/client/components/chat-reply-card";
import type { ChatReply } from "../src/shared/chat-protocol";

const reply: ChatReply = { messageId: "original-message", author: "sender", text: "Original text", imageCount: 0 };

function render(props: Partial<ChatReplyCardProps> = {}) {
  return renderToStaticMarkup(createElement(ChatReplyCard, { reply, replySender: "local", locale: "en", ...props }));
}

describe("reply snapshot presentation", () => {
  it.each([
    ["en", "sender", "local", "You"],
    ["en", "sender", "remote", "Other participant"],
    ["en", "recipient", "local", "Other participant"],
    ["en", "recipient", "remote", "You"],
    ["zh", "sender", "local", "你"],
    ["zh", "sender", "remote", "对方"],
    ["zh", "recipient", "local", "对方"],
    ["zh", "recipient", "remote", "你"],
  ] as const)("shows the original author in %s from %s/%s", (locale, author, replySender, label) => {
    const html = render({ locale, replySender, reply: { ...reply, author } });
    expect(html).toContain(`<span>${label}</span>`);
  });

  it("shows localized image placeholders without fetching a quoted image", () => {
    const imageOnly = { ...reply, text: "", imageCount: 1 };
    expect(render({ reply: imageOnly })).toContain("[Image]");
    expect(render({ reply: imageOnly, locale: "zh" })).toContain("[图片]");
    const mixed = { ...reply, imageCount: 3 };
    expect(render({ reply: mixed })).toContain("Original text [3 images]");
    expect(render({ reply: mixed, locale: "zh" })).toContain("Original text [3 张图片]");
    expect(render()).not.toContain("[0 images]");
    expect(render({ reply: mixed })).not.toMatch(/<(?:img|picture|iframe)\b|\b(?:src|href)=/);
  });

  it("escapes untrusted snapshot text and IDs and ignores nested or image payloads", () => {
    const untrusted = {
      ...reply, messageId: 'target"<&', text: '<img src="https://example.invalid/image"> & <script>bad()</script>',
      reply: { ...reply, text: "NESTED_QUOTE" },
      images: [{ readToken: "READ_CREDENTIAL", imageId: "IMAGE_ID" }],
    };
    const html = render({ reply: untrusted });
    expect(html).toContain("&lt;img src=&quot;https://example.invalid/image&quot;&gt; &amp; &lt;script&gt;bad()&lt;/script&gt;");
    expect(html).toContain('data-chat-reply-target="target&quot;&lt;&amp;"');
    expect(html).not.toMatch(/<(?:img|script|iframe)\b|<[^>]+\s(?:src|href)=/);
    expect(html).not.toContain("NESTED_QUOTE");
    expect(html).not.toContain("READ_CREDENTIAL");
    expect(html).not.toContain("IMAGE_ID");
  });

  it("provides an accessible original-message action and a stable target selector", () => {
    const html = render({ onClick: () => undefined });
    expect(html).toContain('data-chat-reply-target="original-message"');
    expect(html).toContain('aria-label="Go to original message: You, Original text"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain("data-chat-reply-draft");
    expect(html).not.toContain("Cancel reply");
    expect(render({ locale: "zh", onClick: () => undefined })).toContain('aria-label="定位原消息：你，Original text"');
  });

  it("labels draft cancellation separately from navigation without nesting buttons", () => {
    const html = render({ onCancel: () => undefined, onClick: () => undefined });
    expect(html).toContain('data-chat-reply-draft=""');
    expect(html).toContain("Replying to You");
    expect(html).toContain('aria-label="Cancel reply"');
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.match(/<button\b/g)).toHaveLength(1);
    const chinese = render({ locale: "zh", reply: { ...reply, author: "recipient" }, onCancel: () => undefined });
    expect(chinese).toContain("回复 对方");
    expect(chinese).toContain('aria-label="取消引用回复"');
  });
});
