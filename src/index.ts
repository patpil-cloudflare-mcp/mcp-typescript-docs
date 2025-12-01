import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpTypescriptDocsMCP } from "./server";
import { AuthkitHandler } from "./authkit-handler";
import { handleApiKeyRequest } from "./api-key-handler";
import type { Env } from "./types";

// Export the McpAgent class for Cloudflare Workers
export { McpTypescriptDocsMCP };

/**
 * Mcp Typescript Docs M C P with Dual Authentication Support
 *
 * This MCP server supports TWO authentication methods:
 *
 * 1. OAuth 2.1 (WorkOS AuthKit) - For OAuth-capable clients
 *    - Flow: Client → /authorize → WorkOS → Magic Auth → /callback → Tools
 *    - Used by: Claude Desktop, ChatGPT, OAuth-capable clients
 *    - Endpoints: /authorize, /callback, /token, /register
 *
 * 2. API Key Authentication - For non-OAuth clients
 *    - Flow: Client sends Authorization: Bearer wtyk_XXX → Validate → Tools
 *    - Used by: AnythingLLM, Cursor IDE, custom scripts
 *    - Endpoints: /sse, /mcp (with wtyk_ API key in header)
 *
 * MCP Endpoints (support both auth methods):
 * - /sse - Server-Sent Events transport (for AnythingLLM, Claude Desktop)
 * - /mcp - Streamable HTTP transport (for ChatGPT and modern clients)
 *
 * OAuth Endpoints (OAuth only):
 * - /authorize - Initiates OAuth flow, redirects to WorkOS AuthKit
 * - /callback - Handles OAuth callback from WorkOS
 * - /token - Token endpoint for OAuth clients
 * - /register - Dynamic Client Registration endpoint
 *
 * Available Tools (after authentication):
 *  * - search_mcp_docs: Search MCP TypeScript SDK documentation for building MCP servers and clients (1 tokens)
 */

// Create OAuthProvider instance (used when OAuth authentication is needed)
const oauthProvider = new OAuthProvider({
    // Dual transport support (SSE + Streamable HTTP)
    // This ensures compatibility with all MCP clients (Claude, ChatGPT, etc.)
    apiHandlers: {
        '/sse': McpTypescriptDocsMCP.serveSSE('/sse'),  // Legacy SSE transport
        '/mcp': McpTypescriptDocsMCP.serve('/mcp'),     // New Streamable HTTP transport
    },

    // OAuth authentication handler (WorkOS AuthKit integration)
    defaultHandler: AuthkitHandler as any,

    // OAuth 2.1 endpoints
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
});

/**
 * Custom fetch handler with dual authentication support
 *
 * This handler detects the authentication method and routes requests accordingly:
 * - API key (wtyk_*) → Direct API key authentication
 * - OAuth token or no auth → OAuth flow via OAuthProvider
 */
export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {
        try {
            const url = new URL(request.url);
            const authHeader = request.headers.get("Authorization");

            // Check for API key authentication on MCP endpoints
            if (isApiKeyRequest(url.pathname, authHeader)) {
                console.log(`🔐 [Dual Auth] API key request detected: ${url.pathname}`);
                return await handleApiKeyRequest(request, env, ctx, url.pathname);
            }

            // Otherwise, use OAuth flow
            console.log(`🔐 [Dual Auth] OAuth request: ${url.pathname}`);
            return await oauthProvider.fetch(request, env, ctx);

        } catch (error) {
            console.error("[Dual Auth] Error:", error);
            return new Response(
                JSON.stringify({
                    error: "Internal server error",
                    message: error instanceof Error ? error.message : String(error),
                }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }
    },
};

/**
 * Detect if request should use API key authentication
 *
 * Criteria:
 * 1. Must be an MCP endpoint (/sse or /mcp)
 * 2. Must have Authorization header with API key (starts with wtyk_)
 *
 * OAuth endpoints (/authorize, /callback, /token, /register) are NEVER intercepted.
 *
 * @param pathname - Request pathname
 * @param authHeader - Authorization header value
 * @returns true if API key request, false otherwise
 */
function isApiKeyRequest(pathname: string, authHeader: string | null): boolean {
    // Only intercept MCP transport endpoints
    if (pathname !== "/sse" && pathname !== "/mcp") {
        return false;
    }

    // Check if Authorization header contains API key
    if (!authHeader) {
        return false;
    }

    const token = authHeader.replace("Bearer ", "");
    return token.startsWith("wtyk_");
}
