#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerPing } from "./tools/ping.js";
import { registerListCompanies } from "./tools/list-companies.js";
import { registerListLedgers } from "./tools/list-ledgers.js";
import { registerGetLedger } from "./tools/get-ledger.js";
import { registerListStockItems } from "./tools/list-stock-items.js";
import { registerListVoucherTypes } from "./tools/list-voucher-types.js";
import { registerGetVouchers } from "./tools/get-vouchers.js";
import { registerPostVoucher } from "./tools/post-voucher.js";
import { registerGetVoucherDetail } from "./tools/get-voucher-detail.js";
import { registerGetBankEntries } from "./tools/get-bank-entries.js";
import { registerGetVoucherTemplate } from "./tools/get-voucher-template.js";
import { registerExtractInvoice } from "./tools/extract-invoice.js";

const server = new McpServer({
  name: "tally-mcp",
  version: "1.0.0",
});

registerPing(server);
registerListCompanies(server);
registerListLedgers(server);
registerGetLedger(server);
registerListStockItems(server);
registerListVoucherTypes(server);
registerGetVouchers(server);
registerPostVoucher(server);
registerGetVoucherDetail(server);
registerGetBankEntries(server);
registerGetVoucherTemplate(server);
registerExtractInvoice(server);

const transport = new StdioServerTransport();
await server.connect(transport);
