export type MessageKind = "text" | "voice";
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

export interface BaseMessage {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  kind: MessageKind;
  createdAt: string;
  status: MessageStatus;
}

export interface TextMessage extends BaseMessage {
  kind: "text";
  text: string;
}

export interface VoiceMessage extends BaseMessage {
  kind: "voice";
  mediaUrl: string;
  durationMs: number;
  mimeType: string;
}

export type ChatMessage = TextMessage | VoiceMessage;

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: "android" | "windows" | "unknown";
}

export interface ConversationState {
  conversationId: string;
  messages: ChatMessage[];
}

export interface HelloEvent {
  type: "auth.hello";
  device: DeviceInfo;
}

export interface ReadyEvent {
  type: "auth.ready";
  deviceId: string;
  conversationId: string;
}

export interface SendTextEvent {
  type: "message.send_text";
  conversationId: string;
  tempId: string;
  text: string;
}

export interface SendVoiceEvent {
  type: "message.send_voice";
  conversationId: string;
  tempId: string;
  mediaUrl: string;
  durationMs: number;
  mimeType: string;
}

export interface MessageCreatedEvent {
  type: "message.created";
  message: ChatMessage;
}

export interface MessageStatusEvent {
  type: "message.status";
  messageId: string;
  status: MessageStatus;
}

export interface SyncPullEvent {
  type: "sync.pull";
}

export interface SyncBatchEvent {
  type: "sync.batch";
  conversationId: string;
  messages: ChatMessage[];
}

export interface MarkReadEvent {
  type: "message.read";
  messageId: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type ClientToServerEvent =
  | HelloEvent
  | SendTextEvent
  | SendVoiceEvent
  | SyncPullEvent
  | MarkReadEvent;

export type ServerToClientEvent =
  | ReadyEvent
  | MessageCreatedEvent
  | MessageStatusEvent
  | SyncBatchEvent
  | ErrorEvent;

export const DEFAULT_CONVERSATION_ID = "primary";

export const LOCAL_AGENT_PORT = 45888;
