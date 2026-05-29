import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, tdlEnvelope, parseFlatTdl } from "../tally.js";

const TDL = `
  <REPORT NAME="TallyMcpReport"><FORMS>TallyMcpForm</FORMS></REPORT>
  <FORM NAME="TallyMcpForm"><PARTS>TallyMcpPart</PARTS></FORM>
  <PART NAME="TallyMcpPart">
    <LINES>TallyMcpLine</LINES>
    <REPEAT>TallyMcpLine : VchTypeColl</REPEAT>
    <SCROLL>Vertical</SCROLL>
  </PART>
  <LINE NAME="TallyMcpLine">
    <FIELDS>FldVchName,FldVchParent,FldVchClass,FldVchIsActive</FIELDS>
  </LINE>
  <FIELD NAME="FldVchName"><SET>$Name</SET></FIELD>
  <FIELD NAME="FldVchParent"><SET>$Parent</SET></FIELD>
  <FIELD NAME="FldVchClass"><SET>$DefaultClass</SET></FIELD>
  <FIELD NAME="FldVchIsActive"><SET>$$String:$IsActive</SET></FIELD>
  <COLLECTION NAME="VchTypeColl"><TYPE>VoucherType</TYPE></COLLECTION>
`;

export function registerListVoucherTypes(server: McpServer) {
  server.registerTool(
    "list_voucher_types",
    {
      description: "List all voucher types configured in a TallyPrime company, including their parent type and default class. Use this to discover whether a company uses custom voucher classes (e.g. 'Purchase @ 18 %') before posting any voucher.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
      },
    },
    async ({ company }) => {
      const xml = await tallyPost(tdlEnvelope(company, TDL));
      const records = parseFlatTdl(xml, [
        { key: "name", tag: "FLDVCHNAME" },
        { key: "parent", tag: "FLDVCHPARENT" },
        { key: "default_class", tag: "FLDVCHCLASS" },
        { key: "is_active", tag: "FLDVCHISACTIVE" },
      ]);

      if (records.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No voucher types found for ${company}.` },
          ],
        };
      }

      // Group by parent type, only show active / relevant ones
      const coreParents = new Set([
        "Purchase", "Sales", "Payment", "Receipt", "Contra",
        "Journal", "Credit Note", "Debit Note",
      ]);
      const relevant = records.filter(
        (r) => coreParents.has(r.parent) || coreParents.has(r.name)
      );
      const others = records.filter((r) => !relevant.includes(r));

      // Tally uses  as a word separator internally for "DefaultVoucherClass"
      const isDefaultClass = (c: string) =>
        !c || c.includes("") || c.toLowerCase().includes("default");

      const fmt = (r: Record<string, string>) => {
        const hasCustomClass = r.default_class && !isDefaultClass(r.default_class);
        return `  • ${r.name}${hasCustomClass ? ` [class: ${r.default_class}]` : ""}`;
      };

      const sections: string[] = [];
      if (relevant.length > 0) {
        sections.push(`Core voucher types:\n${relevant.map(fmt).join("\n")}`);
      }
      if (others.length > 0) {
        sections.push(`Other types (${others.length}):\n${others.map(fmt).join("\n")}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: sections.join("\n\n"),
          },
        ],
      };
    }
  );
}
