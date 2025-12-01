# MCP TypeScript SDK Documentation AI Search

Semantic search over Model Context Protocol (MCP) TypeScript SDK documentation using **Cloudflare AutoRAG (AI Search)** with token-based access control.

## What is This?

This MCP server provides intelligent search over MCP TypeScript SDK documentation from GitHub:
- **Semantic Search** - Natural language queries over MCP SDK docs
- **AI-Generated Answers** - LLM responses grounded in documentation
- **Token-Based Access** - 1 token per search query
- **PII Redaction** - Automatic privacy protection (Phase 2 security)

**AI Search Instance:** `map-docs`
**Domain:** `tsmcpdocs.wtyczki.ai`

**Use Cases:**
- Learn MCP SDK architecture and core concepts
- Get TypeScript code examples for building MCP servers
- Understand tool definitions, resource handlers, and prompt patterns
- Troubleshoot MCP implementation issues

## Available Tools

| Tool | Cost | Description |
|------|------|-------------|
| `search_mcp_docs` | 1 token | Search MCP TypeScript SDK documentation for SDK architecture, tool definitions, transport layers, and code examples |

## Production URLs

| Endpoint | Transport | Description |
|----------|-----------|-------------|
| `https://tsmcpdocs.wtyczki.ai/sse` | Server-Sent Events | Legacy transport (Claude Desktop) |
| `https://tsmcpdocs.wtyczki.ai/mcp` | Streamable HTTP | Modern transport (ChatGPT) |

## Features

- **AutoRAG (AI Search) Ready** - Pre-configured Workers AI binding
- **Dual Transport Support** - Both SSE (legacy) and Streamable HTTP
- **ChatGPT Compatible** - Works with ChatGPT via `/mcp` endpoint
- **Claude Desktop Compatible** - Works via `/sse` endpoint
- **Token System Integration** - Pay-per-use with shared D1 database
- **WorkOS Magic Auth** - Email + 6-digit code authentication
- **Phase 2 Security** - PII redaction for AutoRAG outputs

## Testing

**Pre-Deployment:**
```bash
npx tsc --noEmit  # Must pass with zero errors
```

**Post-Deployment (Cloudflare Workers AI Playground):**
1. Navigate to https://playground.ai.cloudflare.com/
2. Set model to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
3. Add MCP server: `https://tsmcpdocs.wtyczki.ai/sse`
4. Complete OAuth flow
5. Test `search_mcp_docs` tool with query: "How do I define tools in an MCP server?"

## Project Structure

```
tsmcpdocs/
├── src/
│   ├── index.ts              # Entry point (dual transport)
│   ├── server.ts             # McpTypescriptDocsMCP with tools
│   ├── api-key-handler.ts    # API key authentication path
│   ├── authkit-handler.ts    # WorkOS OAuth handler
│   ├── types.ts              # Type definitions
│   ├── props.ts              # Auth context
│   ├── tokenUtils.ts         # Token management
│   ├── tokenConsumption.ts   # Token consumption logic
│   ├── apiKeys.ts            # API key validation
│   └── api-client.ts         # API client template
├── wrangler.jsonc            # Cloudflare config
├── package.json              # Dependencies
└── README.md                 # This file
```

## Configuration

| Setting | Value |
|---------|-------|
| Worker Name | `mcp-typescript-docs` |
| Class Name | `McpTypescriptDocsMCP` |
| AI Search Instance | `map-docs` |
| Domain | `tsmcpdocs.wtyczki.ai` |
| Database | `mcp-tokens-database` (shared) |

## GitHub Integration

This repository uses Cloudflare Workers Builds for automatic deployments.
Every push to `main` triggers an automatic deployment to `tsmcpdocs.wtyczki.ai`.
