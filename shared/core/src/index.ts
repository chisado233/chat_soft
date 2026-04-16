import type {
  ChatMessage,
  ClientToServerEvent,
  DeviceInfo,
  SendTextEvent,
  SendVoiceEvent,
  ServerToClientEvent
} from "@chat-soft/protocol";
import { DEFAULT_CONVERSATION_ID } from "@chat-soft/protocol";

type Listener = (messages: ChatMessage[]) => void;
type EventListener = (event: ServerToClientEvent) => void;

export interface ChatClientOptions {
  serverBaseUrl: string;
  wsUrl: string;
  device: DeviceInfo;
}

export class ChatClient {
  private socket: WebSocket | null = null;
  private messages: ChatMessage[] = [];
  private messageListeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();

  constructor(private readonly options: ChatClientOptions) {}

  connect() {
    if (this.socket && this.socket.readyState <= 1) return;
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
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
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
    return payload;
  }

  sendText(text: string) {
    const event: SendTextEvent = {
      type: "message.send_text",
      conversationId: DEFAULT_CONVERSATION_ID,
      tempId: crypto.randomUUID(),
      text
    };
    this.send(event);
  }

  sendVoice(mediaUrl: string, durationMs: number, mimeType: string) {
    const event: SendVoiceEvent = {
      type: "message.send_voice",
      conversationId: DEFAULT_CONVERSATION_ID,
      tempId: crypto.randomUUID(),
      mediaUrl,
      durationMs,
      mimeType
    };
    this.send(event);
  }

  private send(event: ClientToServerEvent) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("连接未建立");
    }
    this.socket.send(JSON.stringify(event));
  }

  private handleServerEvent(event: ServerToClientEvent) {
    if (event.type === "sync.batch") {
      this.messages = event.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.emitMessages();
    }
    if (event.type === "message.created") {
      const has = this.messages.some((message) => message.id === event.message.id);
      if (!has) {
        this.messages = [...this.messages, event.message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
}
