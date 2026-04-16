const Fastify = require("fastify");

const LOCAL_AGENT_PORT = 45888;

async function startLocalAgent(initial = {}) {
  let config = {
    serverBaseUrl: "http://127.0.0.1:3000",
    deviceId: "desktop-local-agent",
    deviceName: "Windows-PC",
    agentId: "desktop-helper",
    agentName: "桌面助手",
    agentDescription: "运行在 Windows 电脑侧的本地 agent 网关",
    ...initial
  };
  const registeredAgents = new Map();

  function baseUrl() {
    return config.serverBaseUrl.replace(/\/$/, "");
  }

  function defaultAgentFromConfig() {
    return {
      agentId: config.agentId,
      name: config.agentName,
      description: config.agentDescription,
      agentDeviceId: config.deviceId,
      conversationId: `agent:${config.agentId}`
    };
  }

  function ensureRegisteredAgent(agentId) {
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
  localAgent.post("/api/v1/config", async (request) => {
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
  localAgent.post("/api/v1/agents/register", async (request) => {
    const localAgentInfo = {
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
    const payload = await response.json();
    registeredAgents.set(localAgentInfo.agentId, {
      ...localAgentInfo,
      conversationId: payload.agent.conversationId,
      registeredAt: payload.agent.registeredAt,
      status: payload.agent.status
    });
    return payload;
  });
  localAgent.get("/api/v1/agents/:agentId", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    return { agent };
  });
  localAgent.get("/api/v1/agents/:agentId/messages", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(agent.conversationId)}/messages`);
    return response.json();
  });
  localAgent.get("/api/v1/agents/:agentId/inbox", async (request, reply) => {
    const agent = ensureRegisteredAgent(request.params.agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not registered locally" });
    }
    const response = await fetch(`${baseUrl()}/api/conversations/${encodeURIComponent(agent.conversationId)}/messages`);
    const payload = await response.json();
    const since = request.query?.since ? new Date(request.query.since).toISOString() : "";
    const limit = Number(request.query?.limit ?? "50");
    const messages = payload.messages
      .filter((message) => message.senderDeviceId !== agent.agentDeviceId)
      .filter((message) => (since ? message.createdAt > since : true))
      .slice(-limit);
    return {
      agent,
      messages
    };
  });
  localAgent.post("/api/v1/agents/:agentId/messages/text", async (request, reply) => {
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
        text: request.body?.text
      })
    });
    return response.json();
  });
  localAgent.get("/api/v1/conversations", async () => {
    const response = await fetch(`${baseUrl()}/api/conversations`);
    return response.json();
  });
  localAgent.get("/api/v1/conversations/:conversationId/messages", async (request) => {
    const response = await fetch(
      `${baseUrl()}/api/conversations/${encodeURIComponent(request.params.conversationId)}/messages`
    );
    return response.json();
  });
  localAgent.get("/api/v1/messages/recent", async () => {
    const response = await fetch(`${baseUrl()}/api/messages/recent`);
    return response.json();
  });
  localAgent.post("/api/v1/messages/text", async (request) => {
    const response = await fetch(`${baseUrl()}/api/messages/text`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceId: config.deviceId,
        conversationId: request.body?.conversationId,
        text: request.body?.text
      })
    });
    return response.json();
  });

  await localAgent.listen({ host: "127.0.0.1", port: LOCAL_AGENT_PORT });
  return localAgent;
}

module.exports = {
  LOCAL_AGENT_PORT,
  startLocalAgent
};
