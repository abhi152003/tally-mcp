import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tallyPost, reportEnvelope, tdlEnvelope, xmlEscape, xmlUnescape, extractAll } from "../tally.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

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
  const vchType = block.match(/VCHTYPE="([^"]+)"/)?.[1] ?? "Sales";
  const objView = block.match(/OBJVIEW="([^"]+)"/)?.[1] ?? "Accounting Voucher View";
  const indent  = (n: number) => "  ".repeat(n);
  const tag     = (name: string, val: string, depth = 1) =>
    val ? `${indent(depth)}<${name}>${val}</${name}>` : "";

  const lines: string[] = [];
  lines.push(`<VOUCHER VCHTYPE="${vchType}" ACTION="Create" OBJVIEW="${objView}">`);

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

  for (const inv of getBlocks(block, "ALLINVENTORYENTRIES.LIST")) {
    lines.push(`${indent(1)}<ALLINVENTORYENTRIES.LIST>`);
    for (const f of ["STOCKITEMNAME", "ISDEEMEDPOSITIVE", "RATE", "AMOUNT", "ACTUALQTY", "BILLEDQTY"]) {
      const v = get(inv, f);
      if (v) lines.push(tag(f, v, 2));
    }
    for (const batch of getBlocks(inv, "BATCHALLOCATIONS.LIST")) {
      lines.push(`${indent(2)}<BATCHALLOCATIONS.LIST>`);
      for (const f of ["GODOWNNAME", "BATCHNAME", "AMOUNT", "ACTUALQTY", "BILLEDQTY"]) {
        const v = get(batch, f);
        if (v) lines.push(tag(f, v, 3));
      }
      lines.push(`${indent(2)}</BATCHALLOCATIONS.LIST>`);
    }
    for (const acct of getBlocks(inv, "ACCOUNTINGALLOCATIONS.LIST")) {
      lines.push(`${indent(2)}<ACCOUNTINGALLOCATIONS.LIST>`);
      for (const f of ["LEDGERNAME", "ISDEEMEDPOSITIVE", "ISPARTYLEDGER", "AMOUNT"]) {
        const v = get(acct, f);
        if (v) lines.push(tag(f, v, 3));
      }
      lines.push(`${indent(2)}</ACCOUNTINGALLOCATIONS.LIST>`);
    }
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

  for (const listTag of ["LEDGERENTRIES.LIST", "ALLLEDGERENTRIES.LIST"]) {
    for (const led of getBlocks(block, listTag)) {
      lines.push(`${indent(1)}<${listTag}>`);
      for (const f of ["LEDGERNAME", "ISDEEMEDPOSITIVE", "ISPARTYLEDGER", "AMOUNT"]) {
        const v = get(led, f);
        if (v) lines.push(tag(f, v, 2));
      }
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

// ── Auto-discover a date for the requested voucher type ───────────────────────

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Tally returns dates as "3-Apr-25" or "03-Apr-2025". Normalise to YYYYMMDD.
function normaliseTallyDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const [, dd, mon, yy] = m;
  const mm = MONTH_MAP[mon.toLowerCase()];
  if (!mm) return null;
  const year = yy.length === 2 ? (parseInt(yy) >= 50 ? `19${yy}` : `20${yy}`) : yy;
  return `${year}${mm}${dd.padStart(2, "0")}`;
}

async function findVoucherDate(company: string, voucherType: string): Promise<string | null> {
  const tdl = `
  <REPORT NAME="TallyMcpReport"><FORMS>TallyMcpForm</FORMS></REPORT>
  <FORM NAME="TallyMcpForm"><PARTS>TallyMcpPart</PARTS></FORM>
  <PART NAME="TallyMcpPart">
    <LINES>TallyMcpLine</LINES>
    <REPEAT>TallyMcpLine : VchColl</REPEAT>
    <SCROLL>Vertical</SCROLL>
  </PART>
  <LINE NAME="TallyMcpLine"><FIELDS>FldVchDate</FIELDS></LINE>
  <FIELD NAME="FldVchDate"><SET>$Date</SET></FIELD>
  <COLLECTION NAME="VchColl">
    <TYPE>Voucher</TYPE>
    <FILTER>TypeFilter</FILTER>
    <FETCH>Date</FETCH>
  </COLLECTION>
  <SYSTEM TYPE="Formulae" NAME="TypeFilter">$VoucherTypeName = "${xmlEscape(voucherType)}"</SYSTEM>
  `;

  const xml = await tallyPost(tdlEnvelope(company, tdl));
  const dates = extractAll(xml, "FLDVCHDATE")
    .map((r) => normaliseTallyDate(r))
    .filter((d): d is string => d !== null)
    .sort();
  return dates.at(-1) ?? null;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(os.homedir(), ".tally-mcp", "templates");

function cacheFilePath(company: string, voucherType: string): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return path.join(CACHE_DIR, `${safe(company)}__${safe(voucherType)}.txt`);
}

async function readCache(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function writeCache(filePath: string, template: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, template, "utf-8");
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export function registerGetVoucherTemplate(server: McpServer) {
  server.registerTool(
    "get_voucher_template",
    {
      description: [
        "Fetch a minimal clean XML template of an existing voucher from TallyPrime.",
        "Always call this before post_voucher — it reveals the exact OBJVIEW, tag names",
        "(LEDGERENTRIES.LIST vs ALLLEDGERENTRIES.LIST), ledger names, amount sign conventions,",
        "GST fields, and godown names for this specific company.",
        "Templates are cached to disk after the first fetch — all subsequent calls are instant",
        "and do NOT query Tally at all, so there is zero load on Tally.",
        "Pass force_refresh=true only if the company's voucher class or godown setup has changed.",
      ].join(" "),
      inputSchema: {
        company: z.string().describe("Exact company name as shown in TallyPrime"),
        voucher_type: z.string().describe("Voucher type: Sales, Purchase, Payment, Receipt, Contra, Journal, etc."),
        date: z.string().optional().describe(
          "Optional date in YYYYMMDD format to pin the template to a specific voucher. " +
          "If omitted, the tool auto-discovers a date by querying Tally for the first matching voucher type — no manual input needed."
        ),
        force_refresh: z.boolean().optional().describe(
          "Set true to ignore the cached template and re-fetch from Tally. " +
          "Use only if the company's voucher class or godown setup has changed since the last fetch."
        ),
      },
    },
    async ({ company, voucher_type, date, force_refresh }) => {
      const cacheFile = cacheFilePath(company, voucher_type);

      // Serve from cache unless caller explicitly wants a refresh
      if (!force_refresh) {
        const cached = await readCache(cacheFile);
        if (cached) {
          return {
            content: [{
              type: "text" as const,
              text: `[from cache — no Tally query made] Minimal XML template for a ${voucher_type} voucher from ${company}.\nAdapt the field VALUES for the new entry — keep the structure, tag names, and amount signs exactly.\n\n${cached}`,
            }],
          };
        }
      }

      // Cache miss — resolve the date to use for the single-day Voucher Register query.
      // If caller provided one, use it directly. Otherwise auto-discover via MAXOBJECTS=1.
      const resolvedDate = date ?? await findVoucherDate(company, voucher_type);

      if (!resolvedDate) {
        return {
          content: [{
            type: "text" as const,
            text: `No ${voucher_type} voucher found in "${company}". Make sure at least one ${voucher_type} voucher exists in this company.`,
          }],
        };
      }

      const xml = await tallyPost(reportEnvelope("Voucher Register", company,
        `<SVFROMDATE>${resolvedDate}</SVFROMDATE><SVTODATE>${resolvedDate}</SVTODATE>`));

      const blocks = xml.match(/<VOUCHER[\s\S]*?<\/VOUCHER>/gi) ?? [];
      const target = blocks.find((b) =>
        get(b, "VOUCHERTYPENAME").toLowerCase() === voucher_type.toLowerCase()
      );

      if (!target) {
        return {
          content: [{
            type: "text" as const,
            text: `No ${voucher_type} voucher found in "${company}" on ${resolvedDate}. Please provide a specific date via the "date" parameter where a ${voucher_type} voucher is known to exist.`,
          }],
        };
      }

      const template = buildMinimalTemplate(target);
      await writeCache(cacheFile, template);

      return {
        content: [{
          type: "text" as const,
          text: `Minimal XML template for a ${voucher_type} voucher from ${company}.\nAdapt the field VALUES for the new entry — keep the structure, tag names, and amount signs exactly.\nTemplate saved to cache — future calls will not query Tally at all.\n\n${template}`,
        }],
      };
    }
  );
}
