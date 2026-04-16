# Chat Soft Server 部署说明

## 1. 服务器准备

- Ubuntu 22.04
- 安装 Docker
- 安装 Docker Compose

## 2. 上传项目

把整个 `chat_soft` 目录上传到服务器，例如：

```bash
scp -r chat_soft root@YOUR_SERVER_IP:/opt/chat_soft
```

## 3. 启动服务

```bash
cd /opt/chat_soft/server/deploy
docker compose up -d
```

## 4. 检查状态

```bash
curl http://127.0.0.1:3000/health
```

预期返回：

```json
{"ok":true}
```

## 5. 需要开放的端口

- `3000`

## 6. 第一版连接方式

- HTTP API：`http://SERVER_IP:3000`
- WebSocket：`ws://SERVER_IP:3000/ws`
