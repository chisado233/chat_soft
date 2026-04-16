const { startLocalAgent } = require("./local-agent.cjs");

startLocalAgent().catch((error) => {
  console.error(error);
  process.exit(1);
});
