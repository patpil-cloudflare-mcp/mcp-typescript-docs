/**
 * Token Management Utilities for Skeleton MCP Server
 *
 * This module provides local utility functions for:
 * 1. Querying user information from shared token database
 * 2. Formatting error messages in Polish
 * 3. Rendering error pages for unauthorized users
 *
 * CRITICAL PRINCIPLE: Always query database for current balance. Never cache.
 *
 * Database Schema (from mcp-token-system):
 * - users: user_id, email, current_token_balance, total_tokens_used, total_tokens_purchased
 * - transactions: transaction_id, user_id, type, token_amount, balance_after, description, created_at
 * - mcp_actions: action_id, user_id, mcp_server_name, tool_name, parameters, tokens_consumed, success, created_at
 *
 * NOTE: Token consumption logic has been moved to tokenConsumption.ts module.
 * Use checkBalance() and consumeTokensWithRetry() from that module instead.
 */

/**
 * Database user record from mcp-tokens-database
 */
export interface DatabaseUser {
    user_id: string;
    email: string;
    current_token_balance: number;
    total_tokens_purchased: number;
    total_tokens_used: number;
    stripe_customer_id: string | null;
    created_at: string;
    is_deleted: number; // 0 = active, 1 = deleted (SECURITY: Added for account deletion check)
}

/**
 * Query user from database by email address
 *
 * @param db - D1 Database instance
 * @param email - User's email address (from WorkOS authentication)
 * @returns User record if found, null otherwise
 */
export async function getUserByEmail(
    db: D1Database,
    email: string
): Promise<DatabaseUser | null> {
    try {
        console.log(`[MCP Token Utils] Querying user by email: ${email}`);

        // SECURITY FIX: Check is_deleted to prevent deleted users from authenticating
        const result = await db
            .prepare('SELECT * FROM users WHERE email = ? AND is_deleted = 0')
            .bind(email)
            .first<DatabaseUser>();

        if (!result) {
            console.log(`[MCP Token Utils] User not found in database: ${email}`);
            return null;
        }

        console.log(`[MCP Token Utils] User found: ${result.user_id}, balance: ${result.current_token_balance} tokens`);
        return result;
    } catch (error) {
        console.error('[MCP Token Utils] Error querying user by email:', error);
        throw new Error('Failed to query user from database');
    }
}

/**
 * Query user from database by user ID
 *
 * Used by API key authentication to get user information after validating the API key.
 *
 * @param db - D1 Database instance
 * @param userId - User's ID (from API key validation)
 * @returns User record if found and not deleted, null otherwise
 */
export async function getUserById(
    db: D1Database,
    userId: string
): Promise<DatabaseUser | null> {
    try {
        console.log(`[MCP Token Utils] Querying user by ID: ${userId}`);

        // SECURITY FIX: Check is_deleted to prevent deleted users from authenticating
        const result = await db
            .prepare('SELECT * FROM users WHERE user_id = ? AND is_deleted = 0')
            .bind(userId)
            .first<DatabaseUser>();

        if (!result) {
            console.log(`[MCP Token Utils] User not found or deleted: ${userId}`);
            return null;
        }

        console.log(`[MCP Token Utils] User found: ${result.email}, balance: ${result.current_token_balance} tokens`);
        return result;
    } catch (error) {
        console.error('[MCP Token Utils] Error querying user by ID:', error);
        throw new Error('Failed to query user from database');
    }
}

/**
 * Format insufficient tokens error message in Polish
 *
 * Creates a user-friendly error message with:
 * - Tool name that requires tokens
 * - Current balance
 * - Required tokens
 * - Link to purchase more tokens
 *
 * @param toolName - Name of the tool that requires tokens
 * @param currentBalance - User's current token balance
 * @param requiredTokens - Number of tokens required
 * @returns Formatted error message in Polish
 */
export function formatInsufficientTokensError(
    toolName: string,
    currentBalance: number,
    requiredTokens: number
): string {
    const tokenWord = currentBalance === 1 ? 'token' : (currentBalance === 0 || currentBalance >= 5 ? 'tokenów' : 'tokeny');
    const requiredWord = requiredTokens === 1 ? 'token' : (requiredTokens >= 5 ? 'tokenów' : 'tokeny');

    return `Niewystarczająca liczba tokenów do wykonania ${toolName}.
Aktualny stan: ${currentBalance} ${tokenWord}
Wymagane: ${requiredTokens} ${requiredWord}
Kup tokeny: https://panel.wtyczki.ai/`;
}

/**
 * Format deleted account error message in Polish
 *
 * Creates a user-friendly error message explaining that the account
 * has been deleted and MCP tools are no longer accessible.
 *
 * @param toolName - Name of the tool that was attempted
 * @returns Formatted error message in Polish
 */
export function formatAccountDeletedError(toolName: string): string {
    return `❌ Konto zostało usunięte

To konto zostało usunięte zgodnie z żądaniem użytkownika.
Nie możesz korzystać z narzędzia ${toolName}.

ℹ️ Informacja RODO:
Twoje dane zostały anonimizowane zgodnie z art. 17 RODO (prawo do bycia zapomnianym).

Jeśli chcesz ponownie korzystać z usługi, możesz utworzyć nowe konto na:
https://panel.wtyczki.ai/`;
}

/**
 * Format error page HTML for users not in database
 *
 * Creates an HTML error page for users who authenticated via WorkOS
 * but don't have tokens in the database (never purchased).
 *
 * TODO: Customize the server name in the title and heading if needed
 *
 * @param userEmail - User's email address
 * @returns HTML error page
 */
export function formatPurchaseRequiredPage(userEmail: string): string {
    return `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Wymagane tokeny - MCP Server</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            text-align: center;
            background: #f5f5f5;
        }
        .error-box {
            background: white;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #e74c3c;
            margin-bottom: 20px;
        }
        p {
            color: #555;
            line-height: 1.6;
            margin-bottom: 30px;
        }
        .email {
            font-weight: bold;
            color: #2c3e50;
        }
        .purchase-button {
            display: inline-block;
            background: #3498db;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            transition: background 0.3s;
        }
        .purchase-button:hover {
            background: #2980b9;
        }
    </style>
</head>
<body>
    <div class="error-box">
        <h1>🔒 Wymagane tokeny</h1>
        <p>
            Aby korzystać z tego serwera MCP, musisz najpierw kupić tokeny.
        </p>
        <p>
            Twój email: <span class="email">${userEmail}</span>
        </p>
        <p>
            Po zakupie tokenów będziesz mógł korzystać z wszystkich narzędzi MCP.
        </p>
        <a href="https://panel.wtyczki.ai/" class="purchase-button">
            Kup tokeny
        </a>
    </div>
</body>
</html>`;
}

/**
 * Format error page HTML for users with deleted accounts
 *
 * Creates an HTML error page for users who authenticated via WorkOS
 * but have a deleted account (is_deleted = 1).
 *
 * @returns HTML error page
 */
export function formatAccountDeletedPage(): string {
    return `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Konto usunięte - MCP Server</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            text-align: center;
            background: #f5f5f5;
        }
        .error-box {
            background: white;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #e74c3c;
            margin-bottom: 20px;
        }
        p {
            color: #555;
            line-height: 1.6;
            margin-bottom: 30px;
        }
        .info {
            background: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 5px;
            padding: 15px;
            margin-bottom: 20px;
            color: #856404;
        }
        .home-button {
            display: inline-block;
            background: #3498db;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            transition: background 0.3s;
        }
        .home-button:hover {
            background: #2980b9;
        }
    </style>
</head>
<body>
    <div class="error-box">
        <h1>❌ Konto zostało usunięte</h1>
        <p>
            To konto zostało usunięte zgodnie z żądaniem użytkownika.
        </p>
        <div class="info">
            <strong>ℹ️ Informacja RODO:</strong><br>
            Twoje dane zostały anonimizowane zgodnie z art. 17 RODO (prawo do bycia zapomnianym).
            Jeśli chcesz ponownie korzystać z usługi, możesz utworzyć nowe konto.
        </div>
        <p>
            Jeśli usunąłeś konto przez pomyłkę, możesz zarejestrować się ponownie.
        </p>
        <a href="https://panel.wtyczki.ai/" class="home-button">
            Strona główna
        </a>
    </div>
</body>
</html>`;
}

/**
 * Format OAuth success page HTML for completed authorization
 *
 * Creates an HTML success page shown after OAuth completes successfully.
 * The page auto-redirects to the MCP client after a short delay.
 *
 * This provides clear user feedback that authorization was successful
 * before the browser redirects to the MCP client callback URL.
 *
 * @param userEmail - User's email address
 * @param redirectUrl - URL to redirect to (MCP client callback)
 * @param redirectDelay - Delay in milliseconds before redirect (default: 2000)
 * @returns HTML success page
 */
export function formatOAuthSuccessPage(
    userEmail: string,
    redirectUrl: string,
    redirectDelay: number = 2000
): string {
    // Escape HTML special characters
    const escapeHtml = (str: string): string =>
        str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

    // Escape JavaScript string
    const escapeJs = (str: string): string =>
        str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');

    return `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Autoryzacja zakończona - wtyczki.ai</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 500px;
            width: 100%;
            padding: 48px 40px;
            text-align: center;
        }
        .success-icon {
            font-size: 72px;
            margin-bottom: 24px;
            animation: scaleIn 0.5s ease-out;
        }
        @keyframes scaleIn {
            from { transform: scale(0); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }
        h1 {
            font-size: 28px;
            color: #1f2937;
            margin-bottom: 16px;
            font-weight: 700;
        }
        .message {
            font-size: 16px;
            color: #6b7280;
            line-height: 1.6;
            margin-bottom: 24px;
        }
        .email {
            font-weight: 600;
            color: #3b82f6;
        }
        .close-info {
            background: #f0fdf4;
            border: 1px solid #bbf7d0;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 24px;
        }
        .close-text {
            font-size: 14px;
            color: #166534;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid #bbf7d0;
            border-top-color: #22c55e;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .button {
            display: inline-block;
            padding: 14px 28px;
            font-size: 16px;
            font-weight: 600;
            text-decoration: none;
            border-radius: 8px;
            transition: all 0.2s ease;
            cursor: pointer;
            border: none;
            background: #3b82f6;
            color: white;
        }
        .button:hover {
            background: #2563eb;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
        }
        .footer {
            font-size: 14px;
            color: #9ca3af;
            margin-top: 32px;
        }
        @media (max-width: 640px) {
            .container { padding: 32px 24px; }
            h1 { font-size: 22px; }
            .success-icon { font-size: 56px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✅</div>
        <h1>Autoryzacja zakończona!</h1>
        <p class="message">
            Pomyślnie zalogowano jako<br>
            <span class="email">${escapeHtml(userEmail)}</span>
        </p>
        <div class="close-info">
            <div class="close-text">
                <div class="spinner"></div>
                <span>Przekierowanie do aplikacji...</span>
            </div>
        </div>
        <p class="message" style="margin-bottom: 16px; font-size: 14px;">
            Możesz zamknąć to okno po przekierowaniu.
        </p>
        <a href="${escapeHtml(redirectUrl)}" class="button">
            Kontynuuj
        </a>
        <div class="footer">
            © 2025 wtyczki.ai
        </div>
    </div>
    <script>
        (function() {
            var redirected = false;
            var btn = document.querySelector('.button');
            var closeText = document.querySelector('.close-text span');
            var spinner = document.querySelector('.spinner');

            // Auto-redirect after delay
            setTimeout(function() {
                redirected = true;
                // Update UI to show redirect happened
                if (btn) btn.style.display = 'none';
                if (closeText) closeText.textContent = 'Przekierowano! Możesz zamknąć to okno.';
                if (spinner) spinner.style.display = 'none';
                // Perform redirect
                window.location.href = '${escapeJs(redirectUrl)}';
            }, ${redirectDelay});

            // Prevent button click if already redirected (one-time use OAuth code)
            if (btn) {
                btn.addEventListener('click', function(e) {
                    if (redirected) {
                        e.preventDefault();
                        alert('Przekierowanie już nastąpiło. Możesz zamknąć to okno.');
                    }
                });
            }
        })();
    </script>
</body>
</html>`;
}
