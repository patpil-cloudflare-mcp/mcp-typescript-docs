/**
 * API Key Authentication Handler for MCP TypeScript SDK AI Search MCP
 *
 * This module provides API key authentication support for MCP clients that don't support
 * OAuth flows (like AnythingLLM, Cursor IDE, custom scripts).
 *
 * Authentication flow:
 * 1. Extract API key from Authorization header
 * 2. Validate key using validateApiKey()
 * 3. Get user from database
 * 4. Create MCP server with tools
 * 5. Handle MCP protocol request
 * 6. Return response
 *
 * TODO: When you add new tools to server.ts, you MUST also:
 * 1. Register them in getOrCreateServer() (around line 260)
 * 2. Add tool executor functions (around line 770)
 * 3. Add cases to handleToolsCall() (around line 750)
 * 4. Add tool schemas to handleToolsList() (around line 625)
 */

import { validateApiKey } from "./apiKeys";
import { getUserById } from "./tokenUtils";
import type { Env, ResponseFormat } from "./types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ApiClient } from "./api-client";
import { checkBalance, consumeTokensWithRetry } from "./tokenConsumption";
import { formatInsufficientTokensError, formatAccountDeletedError } from "./tokenUtils";
import { sanitizeOutput, redactPII, validateOutput } from 'pilpat-mcp-security';

/**
 * Simple LRU (Least Recently Used) Cache for MCP Server instances
 *
 * IMPORTANT: This cache is ephemeral and Worker-instance-specific:
 *
 * 🔸 **Ephemeral (Non-Persistent):**
 *   - Cache is cleared when the Worker is evicted from memory
 *   - Eviction can happen at any time (deployments, inactivity, memory pressure)
 *   - NO guarantee of cache persistence between requests
 *
 * 🔸 **Worker-Instance-Specific:**
 *   - Different Worker instances (different data centers) have separate caches
 *   - A user in Warsaw and a user in New York access different caches
 *   - Cache is NOT replicated globally (unlike D1 database)
 *
 * 🔸 **Performance Optimization Only:**
 *   - This is a PERFORMANCE optimization, not critical state storage
 *   - Cache misses simply recreate the MCP server (acceptable overhead)
 *   - Critical state (balances, tokens, transactions) is stored in D1 database
 *
 * 🔸 **Why This Is Safe:**
 *   - MCP servers are stateless (tools query database on each call)
 *   - Recreating a server doesn't cause data loss or corruption
 *   - Token consumption is atomic via D1 transactions (not cached)
 *   - User balances are ALWAYS queried from database (never cached)
 *
 * 🔸 **LRU Eviction:**
 *   - When cache reaches MAX_SIZE, the least recently used server is evicted
 *   - This prevents unbounded memory growth
 *   - Evicted servers are simply garbage collected
 *
 * Reference: Cloudflare Docs - "In-memory state in Durable Objects"
 * https://developers.cloudflare.com/durable-objects/reference/in-memory-state/
 */
class LRUCache<K, V> {
  private cache: Map<K, { value: V; lastAccessed: number }>;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Get value from cache and update last accessed time
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Update last accessed time (LRU tracking)
      entry.lastAccessed = Date.now();
      return entry.value;
    }
    return undefined;
  }

  /**
   * Set value in cache with automatic LRU eviction
   */
  set(key: K, value: V): void {
    // If cache is full, evict least recently used entry
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Check if key exists in cache
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict least recently used entry from cache
   */
  private evictLRU(): void {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    // Find least recently used entry
    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
      console.log(`🗑️  [LRU Cache] Evicted server for user: ${String(oldestKey)}`);
    }
  }

  /**
   * Clear entire cache (useful for testing)
   */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Global MCP server cache
 *
 * Configuration:
 * - Max size: 1000 servers (prevents unbounded memory growth)
 * - Eviction policy: LRU (Least Recently Used)
 * - Lifetime: Until Worker is evicted from memory
 *
 * Typical memory usage:
 * - Each MCP server: ~50-100 KB
 * - 1000 servers: ~50-100 MB (acceptable for Workers)
 *
 * Workers have 128 MB memory limit, so 1000 servers leaves plenty of headroom.
 */
const MAX_CACHED_SERVERS = 1000;
const serverCache = new LRUCache<string, McpServer>(MAX_CACHED_SERVERS);

/**
 * Main entry point for API key authenticated MCP requests
 *
 * @param request - Incoming HTTP request
 * @param env - Cloudflare Workers environment
 * @param ctx - Execution context
 * @param pathname - Request pathname (/sse or /mcp)
 * @returns MCP protocol response
 */
export async function handleApiKeyRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string
): Promise<Response> {
  try {
    console.log(`🔐 [API Key Auth] Request to ${pathname}`);

    // 1. Extract API key from Authorization header
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey) {
      console.log("❌ [API Key Auth] Missing Authorization header");
      return jsonError("Missing Authorization header", 401);
    }

    // 2. Validate API key and get user_id
    const userId = await validateApiKey(apiKey, env);

    if (!userId) {
      console.log("❌ [API Key Auth] Invalid or expired API key");
      return jsonError("Invalid or expired API key", 401);
    }

    // 3. Get user from database
    const dbUser = await getUserById(env.TOKEN_DB, userId);

    if (!dbUser) {
      // getUserById already checks is_deleted, so null means not found OR deleted
      console.log(`❌ [API Key Auth] User not found or deleted: ${userId}`);
      return jsonError("User not found or account deleted", 404);
    }

    console.log(
      `✅ [API Key Auth] Authenticated user: ${dbUser.email} (${userId}), balance: ${dbUser.current_token_balance} tokens`
    );

    // 4. Create or get cached MCP server with tools
    const server = await getOrCreateServer(env, userId, dbUser.email);

    // 5. Handle the MCP request using the appropriate transport
    if (pathname === "/sse") {
      return await handleSSETransport(server, request);
    } else if (pathname === "/mcp") {
      return await handleHTTPTransport(server, request, env, userId, dbUser.email);
    } else {
      return jsonError("Invalid endpoint. Use /sse or /mcp", 400);
    }
  } catch (error) {
    console.error("[API Key Auth] Error:", error);
    return jsonError(
      `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }
}

/**
 * Get or create MCP server instance for API key user
 *
 * This creates a standalone MCP server (not using McpAgent) with all tools.
 * The server instance is cached per user to avoid recreating it on every request.
 *
 * Cache behavior:
 * - Cache hit: Returns existing server immediately (~1ms)
 * - Cache miss: Creates new server (~10-50ms), then caches it
 * - Cache full: Evicts least recently used server automatically
 *
 * TODO: When you add new tools to server.ts, you MUST add them here too!
 *
 * @param env - Cloudflare Workers environment
 * @param userId - User ID for token management
 * @param email - User email for logging
 * @returns Configured MCP server instance
 */
async function getOrCreateServer(
  env: Env,
  userId: string,
  email: string
): Promise<McpServer> {
  // Check cache first
  const cached = serverCache.get(userId);
  if (cached) {
    console.log(
      `📦 [LRU Cache] HIT for user ${userId} (cache size: ${serverCache.size}/${MAX_CACHED_SERVERS})`
    );
    return cached;
  }

  console.log(
    `🔧 [LRU Cache] MISS for user ${userId} - creating new server (cache size: ${serverCache.size}/${MAX_CACHED_SERVERS})`
  );

  // Create new MCP server
  const server = new McpServer({
    name: "MCP TypeScript SDK AI Search MCP (API Key)",
    version: "1.0.0",
  });

  // API client initialization - ONLY add when you implement your custom API client
  // Example: const apiClient = new WeatherApiClient(env);
  // DO NOT uncomment until you have actual API client methods implemented

  // ========================================================================
  // Tool: Search MCP TypeScript SDK Documentation (1 token cost)
  // ========================================================================
  server.registerTool(
    "search_mcp_docs",
    {
      title: "Search MCP Docs",
      description: "Search official MCP TypeScript SDK documentation. Returns semantic search results for SDK architecture, tool definitions, transport layers, and code examples. Best for questions about building MCP servers and clients in TypeScript.",
      inputSchema: {
        query: z.string().min(1).meta({ description: "Natural language question about MCP TypeScript SDK (e.g., 'How do I define tools in an MCP server?')" }),
      },
      outputSchema: z.object({
        success: z.boolean(),
        query: z.string(),
        rag_instance: z.string(),
        security_applied: z.object({
          pii_redacted: z.boolean(),
          pii_types_found: z.array(z.string()),
          html_sanitized: z.boolean()
        }),
        answer: z.string()
      })
    },
    async ({ query }) => {
      const TOOL_COST = 1;
      const TOOL_NAME = "search_mcp_docs";
      const RAG_NAME = "map-docs";
      const actionId = crypto.randomUUID();

      try {
        const balanceCheck = await checkBalance(env.TOKEN_DB, userId, TOOL_COST);

        if (balanceCheck.userDeleted) {
          return {
            content: [{ type: "text" as const, text: formatAccountDeletedError(TOOL_NAME) }],
            isError: true,
          };
        }

        if (!balanceCheck.sufficient) {
          return {
            content: [{
              type: "text" as const,
              text: formatInsufficientTokensError(TOOL_NAME, balanceCheck.currentBalance, TOOL_COST),
            }],
            isError: true,
          };
        }

        if (!env.AI) {
          throw new Error("Workers AI binding not configured. Add 'ai' binding to wrangler.jsonc");
        }

        const response = await env.AI.autorag(RAG_NAME).aiSearch({
          query,
          rewrite_query: true,
          max_num_results: 10,
          ranking_options: {
            score_threshold: 0.3,
          },
        }) as { response: string };

        let processed = response.response;

        processed = sanitizeOutput(processed, {
          removeHtml: true,
          removeControlChars: true,
          normalizeWhitespace: true,
          maxLength: 10000
        });

        const { redacted, detectedPII } = redactPII(processed, {
          redactEmails: false,
          redactPhones: true,
          redactCreditCards: true,
          redactSSN: true,
          redactBankAccounts: true,
          redactPESEL: true,
          redactPolishIdCard: true,
          redactPolishPassport: true,
          redactPolishPhones: true,
          placeholder: '[REDACTED]'
        });
        processed = redacted;

        if (detectedPII.length > 0) {
          console.warn(`[Security] Tool ${TOOL_NAME}: Redacted PII types:`, detectedPII);
        }

        const validation = validateOutput(processed, {
          maxLength: 10000,
          expectedType: 'string'
        });

        if (!validation.valid) {
          throw new Error(`Output validation failed: ${validation.errors.join(', ')}`);
        }

        await consumeTokensWithRetry(
          env.TOKEN_DB,
          userId,
          TOOL_COST,
          "mcp-typescript-docs",
          TOOL_NAME,
          { query: query.substring(0, 100) },
          processed.substring(0, 200) + '...',
          true,
          actionId
        );

        const output = {
          success: true,
          query,
          rag_instance: RAG_NAME,
          security_applied: {
            pii_redacted: detectedPII.length > 0,
            pii_types_found: detectedPII,
            html_sanitized: true
          },
          answer: processed
        };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(output, null, 2)
          }],
          structuredContent: output
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('AI Search instance not found') ||
            errorMessage.includes('AutoRAG instance')) {
          return {
            content: [{
              type: "text" as const,
              text: `AI Search instance '${RAG_NAME}' not found or not ready. Please verify the instance exists in Cloudflare Dashboard and indexing is complete.`
            }],
            isError: true,
          };
        }

        if (errorMessage.includes('indexing')) {
          return {
            content: [{
              type: "text" as const,
              text: "MCP TypeScript SDK documentation is still indexing. Please try again in a few minutes."
            }],
            isError: true,
          };
        }

        console.error(`[AutoRAG] Query failed:`, error);
        return {
          content: [{
            type: "text" as const,
            text: `Failed to search MCP TypeScript SDK documentation: ${errorMessage}`
          }],
          isError: true,
        };
      }
    }
  );

  // TODO: Add more tools here following the same pattern

  // Cache the server (automatic LRU eviction if cache is full)
  serverCache.set(userId, server);

  console.log(
    `✅ [LRU Cache] Server created and cached for user ${userId} (cache size: ${serverCache.size}/${MAX_CACHED_SERVERS})`
  );
  return server;
}

/**
 * Handle HTTP (Streamable HTTP) transport for MCP protocol
 *
 * Streamable HTTP is the modern MCP transport protocol that replaced SSE.
 * It uses standard HTTP POST requests with JSON-RPC 2.0 protocol.
 *
 * Supported JSON-RPC methods:
 * - initialize: Protocol handshake and capability negotiation
 * - ping: Health check (required by AnythingLLM)
 * - tools/list: List all available tools
 * - tools/call: Execute a specific tool
 *
 * @param server - Configured MCP server instance
 * @param request - Incoming HTTP POST request with JSON-RPC message
 * @param env - Cloudflare Workers environment
 * @param userId - User ID for logging
 * @param userEmail - User email for logging
 * @returns JSON-RPC response
 */
async function handleHTTPTransport(
  server: McpServer,
  request: Request,
  env: Env,
  userId: string,
  userEmail: string
): Promise<Response> {
  console.log(`📡 [API Key Auth] HTTP transport request from ${userEmail}`);

  try {
    // DNS Rebinding Protection (NEW: SDK 1.20+)
    const origin = request.headers.get('origin');
    const ALLOWED_ORIGINS = [
      'https://claude.ai',
      'https://chatgpt.com',
      'https://panel.wtyczki.ai',
      'https://anythingllm.local'
    ];

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      console.warn(`[Security] Blocked request from origin: ${origin}`);
      return jsonRpcResponse("error", null, {
        code: -32603,
        message: 'Request origin not allowed'
      });
    }

    // Parse JSON-RPC request
    const jsonRpcRequest = await request.json() as {
      jsonrpc: string;
      id: number | string;
      method: string;
      params?: any;
    };

    console.log(`📨 [HTTP] Method: ${jsonRpcRequest.method}, ID: ${jsonRpcRequest.id}`);

    // Validate JSON-RPC 2.0 format
    if (jsonRpcRequest.jsonrpc !== "2.0") {
      return jsonRpcResponse(jsonRpcRequest.id, null, {
        code: -32600,
        message: "Invalid Request: jsonrpc must be '2.0'",
      });
    }

    // Route to appropriate handler based on method
    switch (jsonRpcRequest.method) {
      case "initialize":
        return handleInitialize(jsonRpcRequest);

      case "ping":
        return handlePing(jsonRpcRequest);

      case "tools/list":
        return await handleToolsList(server, jsonRpcRequest);

      case "tools/call":
        return await handleToolsCall(server, jsonRpcRequest, env, userId, userEmail);

      default:
        return jsonRpcResponse(jsonRpcRequest.id, null, {
          code: -32601,
          message: `Method not found: ${jsonRpcRequest.method}`,
        });
    }
  } catch (error) {
    console.error("❌ [HTTP] Error:", error);
    return jsonRpcResponse("error", null, {
      code: -32700,
      message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Handle initialize request (MCP protocol handshake)
 */
function handleInitialize(request: {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}): Response {
  console.log("✅ [HTTP] Initialize request");

  return jsonRpcResponse(request.id, {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "MCP TypeScript SDK AI Search MCP",
      version: "1.0.0",
    },
  });
}

/**
 * Handle ping request (health check)
 */
function handlePing(request: {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}): Response {
  console.log("✅ [HTTP] Ping request");

  return jsonRpcResponse(request.id, {});
}

/**
 * Handle tools/list request (list all available tools)
 *
 * TODO: When you add new tools, update this list to match!
 */
async function handleToolsList(
  server: McpServer,
  request: {
    jsonrpc: string;
    id: number | string;
    method: string;
    params?: any;
  }
): Promise<Response> {
  console.log("✅ [HTTP] Tools list request");

  // Manually define tools since McpServer doesn't expose listTools()
  // These match the tools registered in getOrCreateServer()
  const tools = [
    {
      name: "search_mcp_docs",
      description: "Search official MCP TypeScript SDK documentation. Returns semantic search results for SDK architecture, tool definitions, transport layers, and code examples. Best for questions about building MCP servers and clients in TypeScript.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language question about MCP TypeScript SDK (e.g., 'How do I define tools in an MCP server?')"
          }
        },
        required: ["query"]
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          query: { type: "string" },
          rag_instance: { type: "string" },
          security_applied: {
            type: "object",
            properties: {
              pii_redacted: { type: "boolean" },
              pii_types_found: { type: "array", items: { type: "string" } },
              html_sanitized: { type: "boolean" }
            }
          },
          answer: { type: "string" }
        }
      }
    }
  ];

  return jsonRpcResponse(request.id, {
    tools,
  });
}

/**
 * Handle tools/call request (execute a tool)
 *
 * TODO: When you add new tools, add cases to the switch statement!
 */
async function handleToolsCall(
  server: McpServer,
  request: {
    jsonrpc: string;
    id: number | string;
    method: string;
    params?: {
      name: string;
      arguments?: Record<string, any>;
    };
  },
  env: Env,
  userId: string,
  userEmail: string
): Promise<Response> {
  if (!request.params || !request.params.name) {
    return jsonRpcResponse(request.id, null, {
      code: -32602,
      message: "Invalid params: name is required",
    });
  }

  const toolName = request.params.name;
  const toolArgs = request.params.arguments || {};

  console.log(`🔧 [HTTP] Tool call: ${toolName} by ${userEmail}`, toolArgs);

  try {
    // Execute tool logic based on tool name
    // This duplicates the logic from getOrCreateServer() but is necessary
    // because McpServer doesn't expose a way to call tools directly

    let result: any;

    switch (toolName) {
      case "search_mcp_docs":
        result = await executeSearchMcpDocsTool(userId, toolArgs, env);
        break;

      default:
        return jsonRpcResponse(request.id, null, {
          code: -32601,
          message: `Unknown tool: ${toolName}`,
        });
    }

    console.log(`✅ [HTTP] Tool ${toolName} completed successfully`);

    return jsonRpcResponse(request.id, result);
  } catch (error) {
    console.error(`❌ [HTTP] Tool ${toolName} failed:`, error);
    return jsonRpcResponse(request.id, null, {
      code: -32603,
      message: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function executeSearchMcpDocsTool(
  userId: string,
  args: any,
  env: Env
): Promise<any> {
  const TOOL_COST = 1;
  const TOOL_NAME = "search_mcp_docs";
  const RAG_NAME = "map-docs";
  const actionId = crypto.randomUUID();

  try {
    const { query } = args;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error("query parameter is required and must be a non-empty string");
    }

    const balanceCheck = await checkBalance(env.TOKEN_DB, userId, TOOL_COST);

    if (!balanceCheck.sufficient) {
      return {
        content: [{
          type: "text",
          text: formatInsufficientTokensError(TOOL_NAME, balanceCheck.currentBalance, TOOL_COST)
        }],
        isError: true
      };
    }

    if (!env.AI) {
      throw new Error("Workers AI binding not configured. Add 'ai' binding to wrangler.jsonc");
    }

    const response = await env.AI.autorag(RAG_NAME).aiSearch({
      query,
      rewrite_query: true,
      max_num_results: 10,
      ranking_options: {
        score_threshold: 0.3,
      },
    }) as { response: string };

    let processed = response.response;

    processed = sanitizeOutput(processed, {
      removeHtml: true,
      removeControlChars: true,
      normalizeWhitespace: true,
      maxLength: 10000
    });

    const { redacted, detectedPII } = redactPII(processed, {
      redactEmails: false,
      redactPhones: true,
      redactCreditCards: true,
      redactSSN: true,
      redactBankAccounts: true,
      redactPESEL: true,
      redactPolishIdCard: true,
      redactPolishPassport: true,
      redactPolishPhones: true,
      placeholder: '[REDACTED]'
    });
    processed = redacted;

    if (detectedPII.length > 0) {
      console.warn(`[Security] Tool ${TOOL_NAME}: Redacted PII types:`, detectedPII);
    }

    const validation = validateOutput(processed, {
      maxLength: 10000,
      expectedType: 'string'
    });

    if (!validation.valid) {
      throw new Error(`Output validation failed: ${validation.errors.join(', ')}`);
    }

    await consumeTokensWithRetry(
      env.TOKEN_DB,
      userId,
      TOOL_COST,
      "mcp-typescript-docs",
      TOOL_NAME,
      { query: query.substring(0, 100) },
      processed.substring(0, 200) + '...',
      true,
      actionId
    );

    const output = {
      success: true,
      query,
      rag_instance: RAG_NAME,
      security_applied: {
        pii_redacted: detectedPII.length > 0,
        pii_types_found: detectedPII,
        html_sanitized: true
      },
      answer: processed
    };
    return {
      content: [{
        type: "text",
        text: JSON.stringify(output, null, 2)
      }],
      structuredContent: output
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('AI Search instance not found') ||
        errorMessage.includes('AutoRAG instance')) {
      return {
        content: [{
          type: "text",
          text: `AI Search instance '${RAG_NAME}' not found or not ready. Please verify the instance exists in Cloudflare Dashboard and indexing is complete.`
        }],
        isError: true
      };
    }

    if (errorMessage.includes('indexing')) {
      return {
        content: [{
          type: "text",
          text: "MCP TypeScript SDK documentation is still indexing. Please try again in a few minutes."
        }],
        isError: true
      };
    }

    console.error(`[AutoRAG] Query failed:`, error);
    return {
      content: [{
        type: "text",
        text: `Failed to search MCP TypeScript SDK documentation: ${errorMessage}`
      }],
      isError: true
    };
  }
}

/**
 * Create a JSON-RPC 2.0 response
 */
function jsonRpcResponse(
  id: number | string,
  result: any = null,
  error: { code: number; message: string } | null = null
): Response {
  const response: any = {
    jsonrpc: "2.0",
    id,
  };

  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Handle SSE (Server-Sent Events) transport for MCP protocol
 *
 * SSE is used by AnythingLLM and other clients for real-time MCP communication.
 * This uses the standard MCP SDK SSEServerTransport for Cloudflare Workers.
 *
 * @param server - Configured MCP server instance
 * @param request - Incoming HTTP request
 * @returns SSE response stream
 */
async function handleSSETransport(_server: McpServer, _request: Request): Promise<Response> {
  console.log("📡 [API Key Auth] Setting up SSE transport");

  try {
    // For Cloudflare Workers, we need to return a Response with a ReadableStream
    // The MCP SDK's SSEServerTransport expects Node.js streams, so we'll implement
    // SSE manually for Cloudflare Workers compatibility

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Send SSE headers
    const response = new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });

    // Connect server to client (handle in background)
    // Note: This is a simplified implementation for API key auth
    // Full SSE support would require handling POST messages from client

    (async () => {
      try {
        // Send initial connection event
        await writer.write(encoder.encode("event: message\n"));
        await writer.write(encoder.encode('data: {"status":"connected"}\n\n'));

        console.log("✅ [API Key Auth] SSE connection established");

        // Keep connection alive
        const keepAliveInterval = setInterval(async () => {
          try {
            await writer.write(encoder.encode(": keepalive\n\n"));
          } catch (e) {
            clearInterval(keepAliveInterval);
          }
        }, 30000);

        // Note: Full MCP protocol implementation would go here
        // For MVP, we're providing basic SSE connectivity
      } catch (error) {
        console.error("❌ [API Key Auth] SSE error:", error);
        await writer.close();
      }
    })();

    return response;
  } catch (error) {
    console.error("❌ [API Key Auth] SSE transport error:", error);
    throw error;
  }
}

/**
 * Helper function to return JSON error responses
 *
 * RFC 9728: For 401 responses, includes WWW-Authenticate header with:
 * - resource_metadata URL for OAuth discovery
 * - scope guidance (mcp:read, mcp:write)
 * - error details
 *
 * @param message - Error message
 * @param status - HTTP status code
 * @returns JSON error response
 */
function jsonError(message: string, status: number): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // RFC 9728: Add WWW-Authenticate header for 401 Unauthorized responses
  if (status === 401) {
    const baseUrl = 'https://mcp-typescript-docs.wtyczki.ai';

    headers["WWW-Authenticate"] = [
      'Bearer',
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      'scope="mcp:read mcp:write"',
      'error="invalid_token"',
      `error_description="${message}"`
    ].join(', ');
  }

  return new Response(
    JSON.stringify({
      error: message,
      status: status,
    }),
    {
      status: status,
      headers: headers,
    }
  );
}
