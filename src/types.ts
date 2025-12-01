/**
 * Cloudflare Workers Environment Bindings
 *
 * This interface defines all the bindings available to your MCP server,
 * including authentication credentials and Cloudflare resources.
 *
 * TODO: Add your custom bindings here (AI, R2, additional KV/D1, etc.)
 */
export interface Env {
    /** KV namespace for storing OAuth tokens and session data */
    OAUTH_KV: KVNamespace;

    /** Durable Object namespace for MCP server instances (required by McpAgent) */
    MCP_OBJECT: DurableObjectNamespace;

    /** D1 Database for token management (shared with mcp-token-system) */
    TOKEN_DB: D1Database;

    /** WorkOS Client ID (public, used to initiate OAuth flows) */
    WORKOS_CLIENT_ID: string;

    /** WorkOS API Key (sensitive, starts with sk_, used to initialize WorkOS SDK) */
    WORKOS_API_KEY: string;

    /**
     * KV namespace for centralized custom login session storage (MANDATORY)
     *
     * CRITICAL: This is REQUIRED for centralized authentication at panel.wtyczki.ai
     *
     * Without this binding:
     * - Users will be redirected to default WorkOS UI (exciting-domain-65.authkit.app)
     * - Centralized branded login will NOT work
     * - Session sharing across servers will fail
     *
     * This namespace is already configured in wrangler.jsonc with the correct ID
     * from CLOUDFLARE_CONFIG.md. DO NOT make this optional or remove it.
     *
     * See docs/CUSTOM_LOGIN_GUIDE.md for architecture details.
     */
    USER_SESSIONS: KVNamespace;

    /**
     * Cloudflare AI Gateway Configuration
     *
     * Route all AI requests through AI Gateway for:
     * - Authenticated access control
     * - Rate limiting (60 requests/hour per user)
     * - Response caching (1-hour TTL)
     * - Analytics and monitoring
     */
    AI_GATEWAY_ID: string;
    AI_GATEWAY_TOKEN: string;

    /**
     * Workers AI binding for LLM inference and AutoRAG (AI Search)
     *
     * This binding provides access to:
     * - Workers AI models (e.g., @cf/meta/llama-3.3-70b-instruct-fp8-fast)
     * - AutoRAG (AI Search) via env.AI.autorag("rag-name").aiSearch()
     *
     * Required for:
     * - Querying AI Search instances
     * - Running Workers AI model inference
     * - Embedding generation for vector search
     *
     * Setup: Must be configured in wrangler.jsonc with "ai": { "binding": "AI" }
     */
    AI: Ai;

    // TODO: Add your custom environment variables and bindings here
    // Examples:
    // MY_BUCKET?: R2Bucket;                 // R2 storage bucket
    // EXTERNAL_API_KEY?: string;            // Third-party API credentials
    // CUSTOM_KV?: KVNamespace;              // Additional KV namespace
}

/**
 * TODO: Define your API response types here
 *
 * Example:
 * export interface ExternalApiResponse {
 *     data: string;
 *     status: number;
 *     timestamp: string;
 * }
 */

/**
 * TODO: Define your tool result types here
 *
 * Example:
 * export interface ProcessedDataResult {
 *     processedData: string[];
 *     count: number;
 *     metadata: Record<string, unknown>;
 * }
 */

/**
 * Response format options for tools that return large datasets
 *
 * Based on MCP best practices for token optimization and LLM comprehension.
 * Use this enum to give agents control over response verbosity.
 *
 * @see https://developers.cloudflare.com/agents/model-context-protocol/
 */
export enum ResponseFormat {
    /**
     * Concise format: Essential data only, ~1/3 tokens
     *
     * - Returns human-readable names, descriptions, and key attributes
     * - Excludes technical IDs, metadata, and redundant fields
     * - Optimized for LLM comprehension and decision-making
     * - Default choice for most tools
     *
     * Example: { name: "Report.pdf", type: "PDF", author: "Jane Smith" }
     */
    CONCISE = "concise",

    /**
     * Detailed format: Full data including IDs for programmatic use
     *
     * - Includes all fields from API response
     * - Contains technical identifiers (UUIDs, IDs, hashes)
     * - Useful when agent needs to make subsequent API calls
     * - Use for tools that are building blocks for complex workflows
     *
     * Example: { id: "uuid-123", name: "Report.pdf", mime_type: "application/pdf", ... }
     */
    DETAILED = "detailed"
}
