import { startLocalAgent } from "./local-agent.js";

startLocalAgent().catch((error) => {
  console.error(error);
  process.exit(1);
});
