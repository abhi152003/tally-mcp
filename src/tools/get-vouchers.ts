import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, reportEnvelope, extractAll, xmlUnescape } from "../tally.js";

const DEFAULT_LIMIT = 100;
const MAX_DAYS = 92; // ~1 quarter — full-year queries crash TallyPrime's XML server

function daysBetween(from: string, to: string): number {
  const parse = (d: string) => new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`);
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

function parseVouchers(xml: string) {
  const blocks = xml.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/gi) ?? [];

  return blocks.map((block) => {
    const first = (tag: string) => {
      const m = new RegExp(`<${tag}(?=[\\s>])[^>]*>(.*?)<\\/${tag}>`, "is").exec(block);
      return m ? xmlUnescape(m[1].trim()) : "";
    };

    const amounts = extractAll(block, "AMOUNT").map((a) =>
      parseFloat(a.replace(/,/g, "")) || 0
    );
    const total = amounts.length ? Math.max(...amounts.map(Math.abs)) : 0;

    // Extract all stock item names from inventory entries
    const invBlocks = block.match(/<ALLINVENTORYENTRIES\.LIST[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/gi) ?? [];
    const items = invBlocks.map((inv) => {
      const m = new RegExp(`<STOCKITEMNAME(?=[\\s>])[^>]*>(.*?)<\\/STOCKITEMNAME>`, "is").exec(inv);
      return m ? xmlUnescape(m[1].trim()) : "";
    }).filter(Boolean);

    return {
      date: first("DATE"),
      type: first("VOUCHERTYPENAME"),
      number: first("VOUCHERNUMBER") || first("REFERENCE"),
      party: first("PARTYNAME"),
      narration: first("NARRATION"),
      amount: total,
      items,
    };
  });
}

export function registerGetVouchers(server: McpServer) {
  server.registerTool(
    "get_vouchers",
    {
      description: "Fetch vouchers from a TallyPrime company for a date range with optional filters: voucher type, party name, stock item name, amount range, and keyword search across narration and voucher number.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        from_date: z.string().describe("Start date in YYYYMMDD format (e.g. 20260401)"),
        to_date: z.string().describe("End date in YYYYMMDD format (e.g. 20260430)"),
        voucher_type: z
          .string()
          .optional()
          .describe("Filter by voucher type: Sales, Purchase, Payment, Receipt, Contra, Journal, etc."),
        party: z
          .string()
          .optional()
          .describe("Filter by party/supplier/customer name (case-insensitive substring match)."),
        min_amount: z
          .number()
          .optional()
          .describe("Only return vouchers with amount >= this value (in rupees)."),
        max_amount: z
          .number()
          .optional()
          .describe("Only return vouchers with amount <= this value (in rupees)."),
        item: z
          .string()
          .optional()
          .describe("Filter by stock item name (case-insensitive substring match). Useful for finding all sales/purchases of a specific item."),
        search: z
          .string()
          .optional()
          .describe("Keyword search across voucher number and narration (case-insensitive)."),
        limit: z
          .number()
          .optional()
          .describe(`Max vouchers to return (default ${DEFAULT_LIMIT}). Increase for broader queries.`),
      },
    },
    async ({ company, from_date, to_date, voucher_type, party, item, min_amount, max_amount, search, limit = DEFAULT_LIMIT }) => {
      const days = daysBetween(from_date, to_date);
      if (days > MAX_DAYS) {
        return {
          content: [{
            type: "text" as const,
            text: `Date range too large (${days} days). Maximum allowed is ${MAX_DAYS} days (~1 quarter) to avoid overloading TallyPrime. Please split your query into smaller ranges.`,
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

      let vouchers = parseVouchers(xml);

      // All filters are applied client-side (Tally's SVFROMDATE/SVTODATE are unreliable)
      vouchers = vouchers.filter((v) => v.date >= from_date && v.date <= to_date);

      if (voucher_type) {
        const q = voucher_type.toLowerCase();
        vouchers = vouchers.filter((v) => v.type.toLowerCase().includes(q));
      }
      if (party) {
        const q = party.toLowerCase();
        vouchers = vouchers.filter((v) => v.party.toLowerCase().includes(q));
      }
      if (item) {
        const q = item.toLowerCase();
        vouchers = vouchers.filter((v) => v.items.some((i) => i.toLowerCase().includes(q)));
      }
      if (min_amount !== undefined) {
        vouchers = vouchers.filter((v) => v.amount >= min_amount);
      }
      if (max_amount !== undefined) {
        vouchers = vouchers.filter((v) => v.amount <= max_amount);
      }
      if (search) {
        const q = search.toLowerCase();
        vouchers = vouchers.filter(
          (v) => v.number.toLowerCase().includes(q) || v.narration.toLowerCase().includes(q)
        );
      }

      if (vouchers.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No vouchers found in ${company} between ${from_date} and ${to_date} with the given filters.`,
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

      const activeFilters = [
        voucher_type && `type=${voucher_type}`,
        party && `party="${party}"`,
        item && `item="${item}"`,
        min_amount !== undefined && `min=₹${min_amount.toLocaleString("en-IN")}`,
        max_amount !== undefined && `max=₹${max_amount.toLocaleString("en-IN")}`,
        search && `search="${search}"`,
      ].filter(Boolean).join(", ");

      const truncNote = total > limit
        ? `\n(Showing ${limit} of ${total}. Pass a higher limit or narrow filters to see more.)`
        : "";

      return {
        content: [{
          type: "text" as const,
          text: `${total} voucher(s) in ${company} (${from_date} – ${to_date})${activeFilters ? ` [${activeFilters}]` : ""}:\n\n${lines.join("\n")}${truncNote}`,
        }],
      };
    }
  );
}
