import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "redis";
import { randomUUID } from "crypto";
import { z } from "zod";
import { ClientMessageSchema, ChatMessage, ServerEvent } from "./types.js";

const PORT = Number(process.env.PORT || 3000);
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || "lobby";
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);
const HISTORY_SIZE = Number(process.env.HISTORY_SIZE || 50);
const HISTORY_TTL_SECONDS = Number(
  process.env.HISTORY_TTL_SECONDS || 60 * 60 * 24 * 7
);

const app = express();
const server = app.listen(PORT, () => {
  console.log(`HTTP/WebSocket server on :${PORT}`);
});

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- Redis setup: separate connections for pub and sub
const pub = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
const sub = pub.duplicate();

await pub.connect();
await sub.connect();

const CHANNEL_PREFIX = "chat:";
const HISTORY_PREFIX = "history:";
const RATE_PREFIX = "rate:";

const wss = new WebSocketServer({ server });

type ClientInfo = { ws: WebSocket; rooms: Set<string>; ip: string };
const clients = new WeakMap<WebSocket, ClientInfo>();

function channelFor(room: string) {
  return `${CHANNEL_PREFIX}${room}`;
}
function historyKey(room: string) {
  return `${HISTORY_PREFIX}${room}`;
}
function rateKey(ip: string) {
  const minuteBucket = Math.floor(Date.now() / 60000);
  return `${RATE_PREFIX}${ip}:${minuteBucket}`;
}

async function loadHistory(room: string): Promise<ChatMessage[]> {
  const raw = await pub.lRange(historyKey(room), 0, HISTORY_SIZE - 1);
  return raw.map((s) => JSON.parse(s) as ChatMessage).reverse();
}

async function pushHistory(room: string, msg: ChatMessage) {
  const key = historyKey(room);
  await pub.lPush(key, JSON.stringify(msg));
  await pub.lTrim(key, 0, HISTORY_SIZE - 1);
  await pub.expire(key, HISTORY_TTL_SECONDS);
}

// Broadcast messages from Redis to all connected sockets in room
await sub.pSubscribe(`${CHANNEL_PREFIX}*`, (message, ch) => {
  const room = ch.substring(CHANNEL_PREFIX.length);
  const parsed = JSON.parse(message) as ChatMessage;
  const payload: ServerEvent = { type: "broadcast", message: parsed };

  wss.clients.forEach((socket) => {
    const info = clients.get(socket);
    if (!info) return;
    if (info.rooms.has(room) && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  });
});

wss.on("connection", async (ws, req) => {
  const ip =
    (req.headers["x-forwarded-for"] as string) ??
    req.socket.remoteAddress ??
    "unknown";
  const info: ClientInfo = { ws, rooms: new Set([DEFAULT_ROOM]), ip };
  clients.set(ws, info);

  // Subscribe this socket's default room history
  const history = await loadHistory(DEFAULT_ROOM);
  ws.send(
    JSON.stringify({
      type: "history",
      room: DEFAULT_ROOM,
      messages: history,
    } satisfies ServerEvent)
  );

  ws.send(
    JSON.stringify({
      type: "system",
      text: `Connected. Joined room "${DEFAULT_ROOM}".`,
    } satisfies ServerEvent)
  );

  ws.on("message", async (data) => {
    // Rate limit per IP
    const rKey = rateKey(info.ip);
    const count = await pub.incr(rKey);
    if (count === 1) {
      // set 60s expiry on first increment of this minute bucket
      await pub.expire(rKey, 60);
    }
    if (count > RATE_LIMIT_PER_MIN) {
      ws.send(
        JSON.stringify({
          type: "system",
          text: "Rate limit exceeded. Try again soon.",
        } satisfies ServerEvent)
      );
      return;
    }

    // Validate input
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      ws.send(
        JSON.stringify({
          type: "system",
          text: "Invalid JSON",
        } satisfies ServerEvent)
      );
      return;
    }

    const parse = ClientMessageSchema.safeParse(payload);
    if (!parse.success) {
      ws.send(
        JSON.stringify({
          type: "system",
          text: "Invalid message shape",
        } satisfies ServerEvent)
      );
      return;
    }
    const { room, text, username } = parse.data;

    // Join room lazily on first message to it
    if (!info.rooms.has(room)) info.rooms.add(room);

    // Construct chat message
    const msg: ChatMessage = {
      id: randomUUID(),
      room,
      text: text.trim(),
      username: username.trim(),
      ts: Date.now(),
    };

    // Persist small history in Redis and publish
    await pushHistory(room, msg);
    await pub.publish(channelFor(room), JSON.stringify(msg));
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

// Simple rooms API (optional): list known rooms based on history keys (for demo)
app.get("/rooms", async (_req, res) => {
  const keys = await pub.keys(`${HISTORY_PREFIX}*`);
  const rooms = keys.map((k) => k.substring(HISTORY_PREFIX.length));
  res.json({ rooms });
});
