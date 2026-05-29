import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import * as crypto from "crypto";

const execFileAsync = promisify(execFile);

const SUPPORTED = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

export function registerExtractInvoice(server: McpServer) {
  server.registerTool(
    "extract_invoice",
    {
      description: [
        "Extract text from a PDF or image invoice/bill using the scribe CLI.",
        "Returns the raw extracted text (supplier, GSTIN, invoice number, date, line items, taxes, total).",
        "Uses scribe's OCR pipeline — no LLM vision tokens consumed.",
        "Supports: PDF, JPEG, JPG, PNG.",
      ].join(" "),
      inputSchema: {
        file_path: z
          .string()
          .describe("Absolute path to the invoice file (PDF, JPEG, JPG, or PNG)."),
      },
    },
    async ({ file_path }) => {
      const ext = path.extname(file_path).toLowerCase();

      if (!SUPPORTED.has(ext)) {
        return err(`Unsupported file type "${ext}". Accepted: pdf, jpg, jpeg, png.`);
      }

      try {
        await fs.access(file_path);
      } catch {
        return err(`File not found: ${file_path}`);
      }

      try {
        await execFileAsync("scribe", ["--version"]);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return err("scribe is not installed or not in PATH. Install it to enable invoice extraction.");
        }
        // scribe exists but --version exited non-zero — still usable
      }

      const tmpDir = path.join(os.tmpdir(), `tally-mcp-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });

      try {
        if (ext === ".pdf") {
          return await extractPdf(file_path, tmpDir);
        }
        return await extractImage(file_path, tmpDir);
      } catch (e: unknown) {
        return err(`Extraction failed: ${(e as Error).message}`);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    }
  );
}

async function extractPdf(filePath: string, tmpDir: string) {
  const directTxt = path.join(tmpDir, "direct.txt");

  // Try native-text extraction first
  const directText = await tryExtract(filePath, directTxt);
  if (directText !== null) return ok(directText);

  // Image-based PDF — run OCR then extract
  const ocrDir = path.join(tmpDir, "ocr");
  await execFileAsync("scribe", ["recognize", "-h", "-o", ocrDir, filePath]);

  const stem = path.basename(filePath, ".pdf");
  const ocrPdf = path.join(ocrDir, `${stem}.pdf`);
  const ocrTxt = path.join(tmpDir, "ocr.txt");
  await execFileAsync("scribe", ["extract", "-f", "txt", ocrPdf, ocrTxt]);

  const text = (await fs.readFile(ocrTxt, "utf-8")).trim();
  return text ? ok(text) : cannotRead();
}

async function extractImage(filePath: string, tmpDir: string) {
  const directTxt = path.join(tmpDir, "direct.txt");

  // Try direct extraction (works when scribe can parse the image format natively)
  const directText = await tryExtract(filePath, directTxt);
  if (directText !== null) return ok(directText);

  // Fall back to OCR
  const ocrDir = path.join(tmpDir, "ocr");
  await execFileAsync("scribe", ["recognize", "-h", "-o", ocrDir, filePath]);

  const ext = path.extname(filePath).toLowerCase();
  const stem = path.basename(filePath, ext);
  const ocrPdf = path.join(ocrDir, `${stem}.pdf`);
  const ocrTxt = path.join(tmpDir, "ocr.txt");
  await execFileAsync("scribe", ["extract", "-f", "txt", ocrPdf, ocrTxt]);

  const text = (await fs.readFile(ocrTxt, "utf-8")).trim();
  return text ? ok(text) : cannotRead();
}

/** Run scribe extract; returns trimmed text if meaningful, null if empty/failed. */
async function tryExtract(filePath: string, outTxt: string): Promise<string | null> {
  try {
    await execFileAsync("scribe", ["extract", "-f", "txt", filePath, outTxt]);
    const text = (await fs.readFile(outTxt, "utf-8")).trim();
    // Require at least 30 chars to consider extraction successful
    return text.length >= 30 ? text : null;
  } catch {
    return null;
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

function cannotRead() {
  return err("I could not read this bill clearly. Please resend a clearer photo or PDF.");
}
