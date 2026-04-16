const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

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
    return;
  }

  await window.loadFile(join(process.cwd(), "dist", "index.html"));
}

app.whenReady().then(async () => {
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
