# Chat Soft V1 接口草案

## 1. 服务端对客户端

### 1.1 WebSocket 事件

#### client -> server

- `auth.hello`
- `sync.pull`
- `message.send_text`
- `message.send_voice_meta`
- `message.read`

#### server -> client

- `auth.ready`
- `sync.batch`
- `message.created`
- `message.status`
- `message.read`
- `error`

## 2. 电脑端本地 AI 接口

## 2.1 HTTP

### `POST /api/v1/messages/text`

请求：

```json
{
  "conversationId": "conv_123",
  "text": "hello"
}
```

### `POST /api/v1/messages/voice`

请求：

- `multipart/form-data`
- 包含音频文件
- 包含 `conversationId`

### `GET /api/v1/messages/recent?limit=50`

返回最近消息。

### `GET /api/v1/messages/search?q=keyword`

返回搜索结果。

## 2.2 WebSocket

事件：

- `message.created`
- `message.updated`
- `sync.completed`

## 2.3 CLI

```bash
chatsoft send-text --conversation conv_123 --text "hello"
chatsoft send-voice --conversation conv_123 --file ./voice.m4a
chatsoft recent --limit 20
chatsoft search --query "keyword"
```

## 3. 鉴权

### 服务端

- 设备首次配对获取 device token
- 后续使用 access token

### 本地 AI 接口

- 仅监听 127.0.0.1
- 请求头携带本地 token
- CLI 从本地配置读取 token
