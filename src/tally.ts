const TALLY_URL = process.env.TALLY_URL ?? "http://localhost:9000";

export async function tallyPost(xml: string): Promise<string> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(TALLY_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: xml,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Tally`);
    return res.text();
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError")
      throw new Error("Tally request timed out (20 s). Is TallyPrime open?");
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#4;/g, ""); // Tally's internal empty sentinel
}

/** Extract every occurrence of <TAG>…</TAG> from xml, in document order. */
export function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?=[\\s>])[^>]*>(.*?)<\\/${tag}>`, "gis");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(xmlUnescape(m[1].trim()));
  }
  return out;
}

/** Extract the first occurrence of <TAG>…</TAG>, or empty string. */
export function extractFirst(xml: string, tag: string): string {
  return extractAll(xml, tag)[0] ?? "";
}

/**
 * Parse a flat TDL response where N records are represented as N*F sibling
 * elements (no per-record wrapper). fields[0] is the "primary key" field used
 * to determine record count.
 */
export function parseFlatTdl(
  xml: string,
  fields: Array<{ key: string; tag: string }>
): Record<string, string>[] {
  const arrays: Record<string, string[]> = {};
  let count = 0;

  for (const { key, tag } of fields) {
    arrays[key] = extractAll(xml, tag);
    if (key === fields[0].key) count = arrays[key].length;
  }

  return Array.from({ length: count }, (_, i) => {
    const rec: Record<string, string> = {};
    for (const { key } of fields) {
      rec[key] = arrays[key]?.[i] ?? "";
    }
    return rec;
  });
}

/** Build the outer TDL export envelope used for custom collection queries. */
export function tdlEnvelope(company: string, tdlMessage: string, extraVars: string = ""): string {
  const cmp = company ? `<SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>TallyMcpReport</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${cmp}
        ${extraVars}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          ${tdlMessage}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

/** Build the standard export envelope for built-in Tally reports. */
export function reportEnvelope(
  reportName: string,
  company: string,
  extraVars: string = ""
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${reportName}</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>
          ${extraVars}
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/** Parse CREATED / ERRORS from a Tally import response. */
export function parseImportResult(xml: string): {
  created: number;
  altered: number;
  errors: number;
  errorText: string;
} {
  const n = (tag: string) => parseInt(extractFirst(xml, tag) || "0", 10);
  const lineerrors = extractAll(xml, "LINEERROR").join("; ");
  const importerr = extractAll(xml, "IMPORTERR").join("; ");
  return {
    created: n("CREATED"),
    altered: n("ALTERED"),
    errors: n("ERRORS"),
    errorText: [lineerrors, importerr].filter(Boolean).join("; "),
  };
}
