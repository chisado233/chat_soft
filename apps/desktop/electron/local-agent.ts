import Fastify from "fastify";
import { basename, extname } from "node:path";
import { openAsBlob, statSync } from "node:fs";
import { LOCAL_AGENT_PORT } from "@chat-soft/protocol";

interface LocalAgentConfig {
  serverBaseUrl: string;
  deviceId: string;
  deviceName: string;
  agentId: string;
  agentName: string;
  agentDescription: string;
}

interface RegisteredAgent {
  agentId: string;
  name: string;
  description: string;
  agentDeviceId: string;
  conversationId: string;
  registeredAt?: string;
  status?: string;
}

interface AgentAttachmentBody {
  filePath: string;
  fileName?: string;
  mimeType?: string;
  durationMs?: number;
  thumbnailUrl?: string;
}

export async function startLocalAgent(initial?: Partial<LocalAgentConfig>) {
  let config: LocalAgentConfig = {
    serverBaseUrl: "http://127.0.0.1:3000",
    deviceId: "desktop-local-agent",
    deviceName: "Windows-PC",
    agentId: "desktop-helper",
    agentName: "桌面助手",
    agentDescription: "运行在 Windows 电脑侧的本地 agent 网关",
    ...initial
  };
  const registeredAgents = new Map<string, RegisteredAgent>();

  function baseUrl() {
    return config.serverBaseUrl.replace(/\/$/, "");
  }

  function guessMimeType(filePath: string, fallbackKind: "audio" | "image" | "video" | "file") {
    const ext = extname(filePath).toLowerCase();
    const known: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".json": "application/json",
      ".zip": "application/zip"
    };
    if (known[ext]) return known[ext];
    if (fallbackKind === "image") return "image/*";
    if (fallbackKind === "video") return "video/*";
    if (fallbackKind === "audio") return "audio/*";
    return "application/octet-stream";
  }

  async function uploadAttachment(body: AgentAttachmentBody, kind: "audio" | "image" | "video" | "file") {
    const fileName = body.fileName ?? basename(body.filePath);
    const mimeType = body.mimeType ?? guessMimeType(body.filePath, kind);
    const blob = await openAsBlob(body.filePath, { type: mimeType });
    const form = new FormData();
    form.append("file", blob, fileName);
    form.append("kind", kind);
    const response = await fetch(`${baseUrl()}/api/upload/attachment`, {
      method: "POST",
      body: form
    });
    const payload = (await response.json()) as {
      mediaUrl: string;
      mimeType: string;
      fileName: string;
      fileSize: number;
    };
    return {
      ...payload,
      durationMs: body.durationMs,
      thumbnailUrl: body.thumbnailUrl
    };
  }

  function defaultAgentFromConfig(): RegisteredAgent {
    return {
      agentId: config.agentId,
      name: config.agentName,
      description: config.agentDescription,
      agentDeviceId: config.deviceId,
      conversationId: `agent:${config.agentId}`
    };
  }

  function ensureRegisteredAgent(agentId: string) {
    const existing = registeredAgents.get(agentId);
    if (existing) return existing;
    if (agentId === config.agentId) {
      const fallback = defaultAgentFromConfig();
      registeredAgents.set(agentId, fallback);
      return fallback;
    }
    return null;
  }

  const localAgent = Fastify({ logger: false });
  localAgent.get("/health", async () => ({ ok: true }));
  localAgent.get("/api/v1/config", async () => config);
  localAgent.post<{ Body: Partial<LocalAgentConfig> }>("/api/v1/config", async (request) => {
    config = { ...config, ...request.body };
    return { ok: true, config };
  });
  localAgent.get("/api/v1/local-agents", async () => {
    return {
      agents: [...registeredAgents.values()]
    };
  });
  localAgent.get("/api/v1/agents", async () => {
    const response = await fetch(`${baseUrl()}/api/agents`);
    return response.json();
  });
  localAgent.post<{
    Body: {
      agentId?: string;
      name?: string;
      description?: string;
      agentDeviceId?: string;
    };
  }>("/api/v1/agents/register", async (request) => {
    const localAgentInfo: RegisteredAgent = {
      agentId: request.body?.agentId ?? config.agentId,
      name: request.body?.name ?? config.agentName,
      description: request.body?.description ?? config.agentDescription,
      agentDeviceId: request.body?.agentDeviceId ?? `${config.deviceId}:${request.body?.agentId ?? config.agentId}`,
      conversationId: `agent:${request.body?.agentId ?? config.agentId}`
    };

    const response = await fetch(`${baseUrl()}/api/agents/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        agentId: localAgentInfo.agentId,
        name: localAgentInfo.name,
        description: localAgentInfo.description,
        transport: "desktop-local",
        agentDeviceId: localAgentInfo.agentDeviceId
      })
    });
    const payload = (await response.json()) as {
      ok: boolean;
      agent: {
        agentId: string;
        name: string;
        description: string;
        conversationId: string;
        registeredAt: string;
        status: string;
      };
    };
    registeredAgents.set(localAgentInfo.agentId, {
      ...localAgentInfo,
      conversationId: payload.agent.conversationId,
      registeredAt: payload.agent.registeredAt,
      status: payload.agent.status
    });
    return payload;
  });
  localAgent.get<{ Params: { agentId: string } }>("/api/v1/agents/:agentId", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    return { agent };
  });
  localAgent.get<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/messages", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(agent.conversationId)}/messages`);
    return response.json();
  });
  localAgent.get<{
    Params: { agentId: string };
    Querystring: { since?: string; limit?: string };
  }>("/api/v1/agents/:agentId/inbox", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(agent.conversationId)}/messages`);
    const payload = (await response.json()) as {
      messages: Array<{
        id: string;
        senderDeviceId: string;
        createdAt: string;
      }>;
    };
    const since = request.query.since ? new Date(request.query.since).toISOString() : "";
    const limit = Number(request.query.limit ?? "50");
    const messages = payload.messages
      .filter((message) => message.senderDeviceId !== agent.agentDeviceId)
      .filter((message) => (since ? message.createdAt > since : true))
      .slice(-limit);
    return {
      agent,
      messages
    };
  });
  localAgent.post<{
    Params: { agentId: string };
    Body: { text: string };
  }>("/api/v1/agents/:agentId/messages/text", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const response = await fetch(`${baseUrl()}/api/messages/text`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceId: agent.agentDeviceId,
        conversationId: agent.conversationId,
        text: request.body.text
      })
    });
    return response.json();
  });
  localAgent.post<{
    Params: { agentId: string };
    Body: AgentAttachmentBody;
  }>("/api/v1/agents/:agentId/messages/audio", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const uploaded = await uploadAttachment(request.body, "audio");
    const response = await fetch(`${baseUrl()}/api/messages/attachment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: agent.agentDeviceId,
        conversationId: agent.conversationId,
        kind: "audio",
        ...uploaded
      })
    });
    return response.json();
  });
  localAgent.post<{
    Params: { agentId: string };
    Body: AgentAttachmentBody;
  }>("/api/v1/agents/:agentId/messages/image", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const uploaded = await uploadAttachment(request.body, "image");
    const response = await fetch(`${baseUrl()}/api/messages/attachment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: agent.agentDeviceId,
        conversationId: agent.conversationId,
        kind: "image",
        ...uploaded
      })
    });
    return response.json();
  });
  localAgent.post<{
    Params: { agentId: string };
    Body: AgentAttachmentBody;
  }>("/api/v1/agents/:agentId/messages/video", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const uploaded = await uploadAttachment(request.body, "video");
    const response = await fetch(`${baseUrl()}/api/messages/attachment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: agent.agentDeviceId,
        conversationId: agent.conversationId,
        kind: "video",
        ...uploaded
      })
    });
    return response.json();
  });
  localAgent.post<{
    Params: { agentId: string };
    Body: AgentAttachmentBody;
  }>("/api/v1/agents/:agentId/messages/file", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const uploaded = await uploadAttachment(request.body, "file");
    const response = await fetch(`${baseUrl()}/api/messages/attachment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: agent.agentDeviceId,
        conversationId: agent.conversationId,
        kind: "file",
        ...uploaded
      })
    });
    return response.json();
  });
  localAgent.get("/api/v1/conversations", async () => {
    const response = await fetch(`${baseUrl()}/api/conversations`);
    return response.json();
  });
  localAgent.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/messages", async (request) => {
    const response = await fetch(
      `${baseUrl()}/api/conversations/${encodeURIComponent(request.params.conversationId)}/messages`
    );
    return response.json();
  });
  localAgent.get("/api/v1/messages/recent", async () => {
    const response = await fetch(`${baseUrl()}/api/messages/recent`);
    return response.json();
  });
  localAgent.post<{ Body: { conversationId?: string; text: string } }>("/api/v1/messages/text", async (request) => {
    const response = await fetch(`${baseUrl()}/api/messages/text`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceId: config.deviceId,
        conversationId: request.body.conversationId,
        text: request.body.text
      })
    });
    return response.json();
  });

  await localAgent.listen({ host: "127.0.0.1", port: LOCAL_AGENT_PORT });
  return localAgent;
}
