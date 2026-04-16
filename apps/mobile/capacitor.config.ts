import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "chat.soft.app",
  appName: "Chat Soft",
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
