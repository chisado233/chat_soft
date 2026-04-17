import * as crypto from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";

type ChatSoftMessage = {
  id: string;
  kind: "text" | "voice" | "audio" | "image" | "video" | "file";
  conversationId: string;
  senderDeviceId: string;
  createdAt: string;
  status: string;
  text?: string;
};

type ChatSoftRegisterResponse = {
  ok: boolean;
  agent: {
    agentId: string;
    name: string;
    description: string;
    conversationId: string;
    registeredAt: string;
    status: string;
    transport: string;
    agentDeviceId: string;
  };
};

type ChatSoftAgentsResponse = {
  agents: Array<{
    agentId: string;
    conversationId: string;
    name: string;
  }>;
};

type ChatSoftMessagesResponse = {
  messages: ChatSoftMessage[];
};

type BridgeState = {
  processedMessageIds: string[];
  selectedModelId: string;
  selectedThreadId: string | null;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: any;
};

type PendingTurn = {
  chunks: string[];
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type CodexModel = {
  id: string;
};

type CodexThread = {
  id: string;
  preview: string;
  updatedAt: number;
  cwd: string;
  name?: string | null;
};

type CodexThreadItem =
  | {
      type: "userMessage";
      content: Array<{ type: string; text?: string }>;
    }
  | {
      type: "agentMessage";
      text: string;
    }
  | {
      type: "reasoning";
      summary: string[];
      content: string[];
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
};

const EXTENSION_KEY_DEVICE_ID = "chatSoftCodexBridge.deviceId";
const EXTENSION_KEY_STATE = "chatSoftCodexBridge.state";
const CONTROL_AGENT_ID = "codex-agent";

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();

  constructor(
    private readonly executable: string,
    private readonly workspaceRoot: string,
    private readonly proxyUrl: string,
    private readonly noProxy: string[],
    private readonly log: (message: string) => void
  ) {}

  async start() {
    if (this.child) {
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_PROXY: this.noProxy.join(","),
      no_proxy: this.noProxy.join(",")
    };

    if (this.proxyUrl) {
      env.HTTP_PROXY = this.proxyUrl;
      env.HTTPS_PROXY = this.proxyUrl;
      env.ALL_PROXY = this.proxyUrl;
      env.http_proxy = this.proxyUrl;
      env.https_proxy = this.proxyUrl;
      env.all_proxy = this.proxyUrl;
    }

    this.child = spawn(this.executable, ["app-server", "--listen", "stdio://"], {
      cwd: this.workspaceRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) {
        this.log(line);
      }
    });

    this.child.on("close", (code) => {
      this.log(`Codex app-server closed with code ${String(code)}`);
      this.child = null;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Codex app-server closed."));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      clientInfo: {
        name: "chat-soft-codex-bridge",
        title: "Chat Soft Codex Bridge",
        version: "0.2.1"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  }

  stop() {
    this.child?.kill();
    this.child = null;
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.start();
    if (!this.child) {
      throw new Error("Codex app-server is not available.");
    }

    const id = this.nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    this.child.stdin.write(`${payload}\n`);
    return promise;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  private handleStdout(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        if ("method" in message) {
          for (const listener of this.notificationListeners) {
            listener(message);
          }
          continue;
        }

        const pending = this.pending.get(message.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      } catch (error) {
        this.log(`Failed to parse app-server message: ${String(error)}`);
      }
    }
  }
}

class ChatSoftCodexBridge {
  private readonly output = vscode.window.createOutputChannel("Chat Soft Codex Bridge");
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;
  private conversationId = "";
  private agentDeviceId = "";
  private codexClient: CodexAppServerClient | null = null;
  private readonly pendingTurns = new Map<string, PendingTurn>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async start() {
    if (this.running) {
      this.log("Bridge already running.");
      return;
    }

    this.running = true;
    this.log("Starting Chat Soft Codex bridge...");
    this.log("Ensuring Codex client...");
    await this.ensureCodexClient();
    this.log("Cleaning legacy Codex agents...");
    await this.cleanupLegacyAgents();
    this.log("Registering control agent...");
    await this.registerControlAgent();
    this.log("Seeding processed messages...");
    await this.seedProcessedMessages();
    this.log("Scheduling polling loop...");
    this.schedule();
    this.log("Running first sync tick...");
    await this.tick();
    this.log("Bridge startup completed.");
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const pending of this.pendingTurns.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge stopped."));
    }
    this.pendingTurns.clear();
    this.codexClient?.stop();
    this.codexClient = null;
    this.running = false;
    this.log("Bridge stopped.");
  }

  async showModels() {
    const models = await this.listModels();
    this.output.show(true);
    this.output.appendLine(models.map((model) => `- ${model.id}`).join("\n"));
    void vscode.window.showInformationMessage(`Found ${models.length} available Codex models.`);
  }

  async resetHistory() {
    const state = this.readState();
    state.selectedThreadId = null;
    await this.writeState(state);
    void vscode.window.showInformationMessage("Selected Codex thread cleared.");
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration("chatSoftCodexBridge");
    return {
      enabled: cfg.get<boolean>("enabled", true),
      serverBaseUrl: cfg.get<string>("serverBaseUrl", "http://39.106.125.149:3000").replace(/\/$/, ""),
      agentName: cfg.get<string>("agentName", "Codex Agent").trim() || "Codex Agent",
      agentDescription: cfg.get<string>("agentDescription", "VS Code 中的 Codex 会话桥接代理").trim(),
      pollIntervalMs: cfg.get<number>("pollIntervalMs", 2000),
      preferredModelId: cfg.get<string>("preferredModelId", "gpt-5.4").trim(),
      codexExecutable: cfg.get<string>("codexExecutable", "").trim(),
      workspaceRoot: cfg.get<string>("workspaceRoot", "D:\\agent_workspace").trim() || "D:\\agent_workspace",
      proxyUrl: cfg.get<string>("proxyUrl", "").trim()
    };
  }

  private deviceId() {
    let existing = this.context.globalState.get<string>(EXTENSION_KEY_DEVICE_ID);
    if (!existing) {
      existing = `vscode-codex-bridge:${crypto.randomUUID()}`;
      void this.context.globalState.update(EXTENSION_KEY_DEVICE_ID, existing);
    }
    return existing;
  }

  private readState(): BridgeState {
    const cfg = this.config();
    const stored = this.context.globalState.get<Partial<BridgeState>>(EXTENSION_KEY_STATE);
    return {
      processedMessageIds: Array.isArray(stored?.processedMessageIds) ? stored.processedMessageIds.slice(-500) : [],
      selectedModelId: stored?.selectedModelId?.trim() || cfg.preferredModelId,
      selectedThreadId: stored?.selectedThreadId?.trim() || null
    };
  }

  private async writeState(state: BridgeState) {
    await this.context.globalState.update(EXTENSION_KEY_STATE, state);
  }

  private schedule() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config().pollIntervalMs);
  }

  private async ensureCodexClient() {
    if (this.codexClient) {
      return this.codexClient;
    }

    const cfg = this.config();
    const executable = await this.resolveCodexExecutable();
    const proxyUrl = cfg.proxyUrl || vscode.workspace.getConfiguration().get<string>("http.proxy", "").trim();
    const noProxy = vscode.workspace.getConfiguration().get<string[]>("http.noProxy", ["127.0.0.1", "localhost", "::1"]);
    const client = new CodexAppServerClient(executable, cfg.workspaceRoot, proxyUrl, noProxy, (message) => this.log(message));
    client.onNotification((notification) => this.handleCodexNotification(notification));
    await client.start();
    this.codexClient = client;
    return client;
  }

  private handleCodexNotification(notification: JsonRpcNotification) {
    if (notification.method === "item/agentMessage/delta") {
      const params = notification.params as { turnId: string; delta: string };
      const pending = this.pendingTurns.get(params.turnId);
      if (pending) {
        pending.chunks.push(params.delta);
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const params = notification.params as { turn: { id: string; status: string; error?: { message?: string } | null } };
      const pending = this.pendingTurns.get(params.turn.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingTurns.delete(params.turn.id);
      if (params.turn.status === "failed" || params.turn.error) {
        pending.reject(new Error(params.turn.error?.message || "Codex turn failed."));
      } else {
        pending.resolve(pending.chunks.join("").trim() || "Codex 没有返回文本内容。");
      }
      return;
    }

    if (notification.method === "error") {
      this.log(`Codex app-server error notification: ${JSON.stringify(notification.params ?? {})}`);
    }
  }

  private async registerControlAgent() {
    if (this.conversationId && this.agentDeviceId) {
      return;
    }

    const cfg = this.config();
    const response = await this.fetchJson<ChatSoftRegisterResponse>(`${cfg.serverBaseUrl}/api/agents/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        agentId: CONTROL_AGENT_ID,
        name: cfg.agentName,
        description: cfg.agentDescription,
        transport: "vscode-codex-bridge",
        agentDeviceId: `${this.deviceId()}:${CONTROL_AGENT_ID}`
      })
    });

    this.conversationId = response.agent.conversationId;
    this.agentDeviceId = response.agent.agentDeviceId;
    this.log(`Registered control agent -> ${this.conversationId}`);
  }

  private async cleanupLegacyAgents() {
    const response = await this.fetchJson<ChatSoftAgentsResponse>(`${this.config().serverBaseUrl}/api/agents`);
    const legacyAgents = response.agents.filter((agent) => {
      if (agent.agentId === CONTROL_AGENT_ID) {
        return false;
      }
      return agent.agentId.startsWith("codex-thread-") || agent.agentId === "codex-agent-debug";
    });

    for (const agent of legacyAgents) {
      try {
        await this.fetchJson(`${this.config().serverBaseUrl}/api/agents/${encodeURIComponent(agent.agentId)}?purge=1`, {
          method: "DELETE"
        });
        this.log(`Removed legacy agent ${agent.agentId}`);
      } catch (error) {
        this.log(`Failed to remove legacy agent ${agent.agentId}: ${String(error)}`);
      }
    }
  }

  private async seedProcessedMessages() {
    const state = this.readState();
    if (!this.conversationId || state.processedMessageIds.length > 0) {
      return;
    }

    const payload = await this.fetchJson<ChatSoftMessagesResponse>(
      `${this.config().serverBaseUrl}/api/conversations/${encodeURIComponent(this.conversationId)}/messages`
    );
    state.processedMessageIds = payload.messages.map((message) => message.id).slice(-500);
    await this.writeState(state);
    this.log(`Seeded ${state.processedMessageIds.length} existing messages.`);
  }

  private async tick() {
    if (!this.running || this.busy) {
      return;
    }

    this.busy = true;
    try {
      await this.ensureCodexClient();
      await this.registerControlAgent();

      const payload = await this.fetchJson<ChatSoftMessagesResponse>(
        `${this.config().serverBaseUrl}/api/conversations/${encodeURIComponent(this.conversationId)}/messages`
      );
      const state = this.readState();
      const seen = new Set(state.processedMessageIds);

      for (const message of payload.messages) {
        if (seen.has(message.id)) {
          continue;
        }
        seen.add(message.id);

        if (message.senderDeviceId === this.agentDeviceId) {
          continue;
        }

        await this.handleIncomingMessage(message, state);
      }

      state.processedMessageIds = [...seen].slice(-500);
      await this.writeState(state);
    } catch (error) {
      this.log(`Tick failed: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async handleIncomingMessage(message: ChatSoftMessage, state: BridgeState) {
    if (message.kind !== "text" || !message.text?.trim()) {
      await this.sendText("当前 Codex Bridge 版本先只支持文本消息。");
      return;
    }

    const text = message.text.trim();
    if (await this.handleCommand(text, state)) {
      return;
    }

    const threadId = await this.ensureSelectedThread(state);
    const reply = await this.sendTurn(threadId, text, state.selectedModelId);
    await this.sendText(reply);
  }

  private async handleCommand(text: string, state: BridgeState) {
    if (/^\/models$/i.test(text)) {
      const models = await this.listModels();
      await this.sendText(`可用模型：\n${models.map((model) => `- ${model.id}`).join("\n")}`);
      return true;
    }

    const modelMatch = text.match(/^\/model\s+(.+)$/i);
    if (modelMatch) {
      const modelId = modelMatch[1].trim();
      const models = await this.listModels();
      if (!models.some((item) => item.id === modelId)) {
        await this.sendText(`没有找到模型 ${modelId}。先发 /models 查看。`);
        return true;
      }
      state.selectedModelId = modelId;
      await this.sendText(`已切换到模型：${modelId}`);
      return true;
    }

    if (/^\/threads$/i.test(text)) {
      const threads = await this.listRecentThreads();
      if (threads.length === 0) {
        await this.sendText("当前没有可用的 Codex 线程。");
        return true;
      }

      const lines = threads.map((thread, index) => {
        const current = state.selectedThreadId === thread.id ? " [当前]" : "";
        return `${index + 1}. ${this.describeThread(thread)} (${thread.id.slice(0, 8)})${current}`;
      });
      await this.sendText(`最近 Codex 线程：\n${lines.join("\n")}\n\n使用 /use <编号|前缀|latest|new> 切换。`);
      return true;
    }

    if (/^\/current$/i.test(text)) {
      if (!state.selectedThreadId) {
        await this.sendText("当前还没有选中的线程。");
        return true;
      }
      const thread = await this.readThreadMeta(state.selectedThreadId);
      await this.sendText(`当前线程：${this.describeThread(thread)} (${thread.id.slice(0, 8)})`);
      return true;
    }

    const useMatch = text.match(/^\/use\s+(.+)$/i);
    if (useMatch) {
      const target = useMatch[1].trim();
      if (/^new$/i.test(target)) {
        const thread = await this.startNewThread(state.selectedModelId);
        state.selectedThreadId = thread.id;
        await this.sendThreadContext(thread.id, `已新建并切换到线程：${this.describeThread(thread)} (${thread.id.slice(0, 8)})`);
        return true;
      }

      const threads = await this.listRecentThreads();
      let picked: CodexThread | undefined;
      if (/^latest$/i.test(target)) {
        picked = threads[0];
      } else {
        const asNumber = Number(target);
        if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= threads.length) {
          picked = threads[asNumber - 1];
        } else {
          picked = threads.find((thread) => thread.id.startsWith(target));
        }
      }

      if (!picked) {
        await this.sendText("没有找到对应线程。先发 /threads 看列表。");
        return true;
      }

      state.selectedThreadId = picked.id;
      await this.sendThreadContext(picked.id, `已切换到线程：${this.describeThread(picked)} (${picked.id.slice(0, 8)})`);
      return true;
    }

    if (/^\/reset$/i.test(text)) {
      state.selectedThreadId = null;
      await this.sendText("已清空当前线程选择。下一条普通消息会自动接到最近线程，没有的话就新建。");
      return true;
    }

    return false;
  }

  private async listModels() {
    const client = await this.ensureCodexClient();
    const response = await client.request<{ data?: Array<{ id?: string }> }>("model/list", {});
    return (response.data || [])
      .map((item) => ({ id: item.id || "" }))
      .filter((item) => Boolean(item.id)) as CodexModel[];
  }

  private async listRecentThreads() {
    const client = await this.ensureCodexClient();
    const merged = new Map<string, CodexThread>();

    const loaded = await client.request<{ data?: string[] }>("thread/loaded/list", { limit: 20 });
    for (const id of loaded.data || []) {
      try {
        const response = await client.request<{ thread: CodexThread }>("thread/read", {
          threadId: id,
          includeTurns: false
        });
        merged.set(response.thread.id, response.thread);
      } catch (error) {
        this.log(`Failed to read loaded thread ${id}: ${String(error)}`);
      }
    }

    const listed = await client.request<{ data?: CodexThread[] }>("thread/list", {
      limit: 20,
      archived: false
    });
    for (const thread of listed.data || []) {
      merged.set(thread.id, thread);
    }

    return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async readThreadMeta(threadId: string) {
    const client = await this.ensureCodexClient();
    const response = await client.request<{ thread: CodexThread }>("thread/read", {
      threadId,
      includeTurns: false
    });
    return response.thread;
  }

  private async readThreadWithTurns(threadId: string) {
    const client = await this.ensureCodexClient();
    const response = await client.request<{ thread: CodexThread & { turns: CodexTurn[] } }>("thread/read", {
      threadId,
      includeTurns: true
    });
    return response.thread;
  }

  private describeThread(thread: CodexThread) {
    const title = thread.name?.trim() || thread.preview?.trim() || path.basename(thread.cwd) || "未命名线程";
    return title.length > 28 ? `${title.slice(0, 28)}...` : title;
  }

  private async ensureSelectedThread(state: BridgeState) {
    if (state.selectedThreadId) {
      return state.selectedThreadId;
    }

    const latest = (await this.listRecentThreads())[0];
    if (latest) {
      state.selectedThreadId = latest.id;
      await this.sendThreadContext(latest.id, `已自动接入最近线程：${this.describeThread(latest)} (${latest.id.slice(0, 8)})`);
      return latest.id;
    }

    const thread = await this.startNewThread(state.selectedModelId);
    state.selectedThreadId = thread.id;
    await this.sendThreadContext(thread.id, `已自动新建线程：${this.describeThread(thread)} (${thread.id.slice(0, 8)})`);
    return thread.id;
  }

  private async startNewThread(modelId: string) {
    const client = await this.ensureCodexClient();
    const response = await client.request<{ thread: CodexThread }>("thread/start", {
      model: modelId,
      cwd: this.config().workspaceRoot,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    return response.thread;
  }

  private async sendTurn(threadId: string, text: string, modelId: string) {
    const client = await this.ensureCodexClient();
    const started = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text,
          text_elements: []
        }
      ],
      model: modelId
    });

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTurns.delete(started.turn.id);
        reject(new Error("Codex turn timed out."));
      }, 120000);

      this.pendingTurns.set(started.turn.id, {
        chunks: [],
        resolve,
        reject,
        timeout
      });
    });
  }

  private async sendThreadContext(threadId: string, intro: string) {
    const thread = await this.readThreadWithTurns(threadId);
    const snippets: string[] = [];
    const recentTurns = thread.turns.slice(-4);

    for (const turn of recentTurns) {
      for (const item of turn.items) {
        if (item.type === "userMessage") {
          const content = Array.isArray((item as { content?: Array<{ type?: string; text?: string }> }).content)
            ? (item as { content: Array<{ type?: string; text?: string }> }).content
            : [];
          const text = content
            .filter((contentItem: { type?: string; text?: string }) => contentItem.type === "text" && contentItem.text)
            .map((contentItem: { type?: string; text?: string }) => contentItem.text?.trim() || "")
            .filter(Boolean)
            .join(" ");
          if (text) {
            snippets.push(`用户: ${text}`);
          }
        } else if (item.type === "agentMessage") {
          const textValue = (item as { text?: string }).text;
          const text = typeof textValue === "string" ? textValue.trim() : "";
          if (text) {
            snippets.push(`Codex: ${text}`);
          }
        }
      }
    }

    const body =
      snippets.length > 0
        ? `${intro}\n\n当前手机会话已切到这个 Codex 线程。最近上下文：\n${snippets.slice(-8).join("\n")}`
        : `${intro}\n\n当前手机会话已切到这个 Codex 线程。这个线程暂时还没有可回显的历史内容。`;
    await this.sendText(body);
  }

  private async sendText(text: string) {
    await this.fetchJson(`${this.config().serverBaseUrl}/api/messages/text`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deviceId: this.agentDeviceId,
        conversationId: this.conversationId,
        text
      })
    });
  }

  private async fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const target = new URL(url);
      const client = target.protocol === "https:" ? https : http;
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : undefined;
      const headerEntries: Record<string, string> = {};
      headers.forEach((value, key) => {
        headerEntries[key] = value;
      });

      const request = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: init?.method || "GET",
          headers: headerEntries
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            raw += chunk;
          });
          response.on("end", () => {
            const statusCode = response.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`HTTP ${statusCode} ${response.statusMessage || ""}`.trim()));
              return;
            }

            try {
              resolve(JSON.parse(raw) as T);
            } catch (error) {
              reject(error);
            }
          });
        }
      );

      request.on("error", (error) => {
        reject(error);
      });

      if (body) {
        request.write(body);
      }
      request.end();
    });
  }

  private async resolveCodexExecutable() {
    const cfg = this.config();
    if (cfg.codexExecutable) {
      return cfg.codexExecutable;
    }

    const openAiExtension = vscode.extensions.getExtension("openai.chatgpt");
    if (openAiExtension) {
      return path.join(openAiExtension.extensionPath, "bin", "windows-x86_64", "codex.exe");
    }

    return "codex";
  }

  private log(message: string) {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const bridge = new ChatSoftCodexBridge(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("chatSoftCodexBridge.start", async () => {
      await bridge.start();
      void vscode.window.showInformationMessage("Chat Soft Codex bridge started.");
    }),
    vscode.commands.registerCommand("chatSoftCodexBridge.stop", () => {
      bridge.stop();
      void vscode.window.showInformationMessage("Chat Soft Codex bridge stopped.");
    }),
    vscode.commands.registerCommand("chatSoftCodexBridge.showModels", async () => {
      await bridge.showModels();
    }),
    vscode.commands.registerCommand("chatSoftCodexBridge.resetHistory", async () => {
      await bridge.resetHistory();
    })
  );

  if (vscode.workspace.getConfiguration("chatSoftCodexBridge").get<boolean>("enabled", true)) {
    try {
      await bridge.start();
    } catch (error) {
      void vscode.window.showWarningMessage(`Chat Soft Codex bridge failed to start: ${String(error)}`);
    }
  }
}

export function deactivate() {}
