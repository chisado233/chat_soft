import { useEffect, useMemo, useRef, useState } from "react";
import { ChatClient } from "@chat-soft/core";
import type { ChatMessage, DeviceInfo } from "@chat-soft/protocol";

export function App({ platform }: { platform: DeviceInfo["platform"] }) {
  const [serverBaseUrl, setServerBaseUrl] = useState(localStorage.getItem("chatsoft.mobile.serverBaseUrl") ?? "http://127.0.0.1:3000");
  const [deviceName, setDeviceName] = useState(localStorage.getItem("chatsoft.mobile.deviceName") ?? "Huawei-P60");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const mediaChunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef<number>(0);

  const deviceId = useMemo(() => {
    const existing = localStorage.getItem("chatsoft.mobile.deviceId");
    if (existing) return existing;
    const next = crypto.randomUUID();
    localStorage.setItem("chatsoft.mobile.deviceId", next);
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
    localStorage.setItem("chatsoft.mobile.serverBaseUrl", serverBaseUrl);
    localStorage.setItem("chatsoft.mobile.deviceName", deviceName);
  }, [deviceName, serverBaseUrl]);

  useEffect(() => {
    client.connect();
    const off = client.onMessages(setMessages);
    return () => {
      off();
      client.disconnect();
    };
  }, [client]);

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
    <div className="mobile-shell">
      <header>
        <h1>Chat Soft</h1>
        <div className="inline-settings">
          <input value={serverBaseUrl} onChange={(event) => setServerBaseUrl(event.target.value)} placeholder="服务器地址" />
          <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="设备名称" />
        </div>
      </header>
      <main className="mobile-messages">
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.senderDeviceId === deviceId ? "self" : "peer"}`}>
            {message.kind === "text" ? <p>{message.text}</p> : <audio controls preload="none" src={message.mediaUrl}></audio>}
            <small>{message.status}</small>
          </div>
        ))}
      </main>
      <footer className="mobile-composer">
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="输入消息" />
        <div className="mobile-actions">
          <button
            onClick={() => {
              if (!text.trim()) return;
              client.sendText(text.trim());
              setText("");
            }}
          >
            发送
          </button>
          <button onTouchStart={startRecording} onTouchEnd={stopRecording}>
            {recording ? "松开发送" : "按住录音"}
          </button>
        </div>
      </footer>
    </div>
  );
}
