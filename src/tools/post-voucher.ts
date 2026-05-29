import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, parseImportResult } from "../tally.js";

export function registerPostVoucher(server: McpServer) {
  server.registerTool(
    "post_voucher",
    {
      description: "Post a voucher (or ledger/master) to TallyPrime by sending the full XML envelope. The XML must be a complete Import Data envelope. Returns CREATED/ERRORS count and any error messages from Tally. Always verify with get_vouchers after a successful post.",
      inputSchema: {
        xml: z
          .string()
          .describe(
            "Complete TallyPrime XML envelope for Import Data (includes HEADER, BODY, IMPORTDATA, REQUESTDESC, REQUESTDATA, TALLYMESSAGE, and the VOUCHER or LEDGER element)."
          ),
      },
    },
    async ({ xml }) => {
      if (!xml.includes("<TALLYREQUEST>")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid XML: must be a complete TallyPrime Import Data envelope containing <TALLYREQUEST>.",
            },
          ],
        };
      }

      const response = await tallyPost(xml);
      const result = parseImportResult(response);

      if (result.errors > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `POST FAILED — Errors: ${result.errors}\n${result.errorText || "No detailed error message from Tally. Check the XML structure."}`,
            },
          ],
        };
      }

      if (result.created === 0 && result.altered === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `WARNING: Tally accepted the request but reported CREATED=0, ALTERED=0. The voucher may not have been saved. Raw response snippet:\n${response.slice(0, 400)}`,
            },
          ],
        };
      }

      const action = result.created > 0 ? `Created: ${result.created}` : "";
      const alt = result.altered > 0 ? `Altered: ${result.altered}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `SUCCESS — ${[action, alt].filter(Boolean).join(", ")}. Now call get_vouchers to verify the entry.`,
          },
        ],
      };
    }
  );
}
