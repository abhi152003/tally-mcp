import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, reportEnvelope, xmlUnescape } from "../tally.js";

function defaultFYRange(): { from: string; to: string } {
  // ±3 months around today — avoids overloading Tally with huge exports
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const past = new Date(); past.setMonth(past.getMonth() - 3);
  const future = new Date(); future.setMonth(future.getMonth() + 3);
  return { from: fmt(past), to: fmt(future) };
}

function first(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return m ? xmlUnescape(m[1].trim()) : "";
}

function parseBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/\./g, "\\.");
  const re = new RegExp(`<${escaped}[\\s\\S]*?<\\/${escaped}>`, "gi");
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

function parseInventoryEntries(block: string) {
  return parseBlocks(block, "ALLINVENTORYENTRIES.LIST").map((inv) => ({
    item: first(inv, "STOCKITEMNAME"),
    qty: first(inv, "BILLEDQTY") || first(inv, "ACTUALQTY"),
    rate: first(inv, "RATE"),
    amount: Math.abs(parseFloat((first(inv, "AMOUNT") || "0").replace(/,/g, "")) || 0),
  })).filter((e) => e.item);
}

function parseLedgerEntries(block: string) {
  // Try both tag variants used by different Tally versions/reports
  for (const tag of ["ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"]) {
    const entries = parseBlocks(block, tag).map((led) => ({
      ledger: first(led, "LEDGERNAME"),
      amount: parseFloat((first(led, "AMOUNT") || "0").replace(/,/g, "")) || 0,
      isDr: first(led, "ISDEEMEDPOSITIVE").toLowerCase() === "yes",
    })).filter((e) => e.ledger);
    if (entries.length > 0) return entries;
  }
  return [];
}

export function registerGetVoucherDetail(server: McpServer) {
  server.registerTool(
    "get_voucher_detail",
    {
      description: "Fetch full details of a specific voucher by its number — includes line items (stock item, qty, rate, amount) and all ledger entries (party, taxes, etc.). Optionally provide a date hint to speed up the search.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        voucher_number: z.string().describe("Voucher number to look up (e.g. G-219)"),
        voucher_type: z
          .string()
          .optional()
          .describe("Voucher type to disambiguate when the same number exists across types (e.g. Payment, Receipt, Sales, Purchase, Contra)."),
        date: z
          .string()
          .optional()
          .describe("Date hint in YYYYMMDD format (e.g. 20260331). Speeds up search significantly when known."),
      },
    },
    async ({ company, voucher_number, voucher_type, date }) => {
      const { from, to } = defaultFYRange();
      const fromDate = date ?? from;
      const toDate = date ?? to;

      const dateVars = `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>`;
      const xml = await tallyPost(reportEnvelope("Voucher Register", company, dateVars));

      if (xml.includes("LINEERROR")) {
        return {
          content: [{
            type: "text" as const,
            text: `Tally error: ${xml.match(/<LINEERROR>(.*?)<\/LINEERROR>/i)?.[1] ?? xml.slice(0, 300)}`,
          }],
        };
      }

      const voucherBlocks = xml.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/gi) ?? [];
      const target = voucherBlocks.find((b) => {
        const numMatch = first(b, "VOUCHERNUMBER").toLowerCase() === voucher_number.toLowerCase();
        if (!numMatch) return false;
        if (voucher_type) {
          return first(b, "VOUCHERTYPENAME").toLowerCase() === voucher_type.toLowerCase();
        }
        return true;
      });

      if (!target) {
        return {
          content: [{
            type: "text" as const,
            text: `Voucher ${voucher_number} not found in ${company} (searched ${fromDate} – ${toDate}).`,
          }],
        };
      }

      const vDate = first(target, "DATE");
      const vType = first(target, "VOUCHERTYPENAME");
      const party = first(target, "PARTYLEDGERNAME") || first(target, "PARTYNAME");
      const narration = first(target, "NARRATION");

      const invEntries = parseInventoryEntries(target);
      const ledEntries = parseLedgerEntries(target);

      const lines: string[] = [];
      lines.push(`Voucher : ${voucher_number}`);
      lines.push(`Type    : ${vType}`);
      lines.push(`Date    : ${vDate}`);
      lines.push(`Party   : ${party}`);
      if (narration) lines.push(`Narr    : ${narration}`);

      if (invEntries.length > 0) {
        lines.push(`\nLine Items (${invEntries.length}):`);
        for (const e of invEntries) {
          lines.push(`  • ${e.item} | Qty: ${e.qty} | Rate: ${e.rate} | ₹${e.amount.toLocaleString("en-IN")}`);
        }
      }

      if (ledEntries.length > 0) {
        lines.push(`\nLedger Entries (${ledEntries.length}):`);
        for (const e of ledEntries) {
          lines.push(`  • ${e.ledger} | ₹${Math.abs(e.amount).toLocaleString("en-IN")} ${e.isDr ? "Dr" : "Cr"}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
