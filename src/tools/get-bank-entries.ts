import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, reportEnvelope, extractAll, xmlUnescape } from "../tally.js";

const DEFAULT_LIMIT = 100;
const MAX_DAYS = 92;

function daysBetween(from: string, to: string): number {
  const parse = (d: string) => new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`);
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}
const BANK_VOUCHER_TYPES = ["payment", "receipt", "contra"];

function first(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?=[\\s>])[^>]*>(.*?)<\\/${tag}>`, "is").exec(xml);
  return m ? xmlUnescape(m[1].trim()) : "";
}

function parseLedgerNames(block: string): string[] {
  const names: string[] = [];
  const re = /<ALLLEDGERENTRIES\.LIST[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const name = first(m[0], "LEDGERNAME");
    if (name) names.push(name);
  }
  return names;
}

function parseBankVouchers(xml: string) {
  const blocks = xml.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/gi) ?? [];

  return blocks.map((block) => {
    const amounts = extractAll(block, "AMOUNT").map((a) =>
      parseFloat(a.replace(/,/g, "")) || 0
    );
    const total = amounts.length ? Math.max(...amounts.map(Math.abs)) : 0;

    return {
      date: first(block, "DATE"),
      type: first(block, "VOUCHERTYPENAME"),
      number: first(block, "VOUCHERNUMBER") || first(block, "REFERENCE"),
      party: first(block, "PARTYNAME"),
      narration: first(block, "NARRATION"),
      amount: total,
      ledgers: parseLedgerNames(block),
    };
  });
}

export function registerGetBankEntries(server: McpServer) {
  server.registerTool(
    "get_bank_entries",
    {
      description: "Fetch bank-related entries (Payment, Receipt, Contra) filtered by bank ledger name. Use this to see all transactions for a specific bank account (e.g. 'HDFC', 'SBI'). Optionally restrict to a single voucher type.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        from_date: z.string().describe("Start date in YYYYMMDD format (e.g. 20260401)"),
        to_date: z.string().describe("End date in YYYYMMDD format (e.g. 20260430)"),
        bank_ledger: z
          .string()
          .describe("Bank ledger name to filter by (case-insensitive substring, e.g. 'HDFC', 'SBI', 'Kotak')"),
        voucher_type: z
          .string()
          .optional()
          .describe("Restrict to a single type: Payment, Receipt, or Contra. Omit to get all three."),
        min_amount: z
          .number()
          .optional()
          .describe("Only return entries with amount >= this value (in rupees)."),
        max_amount: z
          .number()
          .optional()
          .describe("Only return entries with amount <= this value (in rupees)."),
        limit: z
          .number()
          .optional()
          .describe(`Max entries to return (default ${DEFAULT_LIMIT}).`),
      },
    },
    async ({ company, from_date, to_date, bank_ledger, voucher_type, min_amount, max_amount, limit = DEFAULT_LIMIT }) => {
      const days = daysBetween(from_date, to_date);
      if (days > MAX_DAYS) {
        return {
          content: [{
            type: "text" as const,
            text: `Date range too large (${days} days). Maximum allowed is ${MAX_DAYS} days (~1 quarter). Please split your query into smaller ranges.`,
          }],
        };
      }

      const dateVars = `<SVFROMDATE>${from_date}</SVFROMDATE><SVTODATE>${to_date}</SVTODATE>`;
      const xml = await tallyPost(reportEnvelope("Voucher Register", company, dateVars));

      if (xml.includes("LINEERROR")) {
        return {
          content: [{
            type: "text" as const,
            text: `Tally error: ${xml.match(/<LINEERROR>(.*?)<\/LINEERROR>/i)?.[1] ?? xml.slice(0, 200)}`,
          }],
        };
      }

      let vouchers = parseBankVouchers(xml);

      // Client-side date filter (Tally's SVFROMDATE/SVTODATE are unreliable)
      vouchers = vouchers.filter((v) => v.date >= from_date && v.date <= to_date);

      // Filter to bank-related voucher types
      const allowedTypes = voucher_type
        ? [voucher_type.toLowerCase()]
        : BANK_VOUCHER_TYPES;
      vouchers = vouchers.filter((v) => allowedTypes.includes(v.type.toLowerCase()));

      // Filter by bank ledger name (checks all ledger entries in the voucher)
      const bankQ = bank_ledger.toLowerCase();
      vouchers = vouchers.filter((v) =>
        v.ledgers.some((l) => l.toLowerCase().includes(bankQ))
      );

      if (min_amount !== undefined) {
        vouchers = vouchers.filter((v) => v.amount >= min_amount);
      }
      if (max_amount !== undefined) {
        vouchers = vouchers.filter((v) => v.amount <= max_amount);
      }

      if (vouchers.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No bank entries found for "${bank_ledger}" in ${company} between ${from_date} and ${to_date}.`,
          }],
        };
      }

      const total = vouchers.length;
      const shown = vouchers.slice(0, limit);

      const lines = shown.map((v) => {
        const parts = [`[${v.date}]`, v.type, v.number, v.party];
        if (v.amount) parts.push(`₹${v.amount.toLocaleString("en-IN")}`);
        if (v.narration) parts.push(`— ${v.narration.slice(0, 60)}`);
        return `• ${parts.filter(Boolean).join(" | ")}`;
      });

      const truncNote = total > limit
        ? `\n(Showing ${limit} of ${total}. Pass a higher limit or narrow the date range.)`
        : "";

      return {
        content: [{
          type: "text" as const,
          text: `${total} bank entry/entries for "${bank_ledger}" in ${company} (${from_date} – ${to_date}):\n\n${lines.join("\n")}${truncNote}`,
        }],
      };
    }
  );
}
