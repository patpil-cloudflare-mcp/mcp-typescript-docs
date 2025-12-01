// src/apiKeys.ts - Permanent API Key Management
// Purpose: Generate, validate, and manage permanent API keys for non-OAuth MCP clients

// Minimal environment interface for API keys
export interface ApiKeyEnv {
  TOKEN_DB: D1Database;
}

/**
 * API Key interface matching database schema
 */
export interface ApiKey {
  api_key_id: string;
  user_id: string;
  api_key_hash: string;
  key_prefix: string;
  name: string;
  last_used_at?: number;
  created_at: number;
  expires_at?: number;
  is_active: number;
}

/**
 * Result from API key generation (includes plaintext key)
 */
export interface ApiKeyGenerationResult {
  apiKey: string;        // Plaintext key (shown ONCE)
  record: ApiKey;        // Database record
}

/**
 * Generate a new API key for a user
 *
 * @param env - Cloudflare Workers environment
 * @param userId - User ID to associate key with
 * @param name - User-provided name for the key (e.g., "AnythingLLM")
 * @param expiresInDays - Optional expiration in days (null = never expires)
 * @returns Plaintext API key and database record
 *
 * @example
 * const result = await generateApiKey(env, 'user_123', 'AnythingLLM');
 * console.log('Your API key (save this!):', result.apiKey);
 * // Displays: wtyk_a7f3k9m2p5q8r1s4t6v9w2x5y8z1b4c7
 */
export async function generateApiKey(
  env: ApiKeyEnv,
  userId: string,
  name: string,
  expiresInDays?: number
): Promise<ApiKeyGenerationResult> {
  // Generate random API key
  // Format: wtyk_<32_random_chars>
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const randomHex = Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const apiKey = `wtyk_${randomHex}`;

  // Extract prefix for display (first 16 chars)
  const keyPrefix = apiKey.substring(0, 16);

  // Hash the API key for storage (bcrypt simulation - using SHA-256 for Workers compatibility)
  const apiKeyHash = await hashApiKey(apiKey);

  // Generate unique ID
  const apiKeyId = crypto.randomUUID();

  // Calculate expiration if provided
  const expiresAt = expiresInDays ? Date.now() + (expiresInDays * 24 * 60 * 60 * 1000) : null;

  const record: ApiKey = {
    api_key_id: apiKeyId,
    user_id: userId,
    api_key_hash: apiKeyHash,
    key_prefix: keyPrefix,
    name: name,
    last_used_at: undefined,
    created_at: Date.now(),
    expires_at: expiresAt || undefined,
    is_active: 1,
  };

  // Insert into database
  await env.TOKEN_DB.prepare(`
    INSERT INTO api_keys (
      api_key_id,
      user_id,
      api_key_hash,
      key_prefix,
      name,
      last_used_at,
      created_at,
      expires_at,
      is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.api_key_id,
    record.user_id,
    record.api_key_hash,
    record.key_prefix,
    record.name,
    null, // last_used_at is null initially
    record.created_at,
    record.expires_at || null,
    record.is_active
  ).run();

  console.log(`✅ [API Keys] Generated key for user ${userId}: ${keyPrefix}...`);

  return {
    apiKey: apiKey, // Return plaintext ONCE
    record: record,
  };
}

/**
 * Validate an API key and return user_id if valid
 *
 * @param env - Cloudflare Workers environment
 * @param apiKey - Plaintext API key from Authorization header
 * @returns user_id if valid, null if invalid/expired/revoked
 *
 * @example
 * const userId = await validateApiKey(env, 'wtyk_...');
 * if (!userId) {
 *   return new Response('Invalid API key', { status: 401 });
 * }
 */
export async function validateApiKey(
  apiKey: string,
  env: ApiKeyEnv
): Promise<string | null> {
  // Validate format
  if (!apiKey.startsWith('wtyk_') || apiKey.length !== 69) {
    console.log('⚠️ [API Keys] Invalid format');
    return null;
  }

  // Hash the provided key
  const apiKeyHash = await hashApiKey(apiKey);

  // Look up key in database
  const keyRecord = await env.TOKEN_DB.prepare(`
    SELECT
      api_key_id,
      user_id,
      api_key_hash,
      expires_at,
      is_active
    FROM api_keys
    WHERE api_key_hash = ?
  `).bind(apiKeyHash).first<ApiKey>();

  if (!keyRecord) {
    console.log('⚠️ [API Keys] Key not found');
    return null;
  }

  // Check if key is active
  if (keyRecord.is_active !== 1) {
    console.log('⚠️ [API Keys] Key is revoked:', keyRecord.api_key_id);
    return null;
  }

  // Check expiration
  if (keyRecord.expires_at && keyRecord.expires_at < Date.now()) {
    console.log('⚠️ [API Keys] Key expired:', keyRecord.api_key_id);
    return null;
  }

  // Verify user still exists and is not deleted
  const user = await env.TOKEN_DB.prepare(`
    SELECT is_deleted FROM users WHERE user_id = ?
  `).bind(keyRecord.user_id).first<{ is_deleted: number }>();

  if (!user || user.is_deleted === 1) {
    console.log('⚠️ [API Keys] User not found or deleted:', keyRecord.user_id);
    return null;
  }

  // Update last_used_at timestamp (blocking to ensure audit trail accuracy)
  try {
    const updateResult = await env.TOKEN_DB.prepare(`
      UPDATE api_keys
      SET last_used_at = ?
      WHERE api_key_id = ?
    `).bind(Date.now(), keyRecord.api_key_id).run();

    if (updateResult.meta.changes === 0) {
      console.warn('⚠️ [API Keys] Failed to update last_used_at - key may have been revoked');
      // Still allow the request to proceed since key was valid at time of lookup
    }
  } catch (err) {
    console.error('❌ [API Keys] Error updating last_used_at:', err);
    // Continue anyway - authentication was successful, timestamp update is non-critical
    // This prevents temporary DB issues from blocking valid API requests
  }

  console.log(`✅ [API Keys] Valid key for user ${keyRecord.user_id}`);
  return keyRecord.user_id;
}

/**
 * List all API keys for a user
 *
 * @param env - Cloudflare Workers environment
 * @param userId - User ID to list keys for
 * @returns Array of API keys (without hashes)
 */
export async function listUserApiKeys(
  env: ApiKeyEnv,
  userId: string
): Promise<ApiKey[]> {
  const results = await env.TOKEN_DB.prepare(`
    SELECT
      api_key_id,
      user_id,
      key_prefix,
      name,
      last_used_at,
      created_at,
      expires_at,
      is_active
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(userId).all<Omit<ApiKey, 'api_key_hash'>>();

  return results.results as ApiKey[];
}

/**
 * Revoke an API key (soft delete)
 *
 * @param env - Cloudflare Workers environment
 * @param apiKeyId - API key ID to revoke
 * @param userId - User ID (for security check)
 * @returns Success boolean
 */
export async function revokeApiKey(
  env: ApiKeyEnv,
  apiKeyId: string,
  userId: string
): Promise<boolean> {
  const result = await env.TOKEN_DB.prepare(`
    UPDATE api_keys
    SET is_active = 0
    WHERE api_key_id = ? AND user_id = ?
  `).bind(apiKeyId, userId).run();

  if (result.meta.changes === 0) {
    console.log('⚠️ [API Keys] Key not found or not owned by user:', apiKeyId);
    return false;
  }

  console.log(`✅ [API Keys] Revoked key ${apiKeyId} for user ${userId}`);
  return true;
}

/**
 * Delete all API keys for a user (called during account deletion)
 *
 * @param env - Cloudflare Workers environment
 * @param userId - User ID to delete keys for
 * @returns Number of keys deleted
 */
export async function deleteAllUserApiKeys(
  env: ApiKeyEnv,
  userId: string
): Promise<number> {
  const result = await env.TOKEN_DB.prepare(`
    DELETE FROM api_keys WHERE user_id = ?
  `).bind(userId).run();

  console.log(`✅ [API Keys] Deleted ${result.meta.changes} keys for user ${userId}`);
  return result.meta.changes || 0;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Hash API key using SHA-256 (Cloudflare Workers compatible)
 * Note: In production with bcrypt support, use bcrypt instead
 */
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
  return hashHex;
}
