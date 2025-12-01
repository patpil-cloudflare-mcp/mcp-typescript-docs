// tokenConsumption.ts - Token Balance Checking and Consumption Logic
//
// This module provides centralized functions for:
// 1. Checking if a user has sufficient token balance
// 2. Consuming tokens atomically with action execution
// 3. Logging all MCP actions to the database
// 4. Idempotency protection against duplicate charges
// 5. Automatic retry with failed deduction logging
//
// CRITICAL PRINCIPLE: Always query database for current balance. Never cache.

import type { D1Database } from '@cloudflare/workers-types';

/**
 * Result of checking user's token balance
 */
export interface BalanceCheckResult {
  sufficient: boolean;
  currentBalance: number;
  required: number;
  userDeleted?: boolean; // True if user account is deleted
}

/**
 * Result of consuming tokens
 */
export interface TokenConsumptionResult {
  success: boolean;
  newBalance: number;
  transactionId: string;
  actionId: string;
  error?: string;
  alreadyProcessed?: boolean; // NEW: Flag for idempotent retry detection
}

/**
 * Check if user has sufficient token balance for an action
 *
 * This is a READ-ONLY check. It does NOT deduct tokens.
 * Always query the database for current balance - never use cached values.
 *
 * @param db - D1 Database instance
 * @param userId - User's UUID
 * @param requiredTokens - Number of tokens required for the action
 * @returns Balance check result with sufficient flag and current balance
 */
export async function checkBalance(
  db: D1Database,
  userId: string,
  requiredTokens: number
): Promise<BalanceCheckResult> {
  try {
    // Query database for current balance
    // CRITICAL: Never cache this value - always fresh query
    // SECURITY: Also check is_deleted to prevent deleted users from using tools
    const result = await db
      .prepare('SELECT current_token_balance, is_deleted FROM users WHERE user_id = ?')
      .bind(userId)
      .first<{ current_token_balance: number; is_deleted: number }>();

    if (!result) {
      console.error(`[Token Consumption] User not found: ${userId}`);
      return {
        sufficient: false,
        currentBalance: 0,
        required: requiredTokens,
      };
    }

    // Check if user account is deleted
    if (result.is_deleted === 1) {
      console.error(`[Token Consumption] User account is deleted: ${userId}`);
      return {
        sufficient: false,
        currentBalance: result.current_token_balance,
        required: requiredTokens,
        userDeleted: true,
      };
    }

    const currentBalance = result.current_token_balance;
    const sufficient = currentBalance >= requiredTokens;

    console.log(
      `[Token Consumption] Balance check for user ${userId}: ${currentBalance} tokens, needs ${requiredTokens}, sufficient: ${sufficient}`
    );

    return {
      sufficient,
      currentBalance,
      required: requiredTokens,
      userDeleted: false,
    };
  } catch (error) {
    console.error('[Token Consumption] Error checking balance:', error);
    throw new Error('Failed to check token balance');
  }
}

/**
 * Consume tokens atomically with idempotency protection
 *
 * This function performs an atomic transaction that:
 * 1. Checks if action_id already exists (idempotency)
 * 2. Deducts tokens from user's balance
 * 3. Creates a transaction record
 * 4. Logs the MCP action with details
 *
 * All operations succeed together or fail together (atomic).
 *
 * @param db - D1 Database instance
 * @param userId - User's UUID
 * @param tokenAmount - Number of tokens to consume (positive number)
 * @param mcpServerName - Name of the MCP server (e.g., 'nbp-exchange-mcp')
 * @param toolName - Name of the tool executed (e.g., 'getCurrencyRate')
 * @param actionParams - Parameters passed to the tool (will be JSON-ified)
 * @param actionResult - Result returned by the tool (will be JSON-ified)
 * @param success - Whether the action succeeded
 * @param actionId - Pre-generated action ID for idempotency (optional)
 * @returns Token consumption result with new balance and IDs
 */
export async function consumeTokens(
  db: D1Database,
  userId: string,
  tokenAmount: number,
  mcpServerName: string,
  toolName: string,
  actionParams: Record<string, any>,
  actionResult: any,
  success: boolean,
  actionId?: string
): Promise<TokenConsumptionResult> {
  try {
    // Use provided actionId or generate new one
    const finalActionId = actionId ?? crypto.randomUUID();

    // ============================================================
    // IDEMPOTENCY CHECK: Has this action already been processed?
    // ============================================================
    const existingAction = await db
      .prepare('SELECT action_id, tokens_consumed, created_at FROM mcp_actions WHERE action_id = ?')
      .bind(finalActionId)
      .first();

    if (existingAction) {
      console.log(`✋ [Token Consumption] Action already processed: ${finalActionId}`);
      console.log(`   Original execution: ${existingAction.created_at}`);

      // Get current balance
      const balanceResult = await db
        .prepare('SELECT current_token_balance FROM users WHERE user_id = ?')
        .bind(userId)
        .first<{ current_token_balance: number }>();

      return {
        success: true,
        newBalance: balanceResult?.current_token_balance ?? 0,
        transactionId: 'existing', // Placeholder since we don't store transaction_id in mcp_actions
        actionId: finalActionId,
        alreadyProcessed: true
      };
    }

    // Generate unique IDs for transaction and action records
    const transactionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Validate inputs
    if (tokenAmount <= 0) {
      throw new Error('Token amount must be positive');
    }

    if (!userId || !mcpServerName || !toolName) {
      throw new Error('Missing required parameters');
    }

    // Combine params and result into single JSON object for database storage
    const parametersJson = JSON.stringify({
      params: actionParams,
      result: actionResult,
    });

    console.log(
      `[Token Consumption] Consuming ${tokenAmount} tokens for user ${userId}, server: ${mcpServerName}, tool: ${toolName}`
    );

    // ============================================================
    // ATOMIC TRANSACTION: All three operations must succeed together
    // ============================================================
    const batchResult = await db.batch([
      // 1. Update user balance and total tokens used
      db.prepare(`
        UPDATE users
        SET
          current_token_balance = current_token_balance - ?,
          total_tokens_used = total_tokens_used + ?
        WHERE user_id = ?
      `).bind(tokenAmount, tokenAmount, userId),

      // 2. Create transaction record (negative amount for usage)
      db.prepare(`
        INSERT INTO transactions (
          transaction_id,
          user_id,
          type,
          token_amount,
          balance_after,
          description,
          created_at
        )
        VALUES (?, ?, 'usage', ?,
          (SELECT current_token_balance FROM users WHERE user_id = ?),
          ?, ?)
      `).bind(
        transactionId,
        userId,
        -tokenAmount, // Negative for usage
        userId,
        `${mcpServerName}: ${toolName}`,
        timestamp
      ),

      // 3. Log MCP action with full details (UNIQUE constraint on action_id prevents duplicates)
      db.prepare(`
        INSERT INTO mcp_actions (
          action_id,
          user_id,
          mcp_server_name,
          tool_name,
          parameters,
          tokens_consumed,
          success,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        finalActionId,
        userId,
        mcpServerName,
        toolName,
        parametersJson,
        tokenAmount,
        success ? 1 : 0,
        timestamp
      ),
    ]);

    // Check if all operations succeeded
    if (!batchResult || batchResult.length !== 3) {
      throw new Error('Batch transaction failed');
    }

    // Check if any operation affected 0 rows (user not found, etc.)
    if (batchResult[0].meta.changes === 0) {
      throw new Error('User not found or balance update failed');
    }

    // Query updated balance
    const balanceResult = await db
      .prepare('SELECT current_token_balance FROM users WHERE user_id = ?')
      .bind(userId)
      .first<{ current_token_balance: number }>();

    if (!balanceResult) {
      throw new Error('Failed to retrieve updated balance');
    }

    const newBalance = balanceResult.current_token_balance;

    console.log(
      `[Token Consumption] ✅ Success! User ${userId}: ${newBalance + tokenAmount} → ${newBalance} tokens`
    );

    return {
      success: true,
      newBalance,
      transactionId,
      actionId: finalActionId,
      alreadyProcessed: false
    };
  } catch (error) {
    // ============================================================
    // HANDLE UNIQUE CONSTRAINT VIOLATION (Race Condition Detected)
    // ============================================================
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      console.log(`⚠️ [Token Consumption] Race detected - action already processed in parallel request`);

      // Recursive call to fetch existing action details
      // This ensures idempotent response even in race conditions
      return await consumeTokens(
        db, userId, tokenAmount, mcpServerName, toolName,
        actionParams, actionResult, success, actionId
      );
    }

    // Other errors - log and re-throw for retry wrapper
    console.error('[Token Consumption] ❌ Error consuming tokens:', error);
    console.error({
      userId,
      tokenAmount,
      mcpServerName,
      toolName,
      actionParams,
      error: error instanceof Error ? error.message : String(error),
    });

    throw new Error('Failed to consume tokens: ' + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Consume tokens with automatic retry and failed deduction logging
 *
 * Wrapper function that:
 * 1. Retries consumeTokens() on transient failures
 * 2. Uses exponential backoff between retries
 * 3. Logs persistent failures to failed_deductions table
 * 4. Maintains idempotency across all retries
 *
 * @param db - D1 Database instance
 * @param userId - User's UUID
 * @param tokenAmount - Number of tokens to consume
 * @param mcpServerName - Name of the MCP server
 * @param toolName - Name of the tool executed
 * @param actionParams - Parameters passed to the tool
 * @param actionResult - Result returned by the tool
 * @param success - Whether the action succeeded
 * @param actionId - Pre-generated action ID for idempotency
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @returns Token consumption result
 */
export async function consumeTokensWithRetry(
  db: D1Database,
  userId: string,
  tokenAmount: number,
  mcpServerName: string,
  toolName: string,
  actionParams: Record<string, any>,
  actionResult: any,
  success: boolean,
  actionId: string,
  maxRetries: number = 3
): Promise<TokenConsumptionResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await consumeTokens(
        db, userId, tokenAmount, mcpServerName, toolName,
        actionParams, actionResult, success, actionId
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Token Consumption] Attempt ${attempt}/${maxRetries} failed:`, lastError);

      if (attempt < maxRetries) {
        // Exponential backoff: 100ms, 200ms, 400ms...
        const delay = 100 * Math.pow(2, attempt - 1);
        console.log(`[Token Consumption] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // ============================================================
        // ALL RETRIES EXHAUSTED - Log to failed_deductions table
        // ============================================================
        console.error(`[Token Consumption] CRITICAL: All ${maxRetries} attempts failed for action ${actionId}`);

        try {
          await db.prepare(`
            INSERT INTO failed_deductions (
              action_id, user_id, mcp_server_name, tool_name, token_amount,
              parameters, error_message, created_at, retry_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            actionId,
            userId,
            mcpServerName,
            toolName,
            tokenAmount,
            JSON.stringify({ params: actionParams, result: actionResult }),
            lastError.message,
            new Date().toISOString(),
            maxRetries
          ).run();

          console.log(`📝 [Token Consumption] Logged to failed_deductions for reconciliation`);
        } catch (logError) {
          console.error('[Token Consumption] Failed to log failed deduction:', logError);
        }

        throw lastError;
      }
    }
  }

  throw lastError!;
}

/**
 * Get formatted error message for insufficient balance
 *
 * Returns a user-friendly error message with:
 * - Current balance
 * - Required tokens
 * - Link to purchase more tokens
 *
 * @param currentBalance - User's current token balance
 * @param requiredTokens - Number of tokens required
 * @param dashboardUrl - URL to the token purchase dashboard
 * @returns Formatted error message
 */
export function getInsufficientBalanceMessage(
  currentBalance: number,
  requiredTokens: number,
  dashboardUrl: string
): string {
  return `Insufficient tokens. You have ${currentBalance} token${currentBalance === 1 ? '' : 's'} but need ${requiredTokens} token${requiredTokens === 1 ? '' : 's'} for this action.\n\nPurchase more tokens at: ${dashboardUrl}`;
}

/**
 * Get user statistics from database
 *
 * Returns aggregated statistics for a user:
 * - Total tokens purchased
 * - Total tokens used
 * - Current balance
 * - Number of actions performed
 *
 * @param db - D1 Database instance
 * @param userId - User's UUID
 * @returns User statistics object
 */
export async function getUserStats(
  db: D1Database,
  userId: string
): Promise<{
  totalPurchased: number;
  totalUsed: number;
  currentBalance: number;
  actionsPerformed: number;
} | null> {
  try {
    const userResult = await db
      .prepare(`
        SELECT
          current_token_balance,
          total_tokens_purchased,
          total_tokens_used
        FROM users
        WHERE user_id = ?
      `)
      .bind(userId)
      .first<{
        current_token_balance: number;
        total_tokens_purchased: number;
        total_tokens_used: number;
      }>();

    if (!userResult) {
      return null;
    }

    const actionsResult = await db
      .prepare('SELECT COUNT(*) as count FROM mcp_actions WHERE user_id = ?')
      .bind(userId)
      .first<{ count: number }>();

    return {
      totalPurchased: userResult.total_tokens_purchased,
      totalUsed: userResult.total_tokens_used,
      currentBalance: userResult.current_token_balance,
      actionsPerformed: actionsResult?.count || 0,
    };
  } catch (error) {
    console.error('[Token Consumption] Error getting user stats:', error);
    return null;
  }
}
