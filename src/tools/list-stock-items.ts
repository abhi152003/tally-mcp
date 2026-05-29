import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, tdlEnvelope, parseFlatTdl } from "../tally.js";

function buildTdl() {
  return `
  <REPORT NAME="TallyMcpReport"><FORMS>TallyMcpForm</FORMS></REPORT>
  <FORM NAME="TallyMcpForm"><PARTS>TallyMcpPart</PARTS></FORM>
  <PART NAME="TallyMcpPart">
    <LINES>TallyMcpLine</LINES>
    <REPEAT>TallyMcpLine : StkColl</REPEAT>
    <SCROLL>Vertical</SCROLL>
  </PART>
  <LINE NAME="TallyMcpLine">
    <FIELDS>FldStkName,FldStkUnit,FldStkHSN,FldStkGST</FIELDS>
  </LINE>
  <FIELD NAME="FldStkName"><SET>$Name</SET></FIELD>
  <FIELD NAME="FldStkUnit"><SET>$BaseUnits</SET></FIELD>
  <FIELD NAME="FldStkHSN"><SET>$$String:$HSNDetails[Last].HSNCode</SET></FIELD>
  <FIELD NAME="FldStkGST"><SET>$$String:$GstDetails[Last].STATEWISEDETAILS[1].RateDetails[1, @@IsIGST].GSTRate</SET></FIELD>
  <COLLECTION NAME="StkColl">
    <TYPE>Stock Item</TYPE>
    <FETCH>Name,BaseUnits,HSNDetails,GstDetails</FETCH>
  </COLLECTION>
  `;
}

export function registerListStockItems(server: McpServer) {
  server.registerTool(
    "list_stock_items",
    {
      description: "List stock items in a TallyPrime company with their unit of measure, HSN code, and GST rate. Use the `search` parameter to filter by name.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        search: z
          .string()
          .optional()
          .describe("Optional substring to filter item names (case-insensitive)"),
      },
    },
    async ({ company, search }) => {
      const xml = await tallyPost(tdlEnvelope(company, buildTdl()));
      let records = parseFlatTdl(xml, [
        { key: "name", tag: "FLDSTKNAME" },
        { key: "unit", tag: "FLDSTKUNIT" },
        { key: "hsn", tag: "FLDSTKHSN" },
        { key: "gst_rate", tag: "FLDSTKGST" },
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
                ? `No stock items matching "${search}" found in ${company}.`
                : `No stock items found in ${company}.`,
            },
          ],
        };
      }

      const lines = records.map((r) => {
        let line = `• ${r.name}`;
        if (r.unit) line += ` [${r.unit}]`;
        if (r.hsn && r.hsn !== "Not Found") line += ` | HSN: ${r.hsn}`;
        if (r.gst_rate && r.gst_rate !== "Not Found") line += ` | GST: ${r.gst_rate}%`;
        return line;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${records.length} item(s) in ${company}${search ? ` matching "${search}"` : ""}:\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}
