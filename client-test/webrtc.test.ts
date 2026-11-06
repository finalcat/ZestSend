import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeWebRTCSession } from "../src/client/lib/webrtc";

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
  send() {}
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
  const session = new NativeWebRTCSession("room", vi.fn(), vi.fn(), onError, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
  sessions.push(session);
  session.connect();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  socket.receive({
    type: "welcome", epoch: 1, slotId: "local", peerSessionId: "local-1", resumeToken: "token",
    isInitiator: initiator, offererSlotId: initiator ? "local" : "remote", peerCount: 2,
  });
  negotiate(socket, 1, "remote-1", initiator);
  return { session, socket, onError };
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
