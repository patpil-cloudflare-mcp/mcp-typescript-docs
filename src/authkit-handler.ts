import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import * as jose from "jose";
import { type AccessToken, type AuthenticationResponse, WorkOS } from "@workos-inc/node";
import type { Env } from "./types";
import type { Props } from "./props";
import { getUserByEmail, formatPurchaseRequiredPage, formatAccountDeletedPage, formatOAuthSuccessPage } from "./tokenUtils";

/**
 * PKCE (Proof Key for Code Exchange) - OAuth 2.1 Requirement
 *
 * PKCE is now MANDATORY for all OAuth 2.1 authorization code flows.
 * It prevents authorization code interception attacks.
 *
 * Reference: https://workos.com/blog/oauth-2-1-changes
 */

/** Generate cryptographically random code verifier (32 bytes = 43 chars base64url) */
function generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
}

/** Generate S256 code challenge from verifier */
async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(hash));
}

/** Base64 URL encoding (RFC 4648) */
function base64UrlEncode(buffer: Uint8Array): string {
    // Convert Uint8Array to string without spread operator (ES5 compatible)
    let binaryString = '';
    for (let i = 0; i < buffer.length; i++) {
        binaryString += String.fromCharCode(buffer[i]);
    }
    const base64 = btoa(binaryString);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Store code verifier in KV with 10-minute TTL */
async function storeCodeVerifier(env: Env, state: string, verifier: string): Promise<void> {
    if (!env.USER_SESSIONS) {
        console.warn('⚠️ [PKCE] USER_SESSIONS KV not configured - PKCE disabled');
        return;
    }
    await env.USER_SESSIONS.put(`pkce:${state}`, verifier, {
        expirationTtl: 600 // 10 minutes
    });
}

/** Retrieve and delete code verifier from KV (one-time use) */
async function getCodeVerifier(env: Env, state: string): Promise<string | null> {
    if (!env.USER_SESSIONS) {
        console.warn('⚠️ [PKCE] USER_SESSIONS KV not configured - PKCE disabled');
        return null;
    }
    const verifier = await env.USER_SESSIONS.get(`pkce:${state}`);
    if (verifier) {
        await env.USER_SESSIONS.delete(`pkce:${state}`);
    }
    return verifier;
}

/**
 * Authentication handler for WorkOS AuthKit integration
 *
 * This is the DEFAULT authentication implementation using WorkOS-hosted UI.
 * Users see WorkOS branding during login (simple, minimal code, fast setup).
 *
 * ALTERNATIVE: For custom branded login UI, see docs/CUSTOM_LOGIN_GUIDE.md
 * The custom login approach gives you full control over branding and messaging.
 *
 * This Hono app implements OAuth 2.1 routes for MCP client authentication:
 * - /authorize: Redirects users to WorkOS AuthKit (Magic Auth)
 * - /callback: Handles OAuth callback and completes authorization
 *
 * Magic Auth flow (DEFAULT WorkOS UI):
 * 1. User clicks "Connect" in MCP client
 * 2. Redirected to /authorize → WorkOS AuthKit (hosted UI)
 * 3. User enters email → receives 6-digit code
 * 4. User enters code → WorkOS validates
 * 5. Callback to /callback with authorization code
 * 6. Exchange code for tokens and user info
 * 7. Check if user exists in token database
 * 8. IF NOT in database → 403 error page with purchase link
 * 9. IF in database → Complete OAuth and redirect back to MCP client
 *
 * TODO: Customize the server name in formatPurchaseRequiredPage if needed
 */
const app = new Hono<{
    Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
    Variables: { workOS: WorkOS };
}>();

/**
 * Middleware: Initialize WorkOS SDK for all routes
 */
app.use(async (c, next) => {
    c.set("workOS", new WorkOS(c.env.WORKOS_API_KEY));
    await next();
});

/**
 * GET /authorize
 *
 * Initiates OAuth flow with centralized custom login integration.
 *
 * FLOW:
 * 1. Check for session cookie from centralized login (panel.wtyczki.ai)
 * 2. If no session → redirect to centralized custom login
 * 3. If session exists → validate from USER_SESSIONS KV
 * 4. If session valid → query database and complete OAuth
 * 5. If session invalid/expired → redirect to centralized custom login
 * 6. Fallback to WorkOS if USER_SESSIONS not configured
 *
 * See docs/CUSTOM_LOGIN_GUIDE.md for centralized login architecture.
 */
app.get("/authorize", async (c) => {
    // Parse the OAuth request from the MCP client
    const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    if (!oauthReqInfo.clientId) {
        return c.text("Invalid request", 400);
    }

    // ============================================================
    // STEP 1: Check for session cookie from centralized login
    // ============================================================
    const cookieHeader = c.req.header('Cookie');
    let sessionToken: string | null = null;

    if (cookieHeader) {
        const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
            const [key, value] = cookie.trim().split('=');
            acc[key] = value;
            return acc;
        }, {} as Record<string, string>);
        sessionToken = cookies['workos_session'] || null;
    }

    // ============================================================
    // STEP 2: If no session, redirect to centralized custom login
    // ============================================================
    if (!sessionToken && c.env.USER_SESSIONS) {
        console.log('🔐 [OAuth] No session found, redirecting to centralized custom login');
        const loginUrl = new URL('https://panel.wtyczki.ai/auth/login-custom');
        loginUrl.searchParams.set('return_to', c.req.url);
        return Response.redirect(loginUrl.toString(), 302);
    }

    // ============================================================
    // STEP 3: Validate session if present
    // ============================================================
    if (sessionToken && c.env.USER_SESSIONS) {
        const sessionData = await c.env.USER_SESSIONS.get(
            `workos_session:${sessionToken}`,
            'json'
        );

        if (!sessionData) {
            console.log('🔐 [OAuth] Invalid session, redirecting to centralized custom login');
            const loginUrl = new URL('https://panel.wtyczki.ai/auth/login-custom');
            loginUrl.searchParams.set('return_to', c.req.url);
            return Response.redirect(loginUrl.toString(), 302);
        }

        const session = sessionData as {
            expires_at: number;
            user_id: string;
            email: string
        };

        // Check expiration
        if (session.expires_at < Date.now()) {
            console.log('🔐 [OAuth] Session expired, redirecting to centralized custom login');
            const loginUrl = new URL('https://panel.wtyczki.ai/auth/login-custom');
            loginUrl.searchParams.set('return_to', c.req.url);
            return Response.redirect(loginUrl.toString(), 302);
        }

        // ============================================================
        // STEP 4: Session valid - load user from database
        // ============================================================
        console.log(`✅ [OAuth] Valid session found for user: ${session.email}`);

        // CRITICAL: Query database for current user data (balance, deletion status)
        const dbUser = await getUserByEmail(c.env.TOKEN_DB, session.email);

        if (!dbUser) {
            console.log(`❌ [OAuth] User not found in database: ${session.email}`);
            return c.html(formatPurchaseRequiredPage(session.email), 403);
        }

        if (dbUser.is_deleted === 1) {
            console.log(`❌ [OAuth] Account deleted: ${session.email}`);
            return c.html(formatAccountDeletedPage(), 403);
        }

        // ============================================================
        // STEP 5: Complete OAuth authorization directly (skip WorkOS redirect)
        // ============================================================
        const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
            request: oauthReqInfo,
            userId: session.user_id,
            metadata: {},
            scope: [],
            props: {
                // WorkOS data (empty since we used centralized login)
                accessToken: '',
                organizationId: undefined,
                permissions: [],
                refreshToken: '',

                // Reconstructed User object
                user: {
                    id: session.user_id,
                    email: session.email,
                    emailVerified: true,
                    profilePictureUrl: null,
                    firstName: null,
                    lastName: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lastSignInAt: new Date().toISOString(),
                    locale: null,
                    externalId: null,
                    metadata: {},
                    object: 'user' as const,
                },

                // Database user data (CRITICAL for token operations)
                userId: dbUser.user_id,
                email: dbUser.email,
            } satisfies Props,
        });

        // Show success page with auto-redirect (provides user feedback)
        console.log(`✅ [OAuth] Authorization complete for: ${session.email}, redirecting to MCP client`);
        return c.html(formatOAuthSuccessPage(session.email, redirectTo), 200);
    }

    // ============================================================
    // STEP 6: Fallback to WorkOS (if USER_SESSIONS not configured)
    // ============================================================
    console.log('⚠️ [OAuth] No session handling - falling back to WorkOS');

    // OAuth 2.1: Generate PKCE parameters
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = btoa(JSON.stringify(oauthReqInfo));

    // Store code_verifier for later token exchange (10-minute TTL)
    await storeCodeVerifier(c.env, state, codeVerifier);
    console.log('✅ [PKCE] Code verifier generated and stored');

    return Response.redirect(
        c.get("workOS").userManagement.getAuthorizationUrl({
            provider: "authkit",
            clientId: c.env.WORKOS_CLIENT_ID,
            redirectUri: new URL("/callback", c.req.url).href,
            state,
            codeChallenge,
            codeChallengeMethod: 'S256', // SHA-256 (OAuth 2.1 requirement)
        }),
    );
});

/**
 * GET /callback
 *
 * Handles OAuth callback from WorkOS AuthKit after successful authentication.
 * Exchanges authorization code for tokens and completes the OAuth flow.
 *
 * CRITICAL: Checks if user exists in token database before granting access.
 */
app.get("/callback", async (c) => {
    const workOS = c.get("workOS");

    // Decode the OAuth request info from state parameter
    const oauthReqInfo = JSON.parse(atob(c.req.query("state") as string)) as AuthRequest;
    if (!oauthReqInfo.clientId) {
        return c.text("Invalid state", 400);
    }

    // Get authorization code from query params
    const code = c.req.query("code");
    if (!code) {
        return c.text("Missing code", 400);
    }

    // OAuth 2.1: Retrieve code_verifier from KV
    const state = c.req.query("state") as string;
    const codeVerifier = await getCodeVerifier(c.env, state);

    if (!codeVerifier) {
        console.error("[PKCE] Code verifier not found or expired");
        return c.text("Invalid or expired PKCE verification", 400);
    }
    console.log('✅ [PKCE] Code verifier retrieved');

    // Exchange authorization code for tokens and user info (with PKCE)
    let response: AuthenticationResponse;
    try {
        response = await workOS.userManagement.authenticateWithCode({
            clientId: c.env.WORKOS_CLIENT_ID,
            code,
            codeVerifier, // OAuth 2.1: PKCE verification
        });
        console.log('✅ [PKCE] Code verifier validated by WorkOS');
    } catch (error) {
        console.error("[MCP OAuth] Authentication error:", error);
        return c.text("Invalid authorization code or PKCE verification failed", 400);
    }

    // Extract authentication data
    const { accessToken, organizationId, refreshToken, user } = response;

    // Decode JWT to get permissions
    const { permissions = [] } = jose.decodeJwt<AccessToken>(accessToken);

    // CRITICAL: Check if user exists in token database
    console.log(`[MCP OAuth] Checking if user exists in database: ${user.email}`);
    const dbUser = await getUserByEmail(c.env.TOKEN_DB, user.email);

    // If user not found in database, reject authorization and show purchase page
    if (!dbUser) {
        console.log(`[MCP OAuth] ❌ User not found in database: ${user.email} - Tokens required`);
        return c.html(formatPurchaseRequiredPage(user.email), 403);
    }

    // SECURITY FIX: Defensive check for deleted accounts (belt-and-suspenders approach)
    // This provides defense-in-depth even if getUserByEmail() query is modified
    if (dbUser.is_deleted === 1) {
        console.log(`[MCP OAuth] ❌ Account deleted: ${user.email} (user_id: ${dbUser.user_id})`);
        return c.html(formatAccountDeletedPage(), 403);
    }

    console.log(`[MCP OAuth] ✅ User found in database: ${dbUser.user_id}, balance: ${dbUser.current_token_balance} tokens`);

    // Complete OAuth flow and get redirect URL back to MCP client
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: user.id,
        metadata: {},
        scope: permissions,

        // Props will be available via `this.props` in your McpAgent class
        // Include database user info for token management
        props: {
            // WorkOS authentication data
            accessToken,
            organizationId,
            permissions,
            refreshToken,
            user,

            // Database user data for token management
            userId: dbUser.user_id,
            email: dbUser.email,
        } satisfies Props,
    });

    // Show success page with auto-redirect (provides user feedback)
    console.log(`✅ [OAuth Callback] Authorization complete for: ${user.email}, redirecting to MCP client`);
    return c.html(formatOAuthSuccessPage(user.email, redirectTo), 200);
});

export const AuthkitHandler = app;
