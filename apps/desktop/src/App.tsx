import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ChatClient, createId } from "@chat-soft/core";
import type { AgentInfo, ChatMessage, DeviceInfo } from "@chat-soft/protocol";

function formatMessage(message: ChatMessage) {
  if (message.kind === "text") return message.text;
  if (message.kind === "voice") return `[语音] ${Math.round(message.durationMs / 1000)} 秒`;
  if (message.kind === "audio") return `[音频] ${message.fileName}`;
  if (message.kind === "image") return `[图片] ${message.fileName}`;
  if (message.kind === "video") return `[视频] ${message.fileName}`;
  return `[文件] ${message.fileName}`;
}

function renderMessageBody(message: ChatMessage) {
  if (message.kind === "text") {
    return <p>{message.text}</p>;
  }
  if (message.kind === "voice" || message.kind === "audio") {
    return <audio controls preload="metadata" src={message.mediaUrl}></audio>;
  }
  if (message.kind === "image") {
    return (
      <a href={message.mediaUrl} target="_blank" rel="noreferrer">
        <img className="message-image" src={message.mediaUrl} alt={message.fileName} />
      </a>
    );
  }
  if (message.kind === "video") {
    return <video className="message-video" controls preload="metadata" src={message.mediaUrl}></video>;
  }
  return (
    <a href={message.mediaUrl} target="_blank" rel="noreferrer" className="file-link">
      {message.fileName}
    </a>
  );
}

function avatarText(title: string) {
  const cleaned = title.trim();
  if (!cleaned) return "?";
  return cleaned.slice(0, 1).toUpperCase();
}

function Avatar({ title, avatarUrl }: { title: string; avatarUrl?: string }) {
  return (
    <div className="message-avatar" aria-label={title}>
      {avatarUrl ? <img className="avatar-image" src={avatarUrl} alt={title} /> : avatarText(title)}
    </div>
  );
}

export function App({ platform }: { platform: DeviceInfo["platform"] }) {
  const [serverBaseUrl, setServerBaseUrl] = useState(localStorage.getItem("chatsoft.serverBaseUrl") ?? "http://127.0.0.1:3000");
  const [deviceName, setDeviceName] = useState(localStorage.getItem("chatsoft.deviceName") ?? "Windows-PC");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [pickerKind, setPickerKind] = useState<"audio" | "image" | "video" | "file">("file");
  const mediaChunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef<number>(0);
  const filePickerRef = useRef<HTMLInputElement | null>(null);

  const deviceId = useMemo(() => {
    const existing = localStorage.getItem("chatsoft.deviceId");
    if (existing) return existing;
    const next = createId();
    localStorage.setItem("chatsoft.deviceId", next);
    return next;
  }, []);

  const client = useMemo(() => {
    const normalized = serverBaseUrl.replace(/\/$/, "");
    const wsUrl = normalized.replace("http", "ws") + "/ws";
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

  useEffect(() => {
    localStorage.setItem("chatsoft.serverBaseUrl", serverBaseUrl);
    localStorage.setItem("chatsoft.deviceName", deviceName);
  }, [deviceName, serverBaseUrl]);

  useEffect(() => {
    fetch("http://127.0.0.1:45888/api/v1/config", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        serverBaseUrl,
        deviceId,
        deviceName
      })
    }).catch(() => undefined);
  }, [deviceId, deviceName, serverBaseUrl]);

  useEffect(() => {
    async function refreshAgents() {
      try {
        const payload = await client.listAgents();
        setAgents(payload.agents);
      } catch {
        setAgents([]);
      }
    }

    client.connect();
    void refreshAgents();
    const offMessages = client.onMessages((incoming) => {
      setMessages(incoming);
    });
    const offEvents = client.onEvent((event) => {
      if (event.type === "message.created" && event.message.senderDeviceId !== deviceId) {
        if ("Notification" in window) {
          if (Notification.permission === "granted") {
            new Notification("Chat Soft", { body: formatMessage(event.message) });
          } else if (Notification.permission !== "denied") {
            Notification.requestPermission();
          }
        }
        void refreshAgents();
      }
    });
    return () => {
      offMessages();
      offEvents();
      client.disconnect();
    };
  }, [client, deviceId]);

  const agentByDeviceId = useMemo(
    () => new Map(agents.map((agent) => [agent.agentDeviceId, agent])),
    [agents]
  );

  async function startRecording() {
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
      await client.sendVoice(serverBaseUrl.replace(/\/$/, "") + uploaded.mediaUrl, uploaded.durationMs, uploaded.mimeType);
      stream.getTracks().forEach((track) => track.stop());
    };
    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function handleAttachmentSelect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const uploaded = await client.uploadAttachment(file, pickerKind, file.name);
    await client.sendAttachment(pickerKind, uploaded);
    event.target.value = "";
  }

  return (
    <div className="app-shell">
      <aside className="config-panel">
        <h1>Chat Soft</h1>
        <label>
          服务器地址
          <input value={serverBaseUrl} onChange={(event) => setServerBaseUrl(event.target.value)} />
        </label>
        <label>
          设备名称
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
        </label>
      </aside>
      <main className="chat-panel">
        <section className="messages">
          {messages.map((message) => {
            const isSelf = message.senderDeviceId === deviceId;
            const boundAgent = agentByDeviceId.get(message.senderDeviceId);
            const senderTitle = isSelf ? "我" : boundAgent?.name ?? message.senderDeviceId;
            return (
              <article key={message.id} className={`message-row ${isSelf ? "self" : "peer"}`}>
                {!isSelf && <Avatar title={senderTitle} avatarUrl={boundAgent?.avatarUrl} />}
                <div className={`message-card ${isSelf ? "self" : "peer"}`}>
                  <div className="message-meta">
                    <span>{senderTitle}</span>
                    <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                    <span>{message.status}</span>
                  </div>
                  {renderMessageBody(message)}
                </div>
                {isSelf && <Avatar title="我" />}
              </article>
            );
          })}
        </section>
        <section className="composer">
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="输入文本消息" />
          <div className="composer-actions">
            <input
              ref={filePickerRef}
              type="file"
              className="hidden-picker"
              accept={
                pickerKind === "audio"
                  ? "audio/*"
                  : pickerKind === "image"
                    ? "image/*"
                    : pickerKind === "video"
                      ? "video/*"
                      : "*/*"
              }
              onChange={handleAttachmentSelect}
            />
            <button
              onClick={() => {
                if (!text.trim()) return;
                void client.sendText(text.trim());
                setText("");
              }}
            >
              发送文本
            </button>
            <button onMouseDown={startRecording} onMouseUp={stopRecording} onMouseLeave={() => recording && stopRecording()}>
              {recording ? "松开发送语音" : "按住录音"}
            </button>
            <button
              onClick={() => {
                setPickerKind("image");
                filePickerRef.current?.click();
              }}
            >
              图片
            </button>
            <button
              onClick={() => {
                setPickerKind("video");
                filePickerRef.current?.click();
              }}
            >
              视频
            </button>
            <button
              onClick={() => {
                setPickerKind("audio");
                filePickerRef.current?.click();
              }}
            >
              音频
            </button>
            <button
              onClick={() => {
                setPickerKind("file");
                filePickerRef.current?.click();
              }}
            >
              文件
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
