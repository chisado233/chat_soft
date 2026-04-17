import type {
  AgentInfo,
  AttachmentPayload,
  ChatMessage,
  ClientToServerEvent,
  ConversationSummary,
  DeviceInfo,
  SendAttachmentEvent,
  SendTextEvent,
  SendVoiceEvent,
  ServerToClientEvent
} from "@chat-soft/protocol";
import { DEFAULT_CONVERSATION_ID } from "@chat-soft/protocol";
import { createId } from "./id.js";

export { createId } from "./id.js";

type Listener = (messages: ChatMessage[]) => void;
type EventListener = (event: ServerToClientEvent) => void;

export interface ChatClientOptions {
  serverBaseUrl: string;
  wsUrl: string;
  device: DeviceInfo;
}

export interface UploadedAttachment extends AttachmentPayload {}

function resolveMediaUrl(serverBaseUrl: string, mediaUrl: string) {
  if (!mediaUrl) return mediaUrl;
  if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
  return `${serverBaseUrl.replace(/\/$/, "")}${mediaUrl.startsWith("/") ? "" : "/"}${mediaUrl}`;
}

function normalizeMessage(serverBaseUrl: string, message: ChatMessage): ChatMessage {
  if ("mediaUrl" in message && typeof message.mediaUrl === "string") {
    const thumbnailUrl =
      "thumbnailUrl" in message && typeof message.thumbnailUrl === "string"
        ? resolveMediaUrl(serverBaseUrl, message.thumbnailUrl)
        : undefined;
    return {
      ...message,
      mediaUrl: resolveMediaUrl(serverBaseUrl, message.mediaUrl),
      ...(thumbnailUrl ? { thumbnailUrl } : {})
    } as ChatMessage;
  }
  return message;
}

export class ChatClient {
  private socket: WebSocket | null = null;
  private messages: ChatMessage[] = [];
  private messageListeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();
  private pollTimer: number | null = null;

  constructor(private readonly options: ChatClientOptions) {}

  connect() {
    if (this.socket && this.socket.readyState <= 1) return;
    if (typeof window !== "undefined" && window.location.protocol === "https:" && this.options.wsUrl.startsWith("ws://")) {
      this.startPolling();
      return;
    }
    try {
      this.socket = new WebSocket(this.options.wsUrl);
      this.socket.addEventListener("open", () => {
        this.send({
          type: "auth.hello",
          device: this.options.device
        });
        this.send({ type: "sync.pull" });
      });
      this.socket.addEventListener("message", (raw) => {
        const event = JSON.parse(String(raw.data)) as ServerToClientEvent;
        this.handleServerEvent(event);
      });
      this.socket.addEventListener("close", () => {
        this.startPolling();
      });
      this.socket.addEventListener("error", () => {
        this.startPolling();
      });
    } catch {
      this.socket = null;
      this.startPolling();
    }
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onMessages(listener: Listener) {
    this.messageListeners.add(listener);
    listener(this.messages);
    return () => this.messageListeners.delete(listener);
  }

  onEvent(listener: EventListener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getMessages() {
    return this.messages;
  }

  async uploadVoice(file: Blob, durationMs: number) {
    const form = new FormData();
    form.append("file", file, "voice.webm");
    form.append("durationMs", String(durationMs));
    const response = await fetch(`${this.options.serverBaseUrl}/api/upload/voice`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      throw new Error("上传语音失败");
    }
    const payload = (await response.json()) as {
      mediaUrl: string;
      durationMs: number;
      mimeType: string;
    };
    return {
      ...payload,
      mediaUrl: resolveMediaUrl(this.options.serverBaseUrl, payload.mediaUrl)
    };
  }

  async uploadAttachment(file: File | Blob, kind: "audio" | "image" | "video" | "file", fileName?: string) {
    const form = new FormData();
    const inferredName = fileName ?? ("name" in file && typeof file.name === "string" ? file.name : `${kind}-${createId()}`);
    form.append("file", file, inferredName);
    form.append("kind", kind);
    const response = await fetch(`${this.options.serverBaseUrl}/api/upload/attachment`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      throw new Error("上传附件失败");
    }
    const payload = (await response.json()) as UploadedAttachment;
    return {
      ...payload,
      mediaUrl: resolveMediaUrl(this.options.serverBaseUrl, payload.mediaUrl),
      thumbnailUrl: payload.thumbnailUrl
        ? resolveMediaUrl(this.options.serverBaseUrl, payload.thumbnailUrl)
        : payload.thumbnailUrl
    };
  }

  async listAgents() {
    const response = await fetch(`${this.options.serverBaseUrl}/api/agents`);
    if (!response.ok) {
      throw new Error("获取 agent 列表失败");
    }
    return (await response.json()) as { agents: AgentInfo[] };
  }

  async listConversations() {
    const response = await fetch(`${this.options.serverBaseUrl}/api/conversations`);
    if (!response.ok) {
      throw new Error("获取会话列表失败");
    }
    const payload = (await response.json()) as { conversations: ConversationSummary[] };
    return {
      conversations: payload.conversations.map((conversation) => ({
        ...conversation,
        lastMessage: conversation.lastMessage
          ? normalizeMessage(this.options.serverBaseUrl, conversation.lastMessage)
          : conversation.lastMessage
      }))
    };
  }

  async fetchConversationMessages(conversationId: string) {
    const response = await fetch(`${this.options.serverBaseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (!response.ok) {
      throw new Error("获取会话消息失败");
    }
    const payload = (await response.json()) as { messages: ChatMessage[] };
    return payload.messages
      .map((message) => normalizeMessage(this.options.serverBaseUrl, message))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async sendText(text: string, conversationId = DEFAULT_CONVERSATION_ID) {
    const clientMessageId = createId();
    const event: SendTextEvent = {
      type: "message.send_text",
      conversationId,
      tempId: clientMessageId,
      text
    };
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send(event);
      return;
    }
    await fetch(`${this.options.serverBaseUrl}/api/messages/text`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientMessageId,
        deviceId: this.options.device.deviceId,
        conversationId,
        text
      })
    });
    await this.fetchRecent(conversationId);
  }

  async sendVoice(mediaUrl: string, durationMs: number, mimeType: string, conversationId = DEFAULT_CONVERSATION_ID) {
    const clientMessageId = createId();
    const event: SendVoiceEvent = {
      type: "message.send_voice",
      conversationId,
      tempId: clientMessageId,
      mediaUrl,
      durationMs,
      mimeType
    };
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send(event);
      return;
    }
    await fetch(`${this.options.serverBaseUrl}/api/messages/voice`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientMessageId,
        deviceId: this.options.device.deviceId,
        conversationId,
        mediaUrl,
        durationMs,
        mimeType
      })
    });
    await this.fetchRecent(conversationId);
  }

  async sendAttachment(
    kind: "audio" | "image" | "video" | "file",
    attachment: UploadedAttachment,
    conversationId = DEFAULT_CONVERSATION_ID
  ) {
    const clientMessageId = createId();
    const event: SendAttachmentEvent = {
      type: "message.send_attachment",
      conversationId,
      tempId: clientMessageId,
      kind,
      ...attachment
    };
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send(event);
      return;
    }
    await fetch(`${this.options.serverBaseUrl}/api/messages/attachment`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientMessageId,
        deviceId: this.options.device.deviceId,
        conversationId,
        kind,
        ...attachment
      })
    });
    await this.fetchRecent(conversationId);
  }

  private send(event: ClientToServerEvent) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("连接未建立");
    }
    this.socket.send(JSON.stringify(event));
  }

  private handleServerEvent(event: ServerToClientEvent) {
    if (event.type === "sync.batch") {
      this.messages = event.messages
        .map((message) => normalizeMessage(this.options.serverBaseUrl, message))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.emitMessages();
    }
    if (event.type === "message.created") {
      const has = this.messages.some((message) => message.id === event.message.id);
      if (!has) {
        this.messages = [...this.messages, normalizeMessage(this.options.serverBaseUrl, event.message)].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt)
        );
        this.emitMessages();
      }
    }
    if (event.type === "message.status") {
      this.messages = this.messages.map((message) =>
        message.id === event.messageId ? { ...message, status: event.status } : message
      );
      this.emitMessages();
    }
    this.eventListeners.forEach((listener) => listener(event));
  }

  private emitMessages() {
    this.messageListeners.forEach((listener) => listener(this.messages));
  }

  private startPolling() {
    if (this.pollTimer !== null) return;
    void this.fetchRecent();
    this.pollTimer = window.setInterval(() => {
      void this.fetchRecent();
    }, 3000);
  }

  private async fetchRecent(conversationId?: string) {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    const response = await fetch(`${this.options.serverBaseUrl}/api/messages/recent${query}`);
    if (!response.ok) return;
    const payload = (await response.json()) as { messages: ChatMessage[] };
    const normalizedMessages = payload.messages.map((message) => normalizeMessage(this.options.serverBaseUrl, message));
    if (conversationId) {
      const otherMessages = this.messages.filter((message) => message.conversationId !== conversationId);
      this.messages = [...otherMessages, ...normalizedMessages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } else {
      this.messages = normalizedMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    this.emitMessages();
  }
}
