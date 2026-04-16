import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type {
  ChatMessage,
  ClientToServerEvent,
  DeviceInfo,
  ServerToClientEvent
} from "@chat-soft/protocol";
import { DEFAULT_CONVERSATION_ID } from "@chat-soft/protocol";

interface PersistedDb {
  devices: DeviceInfo[];
  messages: ChatMessage[];
}

const app = Fastify({ logger: true });
const dataDir = join(process.cwd(), "data");
const mediaDir = join(dataDir, "media");
const dbPath = join(dataDir, "db.json");
const sockets = new Map<string, Set<WebSocket>>();

function ensureData() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, JSON.stringify({ devices: [], messages: [] }, null, 2));
  }
}

function loadDb(): PersistedDb {
  ensureData();
  return JSON.parse(readFileSync(dbPath, "utf8")) as PersistedDb;
}

function saveDb(db: PersistedDb) {
  writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function pushToAll(event: ServerToClientEvent) {
  const payload = JSON.stringify(event);
  for (const group of sockets.values()) {
    for (const socket of group) {
      socket.send(payload);
    }
  }
}

app.register(cors, { origin: true });
app.register(multipart);
app.register(websocket);
app.register(fastifyStatic, {
  root: mediaDir,
  prefix: "/media/"
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/messages/recent", async () => {
  const db = loadDb();
  return {
    messages: db.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100)
  };
});

app.post<{ Body: { deviceId: string; text: string; conversationId?: string } }>("/api/messages/text", async (request) => {
  const db = loadDb();
  const message: ChatMessage = {
    id: nanoid(),
    kind: "text",
    conversationId: request.body.conversationId ?? DEFAULT_CONVERSATION_ID,
    senderDeviceId: request.body.deviceId,
    createdAt: new Date().toISOString(),
    status: "delivered",
    text: request.body.text
  };
  db.messages.push(message);
  saveDb(db);
  pushToAll({ type: "message.created", message });
  pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
  return { ok: true, message };
});

app.post("/api/upload/voice", async (request, reply) => {
  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ message: "缺少文件" });
  }
  const durationMs = Number((file.fields.durationMs as { value?: string } | undefined)?.value ?? "0");
  const ext = file.mimetype.includes("mpeg") ? "mp3" : "webm";
  const filename = `${Date.now()}-${nanoid(8)}.${ext}`;
  const filepath = join(mediaDir, filename);
  await pipeline(file.file, createWriteStream(filepath));
  return {
    mediaUrl: `/media/${filename}`,
    durationMs,
    mimeType: file.mimetype
  };
});

app.register(async (wsApp) => {
  wsApp.get("/ws", { websocket: true }, (socket) => {
    let currentDeviceId = "";
    socket.on("message", (raw: unknown) => {
      const db = loadDb();
      const event = JSON.parse(String(raw)) as ClientToServerEvent;
      if (event.type === "auth.hello") {
        currentDeviceId = event.device.deviceId;
        if (!sockets.has(currentDeviceId)) sockets.set(currentDeviceId, new Set());
        sockets.get(currentDeviceId)?.add(socket as unknown as WebSocket);
        if (!db.devices.some((device) => device.deviceId === event.device.deviceId)) {
          db.devices.push(event.device);
          saveDb(db);
        }
        const ready: ServerToClientEvent = {
          type: "auth.ready",
          deviceId: event.device.deviceId,
          conversationId: DEFAULT_CONVERSATION_ID
        };
        socket.send(JSON.stringify(ready));
        return;
      }
      if (event.type === "sync.pull") {
        const sync: ServerToClientEvent = {
          type: "sync.batch",
          conversationId: DEFAULT_CONVERSATION_ID,
          messages: db.messages
        };
        socket.send(JSON.stringify(sync));
        return;
      }
      if (event.type === "message.send_text") {
        const message: ChatMessage = {
          id: event.tempId,
          kind: "text",
          conversationId: event.conversationId,
          senderDeviceId: currentDeviceId,
          createdAt: new Date().toISOString(),
          status: "delivered",
          text: event.text
        };
        db.messages.push(message);
        saveDb(db);
        pushToAll({ type: "message.created", message });
        pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
        return;
      }
      if (event.type === "message.send_voice") {
        const message: ChatMessage = {
          id: event.tempId,
          kind: "voice",
          conversationId: event.conversationId,
          senderDeviceId: currentDeviceId,
          createdAt: new Date().toISOString(),
          status: "delivered",
          mediaUrl: event.mediaUrl,
          durationMs: event.durationMs,
          mimeType: event.mimeType
        };
        db.messages.push(message);
        saveDb(db);
        pushToAll({ type: "message.created", message });
        pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
        return;
      }
      if (event.type === "message.read") {
        const message = db.messages.find((item) => item.id === event.messageId);
        if (message) {
          message.status = "read";
          saveDb(db);
          pushToAll({ type: "message.status", messageId: message.id, status: "read" });
        }
      }
    });
    socket.on("close", () => {
      if (currentDeviceId) {
        sockets.get(currentDeviceId)?.delete(socket as unknown as WebSocket);
      }
    });
  });
});

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");

app.listen({ host, port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
