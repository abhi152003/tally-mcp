import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tallyPost } from "../tally.js";

export function registerPing(server: McpServer) {
  server.registerTool(
    "ping",
    { description: "Check if TallyPrime is running and reachable. Call this first in every session." },
    async () => {
      try {
        const body = await tallyPost("");
        const running = body.includes("TallyPrime Server is Running");
        return {
          content: [
            {
              type: "text" as const,
              text: running
                ? "TallyPrime is running and reachable."
                : `Unexpected response from Tally: ${body.slice(0, 200)}`,
            },
          ],
        };
      } catch (e: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot reach TallyPrime: ${(e as Error).message}. Ask the user to open TallyPrime and enable XML integration on port ${process.env.TALLY_URL ?? "http://localhost:9000"}.`,
            },
          ],
        };
      }
    }
  );
}
