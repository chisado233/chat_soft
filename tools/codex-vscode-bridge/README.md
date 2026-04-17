# Chat Soft Codex Bridge

VS Code bridge extension that:

- registers a `Codex Agent` conversation in `chat_soft`
- polls for new mobile messages
- forwards text to a VS Code language model
- sends the final reply back to the mobile conversation

Supported in-chat commands:

- `/models`
- `/model <modelId>`
- `/reset`

Default preferred model:

- `gpt-5.4`

Quick start:

1. Open this folder in VS Code.
2. Run `npm install`.
3. Press `F5` to launch an Extension Development Host.
4. In the new VS Code window, make sure OpenAI Codex is signed in and available.
5. The bridge auto-registers `Codex Agent` to your Chat Soft server.
