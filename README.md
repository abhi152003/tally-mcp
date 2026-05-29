# tally-mcp

MCP server for TallyPrime that lets AI agents read live Tally data and post vouchers through Tally's XML interface.

## Requirements

- Node.js 18+
- TallyPrime running with HTTP/XML access enabled
- Tally listening on `http://localhost:9000` or a custom URL set through `TALLY_URL`

## Setup

```bash
npm install
npm run build
```

## MCP configuration

Add this server to your MCP client configuration, replacing `/your-path/tally-mcp` with the absolute path to this project:

```json
{
  "mcp": {
    "servers": {
      "tally": {
        "command": "node",
        "args": ["/your-path/tally-mcp/dist/index.js"],
        "env": {
          "TALLY_URL": "http://localhost:9000"
        },
        "codex": {
          "defaultToolsApprovalMode": "auto"
        }
      }
    }
  }
}
```

## Available tools

- `ping` - check whether TallyPrime is reachable
- `list_companies` - list companies currently open in TallyPrime
- `list_ledgers` / `get_ledger` - browse and inspect ledgers
- `list_stock_items` - list stock items with HSN, and GST details
- `list_voucher_types` - list configured voucher types and classes
- `get_vouchers` / `get_voucher_detail` - fetch voucher summaries and full voucher details
- `get_bank_entries` - fetch payment, receipt, and contra entries for a bank ledger
- `get_voucher_template` - fetch a clean XML template before posting similar vouchers
- `extract_invoice` - extract invoice data from Tally XML
- `post_voucher` - post a complete XML import envelope to TallyPrime

## Notes

- Call `ping` first to confirm TallyPrime is reachable.
- Call `list_companies` before company-specific tools to get the exact company name.
- Use `get_voucher_template` before `post_voucher` so voucher XML matches the target company's structure.