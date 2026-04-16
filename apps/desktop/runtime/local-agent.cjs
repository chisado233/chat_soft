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

  const localAgent = Fastify({ logger: false });
  localAgent.get("/health", async () => ({ ok: true }));
  localAgent.get("/api/v1/config", async () => config);
  localAgent.post("/api/v1/config", async (request) => {
    config = { ...config, ...request.body };
    return { ok: true, config };
  });
  localAgent.get("/api/v1/agents", async () => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/agents`);
    return response.json();
  });
  localAgent.post("/api/v1/agents/register", async (request) => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/agents/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        agentId: request.body?.agentId ?? config.agentId,
        name: request.body?.name ?? config.agentName,
        description: request.body?.description ?? config.agentDescription,
        transport: "desktop-local",
        agentDeviceId: config.deviceId
      })
    });
    return response.json();
  });
  localAgent.get("/api/v1/conversations", async () => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/conversations`);
    return response.json();
  });
  localAgent.get("/api/v1/conversations/:conversationId/messages", async (request) => {
    const response = await fetch(
      `${config.serverBaseUrl.replace(/\/$/, "")}/api/conversations/${encodeURIComponent(request.params.conversationId)}/messages`
    );
    return response.json();
  });
  localAgent.get("/api/v1/messages/recent", async () => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/messages/recent`);
    return response.json();
  });
  localAgent.post("/api/v1/messages/text", async (request) => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/messages/text`, {
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
