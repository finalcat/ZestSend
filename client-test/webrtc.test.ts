import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeWebRTCSession } from "../src/client/lib/webrtc";
import type { RichChatMessage } from "../src/shared/chat-protocol";

vi.mock("../src/client/lib/media-transport", () => ({
  MediaTransport: class {
    traffic = { received: 0, sent: 0 };
    prepareOffer() {}
    bindIncomingPeer() {}
    detachPeer() {}
    dispose() {}
    handleRemoteTrack() {}
    handleControlMessage() { return false; }
  },
}));

type WireMessage = {
  type?: string;
  mode?: string;
  epoch?: number;
  payload?: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
};

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  messages: WireMessage[] = [];
  descriptionSendFailures = 0;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(data: string) {
    if (!data.startsWith("{")) return;
    const message = JSON.parse(data) as WireMessage;
    if (message.payload?.description && this.descriptionSendFailures > 0) {
      this.descriptionSendFailures -= 1;
      throw new Error("temporary socket send failure");
    }
    this.messages.push(message);
    if (message.type === "ping") this.receive({ type: "pong" });
  }
  close() { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly label: string) {}
  send = vi.fn((_data: string | ArrayBuffer | Blob) => undefined);
  close() { this.readyState = "closed"; this.onclose?.(); }
}

class FakePeer {
  static instances: FakePeer[] = [];
  static onCreate: ((peer: FakePeer) => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  channels: FakeChannel[] = [];
  readonly number = FakePeer.instances.length + 1;
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({ type: "offer", sdp: `offer-${this.number}` }));
  createAnswer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({ type: "answer", sdp: `answer-${this.number}` }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
  });
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  close = vi.fn(() => { this.connectionState = "closed"; this.signalingState = "closed"; });
  getStats = vi.fn(async () => new Map());
  constructor() { FakePeer.instances.push(this); FakePeer.onCreate?.(this); }
  createDataChannel(label: string) {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }
}

type IcePreparationHarness = {
  readyForPeerConnection: boolean;
  prepareIceServers(): Promise<void>;
  coordinateNegotiation(): void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

function negotiate(socket: FakeSocket, epoch = 1, remoteSession = "remote-1", initiator = false) {
  socket.receive({
    type: "negotiate", epoch, slotId: "remote", peerSessionId: remoteSession,
    offererSlotId: initiator ? "local" : "remote",
    peers: [{ slotId: "local", peerSessionId: "local-1" }, { slotId: "remote", peerSessionId: remoteSession }],
  });
}

function signal(socket: FakeSocket, payload: NonNullable<WireMessage["payload"]>, epoch = 1, remoteSession = "remote-1") {
  socket.receive({ type: "signal", epoch, fromSlotId: "remote", peerSessionId: remoteSession, payload });
}

function descriptions(socket: FakeSocket, type: RTCSdpType) {
  return socket.messages.filter((message) => message.payload?.description?.type === type);
}

function acceptRestart(epoch: number, localSession: string, initiator = false) {
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  socket.receive({
    type: "welcome", epoch, slotId: "local", peerSessionId: localSession, resumeToken: "next-token",
    resumed: true, isInitiator: initiator, offererSlotId: initiator ? "local" : "remote", peerCount: 2,
  });
  negotiate(socket, epoch, "remote-1", initiator);
  return socket;
}

function start(initiator = false) {
  const onError = vi.fn();
  const onMessage = vi.fn();
  const session = new NativeWebRTCSession("room", vi.fn(), vi.fn(), onError, vi.fn(), vi.fn(), vi.fn(), onMessage, vi.fn(), vi.fn(), vi.fn());
  sessions.push(session);
  session.connect();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  socket.receive({
    type: "welcome", epoch: 1, slotId: "local", peerSessionId: "local-1", resumeToken: "token",
    isInitiator: initiator, offererSlotId: initiator ? "local" : "remote", peerCount: 2,
  });
  negotiate(socket, 1, "remote-1", initiator);
  return { session, socket, onError, onMessage };
}

const sessions: NativeWebRTCSession[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakePeer.instances = [];
  FakePeer.onCreate = null;
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { origin: "https://zestsend.test" },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.spyOn(NativeWebRTCSession.prototype as unknown as IcePreparationHarness, "prepareIceServers").mockImplementation(async function (this: IcePreparationHarness) {
    this.readyForPeerConnection = true;
    this.coordinateNegotiation();
  });
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.suspend();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function richMessage(): RichChatMessage {
  const expiresAt = 1_794_027_600_000;
  const imageId = `${expiresAt}-${"a".repeat(32)}`;
  return {
    type: "chat-rich", version: 1, id: "rich-message",
    blocks: [{ type: "paragraph", text: "A screenshot" }, { type: "image", imageId }],
    images: [{ imageId, readToken: "r".repeat(43), expiresAt, mimeType: "image/png", size: 512,
      width: 10, height: 10, name: "image.png", original: false }],
  };
}

function openChannel(peer: FakePeer, name: string): FakeChannel {
  const channel = peer.channels.find((entry) => entry.label === name)!;
  channel.readyState = "open";
  channel.onopen?.();
  return channel;
}

function replyMessage(withImage = false): RichChatMessage {
  return { ...richMessage(), version: 2,
    blocks: withImage ? richMessage().blocks : [{ type: "paragraph", text: "Reply body" }],
    images: withImage ? richMessage().images : [],
    reply: { messageId: "original", author: "recipient", text: "Original body", imageCount: 0 },
  };
}

describe("reply capability compatibility", () => {
  it("negotiates separately from image support and accepts late declarations", async () => {
    const { session } = start(true);
    const listener = vi.fn();
    const unsubscribe = session.subscribeChatReplySupport(listener);
    const peer = FakePeer.instances[0];
    const control = openChannel(peer, "control");
    const interactive = openChannel(peer, "interactive");
    expect(control.send).toHaveBeenCalledWith(JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }));
    control.onmessage?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    expect(session.chatImageSupport).toBe("supported");
    expect(session.chatReplySupport).toBe("unknown");
    expect(session.sendRichChatMessage(replyMessage())).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.chatReplySupport).toBe("unsupported");
    expect(session.chatImageSupport).toBe("supported");
    expect(session.sendChatMessage("legacy", "still works")).toBe(true);
    expect(session.sendRichChatMessage(richMessage())).toBe(true);
    control.onmessage?.({ data: JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }) });
    expect(session.sendRichChatMessage(replyMessage())).toBe(true);
    expect(interactive.send).toHaveBeenCalledWith(JSON.stringify(replyMessage()));
    const count = control.send.mock.calls.length;
    control.onmessage?.({ data: JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }) });
    expect(control.send.mock.calls).toHaveLength(count);
    expect(listener.mock.calls.map(([value]) => value)).toEqual(["unknown", "unsupported", "supported"]);
    unsubscribe();
  });

  it("allows text replies without image support but gates attachments", () => {
    const { session } = start(true);
    const peer = FakePeer.instances[0];
    const control = openChannel(peer, "control");
    openChannel(peer, "interactive");
    control.onmessage?.({ data: JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }) });
    expect(session.chatImageSupport).toBe("unknown");
    expect(session.sendRichChatMessage(replyMessage())).toBe(true);
    expect(session.sendRichChatMessage(replyMessage(true))).toBe(false);
    control.onmessage?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    expect(session.sendRichChatMessage(replyMessage(true))).toBe(true);
  });

  it("learns from incoming v2 messages and preserves duplicate receipts", () => {
    const { session, onMessage } = start(true);
    const peer = FakePeer.instances[0];
    const control = openChannel(peer, "control");
    const interactive = openChannel(peer, "interactive");
    const data = JSON.stringify(replyMessage());
    interactive.onmessage?.({ data });
    interactive.onmessage?.({ data });
    expect(session.chatReplySupport).toBe("supported");
    expect(session.chatImageSupport).toBe("unknown");
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(replyMessage());
    expect(control.send.mock.calls.filter(([payload]) => typeof payload === "string" && JSON.parse(payload).type === "chat-received")).toHaveLength(2);
  });

  it("ignores old channel callbacks and deadlines after peer replacement or suspend", async () => {
    const { session, socket } = start(true);
    const control = openChannel(FakePeer.instances[0], "control");
    const oldReceive = control.onmessage;
    negotiate(socket, 2, "remote-2", true);
    oldReceive?.({ data: JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }) });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(session.chatReplySupport).toBe("unknown");
    const next = openChannel(FakePeer.instances[1], "control");
    next.onmessage?.({ data: JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }) });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(session.chatReplySupport).toBe("supported");
    session.suspend();
    expect(session.chatReplySupport).toBe("unknown");
    expect(session.sendRichChatMessage(replyMessage())).toBe(false);
  });

  it.each(["suspend", "replace"] as const)("revokes channels before reentrant capability listeners during %s", (operation) => {
    const { session, socket } = start(true);
    const peer = FakePeer.instances[0];
    const control = openChannel(peer, "control");
    const interactive = openChannel(peer, "interactive");
    control.onmessage?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    control.onmessage?.({ data: JSON.stringify({ type: "chat-reply-capabilities", version: 1, replies: true }) });
    const originalReply = replyMessage();
    expect(session.sendRichChatMessage(originalReply)).toBe(true);
    // Room resumes all unacknowledged messages from either capability listener.
    // Subscribing calls the listeners once, before the teardown under test.
    const resume = vi.fn(() => {
      session.sendChatMessage("unacknowledged-text", "Pending text");
      session.sendRichChatMessage(originalReply);
    });
    session.subscribeChatImageSupport(resume);
    session.subscribeChatReplySupport(resume);
    const sendsBeforeTeardown = interactive.send.mock.calls.length;
    resume.mockClear();
    if (operation === "suspend") session.suspend();
    else negotiate(socket, 2, "remote-2", true);
    expect(resume).toHaveBeenCalled();
    expect(interactive.readyState).toBe("closed");
    expect(interactive.send.mock.calls).toHaveLength(sendsBeforeTeardown);
    expect(session.chatReplySupport).toBe("unknown");
  });
});

describe("rich chat compatibility and upload authorization", () => {
  it("announces capabilities on control open before the other channels are available", async () => {
    const { session } = start(true);
    const support = vi.fn();
    const unsubscribe = session.subscribeChatImageSupport(support);
    const control = openChannel(FakePeer.instances[0], "control");
    expect(control.send).toHaveBeenCalledWith(JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }));
    expect(session.chatImageSupport).toBe("unknown");
    control.onmessage?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    expect(session.chatImageSupport).toBe("supported");
    expect(support.mock.calls.map(([value]) => value)).toEqual(["unknown", "supported"]);
    const announcements = control.send.mock.calls.filter(([data]) => typeof data === "string" && data.includes("chat-capabilities"));
    control.onmessage?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    expect(control.send.mock.calls.filter(([data]) => typeof data === "string" && data.includes("chat-capabilities"))).toHaveLength(announcements.length);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(session.chatImageSupport).toBe("supported");
  });

  it("falls back to text for an old peer and accepts a late capability announcement", async () => {
    const { session } = start(true);
    const peer = FakePeer.instances[0];
    const control = openChannel(peer, "control");
    const interactive = openChannel(peer, "interactive");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(session.chatImageSupport).toBe("unknown");
    expect(session.sendRichChatMessage(richMessage())).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.chatImageSupport).toBe("unsupported");
    expect(session.sendChatMessage("legacy-text", "still usable")).toBe(true);
    expect(interactive.send).toHaveBeenCalledWith(JSON.stringify({ id: "legacy-text", text: "still usable", type: "chat" }));
    control.onmessage?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    expect(session.sendRichChatMessage(richMessage())).toBe(true);
    expect(interactive.send).toHaveBeenCalledWith(JSON.stringify(richMessage()));
    expect(session.sendRichChatMessage({ ...richMessage(), images: [] })).toBe(false);
  });

  it("validates incoming rich messages, acknowledges duplicates and delivers only once", () => {
    const { session, onMessage } = start(true);
    const peer = FakePeer.instances[0];
    const control = openChannel(peer, "control");
    const interactive = openChannel(peer, "interactive");
    const data = JSON.stringify(richMessage());
    interactive.onmessage?.({ data });
    interactive.onmessage?.({ data });
    interactive.onmessage?.({ data: JSON.stringify({ ...richMessage(), id: "bad", images: [{ ...richMessage().images[0], src: "https://example.com" }] }) });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(richMessage());
    expect(control.send.mock.calls.filter(([payload]) => typeof payload === "string" && JSON.parse(payload).type === "chat-received")).toHaveLength(2);
    expect(session.chatImageSupport).toBe("supported");
  });

  it("clears peer-specific capabilities and ignores late callbacks from the old control channel", async () => {
    const { session, socket } = start(true);
    const control = openChannel(FakePeer.instances[0], "control");
    const oldReceive = control.onmessage;
    oldReceive?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    expect(session.chatImageSupport).toBe("supported");
    negotiate(socket, 2, "remote-2", true);
    expect(session.chatImageSupport).toBe("unknown");
    oldReceive?.({ data: JSON.stringify({ type: "chat-capabilities", version: 1, richImages: true }) });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(session.chatImageSupport).toBe("unknown");
    openChannel(FakePeer.instances[1], "control");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.chatImageSupport).toBe("unsupported");
  });

  it("only exposes an admitted, locally valid upload authorization", async () => {
    const { session, socket } = start(true);
    expect(session.getImageUploadAuthorization()).toBe("token");
    socket.close();
    expect(session.getImageUploadAuthorization()).toBe("token");
    await vi.advanceTimersByTimeAsync(35_000);
    expect(session.getImageUploadAuthorization()).toBeNull();
  });

  it("waits for a fresh authoritative resume token without accepting the rejected token", async () => {
    const { session, socket } = start(true);
    const waiting = session.waitForImageUploadAuthorization("token");
    socket.receive({ type: "welcome", epoch: 2, slotId: "local", peerSessionId: "local-1", resumeToken: "rotated-token",
      isInitiator: true, offererSlotId: "local", peerCount: 2, resumed: true });
    await expect(waiting).resolves.toBe("rotated-token");
    await expect(session.waitForImageUploadAuthorization("token")).resolves.toBe("rotated-token");
  });

  it.each(["suspend", "close", "abort", "timeout"] as const)("settles upload authorization waiting after %s", async (operation) => {
    const { session } = start(true);
    const controller = new AbortController();
    const waiting = session.waitForImageUploadAuthorization("token", controller.signal);
    if (operation === "abort") controller.abort();
    else if (operation === "timeout") await vi.advanceTimersByTimeAsync(5_000);
    else session[operation]();
    await expect(waiting).resolves.toBeNull();
    if (operation === "suspend" || operation === "close") expect(session.getImageUploadAuthorization()).toBeNull();
  });
});

describe("WebRTC negotiation ownership and delivery", () => {
  it("answers a new session while the old session's remote-description promise is still pending", async () => {
    const { socket } = start();
    const blocked = deferred<void>();
    FakePeer.onCreate = (peer) => {
      if (peer.number === 1) peer.setRemoteDescription.mockImplementationOnce(async (description) => {
        await blocked.promise;
        peer.remoteDescription = description;
        peer.signalingState = "have-remote-offer";
      });
    };
    signal(socket, { candidate: { candidate: "early" } });
    signal(socket, { description: { type: "offer", sdp: "old-offer" } });
    const oldPeer = FakePeer.instances[0];
    expect(oldPeer).toBeDefined();
    await settle();
    negotiate(socket, 2, "remote-2");
    signal(socket, { description: { type: "offer", sdp: "new-offer" } }, 2, "remote-2");
    await settle();
    expect(descriptions(socket, "answer").map((message) => message.payload?.description?.sdp)).toEqual(["answer-2"]);
    expect(oldPeer.close).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await settle();
    expect(descriptions(socket, "answer")).toHaveLength(1);
    expect(FakePeer.instances[1].close).not.toHaveBeenCalled();
  });

  it("keeps an in-progress answer alive across repeated authoritative negotiate and epoch-only changes", async () => {
    const { socket } = start();
    const blocked = deferred<RTCSessionDescriptionInit>();
    FakePeer.onCreate = (peer) => { peer.createAnswer.mockReturnValueOnce(blocked.promise); };
    signal(socket, { description: { type: "offer", sdp: "v=0\r\na=ice-ufrag:remote\r\n" } });
    const peer = FakePeer.instances[0];
    await settle();
    negotiate(socket);
    negotiate(socket, 2);
    blocked.resolve({ type: "answer", sdp: "answer" });
    await settle();
    expect(FakePeer.instances).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
    expect(descriptions(socket, "answer").at(-1)).toMatchObject({ epoch: 2, payload: { description: { sdp: "answer" } } });
  });

  it("finishes an offer under the latest signaling epoch without abandoning a half-created peer", async () => {
    const blocked = deferred<RTCSessionDescriptionInit>();
    FakePeer.onCreate = (peer) => {
      peer.setLocalDescription.mockImplementationOnce(async (description) => { await blocked.promise; peer.localDescription = description; peer.signalingState = "have-local-offer"; });
    };
    const { socket } = start(true);
    const peer = FakePeer.instances[0];
    await settle();
    negotiate(socket, 2, "remote-1", true);
    blocked.resolve({ type: "offer", sdp: "unused" });
    await settle();
    expect(FakePeer.instances).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
    expect(descriptions(socket, "offer").at(-1)?.epoch).toBe(2);
  });

  it("lets the new owner's offer finish while an old createOffer never resolves", async () => {
    const blocked = deferred<RTCSessionDescriptionInit>();
    FakePeer.onCreate = (peer) => { if (peer.number === 1) peer.createOffer.mockReturnValueOnce(blocked.promise); };
    const { socket } = start(true);
    await settle();
    negotiate(socket, 2, "remote-2", true);
    await settle();
    expect(descriptions(socket, "offer").map((message) => message.payload?.description?.sdp)).toEqual(["offer-2"]);
    blocked.resolve({ type: "offer", sdp: "obsolete-offer" });
    await settle();
    expect(descriptions(socket, "offer")).toHaveLength(1);
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
    expect(FakePeer.instances[1].close).not.toHaveBeenCalled();
  });

  it("replays an unsent description after a transient socket error without replacing its PC", async () => {
    const { socket } = start(true);
    socket.descriptionSendFailures = 1;
    await settle();
    expect(descriptions(socket, "offer")).toHaveLength(0);
    negotiate(socket, 2, "remote-1", true);
    await settle();
    expect(descriptions(socket, "offer")).toHaveLength(1);
    expect(descriptions(socket, "offer")[0]).toMatchObject({ epoch: 2, payload: { description: { sdp: "offer-1" } } });
    expect(FakePeer.instances).toHaveLength(1);
    expect(FakePeer.instances[0].close).not.toHaveBeenCalled();
  });

  it("retries the first failed offer send after two seconds without any metadata wakeup", async () => {
    const { socket } = start(true);
    socket.descriptionSendFailures = 1;
    await settle();
    expect(descriptions(socket, "offer")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(descriptions(socket, "offer")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(descriptions(socket, "offer")).toHaveLength(1);
    expect(descriptions(socket, "offer")[0]).toMatchObject({ epoch: 1, payload: { description: { sdp: "offer-1" } } });
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakePeer.instances[0].close).not.toHaveBeenCalled();
  });

  it("retries an admitted restart handshake that never receives negotiate after its deadline and backoff", async () => {
    start(true);
    await settle();
    const peer = FakePeer.instances[0];
    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
    const replacement = FakeSocket.instances[1];
    replacement.open();
    replacement.receive({
      type: "welcome", epoch: 2, slotId: "local", peerSessionId: "local-2", resumeToken: "next-token",
      resumed: true, isInitiator: true, offererSlotId: "local", peerCount: 2,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);
    const retried = FakeSocket.instances[2];
    retried.open();
    expect(retried.messages).toContainEqual(expect.objectContaining({ type: "hello", mode: "restart-peer" }));
    expect(FakePeer.instances).toHaveLength(1);
  });

  it("does not reuse a completed negotiation deadline during a transient disconnect", async () => {
    const { socket } = start(true);
    await settle();
    signal(socket, { description: { type: "answer", sdp: "answer" } });
    await settle();
    const peer = FakePeer.instances[0];
    peer.connectionState = "connected";
    for (const channel of peer.channels) { channel.readyState = "open"; channel.onopen?.(); }
    await vi.advanceTimersByTimeAsync(31_000);
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    socket.receive({ type: "peer-reconnected", epoch: 2, slotId: "remote", peerSessionId: "remote-1" });
    await settle();
    expect(peer.close).not.toHaveBeenCalled();
    peer.connectionState = "connected";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("recovers an overdue half-created PC after a solo signaling welcome and same-session peer return", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const blocked = deferred<RTCSessionDescriptionInit>();
    FakePeer.onCreate = (peer) => { if (peer.number === 1) peer.createOffer.mockReturnValueOnce(blocked.promise); };
    const { socket } = start(true);
    await settle();
    socket.close();
    await vi.advanceTimersByTimeAsync(250);
    const resumed = FakeSocket.instances[1];
    resumed.open();
    resumed.receive({
      type: "welcome", epoch: 2, slotId: "local", peerSessionId: "local-1", resumeToken: "resumed-token",
      resumed: true, isInitiator: true, offererSlotId: "local", peerCount: 1,
    });
    blocked.resolve({ type: "offer", sdp: "late-offer" });
    await settle();
    await vi.advanceTimersByTimeAsync(31_000);
    resumed.receive({ type: "peer-reconnected", epoch: 2, slotId: "remote", peerSessionId: "remote-1" });
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(FakePeer.instances[0].close).toHaveBeenCalled();
    const retry = FakeSocket.instances[2];
    retry.open();
    expect(retry.messages).toContainEqual(expect.objectContaining({ type: "hello", mode: "restart-peer" }));
  });

  it("preserves a healthy transport when the same participant loses and resumes signaling", async () => {
    const { socket } = start(true);
    await settle();
    const peer = FakePeer.instances[0];
    signal(socket, { description: { type: "answer", sdp: "remote-answer" } });
    await settle();
    peer.connectionState = "connected";
    expect(peer.channels).toHaveLength(4);
    for (const channel of peer.channels) {
      channel.readyState = "open";
      channel.onopen?.();
    }
    peer.onconnectionstatechange?.();
    const offerCount = descriptions(socket, "offer").length;
    socket.receive({ type: "peer-disconnected", epoch: 2, slotId: "remote", peerSessionId: "remote-1" });
    socket.receive({ type: "peer-reconnected", epoch: 2, slotId: "remote", peerSessionId: "remote-1" });
    await settle();
    expect(FakePeer.instances).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
    expect(descriptions(socket, "offer")).toHaveLength(offerCount);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("retransmits the fixed offer and ignores an already-applied duplicate answer", async () => {
    const { socket } = start(true);
    await settle();
    const first = descriptions(socket, "offer")[0];
    expect(first).toBeDefined();
    const peer = FakePeer.instances[0];
    peer.localDescription = { type: "offer", sdp: "changed-after-ice-gathering" };
    await vi.advanceTimersByTimeAsync(2_000);
    const offers = descriptions(socket, "offer");
    expect(offers.length).toBeGreaterThan(1);
    expect(offers.every((offer) => offer.payload?.description?.sdp === first.payload?.description?.sdp)).toBe(true);
    const answer = { description: { type: "answer" as const, sdp: "remote-answer" } };
    signal(socket, answer);
    await settle();
    signal(socket, answer);
    await settle();
    expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(peer.close).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("resends one cached answer when an offer is duplicated before and after answering", async () => {
    const { socket } = start();
    const offer = { description: { type: "offer" as const, sdp: "same-offer" } };
    const blocked = deferred<RTCSessionDescriptionInit>();
    FakePeer.onCreate = (peer) => { peer.createAnswer.mockReturnValueOnce(blocked.promise); };
    signal(socket, offer);
    const peer = FakePeer.instances[0];
    await settle();
    signal(socket, offer);
    blocked.resolve({ type: "answer", sdp: "cached-answer" });
    await settle();
    const before = descriptions(socket, "answer").length;
    signal(socket, offer);
    await settle();
    expect(descriptions(socket, "answer")).toHaveLength(before + 1);
    expect(descriptions(socket, "answer").every((message) => message.payload?.description?.sdp === "cached-answer")).toBe(true);
    expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(peer.createAnswer).toHaveBeenCalledTimes(1);
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("buffers early candidates, deduplicates them and survives a rejected candidate", async () => {
    const { socket } = start();
    const early = { candidate: { candidate: "candidate:early", sdpMid: "0", usernameFragment: "remote" } };
    signal(socket, early);
    signal(socket, early);
    signal(socket, { description: { type: "offer", sdp: "v=0\r\na=ice-ufrag:remote\r\n" } });
    const peer = FakePeer.instances[0];
    peer.addIceCandidate.mockImplementation(async (candidate) => {
      if (candidate.candidate === "candidate:bad") throw new Error("stale ICE candidate");
    });
    await settle();
    signal(socket, { candidate: { candidate: "candidate:bad" } });
    signal(socket, { candidate: { candidate: "candidate:good" } });
    await settle();
    expect(peer.addIceCandidate.mock.calls.filter(([candidate]) => candidate.candidate === "candidate:early")).toHaveLength(1);
    expect(peer.addIceCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidate: "candidate:good" }));
    expect(descriptions(socket, "answer")).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("discards old session candidates and ICE ufrags that only prefix-match the current credentials", async () => {
    const { socket } = start();
    negotiate(socket, 2, "remote-2");
    signal(socket, { candidate: { candidate: "candidate:old-session" } }, 2, "remote-1");
    signal(socket, { description: { type: "offer", sdp: "v=0\r\na=ice-ufrag:current-longer\r\n" } }, 2, "remote-2");
    await settle();
    const peer = FakePeer.instances[0];
    signal(socket, { candidate: { candidate: "candidate:prefix", usernameFragment: "current" } }, 2, "remote-2");
    signal(socket, { candidate: { candidate: "candidate:current", usernameFragment: "current-longer" } }, 2, "remote-2");
    await settle();
    expect(peer.addIceCandidate.mock.calls.map(([candidate]) => candidate.candidate)).toEqual(["candidate:current"]);
  });

  it("ignores queued callbacks from old channels and peers after ownership changes", async () => {
    const { socket } = start(true);
    await settle();
    const oldPeer = FakePeer.instances[0];
    const oldClose = oldPeer.channels[0].onclose;
    const oldError = oldPeer.channels[0].onerror;
    const oldStateChange = oldPeer.onconnectionstatechange;
    const oldDataChannel = oldPeer.ondatachannel;
    negotiate(socket, 2, "remote-2", true);
    await settle();
    oldPeer.connectionState = "failed";
    oldClose?.();
    oldError?.();
    oldStateChange?.();
    oldDataChannel?.({ channel: new FakeChannel("control") as unknown as RTCDataChannel });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakePeer.instances).toHaveLength(2);
    expect(FakePeer.instances[1].close).not.toHaveBeenCalled();
  });

  it("can recover again when SDP fails in the first replacement session", async () => {
    const { socket } = start();
    FakePeer.onCreate = (peer) => {
      if (peer.number <= 2) peer.setRemoteDescription.mockRejectedValueOnce(new Error("invalid SDP"));
    };
    signal(socket, { description: { type: "offer", sdp: "first-offer" } });
    await settle();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(FakeSocket.instances).toHaveLength(2);
    const replacement = acceptRestart(2, "local-2");
    signal(replacement, { description: { type: "offer", sdp: "replacement-offer" } }, 2);
    await settle();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(FakeSocket.instances).toHaveLength(3);
    const recovered = acceptRestart(3, "local-3");
    signal(recovered, { description: { type: "offer", sdp: "final-offer" } }, 3);
    await settle();
    expect(descriptions(recovered, "answer")).toHaveLength(1);
  });

  it.each(["suspend", "close"] as const)("does not send stale SDP or restart after %s during an RTC await", async (method) => {
    const { session, socket } = start();
    const blocked = deferred<RTCSessionDescriptionInit>();
    FakePeer.onCreate = (peer) => { peer.createAnswer.mockReturnValueOnce(blocked.promise); };
    signal(socket, { description: { type: "offer", sdp: "offer" } });
    const peer = FakePeer.instances[0];
    await settle();
    session[method]();
    blocked.resolve({ type: "answer", sdp: "stale-answer" });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(descriptions(socket, "answer")).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(peer.close).toHaveBeenCalled();
  });
});
