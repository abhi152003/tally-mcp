import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, tdlEnvelope, extractFirst, xmlEscape } from "../tally.js";

function buildTdl(ledgerName: string) {
  const escaped = xmlEscape(ledgerName);
  return `
  <REPORT NAME="TallyMcpReport"><FORMS>TallyMcpForm</FORMS></REPORT>
  <FORM NAME="TallyMcpForm"><PARTS>TallyMcpPart</PARTS></FORM>
  <PART NAME="TallyMcpPart">
    <LINES>TallyMcpLine</LINES>
    <REPEAT>TallyMcpLine : LedColl</REPEAT>
    <SCROLL>Vertical</SCROLL>
  </PART>
  <LINE NAME="TallyMcpLine">
    <FIELDS>FldName,FldParent,FldGSTIN,FldGSTType,FldAddr,FldState,FldPinCode,FldOpenBal</FIELDS>
  </LINE>
  <FIELD NAME="FldName"><SET>$Name</SET></FIELD>
  <FIELD NAME="FldParent"><SET>$Parent</SET></FIELD>
  <FIELD NAME="FldGSTIN"><SET>$PARTYGSTIN</SET></FIELD>
  <FIELD NAME="FldGSTType"><SET>$GSTRegistrationType</SET></FIELD>
  <FIELD NAME="FldAddr"><SET>$Address</SET></FIELD>
  <FIELD NAME="FldState"><SET>$PriorStateName</SET></FIELD>
  <FIELD NAME="FldPinCode"><SET>$PinCode</SET></FIELD>
  <FIELD NAME="FldOpenBal"><SET>$$String:$OpeningBalance</SET></FIELD>
  <COLLECTION NAME="LedColl">
    <TYPE>Ledger</TYPE>
    <FILTER>ByName</FILTER>
  </COLLECTION>
  <SYSTEM TYPE="Formulae" NAME="ByName">$Name = "${escaped}"</SYSTEM>
  `;
}

export function registerGetLedger(server: McpServer) {
  server.registerTool(
    "get_ledger",
    {
      description: "Get full details for a single ledger: parent group, GSTIN, GST registration type, address, state, pincode, and opening balance. Use this before posting a voucher involving a specific party to confirm GSTIN and place of supply.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        ledger_name: z.string().describe("Exact ledger name (case-sensitive, as in Tally)"),
      },
    },
    async ({ company, ledger_name }) => {
      const xml = await tallyPost(tdlEnvelope(company, buildTdl(ledger_name)));
      const name = extractFirst(xml, "FLDNAME");

      if (!name) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Ledger "${ledger_name}" not found in ${company}. Use list_ledgers to find the exact name.`,
            },
          ],
        };
      }

      const fields: Record<string, string> = {
        Name: name,
        "Parent Group": extractFirst(xml, "FLDPARENT"),
        GSTIN: extractFirst(xml, "FLDGSTIN"),
        "GST Type": extractFirst(xml, "FLDGSTTYPE"),
        "Address (line 1)": extractFirst(xml, "FLDADDR"),
        State: extractFirst(xml, "FLDSTATE"),
        Pincode: extractFirst(xml, "FLDPINCODE"),
        "Opening Balance": extractFirst(xml, "FLDOPENBAL"),
      };

      const lines = Object.entries(fields)
        .filter(([, v]) => v)
        .map(([k, v]) => `  ${k}: ${v}`);

      return {
        content: [{ type: "text" as const, text: `Ledger details:\n${lines.join("\n")}` }],
      };
    }
  );
}
