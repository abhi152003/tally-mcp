import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tallyPost, tdlEnvelope, parseFlatTdl } from "../tally.js";

const TDL = `
  <REPORT NAME="TallyMcpReport"><FORMS>TallyMcpForm</FORMS></REPORT>
  <FORM NAME="TallyMcpForm"><PARTS>TallyMcpPart</PARTS></FORM>
  <PART NAME="TallyMcpPart">
    <LINES>TallyMcpLine</LINES>
    <REPEAT>TallyMcpLine : CmpColl</REPEAT>
    <SCROLL>Vertical</SCROLL>
  </PART>
  <LINE NAME="TallyMcpLine">
    <FIELDS>FldCmpName,FldCmpState,FldCmpGSTIN</FIELDS>
  </LINE>
  <FIELD NAME="FldCmpName"><SET>$Name</SET></FIELD>
  <FIELD NAME="FldCmpState"><SET>$StateName</SET></FIELD>
  <FIELD NAME="FldCmpGSTIN"><SET>$GSTNumber</SET></FIELD>
  <COLLECTION NAME="CmpColl"><TYPE>Company</TYPE></COLLECTION>
`;

export function registerListCompanies(server: McpServer) {
  server.registerTool(
    "list_companies",
    { description: "List all companies currently open in TallyPrime. Always call this before any other operation to confirm the exact company name." },
    async () => {
      const xml = await tallyPost(tdlEnvelope("", TDL));
      const records = parseFlatTdl(xml, [
        { key: "name", tag: "FLDCMPNAME" },
        { key: "state", tag: "FLDCMPSTATE" },
        { key: "gstin", tag: "FLDCMPGSTIN" },
      ]);
      if (records.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No companies are open in TallyPrime. Ask the user to open a company.",
            },
          ],
        };
      }
      const lines = records.map(
        (r) => `• ${r.name}${r.state ? ` | State: ${r.state}` : ""}${r.gstin ? ` | GSTIN: ${r.gstin}` : ""}`
      );
      return {
        content: [{ type: "text" as const, text: `Open companies:\n${lines.join("\n")}` }],
      };
    }
  );
}
