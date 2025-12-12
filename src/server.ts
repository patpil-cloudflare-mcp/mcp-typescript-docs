import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Env } from "./types";
import type { Props } from "./props";
import { checkBalance, consumeTokensWithRetry } from "./tokenConsumption";
import { formatInsufficientTokensError } from "./tokenUtils";
import { sanitizeOutput, redactPII, validateOutput } from 'pilpat-mcp-security';
import { TOOL_DESCRIPTIONS, TOOL_TITLES, PARAM_DESCRIPTIONS } from './tool-descriptions';

/**
 * Fast heuristic check for potential PII patterns
 * Avoids expensive regex operations when content is clearly clean
 *
 * This function uses lightweight checks to detect if content might contain PII.
 * False positives are acceptable (will trigger full scan), but false negatives
 * are not (would skip PII redaction when needed).
 *
 * @param text Content to check for PII indicators
 * @returns true if potential PII detected (run full scan), false for clean content (skip scan)
 */
function hasPotentialPII(text: string): boolean {
    // Quick character-based heuristics (no regex - very fast)
    const hasAtSymbol = text.includes('@');  // Potential email
    const hasMultipleDashes = text.includes('---') || text.includes('--');  // Potential SSN/ID format
    const hasMultipleDigits = (text.match(/\d/g) || []).length > 10;  // Potential phone/card numbers

    // If no suspicious patterns, skip expensive PII redaction
    if (!hasAtSymbol && !hasMultipleDashes && !hasMultipleDigits) {
        return false;
    }

    // Lightweight regex checks for common PII patterns
    // These patterns are simplified for speed - full patterns run in redactPII()
    const patterns = [
        /\d{3}[-.\s]?\d{2}[-.\s]?\d{4}/,     // SSN-like: 123-45-6789
        /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/, // Credit card-like: 1234-5678-9012-3456
        /\d{11}/,                             // PESEL-like: 11 consecutive digits
        /\+?[\d\s()-]{10,}/,                  // Phone-like: +48 123 456 789
        /\d{2}[-\s]?\d{4,}/,                  // Bank account patterns
        /[A-Z]{3}\d{6}/,                      // Polish passport-like: ABC123456
    ];

    return patterns.some(pattern => pattern.test(text));
}

/**
 * MCP TypeScript Docs Server with Token Integration
 *
 * This server provides secure, token-based access to the Model Context Protocol (MCP) TypeScript SDK documentation from GitHub
 * indexed in the ai-search-map-docs AI Search instance.
 *
 * Generic type parameters:
 * - Env: Cloudflare Workers environment bindings (KV, D1, WorkOS credentials, AI)
 * - unknown: No state management (stateless server)
 * - Props: Authenticated user context from WorkOS (user, tokens, permissions, userId)
 *
 * Authentication flow:
 * 1. User connects via MCP client
 * 2. Redirected to WorkOS AuthKit (Magic Auth)
 * 3. User enters email → receives 6-digit code
 * 4. OAuth callback checks if user exists in token database
 * 5. If not in database → 403 error page
 * 6. If in database → Access granted, user info available via this.props
 * 7. All tools check token balance before execution
 */
export class McpTypescriptDocsMCP extends McpAgent<Env, unknown, Props> {
    server = new McpServer(
        {
            name: "MCP TypeScript Docs",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
                prompts: { listChanged: true }  // Required for prompt support
            },
            instructions: `
MCP TypeScript SDK - Semantic search for Model Context Protocol (MCP) TypeScript SDK documentation from GitHub

## Key Capabilities
- MCP SDK architecture and core concepts (Client, Server, Transport layers)
- TypeScript code examples for building MCP servers and clients
- Tool definitions, resource handlers, and prompt management patterns
- Protocol specifications and message format documentation

## Usage Patterns
- Use \`search_mcp_docs\` for questions about MCP TypeScript SDK
- Include specific context in queries for more accurate results (e.g., "How do I create an MCP server with custom tools?")
- For MCP server development and SDK reference: Include specific SDK component or pattern in your query for best results

## Performance
- Search response time: 500ms-2s
- Results cached for 5 minutes
- AI Search instance: 1,430+ pages

## Important Notes
- Indexed content: Official MCP TypeScript SDK documentation from GitHub repository
- Does not include: Python SDK documentation, third-party implementations
            `.trim(),
        }
    );

    async init() {
        // ========================================================================
        // Tool: search_mcp_docs
        // ========================================================================
        // Queries the ai-search-map-docs AI Search instance for Model Context Protocol (MCP) TypeScript SDK documentation from GitHub
        this.server.registerTool(
            "search_mcp_docs",
            {
                title: TOOL_TITLES.SEARCH_MCP_DOCS,
                description: TOOL_DESCRIPTIONS.SEARCH_MCP_DOCS,
                inputSchema: {
                    query: z.string().min(1).describe(PARAM_DESCRIPTIONS.QUERY),
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
                const TOOL_COST = 1; // Custom cost for MCP docs search
                const TOOL_NAME = "search_mcp_docs";
                const RAG_NAME = "map-docs";
                const actionId = crypto.randomUUID();

                try {
                    // 1. Get user ID
                    const userId = this.props?.userId;
                    if (!userId) {
                        throw new Error("User ID not found in authentication context");
                    }

                    // 2. Check token balance
                    const balanceCheck = await checkBalance(this.env.TOKEN_DB, userId, TOOL_COST);

                    // 3. Handle insufficient balance
                    if (!balanceCheck.sufficient) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: formatInsufficientTokensError(TOOL_NAME, balanceCheck.currentBalance, TOOL_COST)
                            }],
                            isError: true
                        };
                    }

                    // 4. Execute AutoRAG query
                    if (!this.env.AI) {
                        throw new Error("Workers AI binding not configured. Add 'ai' binding to wrangler.jsonc");
                    }

                    const response = await this.env.AI.autorag(RAG_NAME).aiSearch({
                        query,
                        rewrite_query: true,  // Recommended: Improves retrieval accuracy
                        max_num_results: 10,  // Balanced depth for quality answers
                        ranking_options: {
                            score_threshold: 0.3,  // Standard threshold for documentation
                        },
                    }) as { response: string };

                    // 4.5. SECURITY: Sanitize and redact PII from AutoRAG output (PHASE 2)
                    let processed = response.response;
                    const securityPerfStart = Date.now();

                    // Phase 2A: Sanitize HTML and normalize content (ALWAYS run - lightweight)
                    processed = sanitizeOutput(processed, {
                        removeHtml: true,
                        removeControlChars: true,
                        normalizeWhitespace: true,
                        maxLength: 10000
                    });

                    // Phase 2B: Fast-path detection for clean documentation responses
                    const needsPIIRedaction = hasPotentialPII(processed);

                    let detectedPII: string[] = [];
                    if (needsPIIRedaction) {
                        console.log(`[Security] PII patterns detected, running full redaction`);

                        // Full PII redaction (expensive)
                        const redactionResult = redactPII(processed, {
                            // US/International PII
                            redactEmails: false,  // v1.1.0+ default, enable if needed
                            redactPhones: true,
                            redactCreditCards: true,
                            redactSSN: true,
                            redactBankAccounts: true,

                            // Polish Market PII (Phase 2)
                            redactPESEL: true,
                            redactPolishIdCard: true,
                            redactPolishPassport: true,
                            redactPolishPhones: true,

                            placeholder: '[REDACTED]'
                        });
                        processed = redactionResult.redacted;
                        detectedPII = redactionResult.detectedPII;
                    } else {
                        console.log(`[Security] Fast-path: No PII patterns detected, skipping redaction`);
                    }

                    // Log performance and detected PII
                    const securityDuration = Date.now() - securityPerfStart;
                    console.log(`[Security] Processing took ${securityDuration}ms (PII scan: ${needsPIIRedaction ? 'FULL' : 'SKIPPED'})`);

                    if (detectedPII.length > 0) {
                        console.warn(`[Security] Tool ${TOOL_NAME}: Redacted PII types:`, detectedPII);
                    }

                    // Phase 2C: Validate output before returning
                    const validation = validateOutput(processed, {
                        maxLength: 10000,
                        expectedType: 'string'
                    });

                    if (!validation.valid) {
                        throw new Error(`Output validation failed: ${validation.errors.join(', ')}`);
                    }

                    // 5. Consume tokens WITH RETRY and idempotency protection
                    await consumeTokensWithRetry(
                        this.env.TOKEN_DB,
                        userId,
                        TOOL_COST,
                        "tsmcpdocs",
                        TOOL_NAME,
                        {
                            query: query.substring(0, 100)
                        },
                        processed.substring(0, 200) + '...', // Log truncated result
                        true,
                        actionId
                    );

                    // 6. Return securely processed AutoRAG result with structuredContent
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
                            text: processed  // Return answer directly, avoid double JSON encoding
                        }],
                        structuredContent: output
                    };
                } catch (error) {
                    // Error handling
                    const errorMessage = error instanceof Error ? error.message : String(error);

                    // Handle AutoRAG-specific errors
                    if (errorMessage.includes('AI Search instance not found') ||
                        errorMessage.includes('AutoRAG instance')) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: `AI Search instance '${RAG_NAME}' not found or not ready. Please verify the instance exists in Cloudflare Dashboard and indexing is complete.`
                            }],
                            isError: true
                        };
                    }

                    if (errorMessage.includes('indexing')) {
                        return {
                            content: [{
                                type: "text" as const,
                                text: "Model Context Protocol (MCP) TypeScript SDK documentation from GitHub is still indexing. Please try again in a few minutes."
                            }],
                            isError: true
                        };
                    }

                    // Generic error
                    console.error(`[AutoRAG] Query failed:`, error);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Failed to search Model Context Protocol (MCP) TypeScript SDK documentation from GitHub: ${errorMessage}`
                        }],
                        isError: true
                    };
                }
            }
        );

        // ========================================================================
        // PROMPT REGISTRATION: SDK 1.20+ registerPrompt() Pattern
        // Progressive complexity: Core prompt first, enhanced workflow second
        // ========================================================================

        // Prompt 1: Core Function (simple, direct)
        this.server.registerPrompt(
            "search-docs",
            {
                title: "Search MCP SDK Documentation",
                description: "Search the official MCP TypeScript SDK documentation for a specific topic or concept.",
                argsSchema: {
                    topic: z.string()
                        .min(2)
                        .max(200)
                        .describe("Topic or concept to search (e.g., 'tool registration', 'OAuth flow', 'Durable Objects')")
                }
            },
            async ({ topic }) => ({
                messages: [{
                    role: "user",
                    content: {
                        type: "text",
                        text: `Please use the 'search_mcp_docs' tool to find information about: ${topic}`
                    }
                }]
            })
        );

        // Prompt 2: Enhanced Workflow (adds context for code examples)
        this.server.registerPrompt(
            "find-code-example",
            {
                title: "Find Code Example",
                description: "Search for TypeScript code examples and implementation patterns in MCP SDK documentation.",
                argsSchema: {
                    feature: z.string()
                        .min(2)
                        .max(200)
                        .describe("MCP feature or API needing code example (e.g., 'registerTool', 'McpAgent', 'structuredContent')")
                }
            },
            async ({ feature }) => ({
                messages: [{
                    role: "user",
                    content: {
                        type: "text",
                        text: `Please use the 'search_mcp_docs' tool to find TypeScript code examples for: ${feature}. Focus on implementation patterns and best practices.`
                    }
                }]
            })
        );
    }
}
