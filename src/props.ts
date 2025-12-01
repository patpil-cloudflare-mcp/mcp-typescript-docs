import type { User } from "@workos-inc/node";

/**
 * Props type for authenticated user context in your MCP Server
 *
 * This type defines the authentication and authorization data that will be
 * available via `this.props` in the McpAgent after successful OAuth flow.
 *
 * Data comes from WorkOS AuthKit after Magic Auth authentication and
 * database user lookup for token management.
 */
export interface Props {
    // WorkOS authentication data
    /** WorkOS user object containing id, email, firstName, lastName, etc. */
    user: User;

    /** JWT access token issued by WorkOS for this session */
    accessToken: string;

    /** Refresh token for renewing the access token when it expires */
    refreshToken: string;

    /** Array of permission slugs assigned to this user (e.g., ["tool_access", "admin"]) */
    permissions: string[];

    /** Optional: WorkOS organization ID if user belongs to an organization */
    organizationId?: string;

    // Database user data (populated during OAuth callback)
    /** User ID from mcp-tokens-database (primary key for token management) */
    userId: string;

    /** User email address (from WorkOS, used to query database) */
    email: string;

    /**
     * Index signature required by McpAgent generic Props type
     * Allows additional custom properties to be stored in the auth context
     */
    [key: string]: unknown;
}
