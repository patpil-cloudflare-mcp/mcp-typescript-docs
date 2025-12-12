/**
 * Shared tool descriptions for dual-auth consistency
 * Used in both OAuth (server.ts) and API key (api-key-handler.ts) paths
 *
 * SECURITY: Never include API vendor names in descriptions
 * Follow 4-part formula: Purpose → Return Value → Use Case → Constraints
 *
 * @see guides/tools_description/TOOL_DESCRIPTION_BEST_PRACTICES.md
 */

export const TOOL_TITLES = {
    SEARCH_MCP_DOCS: "Search MCP SDK Documentation",
} as const;

export const TOOL_DESCRIPTIONS = {
    /**
     * 4-Part Description Formula:
     * Part 1: Purpose - Action verb + functionality
     * Part 2: Return Value - What data is returned
     * Part 3: Use Case - When to use this tool
     * Part 4: Constraints - Any limitations (optional)
     */
    SEARCH_MCP_DOCS:
        "Search the official MCP TypeScript SDK documentation using AI-powered semantic search. " +
        "Returns relevant passages, code examples, source URLs, and implementation patterns. " +
        "Use when you need to understand MCP concepts, find API references, or discover best practices for building MCP servers. " +
        "Note: Results are cached for 5 minutes to optimize response times.",
} as const;

/**
 * Parameter descriptions for consistent validation messages
 * Include: Format, Valid values, Examples, Default, Purpose
 */
export const PARAM_DESCRIPTIONS = {
    QUERY: "Natural language question about MCP TypeScript SDK (e.g., 'How do I define tools in an MCP server?', 'OAuth 2.1 implementation', 'Durable Objects patterns')",
} as const;
