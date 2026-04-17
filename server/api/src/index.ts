import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type {
  AgentInfo,
  AgentConversationState,
  AttachmentPayload,
  ChatMessage,
  ClientToServerEvent,
  ConversationSummary,
  DeviceInfo,
  ServerToClientEvent
} from "@chat-soft/protocol";
import { DEFAULT_CONVERSATION_ID, DEFAULT_CONVERSATION_TITLE } from "@chat-soft/protocol";

interface PersistedDb {
  devices: DeviceInfo[];
  messages: ChatMessage[];
  agents: AgentInfo[];
  conversations: ConversationSummary[];
}

type TextMessageBody = {
  clientMessageId?: string;
  deviceId: string;
  text: string;
  conversationId?: string;
};

type VoiceMessageBody = {
  clientMessageId?: string;
  deviceId: string;
  mediaUrl: string;
  durationMs: number;
  mimeType: string;
  conversationId?: string;
};

type AttachmentMessageBody = {
  clientMessageId?: string;
  deviceId: string;
  conversationId?: string;
  kind: "audio" | "image" | "video" | "file";
} & AttachmentPayload;

type UpdateConversationAgentStateBody = {
  provider: "codex";
  selectedThreadId?: string | null;
  selectedModelId?: string;
  threadTitle?: string;
};

const app = Fastify({ logger: true });
const dataDir = join(process.cwd(), "data");
const mediaDir = join(dataDir, "media");
const dbPath = join(dataDir, "db.json");
const sockets = new Map<string, Set<WebSocket>>();

function defaultConversation(): ConversationSummary {
  return {
    conversationId: DEFAULT_CONVERSATION_ID,
    title: DEFAULT_CONVERSATION_TITLE,
    type: "direct",
    updatedAt: new Date(0).toISOString()
  };
}

function ensureData() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
  if (!existsSync(dbPath)) {
    writeFileSync(
      dbPath,
      JSON.stringify({ devices: [], messages: [], agents: [], conversations: [defaultConversation()] }, null, 2)
    );
  }
}

function normalizeDb(payload: unknown): PersistedDb {
  const value = payload && typeof payload === "object" ? (payload as Partial<PersistedDb>) : {};
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const agents = Array.isArray(value.agents) ? value.agents : [];
  const devices = Array.isArray(value.devices) ? value.devices : [];
  const conversations = Array.isArray(value.conversations) ? value.conversations : [];

  const nextConversations = conversations.length > 0 ? conversations : [defaultConversation()];
  if (!nextConversations.some((conversation) => conversation.conversationId === DEFAULT_CONVERSATION_ID)) {
    nextConversations.unshift(defaultConversation());
  }

  return {
    devices,
    messages,
    agents,
    conversations: nextConversations
  };
}

function loadDb(): PersistedDb {
  ensureData();
  return normalizeDb(JSON.parse(readFileSync(dbPath, "utf8")));
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

function upsertConversation(db: PersistedDb, conversation: ConversationSummary) {
  const index = db.conversations.findIndex((item) => item.conversationId === conversation.conversationId);
  if (index >= 0) {
    db.conversations[index] = { ...db.conversations[index], ...conversation };
    return db.conversations[index];
  }
  db.conversations.push(conversation);
  return conversation;
}

function touchConversation(db: PersistedDb, conversationId: string, lastMessage?: ChatMessage) {
  const existing = db.conversations.find((item) => item.conversationId === conversationId);
  const updatedAt = lastMessage?.createdAt ?? new Date().toISOString();
  if (existing) {
    existing.updatedAt = updatedAt;
    if (lastMessage) existing.lastMessage = lastMessage;
    return existing;
  }
  return upsertConversation(db, {
    conversationId,
    title: conversationId === DEFAULT_CONVERSATION_ID ? DEFAULT_CONVERSATION_TITLE : conversationId,
    type: conversationId === DEFAULT_CONVERSATION_ID ? "direct" : "agent",
    updatedAt,
    lastMessage
  });
}

function sortMessages(messages: ChatMessage[]) {
  return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function conversationTitleForAgent(agent: AgentInfo | undefined, conversation: ConversationSummary) {
  return agent?.name || conversation.title || conversation.conversationId;
}

function listConversations(db: PersistedDb) {
  return [...db.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function createTextMessage(body: TextMessageBody, messageId?: string): ChatMessage {
  return {
    id: messageId ?? nanoid(),
    kind: "text",
    conversationId: body.conversationId ?? DEFAULT_CONVERSATION_ID,
    senderDeviceId: body.deviceId,
    createdAt: new Date().toISOString(),
    status: "delivered",
    text: body.text
  };
}

function createVoiceMessage(body: VoiceMessageBody, messageId?: string): ChatMessage {
  return {
    id: messageId ?? nanoid(),
    kind: "voice",
    conversationId: body.conversationId ?? DEFAULT_CONVERSATION_ID,
    senderDeviceId: body.deviceId,
    createdAt: new Date().toISOString(),
    status: "delivered",
    mediaUrl: body.mediaUrl,
    durationMs: body.durationMs,
    mimeType: body.mimeType
  };
}

function createAttachmentMessage(body: AttachmentMessageBody, messageId?: string): ChatMessage {
  return {
    id: messageId ?? nanoid(),
    kind: body.kind,
    conversationId: body.conversationId ?? DEFAULT_CONVERSATION_ID,
    senderDeviceId: body.deviceId,
    createdAt: new Date().toISOString(),
    status: "delivered",
    mediaUrl: body.mediaUrl,
    mimeType: body.mimeType,
    fileName: body.fileName,
    fileSize: body.fileSize,
    durationMs: body.durationMs,
    thumbnailUrl: body.thumbnailUrl
  };
}

function appendMessage(db: PersistedDb, message: ChatMessage) {
  db.messages.push(message);
  touchConversation(db, message.conversationId, message);
}

function findMessageByClientId(db: PersistedDb, clientMessageId?: string) {
  if (!clientMessageId) {
    return null;
  }
  return db.messages.find((message) => message.id === clientMessageId) ?? null;
}

app.register(cors, { origin: true });
app.register(multipart);
app.register(websocket);
app.register(fastifyStatic, {
  root: mediaDir,
  prefix: "/media/"
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/agents", async () => {
  const db = loadDb();
  return {
    agents: db.agents.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))
  };
});

app.delete<{
  Params: { agentId: string };
  Querystring: { purge?: string };
}>("/api/agents/:agentId", async (request, reply) => {
  const db = loadDb();
  const agentId = request.params.agentId;
  const agent = db.agents.find((item) => item.agentId === agentId);
  if (!agent) {
    return reply.code(404).send({ message: "Agent 不存在" });
  }

  const purge = request.query.purge !== "0";
  db.agents = db.agents.filter((item) => item.agentId !== agentId);

  if (purge) {
    db.messages = db.messages.filter((message) => message.conversationId !== agent.conversationId);
    db.conversations = db.conversations.filter((conversation) => conversation.conversationId !== agent.conversationId);
  } else {
    const conversation = db.conversations.find((item) => item.conversationId === agent.conversationId);
    if (conversation) {
      delete conversation.agentId;
      conversation.title = conversation.title || agent.name;
      conversation.type = "direct";
    }
  }

  const isDeviceStillUsed = db.agents.some((item) => item.agentDeviceId === agent.agentDeviceId);
  if (!isDeviceStillUsed) {
    db.devices = db.devices.filter((device) => device.deviceId !== agent.agentDeviceId);
  }

  saveDb(db);
  return {
    ok: true,
    removedAgentId: agentId,
    purge
  };
});

app.post<{
  Body: {
    agentId?: string;
    name: string;
    description?: string;
    avatarUrl?: string;
    transport?: "desktop-local" | "server";
    agentDeviceId?: string;
  };
}>("/api/agents/register", async (request) => {
  const db = loadDb();
  const agentId = request.body.agentId?.trim() || `agent_${nanoid(8)}`;
  const conversationId = `agent:${agentId}`;
  const agentDeviceId = request.body.agentDeviceId?.trim() || `agent-device:${agentId}`;
  const agent: AgentInfo = {
    agentId,
    name: request.body.name.trim(),
    description: request.body.description?.trim() || "Desktop agent",
    avatarUrl: request.body.avatarUrl?.trim() || undefined,
    conversationId,
    registeredAt: new Date().toISOString(),
    status: "online",
    transport: request.body.transport ?? "desktop-local",
    agentDeviceId
  };

  db.agents = db.agents.filter((item) => item.agentId !== agentId);
  db.agents.push(agent);
  upsertConversation(db, {
    conversationId,
    title: agent.name,
    type: "agent",
    updatedAt: agent.registeredAt,
    agentId
  });

  if (!db.devices.some((device) => device.deviceId === agentDeviceId)) {
    db.devices.push({
      deviceId: agentDeviceId,
      deviceName: agent.name,
      platform: "windows"
    });
  }

  saveDb(db);
  return { ok: true, agent };
});

app.get("/api/conversations", async () => {
  const db = loadDb();
  for (const conversation of db.conversations) {
    const messages = db.messages.filter((message) => message.conversationId === conversation.conversationId);
    const lastMessage = sortMessages(messages).at(-1);
    if (lastMessage) {
      conversation.lastMessage = lastMessage;
      conversation.updatedAt = lastMessage.createdAt;
    }
  }
  saveDb(db);
  return {
    conversations: listConversations(db)
  };
});

app.patch<{
  Params: { conversationId: string };
  Body: UpdateConversationAgentStateBody;
}>("/api/conversations/:conversationId/agent-state", async (request, reply) => {
  const db = loadDb();
  const conversation = db.conversations.find((item) => item.conversationId === request.params.conversationId);
  if (!conversation) {
    return reply.code(404).send({ message: "会话不存在" });
  }

  const nextState: AgentConversationState = {
    provider: "codex",
    selectedThreadId: request.body.selectedThreadId ?? null,
    selectedModelId: request.body.selectedModelId?.trim() || undefined,
    threadTitle: request.body.threadTitle?.trim() || undefined,
    lastSyncedAt: new Date().toISOString()
  };

  conversation.agentState = nextState;
  const agent = db.agents.find((item) => item.conversationId === conversation.conversationId);
  const titleBase = conversationTitleForAgent(agent, conversation);
  if (nextState.threadTitle) {
    conversation.title = `${titleBase}`;
  } else if (agent?.name) {
    conversation.title = agent.name;
  }
  saveDb(db);
  return {
    ok: true,
    conversation
  };
});

app.get<{
  Params: { conversationId: string };
}>("/api/conversations/:conversationId/messages", async (request) => {
  const db = loadDb();
  return {
    messages: sortMessages(db.messages.filter((message) => message.conversationId === request.params.conversationId))
  };
});

app.get<{
  Querystring: { conversationId?: string };
}>("/api/messages/recent", async (request) => {
  const db = loadDb();
  const messages = request.query.conversationId
    ? db.messages.filter((message) => message.conversationId === request.query.conversationId)
    : db.messages;
  return {
    messages: sortMessages(messages).slice(-100)
  };
});

app.post<{ Body: TextMessageBody }>("/api/messages/text", async (request) => {
  const db = loadDb();
  const existing = findMessageByClientId(db, request.body.clientMessageId);
  if (existing) {
    return { ok: true, message: existing, deduplicated: true };
  }
  const message = createTextMessage(request.body, request.body.clientMessageId);
  appendMessage(db, message);
  saveDb(db);
  pushToAll({ type: "message.created", message });
  pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
  return { ok: true, message };
});

app.post<{ Body: VoiceMessageBody }>("/api/messages/voice", async (request) => {
  const db = loadDb();
  const existing = findMessageByClientId(db, request.body.clientMessageId);
  if (existing) {
    return { ok: true, message: existing, deduplicated: true };
  }
  const message = createVoiceMessage(request.body, request.body.clientMessageId);
  appendMessage(db, message);
  saveDb(db);
  pushToAll({ type: "message.created", message });
  pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
  return { ok: true, message };
});

app.post<{ Body: AttachmentMessageBody }>("/api/messages/attachment", async (request) => {
  const db = loadDb();
  const existing = findMessageByClientId(db, request.body.clientMessageId);
  if (existing) {
    return { ok: true, message: existing, deduplicated: true };
  }
  const message = createAttachmentMessage(request.body, request.body.clientMessageId);
  appendMessage(db, message);
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

app.post("/api/upload/attachment", async (request, reply) => {
  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ message: "缺少文件" });
  }
  const kind = String((file.fields.kind as { value?: string } | undefined)?.value ?? "file");
  const originalName = file.filename || `${kind}-${Date.now()}`;
  const ext = originalName.includes(".") ? originalName.slice(originalName.lastIndexOf(".") + 1) : "bin";
  const filename = `${Date.now()}-${nanoid(8)}.${ext}`;
  const filepath = join(mediaDir, filename);
  await pipeline(file.file, createWriteStream(filepath));

  const mimeType = file.mimetype || "application/octet-stream";
  return {
    mediaUrl: `/media/${filename}`,
    mimeType,
    fileName: originalName,
    fileSize: statSync(filepath).size
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
        }
        touchConversation(db, DEFAULT_CONVERSATION_ID);
        saveDb(db);
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
          messages: sortMessages(db.messages)
        };
        socket.send(JSON.stringify(sync));
        return;
      }

      if (event.type === "message.send_text") {
        const message = createTextMessage(
          {
            deviceId: currentDeviceId,
            conversationId: event.conversationId,
            text: event.text
          },
          event.tempId
        );
        appendMessage(db, message);
        saveDb(db);
        pushToAll({ type: "message.created", message });
        pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
        return;
      }

      if (event.type === "message.send_voice") {
        const message = createVoiceMessage(
          {
            deviceId: currentDeviceId,
            conversationId: event.conversationId,
            mediaUrl: event.mediaUrl,
            durationMs: event.durationMs,
            mimeType: event.mimeType
          },
          event.tempId
        );
        appendMessage(db, message);
        saveDb(db);
        pushToAll({ type: "message.created", message });
        pushToAll({ type: "message.status", messageId: message.id, status: "delivered" });
        return;
      }

      if (event.type === "message.send_attachment") {
        const message = createAttachmentMessage(
          {
            deviceId: currentDeviceId,
            conversationId: event.conversationId,
            kind: event.kind,
            mediaUrl: event.mediaUrl,
            mimeType: event.mimeType,
            fileName: event.fileName,
            fileSize: event.fileSize,
            durationMs: event.durationMs,
            thumbnailUrl: event.thumbnailUrl
          },
          event.tempId
        );
        appendMessage(db, message);
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
