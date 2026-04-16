import { useEffect, useMemo, useRef, useState } from "react";
import { ChatClient } from "@chat-soft/core";
import type { ChatMessage, DeviceInfo } from "@chat-soft/protocol";

function formatMessage(message: ChatMessage) {
  if (message.kind === "text") return message.text;
  return `[语音] ${Math.round(message.durationMs / 1000)} 秒`;
}

export function App({ platform }: { platform: DeviceInfo["platform"] }) {
  const [serverBaseUrl, setServerBaseUrl] = useState(localStorage.getItem("chatsoft.serverBaseUrl") ?? "http://127.0.0.1:3000");
  const [deviceName, setDeviceName] = useState(localStorage.getItem("chatsoft.deviceName") ?? "Windows-PC");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const mediaChunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef<number>(0);

  const deviceId = useMemo(() => {
    const existing = localStorage.getItem("chatsoft.deviceId");
    if (existing) return existing;
    const next = crypto.randomUUID();
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
    client.connect();
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
      }
    });
    return () => {
      offMessages();
      offEvents();
      client.disconnect();
    };
  }, [client, deviceId]);

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
      client.sendVoice(serverBaseUrl.replace(/\/$/, "") + uploaded.mediaUrl, uploaded.durationMs, uploaded.mimeType);
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
          {messages.map((message) => (
            <article key={message.id} className={`message-card ${message.senderDeviceId === deviceId ? "self" : "peer"}`}>
              <div className="message-meta">
                <span>{message.senderDeviceId === deviceId ? "我" : message.senderDeviceId}</span>
                <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                <span>{message.status}</span>
              </div>
              {message.kind === "text" ? (
                <p>{message.text}</p>
              ) : (
                <audio controls preload="none" src={message.mediaUrl}></audio>
              )}
            </article>
          ))}
        </section>
        <section className="composer">
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="输入文本消息" />
          <div className="composer-actions">
            <button
              onClick={() => {
                if (!text.trim()) return;
                client.sendText(text.trim());
                setText("");
              }}
            >
              发送文本
            </button>
            <button onMouseDown={startRecording} onMouseUp={stopRecording} onMouseLeave={() => recording && stopRecording()}>
              {recording ? "松开发送语音" : "按住录音"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
