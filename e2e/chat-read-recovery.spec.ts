import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { RiCheckDoubleLine, RiCheckLine } from "@remixicon/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Transport = "direct" | "relay";

type ReadReceiptProbe = {
  channels: Array<{ peer: RTCPeerConnection; channel: RTCDataChannel }>;
  dropNextRead: boolean;
  droppedReadIds: string[];
  receivedReadIds: string[];
};

declare global { interface Window { __chatReadRecovery: ReadReceiptProbe } }

const channelLabels = ["bulk", "collaboration", "control", "interactive"];
const productionTurnEndpoint = "https://zestsend.1736995.workers.dev/api/turn/credentials";
const useRealTurn = process.env.ZESTSEND_E2E_REAL_TURN === "1";
const singleCheckPath = renderToStaticMarkup(createElement(RiCheckLine)).match(/<path d="([^"]+)"/)?.[1];
const doubleCheckPath = renderToStaticMarkup(createElement(RiCheckDoubleLine)).match(/<path d="([^"]+)"/)?.[1];

if (useRealTurn) test.use({ trace: "off", video: "off", screenshot: "off" });

async function installProbe(page: Page, transport: Transport) {
  await page.route(/\/api\/turn\/credentials$/, async (route) => {
    if (transport === "direct") {
      await route.fulfill({ status: 503, json: { error: "TURN credentials are not configured." } });
      return;
    }
    // Keep production credentials in memory. The app and signaling still run on the local test server.
    let response: Response;
    try {
      response = await fetch(productionTurnEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 300 }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      await route.fulfill({ status: 502, json: { error: "Production TURN credentials request failed." } });
      return;
    }
    expect(response.status, "Production TURN credentials endpoint").toBe(200);
    await route.fulfill({ status: 200, contentType: "application/json", body: await response.text() });
  });

  await page.addInitScript((mode) => {
    const probe: ReadReceiptProbe = { channels: [], dropNextRead: false, droppedReadIds: [], receivedReadIds: [] };
    window.__chatReadRecovery = probe;

    const readId = (data: unknown): string | undefined => {
      if (typeof data !== "string") return;
      try {
        const message = JSON.parse(data);
        if (message.type === "chat-read" && typeof message.id === "string") return message.id;
      } catch { /* Other channel traffic need not be JSON. */ }
    };

    const observeChannel = (peer: RTCPeerConnection, channel: RTCDataChannel) => {
      probe.channels.push({ peer, channel });
      if (channel.label !== "control") return;
      channel.addEventListener("message", ({ data }) => {
        const id = readId(data);
        if (id) probe.receivedReadIds.push(id);
      });
      const send = channel.send.bind(channel) as (data: unknown) => void;
      Object.defineProperty(channel, "send", { value(data: unknown) {
        const id = readId(data);
        if (id && probe.dropNextRead) {
          probe.dropNextRead = false;
          probe.droppedReadIds.push(id);
          return;
        }
        send(data);
      } });
    };

    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, [configuration], newTarget) {
        const settings: RTCConfiguration = mode === "direct"
          ? { ...configuration, iceServers: [], iceTransportPolicy: "all" }
          : { ...configuration, iceTransportPolicy: "relay" };
        const peer = Reflect.construct(target, [settings], newTarget) as RTCPeerConnection;
        const createDataChannel = peer.createDataChannel.bind(peer);
        peer.createDataChannel = (...args) => {
          const channel = createDataChannel(...args);
          observeChannel(peer, channel);
          return channel;
        };
        peer.addEventListener("datachannel", ({ channel }) => observeChannel(peer, channel));
        return peer;
      },
    });
  }, transport);
}

async function activeTransport(page: Page) {
  return page.evaluate(async () => {
    const openChannels = window.__chatReadRecovery.channels.filter(({ peer, channel }) =>
      peer.connectionState === "connected" && channel.readyState === "open" && channel.label !== "probe"
    );
    const peer = openChannels.find(({ channel }) => channel.label === "control")?.peer;
    if (!peer) return null;
    const stats = await peer.getStats();
    const transport = [...stats.values()].find((report) => report.type === "transport" && report.selectedCandidatePairId);
    const pair = transport ? stats.get(transport.selectedCandidatePairId) : undefined;
    if (!pair) return null;

    return {
      channels: openChannels.filter((entry) => entry.peer === peer).map(({ channel }) => channel.label).sort(),
      local: stats.get(pair.localCandidateId)?.candidateType ?? null,
      remote: stats.get(pair.remoteCandidateId)?.candidateType ?? null,
    };
  });
}

async function expectConnected(page: Page, transport: Transport) {
  const candidate = transport === "direct" ? "host" : "relay";
  await expect.poll(() => activeTransport(page), { timeout: 45_000 })
    .toEqual({ channels: channelLabels, local: candidate, remote: candidate });
}

function message(page: Page, text: string) {
  return page.locator("[data-chat-entry-id]").filter({ has: page.getByText(text, { exact: true }) });
}

async function expectCheck(page: Page, text: string, status: "received" | "read") {
  const iconPath = status === "received" ? singleCheckPath : doubleCheckPath;
  expect(iconPath, "Remix Icon checkmark path").toBeTruthy();
  await expect(message(page, text).locator(`svg path[d="${iconPath}"]`)).toHaveCount(1);
}

async function send(page: Page, text: string) {
  await page.bringToFront();
  const composer = page.getByRole("textbox", { name: "Write a message", exact: true });
  await expect(composer).toBeEditable();
  await composer.fill(text);
  await composer.press("Enter");
}

async function expectNormalRead(sender: Page, reader: Page, text: string) {
  await send(sender, text);
  await reader.bringToFront();
  await expect(message(reader, text)).toBeVisible();
  await expectCheck(sender, text, "read");
}

async function expectReadAfterRefresh(sender: Page, reader: Page, text: string, transport: Transport) {
  await reader.evaluate(() => { window.__chatReadRecovery.dropNextRead = true; });
  await send(sender, text);
  await reader.bringToFront();
  const incoming = message(reader, text);
  await expect(incoming).toBeVisible();
  const messageId = await incoming.getAttribute("data-chat-entry-id");
  expect(messageId).toBeTruthy();
  await expect.poll(() => reader.evaluate(() => window.__chatReadRecovery.droppedReadIds)).toEqual([messageId]);
  await expectCheck(sender, text, "received");
  expect(await sender.evaluate(() => window.__chatReadRecovery.receivedReadIds)).not.toContain(messageId);

  await reader.reload();
  await reader.bringToFront();
  await Promise.all([expectConnected(sender, transport), expectConnected(reader, transport)]);
  await expect.poll(() => sender.evaluate(() => window.__chatReadRecovery.receivedReadIds)).toContain(messageId);
  await expectCheck(sender, text, "read");
}

for (const transport of ["direct", "relay"] as const) {
  test.describe(`chat read receipts over ${transport}`, () => {
    test.skip(transport === "relay" && !useRealTurn, "Opt in to using the production TURN service.");

    test("recovers a lost read receipt after the reader reloads", async ({ browser, baseURL }, info) => {
      expect(baseURL, "The application must run on a local test server.").toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/);
      const [aliceContext, bobContext] = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
      try {
        const [alice, bob] = await Promise.all([aliceContext.newPage(), bobContext.newPage()]);
        await Promise.all([installProbe(alice, transport), installProbe(bob, transport)]);
        const room = `/en/room/${randomInt(1000, 10000)}#chat`;
        await bob.goto(room);
        await alice.goto(room);
        await Promise.all([expectConnected(alice, transport), expectConnected(bob, transport)]);
        await expectNormalRead(alice, bob, "Alice read receipt before reload");
        await expectNormalRead(bob, alice, "Bob read receipt before reload");

        await expectReadAfterRefresh(alice, bob, "Alice receipt lost before Bob reloads", transport);
        await expectReadAfterRefresh(bob, alice, "Bob receipt lost before Alice reloads", transport);
        await expectNormalRead(alice, bob, "Alice read receipt after reload");
        await expectNormalRead(bob, alice, "Bob read receipt after reload");
        await info.attach("selected-ice-path", {
          contentType: "application/json",
          body: JSON.stringify(await Promise.all([activeTransport(alice), activeTransport(bob)])),
        });
      } finally {
        await Promise.allSettled([aliceContext.close(), bobContext.close()]);
      }
    });
  });
}
