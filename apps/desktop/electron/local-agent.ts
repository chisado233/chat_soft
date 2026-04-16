import Fastify from "fastify";
import { LOCAL_AGENT_PORT } from "@chat-soft/protocol";

interface LocalAgentConfig {
  serverBaseUrl: string;
  deviceId: string;
  deviceName: string;
}

export async function startLocalAgent(initial?: Partial<LocalAgentConfig>) {
  let config: LocalAgentConfig = {
    serverBaseUrl: "http://127.0.0.1:3000",
    deviceId: "desktop-local-agent",
    deviceName: "Windows-PC",
    ...initial
  };

  const localAgent = Fastify({ logger: false });
  localAgent.get("/health", async () => ({ ok: true }));
  localAgent.get("/api/v1/config", async () => config);
  localAgent.post<{ Body: Partial<LocalAgentConfig> }>("/api/v1/config", async (request) => {
    config = { ...config, ...request.body };
    return { ok: true, config };
  });
  localAgent.get("/api/v1/messages/recent", async () => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/messages/recent`);
    return response.json();
  });
  localAgent.post<{ Body: { conversationId?: string; text: string } }>("/api/v1/messages/text", async (request) => {
    const response = await fetch(`${config.serverBaseUrl.replace(/\/$/, "")}/api/messages/text`, {
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
