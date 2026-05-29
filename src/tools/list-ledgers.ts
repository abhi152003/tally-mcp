import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, tdlEnvelope, parseFlatTdl } from "../tally.js";

function buildTdl() {
  return `
  <REPORT NAME="TallyMcpReport"><FORMS>TallyMcpForm</FORMS></REPORT>
  <FORM NAME="TallyMcpForm"><PARTS>TallyMcpPart</PARTS></FORM>
  <PART NAME="TallyMcpPart">
    <LINES>TallyMcpLine</LINES>
    <REPEAT>TallyMcpLine : LedColl</REPEAT>
    <SCROLL>Vertical</SCROLL>
  </PART>
  <LINE NAME="TallyMcpLine">
    <FIELDS>FldLedName,FldLedParent,FldLedGSTIN,FldLedGSTType</FIELDS>
  </LINE>
  <FIELD NAME="FldLedName"><SET>$Name</SET></FIELD>
  <FIELD NAME="FldLedParent"><SET>$Parent</SET></FIELD>
  <FIELD NAME="FldLedGSTIN"><SET>$PARTYGSTIN</SET></FIELD>
  <FIELD NAME="FldLedGSTType"><SET>$GSTRegistrationType</SET></FIELD>
  <COLLECTION NAME="LedColl"><TYPE>Ledger</TYPE></COLLECTION>
  `;
}

export function registerListLedgers(server: McpServer) {
  server.registerTool(
    "list_ledgers",
    {
      description: "List all ledgers in a TallyPrime company with their parent group, GSTIN, and GST registration type. Use the `search` parameter to filter by name (case-insensitive substring match).",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        search: z
          .string()
          .optional()
          .describe("Optional substring to filter ledger names (case-insensitive)"),
      },
    },
    async ({ company, search }) => {
      const xml = await tallyPost(tdlEnvelope(company, buildTdl()));
      let records = parseFlatTdl(xml, [
        { key: "name", tag: "FLDLEDNAME" },
        { key: "parent", tag: "FLDLEDPARENT" },
        { key: "gstin", tag: "FLDLEDGSTIN" },
        { key: "gst_type", tag: "FLDLEDGSTTYPE" },
      ]);

      if (search) {
        const q = search.toLowerCase();
        records = records.filter((r) => r.name.toLowerCase().includes(q));
      }

      if (records.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: search
                ? `No ledgers matching "${search}" found in ${company}.`
                : `No ledgers found in ${company}. Verify the company name.`,
            },
          ],
        };
      }

      const lines = records.map((r) => {
        let line = `• ${r.name} [${r.parent}]`;
        if (r.gstin) line += ` GSTIN: ${r.gstin}`;
        if (r.gst_type) line += ` (${r.gst_type})`;
        return line;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${records.length} ledger(s) in ${company}${search ? ` matching "${search}"` : ""}:\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}
