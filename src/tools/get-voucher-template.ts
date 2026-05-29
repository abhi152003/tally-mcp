import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, reportEnvelope, xmlUnescape } from "../tally.js";

function get(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return m ? xmlUnescape(m[1].trim()) : "";
}

function getBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/\./g, "\\.");
  const re = new RegExp(`<${escaped}[\\s\\S]*?<\\/${escaped}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

function buildMinimalTemplate(block: string): string {
  const vchType   = block.match(/VCHTYPE="([^"]+)"/)?.[1] ?? "Sales";
  const objView   = block.match(/OBJVIEW="([^"]+)"/)?.[1] ?? "Accounting Voucher View";
  const indent    = (n: number) => "  ".repeat(n);
  const tag       = (name: string, val: string, depth = 1) =>
    val ? `${indent(depth)}<${name}>${val}</${name}>` : "";

  const lines: string[] = [];
  lines.push(`<VOUCHER VCHTYPE="${vchType}" ACTION="Create" OBJVIEW="${objView}">`);

  // ── Header fields ───────────────────────────────────────────────────────────
  const HEADER_FIELDS = [
    "GUID", "DATE", "VOUCHERTYPENAME", "VOUCHERNUMBER", "REFERENCE",
    "REFERENCEDATE", "PARTYLEDGERNAME", "ISINVOICE", "PERSISTEDVIEW",
    "VCHENTRYMODE", "CLASSNAME", "CMPGSTIN", "PARTYGSTIN",
    "GSTREGISTRATIONTYPE", "PLACEOFSUPPLY",
  ];
  for (const f of HEADER_FIELDS) {
    const v = get(block, f);
    if (v) lines.push(tag(f, v));
  }

  // ── Inventory entries ────────────────────────────────────────────────────────
  for (const inv of getBlocks(block, "ALLINVENTORYENTRIES.LIST")) {
    lines.push(`${indent(1)}<ALLINVENTORYENTRIES.LIST>`);
    for (const f of ["STOCKITEMNAME", "ISDEEMEDPOSITIVE", "RATE", "AMOUNT", "ACTUALQTY", "BILLEDQTY"]) {
      const v = get(inv, f);
      if (v) lines.push(tag(f, v, 2));
    }

    // Batch allocations
    for (const batch of getBlocks(inv, "BATCHALLOCATIONS.LIST")) {
      lines.push(`${indent(2)}<BATCHALLOCATIONS.LIST>`);
      for (const f of ["GODOWNNAME", "BATCHNAME", "AMOUNT", "ACTUALQTY", "BILLEDQTY"]) {
        const v = get(batch, f);
        if (v) lines.push(tag(f, v, 3));
      }
      lines.push(`${indent(2)}</BATCHALLOCATIONS.LIST>`);
    }

    // Accounting allocations
    for (const acct of getBlocks(inv, "ACCOUNTINGALLOCATIONS.LIST")) {
      lines.push(`${indent(2)}<ACCOUNTINGALLOCATIONS.LIST>`);
      for (const f of ["LEDGERNAME", "ISDEEMEDPOSITIVE", "ISPARTYLEDGER", "AMOUNT"]) {
        const v = get(acct, f);
        if (v) lines.push(tag(f, v, 3));
      }
      lines.push(`${indent(2)}</ACCOUNTINGALLOCATIONS.LIST>`);
    }

    // GST rate details — only non-zero rates
    for (const rate of getBlocks(inv, "RATEDETAILS.LIST")) {
      const gstRate = parseFloat(get(rate, "GSTRATE")) || 0;
      if (gstRate > 0) {
        lines.push(`${indent(2)}<RATEDETAILS.LIST>`);
        lines.push(tag("GSTRATEDUTYHEAD", get(rate, "GSTRATEDUTYHEAD"), 3));
        lines.push(tag("GSTRATE", get(rate, "GSTRATE"), 3));
        lines.push(`${indent(2)}</RATEDETAILS.LIST>`);
      }
    }

    lines.push(`${indent(1)}</ALLINVENTORYENTRIES.LIST>`);
  }

  // ── Ledger entries (Invoice Voucher View uses LEDGERENTRIES.LIST) ────────────
  for (const listTag of ["LEDGERENTRIES.LIST", "ALLLEDGERENTRIES.LIST"]) {
    for (const led of getBlocks(block, listTag)) {
      lines.push(`${indent(1)}<${listTag}>`);
      for (const f of ["LEDGERNAME", "ISDEEMEDPOSITIVE", "ISPARTYLEDGER", "AMOUNT"]) {
        const v = get(led, f);
        if (v) lines.push(tag(f, v, 2));
      }

      // Bill allocations (on party ledger)
      for (const bill of getBlocks(led, "BILLALLOCATIONS.LIST")) {
        const name     = get(bill, "NAME");
        const billType = get(bill, "BILLTYPE");
        const amount   = get(bill, "AMOUNT");
        if (name || billType || amount) {
          lines.push(`${indent(2)}<BILLALLOCATIONS.LIST>`);
          if (name)     lines.push(tag("NAME",     name,     3));
          if (billType) lines.push(tag("BILLTYPE", billType, 3));
          if (amount)   lines.push(tag("AMOUNT",   amount,   3));
          lines.push(`${indent(2)}</BILLALLOCATIONS.LIST>`);
        }
      }

      lines.push(`${indent(1)}</${listTag}>`);
    }
  }

  lines.push("</VOUCHER>");
  return lines.join("\n");
}

export function registerGetVoucherTemplate(server: McpServer) {
  server.registerTool(
    "get_voucher_template",
    {
      description: "Fetch a minimal clean XML template of an existing voucher from TallyPrime. Always call this before post_voucher — it reveals the exact OBJVIEW, tag names (LEDGERENTRIES.LIST vs ALLLEDGERENTRIES.LIST), ledger names, amount sign conventions, GST fields, and godown names for this specific company. Avoids all guesswork.",
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        voucher_type: z.string().describe("Voucher type: Sales, Purchase, Payment, Receipt, Contra, Journal, etc."),
        date: z.string().optional().describe("Date hint in YYYYMMDD format to look near. Provide a date where you know a voucher of this type exists."),
      },
    },
    async ({ company, voucher_type, date }) => {
      const hint = date ?? "20260331";

      // Try exact date first
      let xml = await tallyPost(reportEnvelope("Voucher Register", company,
        `<SVFROMDATE>${hint}</SVFROMDATE><SVTODATE>${hint}</SVTODATE>`));

      let blocks = xml.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/gi) ?? [];
      let target = blocks.find((b) =>
        get(b, "VOUCHERTYPENAME").toLowerCase() === voucher_type.toLowerCase()
      );

      // Broaden to 30-day window if not found
      if (!target) {
        const hintDate = new Date(`${hint.slice(0,4)}-${hint.slice(4,6)}-${hint.slice(6,8)}`);
        const past = new Date(hintDate);
        past.setDate(past.getDate() - 30);
        const fmt = (d: Date) =>
          `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;

        xml = await tallyPost(reportEnvelope("Voucher Register", company,
          `<SVFROMDATE>${fmt(past)}</SVFROMDATE><SVTODATE>${hint}</SVTODATE>`));

        blocks = xml.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/gi) ?? [];
        target = blocks.find((b) =>
          get(b, "VOUCHERTYPENAME").toLowerCase() === voucher_type.toLowerCase()
        );
      }

      if (!target) {
        return {
          content: [{
            type: "text" as const,
            text: `No existing ${voucher_type} voucher found in ${company} near ${hint}. Provide a date hint where you know a ${voucher_type} voucher exists.`,
          }],
        };
      }

      const template = buildMinimalTemplate(target);
      return {
        content: [{
          type: "text" as const,
          text: `Minimal XML template for a ${voucher_type} voucher from ${company}.\nAdapt the field VALUES for the new entry — keep the structure, tag names, and amount signs exactly.\n\n${template}`,
        }],
      };
    }
  );
}
