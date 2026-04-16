import { useEffect, useMemo, useRef, useState } from "react";
import { ChatClient, createId } from "@chat-soft/core";
import type { AgentInfo, ChatMessage, ConversationSummary, DeviceInfo } from "@chat-soft/protocol";

export function App({ platform }: { platform: DeviceInfo["platform"] }) {
  const [serverBaseUrl, setServerBaseUrl] = useState(
    localStorage.getItem("chatsoft.mobile.serverBaseUrl") ?? "http://39.106.125.149:3000"
  );
  const [deviceName, setDeviceName] = useState(localStorage.getItem("chatsoft.mobile.deviceName") ?? "Huawei-P60");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>("");
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(true);
  const mediaChunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef<number>(0);

  const deviceId = useMemo(() => {
    const existing = localStorage.getItem("chatsoft.mobile.deviceId");
    if (existing) return existing;
    const next = createId();
    localStorage.setItem("chatsoft.mobile.deviceId", next);
    return next;
  }, []);

  const client = useMemo(() => {
    const normalized = serverBaseUrl.replace(/\/$/, "");
    const httpUrl = new URL(normalized);
    const wsProtocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${httpUrl.host}/ws`;
    return new ChatClient({
      serverBaseUrl: normalized,
      wsUrl,
      device: {
        deviceId,
        deviceName,
        platform
      }
    });
  }, [deviceId, deviceName, platform, serverBaseUrl]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );

  const visibleMessages = useMemo(
    () =>
      allMessages
        .filter((message) => message.conversationId === activeConversationId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [activeConversationId, allMessages]
  );

  useEffect(() => {
    localStorage.setItem("chatsoft.mobile.serverBaseUrl", serverBaseUrl);
    localStorage.setItem("chatsoft.mobile.deviceName", deviceName);
  }, [deviceName, serverBaseUrl]);

  useEffect(() => {
    async function loadSidebar() {
      setLoading(true);
      try {
        const [agentPayload, conversationPayload] = await Promise.all([client.listAgents(), client.listConversations()]);
        setAgents(agentPayload.agents);
        setConversations(conversationPayload.conversations);
        setActiveConversationId((current) => current || conversationPayload.conversations[0]?.conversationId || "");
      } finally {
        setLoading(false);
      }
    }

    client.connect();
    void loadSidebar();

    const offMessages = client.onMessages((messages) => {
      setAllMessages(messages);
    });
    const offEvents = client.onEvent((event) => {
      if (event.type === "message.created") {
        void client.listConversations().then((payload) => {
          setConversations(payload.conversations);
          setActiveConversationId((current) => current || payload.conversations[0]?.conversationId || "");
        });
      }
    });

    return () => {
      offMessages();
      offEvents();
      client.disconnect();
    };
  }, [client]);

  async function startRecording() {
    if (!activeConversationId) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    mediaChunksRef.current = [];
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    recorder.ondataavailable = (event) => {
      mediaChunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(mediaChunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const durationMs = Date.now() - startedAtRef.current;
      const uploaded = await client.uploadVoice(blob, durationMs);
      await client.sendVoice(
        serverBaseUrl.replace(/\/$/, "") + uploaded.mediaUrl,
        uploaded.durationMs,
        uploaded.mimeType,
        activeConversationId
      );
      stream.getTracks().forEach((track) => track.stop());
    };
    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <h1>Chat Soft</h1>
        <div className="inline-settings">
          <input value={serverBaseUrl} onChange={(event) => setServerBaseUrl(event.target.value)} placeholder="服务器地址" />
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="设备名称" />
        </div>
      </header>

      <section className="agent-strip">
        <div className="section-title">Agent 列表</div>
        <div className="agent-scroll">
          {agents.map((agent) => (
            <button
              key={agent.agentId}
              className={`agent-chip ${activeConversationId === agent.conversationId ? "active" : ""}`}
              onClick={() => setActiveConversationId(agent.conversationId)}
            >
              <strong>{agent.name}</strong>
              <span>{agent.status}</span>
            </button>
          ))}
          {agents.length === 0 && <div className="empty-hint">还没有注册任何 agent</div>}
        </div>
      </section>

      <main className="mobile-content">
        <section className="conversation-list">
          <div className="section-title">会话</div>
          {loading && <div className="empty-hint">加载中...</div>}
          {!loading &&
            conversations.map((conversation) => (
              <button
                key={conversation.conversationId}
                className={`conversation-card ${activeConversationId === conversation.conversationId ? "active" : ""}`}
                onClick={() => setActiveConversationId(conversation.conversationId)}
              >
                <strong>{conversation.title}</strong>
                <span>{conversation.type === "agent" ? "Agent" : "设备"}</span>
                <small>{conversation.lastMessage?.kind === "text" ? conversation.lastMessage.text : "暂无消息"}</small>
              </button>
            ))}
        </section>

        <section className="conversation-panel">
          <div className="conversation-title">{activeConversation?.title ?? "选择一个会话"}</div>
          <div className="mobile-messages">
            {visibleMessages.map((message) => (
              <div key={message.id} className={`bubble ${message.senderDeviceId === deviceId ? "self" : "peer"}`}>
                {message.kind === "text" ? <p>{message.text}</p> : <audio controls preload="none" src={message.mediaUrl}></audio>}
                <small>{message.status}</small>
              </div>
            ))}
            {activeConversationId && visibleMessages.length === 0 && <div className="empty-hint">这个会话里还没有消息</div>}
          </div>
        </section>
      </main>

      <footer className="mobile-composer">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={activeConversationId ? "输入消息" : "先选择一个会话"}
          disabled={!activeConversationId}
        />
        <div className="mobile-actions">
          <button
            disabled={!activeConversationId}
            onClick={() => {
              if (!text.trim() || !activeConversationId) return;
              void client.sendText(text.trim(), activeConversationId);
              setText("");
            }}
          >
            发送
          </button>
          <button disabled={!activeConversationId} onTouchStart={startRecording} onTouchEnd={stopRecording}>
            {recording ? "松开发送" : "按住录音"}
          </button>
        </div>
      </footer>
    </div>
  );
}
