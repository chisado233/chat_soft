import { createRequire } from "node:module";
import { join } from "node:path";
import { startLocalAgent } from "./local-agent.js";

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron/main") as {
  app: {
    whenReady: () => Promise<void>;
    on: (event: string, listener: () => void) => void;
    quit: () => void;
  };
  BrowserWindow: new (options: {
    width: number;
    height: number;
    webPreferences?: {
      preload?: string | undefined;
    };
  }) => {
    loadURL: (url: string) => Promise<void>;
    loadFile: (path: string) => Promise<void>;
  };
};

async function createWindow() {
  const window = new BrowserWindow({
    width: 1366,
    height: 860,
    webPreferences: {
      preload: undefined
    }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await window.loadURL(devUrl);
  } else {
    await window.loadFile(join(process.cwd(), "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  await startLocalAgent();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
