# Chat Soft V1 技术选型建议

## 1. 选型目标

V1 的目标不是一步到位做到最强，而是：

- 快速跑通
- 跨端可维护
- 易于后续扩展
- 能给 AI 留接口

## 2. 推荐技术栈

## 2.1 Android 客户端

- 语言：Kotlin
- UI：Jetpack Compose
- 本地存储：Room + SQLite
- 网络：Ktor Client 或 OkHttp + WebSocket
- 音频录制：MediaRecorder / AudioRecord
- 音频播放：ExoPlayer 或 MediaPlayer

选择理由：

- 安卓原生支持最好
- 后续做录音、通知、前台服务更自然

## 2.2 Windows 客户端

推荐：

- 桌面壳：Tauri
- 前端：React
- 本地服务层：Rust
- 本地数据库：SQLite
- 本地 API：Rust 内置 HTTP + WebSocket + CLI

选择理由：

- Windows 打包相对轻
- Rust 适合做本地 Agent 和接口层
- 后续对接 AI、本地自动化和系统权限更灵活

备选：

- Electron + Node.js

不作为首选原因：

- 资源占用更高
- 后续本地服务能力虽然也能做，但整体更重

## 2.3 服务端

- 语言：TypeScript
- 运行时：Node.js
- 框架：NestJS 或 Fastify
- 实时链路：WebSocket
- 数据库：PostgreSQL
- 缓存/队列：Redis
- 媒体存储：本机磁盘目录

推荐优先：

- `Node.js + Fastify + ws + PostgreSQL + Redis`

理由：

- V1 开发速度快
- 实时通信和后台任务足够
- 后期若要拆服务也容易

## 2.4 部署

- 云服务器：香港轻量应用服务器
- 系统：Ubuntu 22.04 LTS
- 部署方式：Docker Compose

## 3. V1 模块拆分

### 3.1 server

- auth-service
- device-service
- chat-service
- sync-service
- media-service
- notification-service

### 3.2 windows-app

- desktop-ui
- desktop-core
- local-agent

### 3.3 android-app

- android-ui
- android-core
- sync-engine

### 3.4 shared

- api-schema
- message-model
- event-model

## 4. 为什么不建议 V1 直接上 WebRTC

V1 先只做文本和语音消息，不做实时通话。

原因：

- WebRTC 会引入 STUN/TURN、编解码、弱网问题
- 会明显拖慢第一版验证速度
- 当前第一目标是把消息链路和媒体链路跑稳

## 5. 为什么服务端用中心化消息模型

- 最容易做离线补收
- 最容易做多设备同步
- 最容易观察延迟和问题
- 最容易给 AI 提供稳定接口

## 6. V1 电脑端 AI 接口建议

### HTTP

- `POST /api/messages/text`
- `POST /api/messages/voice`
- `GET /api/messages/recent`
- `GET /api/messages/search`

### WebSocket

- `message.created`
- `message.updated`
- `sync.completed`

### CLI

- `chatsoft send-text`
- `chatsoft send-voice`
- `chatsoft recent`
- `chatsoft search`

## 7. 关键风险

- 香港节点到内地移动网络的链路波动
- 语音消息上传下载体验
- 多设备同步状态一致性
- 本地 API 的权限控制

## 8. V1 技术结论

推荐方案：

- Android：Kotlin + Compose
- Windows：Tauri + Rust + React
- Server：Node.js + Fastify + PostgreSQL + Redis
- Deploy：香港轻量服务器 + Docker Compose
