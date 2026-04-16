# Chat Soft 仓库结构建议

```text
chat_soft/
├─ docs/
│  ├─ architecture/
│  ├─ plan/
│  └─ product/
├─ apps/
│  ├─ android/
│  └─ desktop/
├─ server/
│  ├─ api/
│  ├─ worker/
│  └─ deploy/
├─ shared/
│  ├─ schemas/
│  └─ protocol/
└─ tools/
```

## 目录说明

### `apps/android`

- 安卓客户端代码

### `apps/desktop`

- Windows 桌面端代码
- 本地 GUI 与本地 Agent

### `server/api`

- 聊天服务端主程序

### `server/worker`

- 异步任务
- 媒体处理
- 通知任务

### `server/deploy`

- Docker Compose
- 环境变量模板
- 部署脚本

### `shared/schemas`

- 前后端共享数据结构

### `shared/protocol`

- WebSocket 事件协议
- 消息状态枚举
