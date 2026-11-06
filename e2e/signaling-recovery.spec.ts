import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";

const protocolDiagnostics = new WeakMap<Page, Array<Record<string, unknown>>>();

async function installPeerProbe(page: Page, delayAnswers = false) {
  await page.addInitScript(({ delayAnswers }) => {
    const nativeConstructor = window.RTCPeerConnection;
    const probe = { releaseAnswer: () => {}, peers: [] as RTCPeerConnection[], channels: [] as Array<{ peer: RTCPeerConnection; channel: RTCDataChannel }> };
    const log: Array<Record<string, unknown>> = [];
    Object.defineProperty(window, "__pclog", { value: log });
    let nextChannelId = 0;
    let releaseAnswer: () => void = () => undefined;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    probe.releaseAnswer = releaseAnswer;
    Object.defineProperty(window, "__zestsendPeerProbe", { configurable: false, value: probe });
    const signalingSockets: WebSocket[] = [];
    Object.defineProperty(window, "__zestsendSignalingSockets", { configurable: false, value: signalingSockets });
    const nativeWebSocket = window.WebSocket;
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: new Proxy(nativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget) as WebSocket;
          if (String(args[0]).includes("/api/rooms/")) {
            signalingSockets.push(socket);
            let negotiations = 0;
            socket.addEventListener("message", ({ data }) => {
              try {
                if (JSON.parse(String(data)).type === "negotiate" && ++negotiations > 1) releaseAnswer();
              } catch { /* Heartbeats are not JSON. */ }
            });
          }
          return socket;
        },
      }),
    });
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: new Proxy(nativeConstructor, {
        construct(target, args, newTarget) {
          const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
          probe.peers.push(peer);
          const id = probe.peers.length;
          const record = (ev: string, extra: Record<string, unknown> = {}) => log.push({
            id, ev, t: Date.now(), elapsed: performance.now(), connectionState: peer.connectionState,
            signalingState: peer.signalingState, ...extra,
          });
          record("construct");
          for (const event of ["connectionstatechange", "signalingstatechange", "iceconnectionstatechange"]) {
            peer.addEventListener(event, () => record(event));
          }
          for (const method of ["createOffer", "createAnswer", "setLocalDescription", "setRemoteDescription", "addIceCandidate"] as const) {
            const original = peer[method] as (...args: unknown[]) => Promise<unknown>;
            Object.defineProperty(peer, method, { value: async (...args: unknown[]) => {
              const descriptionType = (args[0] as RTCSessionDescriptionInit | undefined)?.type;
              record(`${method}:start`, { descriptionType });
              try {
                if (delayAnswers && method === "createAnswer") await answerGate;
                const result = await original.apply(peer, args);
                record(`${method}:done`, { descriptionType });
                return result;
              } catch (error) {
                record(`${method}:failed`, { descriptionType, error: String(error) });
                throw error;
              }
            } });
          }
          const observeChannel = (channel: RTCDataChannel) => {
            probe.channels.push({ peer, channel });
            const channelId = ++nextChannelId;
            record("channel:construct", { channelId, label: channel.label });
            for (const event of ["open", "close", "error"]) channel.addEventListener(event, () => {
              record(`channel:${event}`, { channelId, label: channel.label, readyState: channel.readyState });
            });
          };
          const createChannel = peer.createDataChannel;
          peer.createDataChannel = (...channelArgs) => {
            const channel = createChannel.apply(peer, channelArgs);
            observeChannel(channel);
            return channel;
          };
          peer.addEventListener("datachannel", ({ channel }) => observeChannel(channel));
          const close = peer.close;
          peer.close = () => { record("close"); close.call(peer); };
          return peer;
        },
      }),
    });
  }, { delayAnswers });
}

async function peerCount(page: Page) {
  return page.evaluate(() => (window as unknown as Window & { __zestsendPeerProbe: { peers: RTCPeerConnection[] } })
    .__zestsendPeerProbe.peers.length);
}

async function expectFourChannels(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const probe = (window as unknown as { __zestsendPeerProbe: {
      peers: RTCPeerConnection[]; channels: Array<{ peer: RTCPeerConnection; channel: RTCDataChannel }>;
    } }).__zestsendPeerProbe;
    const peers = probe.peers.filter((peer) => peer.signalingState !== "closed"
      && probe.channels.some((entry) => entry.peer === peer && entry.channel.label !== "probe"));
    if (peers.length !== 1 || peers[0].connectionState !== "connected") return [];
    return probe.channels.filter(({ peer, channel }) => peer === peers[0] && channel.readyState === "open")
      .map(({ channel }) => channel.label).sort();
  }), { timeout: 30_000 }).toEqual(["bulk", "collaboration", "control", "interactive"]);
}

async function liveSenderKinds(page: Page) {
  return page.evaluate(() => {
    const peers = (window as unknown as Window & { __zestsendPeerProbe: { peers: RTCPeerConnection[] } })
      .__zestsendPeerProbe.peers;
    const kinds = peers.filter((peer) => peer.signalingState !== "closed")
      .flatMap((peer) => peer.getSenders().map((sender) => sender.track).filter((track): track is MediaStreamTrack => track !== null && track.readyState === "live"))
      .map((track) => track.kind);
    return { audio: kinds.includes("audio"), video: kinds.includes("video") };
  });
}

async function peerDiagnostics(page: Page) {
  return page.evaluate(() => (window as unknown as Window & { __zestsendPeerProbe: { peers: RTCPeerConnection[] } })
    .__zestsendPeerProbe.peers.map((peer, index) => ({
      id: index + 1,
      connectionState: peer.connectionState,
      signalingState: peer.signalingState,
      senders: peer.getSenders().map((sender) => sender.track ? `${sender.track.kind}:${sender.track.readyState}` : null).filter(Boolean),
      sctp: peer.sctp !== null,
    })));
}

async function forceIceFailure(page: Page, failAt = 0) {
  await page.evaluate(async (failAt) => {
    const peers = (window as unknown as Window & { __zestsendPeerProbe: { peers: RTCPeerConnection[] } })
      .__zestsendPeerProbe.peers;
    const connectedPeers = peers.filter((candidate) => candidate.sctp !== null
      && candidate.signalingState !== "closed"
      && candidate.connectionState === "connected");
    if (connectedPeers.length === 0) throw new Error("No connected peer connection was found to exercise ICE recovery.");
    if (failAt > Date.now()) await new Promise<void>((resolve) => setTimeout(resolve, failAt - Date.now()));
    for (const peer of connectedPeers) {
      Object.defineProperty(peer, "connectionState", { configurable: true, value: "failed" });
      peer.close();
      peer.dispatchEvent(new Event("connectionstatechange"));
    }
  }, failAt);
}

async function openChat(page: Page) {
  const composer = page.getByRole("textbox", { name: "Write a message" });
  if (await composer.isVisible().catch(() => false)) return composer;
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(composer).toBeVisible();
  return composer;
}

async function dumpTransportLogs(pages: { name: string; page: Page }[]) {
  const result: Record<string, unknown> = {};
  for (const { name, page } of pages) {
    result[name] = {
      page: await page.evaluate(() => (window as unknown as { __pagevlog?: unknown[] }).__pagevlog ?? null).catch(() => "page-gone"),
      pc: await page.evaluate(() => (window as unknown as { __pclog?: unknown[] }).__pclog ?? null).catch(() => "page-gone"),
      ws: await page.evaluate(() => (window as unknown as { __wslog?: unknown[] }).__wslog ?? null).catch(() => "page-gone"),
    };
  }
  return result;
}

async function saveTransportDiagnostics(
  pages: { name: string; page: Page }[],
  frames: Record<string, string[]> = {},
) {
  try {
    const info = test.info();
    const path = info.outputPath("transport-diagnostics.json");
    const peers = Object.fromEntries(await Promise.all(pages.map(async ({ name, page }) => [
      name, await peerDiagnostics(page).catch(() => "page-gone"),
    ])));
    await writeFile(path, `${JSON.stringify({ frames, peers, protocol: Object.fromEntries(pages.map(({ name, page }) => [name, protocolDiagnostics.get(page)])), ...await dumpTransportLogs(pages) }, null, 2)}\n`, "utf8");
    await info.attach("transport-diagnostics", { path, contentType: "application/json" });
  } catch {
    // Diagnostics must never mask the original failure.
  }
}

async function sendChat(page: Page, text: string) {
  const composer = await openChat(page);
  await composer.fill(text);
  await composer.press("Enter");
  // .first(): the same text may be sent more than once by resend-tolerant
  // helpers (e.g. the createPair barrier), which would trip strict mode.
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
}

type SignalingFault = {
  kind: "drop-offer" | "drop-answer" | "duplicate-negotiate";
  triggered: boolean;
  epoch?: number;
  descriptions: Array<{ type: string; epoch?: number }>;
};

async function installSignalingFault(page: Page, fault: SignalingFault) {
  await page.routeWebSocket(/\/api\/rooms\/\d{4}\/ws(?:\?.*)?$/, (client) => {
    const server = client.connectToServer();
    let negotiation: string | undefined;
    server.onMessage(async (raw) => {
      let message: { type?: string; epoch?: number; payload?: { description?: { type?: string } } };
      try { message = JSON.parse(String(raw)) as typeof message; }
      catch { client.send(raw); return; }
      if (message.type === "negotiate") negotiation = String(raw);
      const descriptionType = message.payload?.description?.type;
      if (message.type === "signal" && descriptionType) {
        fault.descriptions.push({ type: descriptionType, epoch: message.epoch });
        if (!fault.triggered && fault.kind === `drop-${descriptionType}`) {
          fault.triggered = true;
          fault.epoch = message.epoch;
          return;
        }
      }
      client.send(raw);
      if (!fault.triggered && fault.kind === "duplicate-negotiate" && descriptionType === "offer" && negotiation) {
        fault.triggered = true;
        fault.epoch = message.epoch;
        // The probe holds createAnswer until it receives repeated metadata, so
        // a real incoming offer is being answered when negotiate is replayed.
        await page.waitForFunction(() => (window as unknown as { __pclog: Array<{ ev: string }> })
          .__pclog.some((entry) => entry.ev === "createAnswer:start"), undefined, { polling: 50 });
        await page.evaluate((data) => {
          const state = window as unknown as {
            __zestsendSignalingSockets: WebSocket[];
            __zestsendPeerProbe: { peers: RTCPeerConnection[]; releaseAnswer(): void };
          };
          const socket = [...state.__zestsendSignalingSockets].reverse().find((entry) => entry.readyState === WebSocket.OPEN);
          if (!socket) throw new Error("No signaling socket for repeated negotiate.");
          const answering = state.__zestsendPeerProbe.peers.find((peer) => peer.signalingState === "have-remote-offer");
          if (!answering) throw new Error("No in-progress answer for repeated negotiate.");
          // Enter the application's real message handler synchronously before
          // releasing createAnswer; the routing shim need not replay listeners.
          socket.dispatchEvent(new MessageEvent("message", { data }));
          if (answering.connectionState === "closed") throw new Error("Repeated negotiate destroyed the answering peer.");
          state.__zestsendPeerProbe.releaseAnswer();
        }, negotiation);
        protocolDiagnostics.get(page)?.push({ direction: "injected", type: "negotiate", epoch: message.epoch, at: Date.now() });
      }
    });
  });
}

function observeFrames(page: Page, frames: string[]) {
  const diagnosticFrames: Array<Record<string, unknown>> = [];
  protocolDiagnostics.set(page, diagnosticFrames);
  let socketId = 0;
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/rooms/")) return;
    const id = ++socketId;
    const record = (direction: string, payload: string | Buffer) => {
      if (typeof payload !== "string" || !payload.startsWith("{")) return;
      try {
        const message = JSON.parse(payload) as { code?: string; epoch?: number; mode?: string; payload?: { description?: { type?: string } }; type?: string };
        const meta = JSON.parse(payload) as Record<string, unknown>;
        diagnosticFrames.push({ socketId: id, direction, at: Date.now(), type: message.type, epoch: message.epoch,
          mode: message.mode, slotId: meta.slotId, fromSlotId: meta.fromSlotId,
          peerSessionId: meta.peerSessionId, offererSlotId: meta.offererSlotId,
          descriptionType: message.payload?.description?.type });
        if (message.type === "hello") frames.push(`${direction}:hello:${message.mode}`);
        else if (message.type === "signal" && message.payload?.description) frames.push(`${direction}:signal:${message.payload.description.type}:epoch=${message.epoch}`);
        else if (message.type === "error") frames.push(`${direction}:error:${message.code ?? "unknown"}`);
        else if (message.type && !["pong", "signal"].includes(message.type)) frames.push(`${direction}:${message.type}:epoch=${message.epoch ?? ""}`);
      } catch {
        // Ignore non-protocol WebSocket payloads in this diagnostic stream.
      }
    };
    socket.on("framesent", ({ payload }) => record("sent", payload));
    socket.on("framereceived", ({ payload }) => record("received", payload));
  });
}

async function createRoomPeer(page: Page, roomId: string, interceptSignaling = true) {
  let blockNewSockets = false;
  let routeRegistered = false;
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as unknown as { __wslog: unknown[] }).__wslog = [];
    class LoggedWS extends OrigWS {
      constructor(...args: [string | URL, string | string[] | undefined]) {
        super(args[0] as string, args[1] as string[]);
        const url = String(args[0]);
        if (!url.includes("/api/rooms/")) return;
        const log = (window as unknown as { __wslog: { ev: string; t: number; url: string; code?: number; reason?: string }[] }).__wslog;
        log.push({ ev: "construct", t: Date.now(), url: url.slice(-24) });
        this.addEventListener("open", () => log.push({ ev: "open", t: Date.now(), url: url.slice(-24) }));
        this.addEventListener("close", (event) => log.push({ ev: "close", t: Date.now(), url: url.slice(-24), code: (event as CloseEvent).code, reason: (event as CloseEvent).reason }));
      }
    }
    window.WebSocket = LoggedWS;
    const pagevlog: { ev: string; t: number }[] = [];
    (window as unknown as { __pagevlog: { ev: string; t: number }[] }).__pagevlog = pagevlog;
    window.addEventListener("pagehide", (event) => pagevlog.push({ ev: `pagehide(persisted=${(event as PageTransitionEvent).persisted})`, t: Date.now() }));
    window.addEventListener("pageshow", (event) => pagevlog.push({ ev: `pageshow(persisted=${(event as PageTransitionEvent).persisted})`, t: Date.now() }));
    document.addEventListener("visibilitychange", () => pagevlog.push({ ev: `visibility=${document.visibilityState}`, t: Date.now() }));
  });
  const registerSignalingRoute = async () => {
    if (routeRegistered) return;
    await page.routeWebSocket(/\/api\/rooms\/\d{4}\/ws(?:\?.*)?$/, (client) => {
      if (blockNewSockets) {
        client.close({ code: 1001, reason: "Signaling is paused by the test." });
        return;
      }
      const server = client.connectToServer();
      client.onClose(() => server.close({ code: 1001, reason: "Signaling interruption under test." }));
      server.onClose(() => client.close({ code: 1001, reason: "Signaling interruption under test." }));
    });
    routeRegistered = true;
  };
  // Production acceptance must exercise the target Worker's real TURN binding.
  // The ordinary local suite retains its deterministic STUN-only setup.
  if (test.info().config.metadata.realTurn !== true) {
    await page.route("**/api/turn/credentials", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      json: { error: "TURN credentials are not configured." },
    }));
  }

  await page.goto(`/en/room/${roomId}`);

  return {
    async disconnectSignaling(page: Page) {
      blockNewSockets = true;
      if (interceptSignaling) await registerSignalingRoute();
      await page.evaluate(() => {
        const sockets = (window as unknown as Window & { __zestsendSignalingSockets: WebSocket[] }).__zestsendSignalingSockets;
        const current = [...sockets].reverse().find((socket) => socket.readyState === WebSocket.OPEN);
        if (!current) throw new Error("No open signaling WebSocket was found in the page.");
        current.close(4001, "Signaling interruption under test.");
      });
    },
    async reconnectSignaling() {
      blockNewSockets = false;
    },
  };
}

async function createPair(
  browser: Browser,
  roomId: string,
  options: { grantMediaPermissions?: boolean; interceptSignaling?: boolean; fault?: SignalingFault } = {},
) {
  const grantMediaPermissions = options.grantMediaPermissions ?? false;
  const interceptSignaling = options.interceptSignaling ?? true;
  const contextOptions = grantMediaPermissions ? { permissions: ["camera", "microphone"] } : {};
  const aliceContext = await browser.newContext(contextOptions);
  const bobContext = await browser.newContext(contextOptions);
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceFrames: string[] = [];
  const bobFrames: string[] = [];
  observeFrames(alice, aliceFrames);
  observeFrames(bob, bobFrames);
  try {
    await Promise.all([
      installPeerProbe(alice, options.fault?.kind === "duplicate-negotiate"),
      installPeerProbe(bob, options.fault?.kind === "duplicate-negotiate"),
    ]);
    if (options.fault) await Promise.all([
      installSignalingFault(alice, options.fault), installSignalingFault(bob, options.fault),
    ]);
    const bobSession = await createRoomPeer(bob, roomId, interceptSignaling);
    const aliceSession = await createRoomPeer(alice, roomId, interceptSignaling);
    await openChat(alice);
    await openChat(bob);
    await expect(alice.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
    await expect(bob.getByRole("textbox", { name: "Write a message" })).toBeEnabled();
    await expect.poll(() => peerCount(alice)).toBeGreaterThan(0);
    await expect.poll(() => peerCount(bob)).toBeGreaterThan(0);
    await Promise.all([expectFourChannels(alice), expectFourChannels(bob)]);
    const barrierId = `pair-ready-${roomId}-${Date.now()}`;
    for (const [sender, receiver, text] of [
      [alice, bob, `${barrierId}-alice`], [bob, alice, `${barrierId}-bob`],
    ] as const) {
      const received = receiver.getByText(text, { exact: true }).first();
      await expect(async () => {
        await sendChat(sender, text);
        await expect(received).toBeVisible({ timeout: 4_000 });
      }).toPass({ timeout: 45_000 });
    }
    return { alice, aliceContext, aliceFrames, aliceSession, bob, bobContext, bobFrames, bobSession };
  } catch (error) {
    await saveTransportDiagnostics([{ name: "alice", page: alice }, { name: "bob", page: bob }], { aliceFrames, bobFrames });
    await Promise.allSettled([aliceContext.close(), bobContext.close()]);
    throw error;
  }
}

test.describe("signaling-only interruptions", () => {
  for (const kind of ["drop-offer", "drop-answer", "duplicate-negotiate"] as const) {
    test(`connects bidirectionally through ${kind}`, async ({ browser }) => {
      const roomId = String(Math.floor(1000 + Math.random() * 9000));
      const fault: SignalingFault = { kind, triggered: false, descriptions: [] };
      const pair = await createPair(browser, roomId, { interceptSignaling: false, fault });
      try {
        expect(fault.triggered).toBe(true);
        expect([...pair.aliceFrames, ...pair.bobFrames]).not.toContain("sent:hello:restart-peer");
        if (kind !== "duplicate-negotiate") {
          const droppedType = kind === "drop-offer" ? "offer" : "answer";
          expect(fault.descriptions.filter(({ type, epoch }) => type === droppedType && epoch === fault.epoch).length)
            .toBeGreaterThanOrEqual(2);
        }
        for (const page of [pair.alice, pair.bob]) {
          await expect.poll(async () => (await peerDiagnostics(page)).filter((peer) => peer.signalingState !== "closed").length)
            .toBe(1);
        }
      } catch (error) {
        await saveTransportDiagnostics([
          { name: "alice", page: pair.alice }, { name: "bob", page: pair.bob },
        ], { aliceFrames: pair.aliceFrames, bobFrames: pair.bobFrames });
        throw error;
      } finally {
        await pair.aliceContext.close();
        await pair.bobContext.close();
      }
    });
  }

  for (const durationMs of [5_000, 20_000]) {
    test(`preserves chat and the peer connection through a ${durationMs / 1_000}s signaling interruption`, async ({ browser }) => {
      const roomId = String(Math.floor(1000 + Math.random() * 9000));
      let pair: Awaited<ReturnType<typeof createPair>> | undefined;
      try {
        pair = await createPair(browser, roomId);
        const alicePeerCount = await peerCount(pair.alice);
        const bobPeerCount = await peerCount(pair.bob);
        await pair.aliceSession.disconnectSignaling(pair.alice);
        await expect.poll(() => pair!.bobFrames.some((frame) => frame.startsWith("received:peer-disconnected:"))).toBe(true);
        await sendChat(pair.bob, `from-bob-${durationMs}`);
        await expect(pair.alice.getByText(`from-bob-${durationMs}`, { exact: true })).toBeVisible();
        await sendChat(pair.alice, `from-alice-${durationMs}`);
        await expect(pair.bob.getByText(`from-alice-${durationMs}`, { exact: true })).toBeVisible();
        await pair.alice.waitForTimeout(durationMs);
        await expect.poll(() => peerCount(pair!.alice)).toBe(alicePeerCount);
        await expect.poll(() => peerCount(pair!.bob)).toBe(bobPeerCount);
        await expect(pair.alice.getByRole("textbox", { name: "Write a message" })).toBeEnabled();

        await pair.aliceSession.reconnectSignaling();
        await expect(pair.alice.getByRole("status")).toHaveCount(0, { timeout: 20_000 });
        await sendChat(pair.alice, `after-recovery-${durationMs}`);
        await expect(pair.bob.getByText(`after-recovery-${durationMs}`, { exact: true })).toBeVisible();
        await expect.poll(() => peerCount(pair!.alice)).toBe(alicePeerCount);
      } catch (error) {
        if (pair) {
          await saveTransportDiagnostics([
            { name: "alice", page: pair.alice }, { name: "bob", page: pair.bob },
          ], { aliceFrames: pair.aliceFrames, bobFrames: pair.bobFrames });
        }
        throw error;
      } finally {
        await pair?.aliceContext.close();
        await pair?.bobContext.close();
      }
    });
  }

  test("resumes the signaling seat after a full page refresh", async ({ browser }) => {
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const pair = await createPair(browser, roomId, { interceptSignaling: false });
    try {
      await sendChat(pair.bob, "chat-before-refresh");
      await expect(pair.alice.getByText("chat-before-refresh", { exact: true })).toBeVisible();
      const resumeKey = `zestsend:room:${encodeURIComponent(roomId)}:resume`;
      const tokenBeforeReload = await pair.alice.evaluate((key) => sessionStorage.getItem(key), resumeKey);
      expect(tokenBeforeReload).not.toBeNull();
      await pair.alice.reload();
      await openChat(pair.alice);
      await expect(pair.alice.getByRole("textbox", { name: "Write a message" })).toBeEnabled({ timeout: 30_000 });
      await expect.poll(() => pair.aliceFrames.includes("sent:hello:resume-signaling")).toBe(true);
      await expect.poll(() => peerCount(pair.alice), { timeout: 30_000 }).toBeGreaterThan(0);
      await Promise.all([expectFourChannels(pair.alice), expectFourChannels(pair.bob)]);
      await sendChat(pair.bob, "chat-after-refresh");
      await expect(pair.alice.getByText("chat-after-refresh", { exact: true })).toBeVisible();
      await sendChat(pair.alice, "reply-after-refresh");
      await expect(pair.bob.getByText("reply-after-refresh", { exact: true })).toBeVisible();
    } catch (error) {
      await saveTransportDiagnostics([
        { name: "alice", page: pair.alice }, { name: "bob", page: pair.bob },
      ], { aliceFrames: pair.aliceFrames, bobFrames: pair.bobFrames });
      throw error;
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });

  test("enters chat while alone and syncs queued messages when a peer joins", async ({ browser }) => {
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    try {
      await createRoomPeer(alice, roomId, false);
      // Solo entry: the workspace opens straight into chat and the composer
      // is usable with no peer in the room.
      const composer = alice.getByRole("textbox", { name: "Write a message" });
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await expect(composer).toBeEnabled({ timeout: 20_000 });
      await composer.fill("queued-while-alone");
      await composer.press("Enter");
      await expect(alice.getByText("queued-while-alone", { exact: true })).toBeVisible();

      await createRoomPeer(bob, roomId, false);
      // The queued message syncs as soon as the peer transport opens.
      await expect(bob.getByText("queued-while-alone", { exact: true })).toBeVisible({ timeout: 30_000 });

      // Live chat continues bidirectionally.
      await sendChat(bob, "hello-after-join");
      await expect(alice.getByText("hello-after-join", { exact: true })).toBeVisible();
    } finally {
      await aliceContext.close();
      await bobContext.close();
    }
  });

  test("admits only two participants in the browser room", async ({ browser }) => {
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const thirdContext = await browser.newContext();
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const third = await thirdContext.newPage();
    const firstFrames: string[] = [];
    const secondFrames: string[] = [];
    const thirdFrames: string[] = [];
    observeFrames(first, firstFrames);
    observeFrames(second, secondFrames);
    observeFrames(third, thirdFrames);
    try {
      await createRoomPeer(first, roomId, false);
      await expect.poll(() => firstFrames.some((frame) => frame.startsWith("received:welcome:"))).toBe(true);
      await createRoomPeer(second, roomId, false);
      await expect.poll(() => secondFrames.some((frame) => frame.startsWith("received:welcome:"))).toBe(true);
      await createRoomPeer(third, roomId, false);
      try {
        await expect.poll(() => thirdFrames.includes("received:error:room-full")).toBe(true);
      } catch (error) {
        console.log("full room diagnostics", JSON.stringify({ roomId, firstFrames, secondFrames, thirdFrames }));
        throw error;
      }
      await expect(third.getByText("Room is full", { exact: true })).toBeVisible({ timeout: 20_000 });
    } finally {
      await thirdContext.close();
      await secondContext.close();
      await firstContext.close();
    }
  });

  test("restarts the peer after ICE failure and reconnects chat", async ({ browser }) => {
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const pair = await createPair(browser, roomId, { interceptSignaling: false });
    try {
      await sendChat(pair.alice, "chat-before-ice-failure");
      await expect(pair.bob.getByText("chat-before-ice-failure", { exact: true })).toBeVisible();
      const peersBeforeFailure = await peerCount(pair.alice);
      const aliceFrameCursor = pair.aliceFrames.length;
      const bobFrameCursor = pair.bobFrames.length;
      await forceIceFailure(pair.alice);
      try {
        await expect.poll(() => peerCount(pair.alice), { timeout: 30_000 }).toBeGreaterThan(peersBeforeFailure);
      } catch (error) {
        await saveTransportDiagnostics([
          { name: "alice", page: pair.alice }, { name: "bob", page: pair.bob },
        ], { aliceFrames: pair.aliceFrames, bobFrames: pair.bobFrames });
        throw error;
      }
      await expect.poll(
        () => (pair.aliceFrames.slice(aliceFrameCursor).includes("sent:hello:restart-peer")
          || pair.bobFrames.slice(bobFrameCursor).includes("sent:hello:restart-peer"))
          && [...pair.aliceFrames.slice(aliceFrameCursor), ...pair.bobFrames.slice(bobFrameCursor)]
            .some((frame) => frame.startsWith("sent:signal:offer:")),
        { timeout: 30_000 },
      ).toBe(true);
      await Promise.all([expectFourChannels(pair.alice), expectFourChannels(pair.bob)]);
      await sendChat(pair.alice, "chat-after-ice-restart");
      await expect(pair.bob.getByText("chat-after-ice-restart", { exact: true })).toBeVisible();
      await sendChat(pair.bob, "reply-after-ice-restart");
      await expect(pair.alice.getByText("reply-after-ice-restart", { exact: true })).toBeVisible();
    } catch (error) {
      await saveTransportDiagnostics([{ name: "alice", page: pair.alice }, { name: "bob", page: pair.bob }],
        { aliceFrames: pair.aliceFrames, bobFrames: pair.bobFrames });
      throw error;
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });

  test("converges after simultaneous peer failures without a restart storm", async ({ browser }) => {
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const pair = await createPair(browser, roomId, { interceptSignaling: false });
    const aliceCursor = pair.aliceFrames.length;
    const bobCursor = pair.bobFrames.length;
    try {
      const failAt = Date.now() + 500;
      await Promise.all([forceIceFailure(pair.alice, failAt), forceIceFailure(pair.bob, failAt)]);
      await Promise.all([expectFourChannels(pair.alice), expectFourChannels(pair.bob)]);
      await sendChat(pair.alice, "alice-after-simultaneous-failure");
      await expect(pair.bob.getByText("alice-after-simultaneous-failure", { exact: true })).toBeVisible();
      await sendChat(pair.bob, "bob-after-simultaneous-failure");
      await expect(pair.alice.getByText("bob-after-simultaneous-failure", { exact: true })).toBeVisible();
      const restarts = [...pair.aliceFrames.slice(aliceCursor), ...pair.bobFrames.slice(bobCursor)]
        .filter((frame) => frame === "sent:hello:restart-peer");
      expect(restarts.length).toBeGreaterThan(0);
      expect(restarts.length).toBeLessThanOrEqual(2);
    } catch (error) {
      await saveTransportDiagnostics([{ name: "alice", page: pair.alice }, { name: "bob", page: pair.bob }],
        { aliceFrames: pair.aliceFrames, bobFrames: pair.bobFrames });
      throw error;
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });

  test("keeps collaboration and voice active through a signaling outage", async ({ browser }) => {
    test.setTimeout(240_000);
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const pair = await createPair(browser, roomId, { grantMediaPermissions: true });
    try {
      await pair.alice.getByRole("button", { name: "Collaborate" }).click();
      await pair.bob.getByRole("button", { name: "Collaborate" }).click();
      const aliceEditor = pair.alice.locator('.zest-collaboration-editor[contenteditable="true"]');
      const bobEditor = pair.bob.locator('.zest-collaboration-editor[contenteditable="true"]');
      await expect(aliceEditor).toBeVisible();
      await expect(bobEditor).toBeVisible();
      await aliceEditor.fill("Collaboration survives signaling loss");
      await expect(bobEditor).toContainText("Collaboration survives signaling loss");

      await pair.alice.getByRole("button", { name: "Voice" }).click();
      await pair.alice.getByRole("button", { name: "Turn microphone on" }).click();
      await expect.poll(async () => (await liveSenderKinds(pair.alice)).audio).toBe(true);
      await pair.alice.getByRole("button", { name: "Video" }).click();
      await pair.alice.getByRole("button", { name: "Turn camera on" }).click();
      await expect.poll(async () => (await liveSenderKinds(pair.alice)).video).toBe(true);

      const alicePeerCount = await peerCount(pair.alice);
      await pair.aliceSession.disconnectSignaling(pair.alice);
      await expect(pair.alice.getByRole("status")).toContainText("Signaling is reconnecting");
      await expect.poll(async () => (await liveSenderKinds(pair.alice)).audio).toBe(true);
      await pair.alice.getByRole("button", { name: "Collaborate" }).click();
      await aliceEditor.fill("Shared edits continue while offline");
      await expect(bobEditor).toContainText("Shared edits continue while offline");
      await pair.alice.bringToFront();
      await expect.poll(async () => (await liveSenderKinds(pair.alice)).audio).toBe(true);
      await sendChat(pair.bob, "chat-during-collaboration-outage");
      await openChat(pair.alice);
      await expect(pair.alice.getByText("chat-during-collaboration-outage", { exact: true })).toBeVisible();
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);

      await pair.aliceSession.reconnectSignaling();
      await pair.alice.bringToFront();
      await expect(pair.alice.getByRole("status")).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);
      await expect.poll(async () => (await liveSenderKinds(pair.alice)).audio).toBe(true);
      await sendChat(pair.alice, "chat-after-collaboration-recovery");
      await expect(pair.bob.getByText("chat-after-collaboration-recovery", { exact: true })).toBeVisible();
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });

  test("keeps a large file transfer intact across signaling reconnection", async ({ browser }) => {
    test.setTimeout(180_000);
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const pair = await createPair(browser, roomId);
    try {
      const payload = Buffer.alloc(32 * 1024 * 1024, 0x5a);
      const expectedDigest = createHash("sha256").update(payload).digest("hex");
      await pair.alice.getByRole("button", { name: "Files" }).click();
      await pair.alice.locator('input[type="file"]:not([accept])').setInputFiles({
        name: "signaling-resume-integrity.bin",
        mimeType: "application/octet-stream",
        buffer: payload,
      });
      await pair.bob.getByRole("button", { name: "Files" }).click();
      await expect(pair.bob.getByRole("button", { name: "Receive" })).toBeVisible({ timeout: 20_000 });
      const downloadPromise = pair.bob.waitForEvent("download");
      await pair.bob.getByRole("button", { name: "Receive" }).click();
      await expect(pair.alice.getByText("Sending", { exact: true })).toBeVisible();

      const alicePeerCount = await peerCount(pair.alice);
      const offersBeforeReconnect = pair.aliceFrames.filter((frame) => frame.startsWith("sent:signal:offer:")).length;
      await pair.aliceSession.disconnectSignaling(pair.alice);
      await expect(pair.alice.getByRole("status")).toContainText("Signaling is reconnecting");
      await pair.alice.waitForTimeout(1_000);
      await pair.aliceSession.reconnectSignaling();
      const download = await downloadPromise;
      await expect(pair.bob.getByText("Transfer complete", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => pair.aliceFrames.includes("sent:hello:resume-signaling"), { timeout: 20_000 }).toBe(true);
      await expect(pair.alice.getByRole("status")).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);
      expect(pair.aliceFrames.filter((frame) => frame.startsWith("sent:signal:offer:")).length).toBe(offersBeforeReconnect);
      expect(download.suggestedFilename()).toBe("signaling-resume-integrity.bin");
      const downloadedPath = await download.path();
      if (!downloadedPath) throw new Error("The browser did not retain the completed download.");
      const downloadedDigest = createHash("sha256").update(await readFile(downloadedPath)).digest("hex");
      expect(downloadedDigest).toBe(expectedDigest);

      await sendChat(pair.alice, "chat-after-file-transfer-recovery");
      await openChat(pair.bob);
      await expect(pair.bob.getByText("chat-after-file-transfer-recovery", { exact: true })).toBeVisible();
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });

  test("preserves a large file transfer and the existing peer after the seat lease expires", async ({ browser }) => {
    test.setTimeout(240_000);
    const roomId = String(Math.floor(1000 + Math.random() * 9000));
    const pair = await createPair(browser, roomId);
    try {
      await pair.alice.getByRole("button", { name: "Files" }).click();
      await pair.alice.locator('input[type="file"]:not([accept])').setInputFiles({
        name: "lease-interruption.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(32 * 1024 * 1024, 0x5a),
      });
      await pair.bob.getByRole("button", { name: "Files" }).click();
      await expect(pair.bob.getByRole("button", { name: "Receive" })).toBeVisible({ timeout: 20_000 });
      await pair.bob.getByRole("button", { name: "Receive" }).click();
      await expect(pair.alice.getByText("Sending", { exact: true })).toBeVisible();

      const alicePeerCount = await peerCount(pair.alice);
      await pair.aliceSession.disconnectSignaling(pair.alice);
      await pair.alice.getByRole("button", { name: "Chat" }).click();
      await expect(pair.alice.getByRole("status")).toContainText("Signaling is reconnecting");
      await expect(pair.bob.getByText("Transfer complete", { exact: true })).toBeVisible({ timeout: 60_000 });
      await pair.alice.waitForTimeout(36_000);
      await expect(pair.alice.getByRole("status")).toContainText("Verifying the room seat", { timeout: 10_000 });
      await expect.poll(() => peerCount(pair.alice)).toBe(alicePeerCount);
      await sendChat(pair.alice, "existing-peer-survived-seat-expiry");
      await openChat(pair.bob);
      await expect(pair.bob.getByText("existing-peer-survived-seat-expiry", { exact: true })).toBeVisible();
    } finally {
      await pair.aliceContext.close();
      await pair.bobContext.close();
    }
  });
});
