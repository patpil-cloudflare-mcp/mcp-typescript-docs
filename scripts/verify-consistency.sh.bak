#!/bin/bash
# Verify MCP server consistency before deployment
# This script checks for common configuration issues that cause production failures

set -e  # Exit on first error

echo "🔍 MCP Server Consistency Check"
echo "================================"
echo ""

ERRORS=0
WARNINGS=0

# Check 1: USER_SESSIONS in wrangler.jsonc (MANDATORY for centralized login)
echo "📋 [1/12] Checking USER_SESSIONS KV namespace in wrangler.jsonc..."
if ! grep -q '"binding": "USER_SESSIONS"' wrangler.jsonc 2>/dev/null; then
  echo "❌ ERROR: USER_SESSIONS binding missing from wrangler.jsonc"
  echo "   This is MANDATORY for centralized authentication at panel.wtyczki.ai"
  echo "   Fix: Add USER_SESSIONS namespace with ID from CLOUDFLARE_CONFIG.md"
  ERRORS=$((ERRORS + 1))
elif grep -q '"binding": "USER_SESSIONS"' wrangler.jsonc && grep -A2 '"binding": "USER_SESSIONS"' wrangler.jsonc | grep -q "e5ad189139cd44f38ba0224c3d596c73"; then
  echo "✅ USER_SESSIONS configured correctly in wrangler.jsonc"
else
  echo "⚠️  WARNING: USER_SESSIONS has non-standard ID (should be e5ad189139cd44f38ba0224c3d596c73)"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# Check 2: USER_SESSIONS in types.ts (must be required, not optional)
echo "📋 [2/12] Checking USER_SESSIONS in types.ts..."
if [ ! -f "src/types.ts" ]; then
  echo "⚠️  WARNING: src/types.ts not found"
  WARNINGS=$((WARNINGS + 1))
elif grep -q "USER_SESSIONS?: KVNamespace" src/types.ts; then
  echo "❌ ERROR: USER_SESSIONS is optional in types.ts (should be required)"
  echo "   This causes silent fallback to WorkOS default UI"
  echo "   Fix: Change 'USER_SESSIONS?: KVNamespace' to 'USER_SESSIONS: KVNamespace'"
  ERRORS=$((ERRORS + 1))
elif grep -q "USER_SESSIONS: KVNamespace" src/types.ts; then
  echo "✅ USER_SESSIONS is required in types.ts"
else
  echo "❌ ERROR: USER_SESSIONS missing from Env interface in types.ts"
  echo "   Fix: Add 'USER_SESSIONS: KVNamespace' to Env interface"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Check 3: TOKEN_DB vs DB consistency in source files
echo "📋 [3/12] Checking database binding consistency in source files..."
if grep -r "\.env\.DB\b" src/ 2>/dev/null; then
  echo "❌ ERROR: Found .env.DB references (should be .env.TOKEN_DB)"
  echo "   Fix: Replace all .env.DB with .env.TOKEN_DB in source files"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ Source files use TOKEN_DB correctly"
fi
echo ""

# Check 4: wrangler.jsonc binding name
echo "📋 [4/12] Checking wrangler.jsonc database binding..."
if grep -q '"binding": "DB"' wrangler.jsonc 2>/dev/null; then
  echo "❌ ERROR: wrangler.jsonc uses 'DB' binding (should be 'TOKEN_DB')"
  echo "   Fix: Change all 'binding': 'DB' to 'binding': 'TOKEN_DB' in wrangler.jsonc"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ wrangler.jsonc uses TOKEN_DB binding"
fi
echo ""

# Check 5: types.ts interface
echo "📋 [5/12] Checking types.ts interface definition..."
if [ ! -f "src/types.ts" ]; then
  echo "⚠️  WARNING: src/types.ts not found"
  WARNINGS=$((WARNINGS + 1))
elif ! grep -q "TOKEN_DB: D1Database" src/types.ts; then
  echo "❌ ERROR: types.ts missing 'TOKEN_DB: D1Database' in Env interface"
  echo "   Fix: Add 'TOKEN_DB: D1Database' to Env interface in src/types.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ types.ts defines TOKEN_DB correctly"
fi
echo ""

# Check 6: Dual authentication tool count
echo "📋 [6/12] Checking dual authentication tool parity..."
if [ ! -f "src/server.ts" ]; then
  echo "⚠️  WARNING: src/server.ts not found (skipping tool count check)"
  WARNINGS=$((WARNINGS + 1))
elif [ ! -f "src/api-key-handler.ts" ]; then
  echo "⚠️  WARNING: src/api-key-handler.ts not found (skipping tool count check)"
  WARNINGS=$((WARNINGS + 1))
else
  OAUTH_COUNT=$(grep -c "this.server.tool(" src/server.ts 2>/dev/null || echo "0")
  API_KEY_COUNT=$(grep -c "server.tool(" src/api-key-handler.ts 2>/dev/null || echo "0")

  if [ "$OAUTH_COUNT" != "$API_KEY_COUNT" ]; then
    echo "❌ ERROR: Tool count mismatch"
    echo "   OAuth path (server.ts): $OAUTH_COUNT tools"
    echo "   API key path (api-key-handler.ts): $API_KEY_COUNT tools"
    echo "   Fix: Every tool must be implemented in BOTH files"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ Tool count matches: $OAUTH_COUNT tools in both auth paths"
  fi
fi
echo ""

# Check 7: Unused imports (ResponseFormat)
echo "📋 [7/12] Checking for unused imports..."
if grep -q "import.*ResponseFormat.*from.*types" src/api-key-handler.ts 2>/dev/null; then
  if ! grep -q "export.*ResponseFormat" src/types.ts 2>/dev/null; then
    echo "⚠️  WARNING: api-key-handler.ts imports non-existent ResponseFormat"
    echo "   Fix: Remove ResponseFormat from imports in api-key-handler.ts"
    WARNINGS=$((WARNINGS + 1))
  else
    echo "✅ ResponseFormat import is valid"
  fi
else
  echo "✅ No unused ResponseFormat imports"
fi
echo ""

# Check 8: KV namespace IDs (no placeholders in active configuration)
echo "📋 [8/12] Checking for placeholder values in active configuration..."

# Remove comments and check for placeholders
UNCOMMENTED=$(grep -v '^\s*//' wrangler.jsonc | grep -v '^\s*\*')

if echo "$UNCOMMENTED" | grep -E "YOUR_.*_ID|<YOUR_" 2>/dev/null; then
  echo "❌ ERROR: Found placeholder values in active wrangler.jsonc configuration"
  echo "   Fix: Replace ALL placeholders with actual IDs from CLOUDFLARE_CONFIG.md"
  echo ""
  echo "   Detected placeholders:"
  echo "$UNCOMMENTED" | grep -E "YOUR_.*_ID|<YOUR_" | sed 's/^/   /'
  ERRORS=$((ERRORS + 1))
else
  echo "✅ No placeholder values in active configuration"
fi
echo ""

# Check 9: Durable Objects configuration
echo "📋 [9/12] Checking Durable Objects configuration..."
if ! grep -q "durable_objects" wrangler.jsonc 2>/dev/null; then
  echo "❌ ERROR: wrangler.jsonc missing durable_objects configuration"
  echo "   Fix: Add durable_objects bindings (required for McpAgent)"
  ERRORS=$((ERRORS + 1))
elif ! grep -q "migrations" wrangler.jsonc 2>/dev/null; then
  echo "❌ ERROR: wrangler.jsonc missing migrations configuration"
  echo "   Fix: Add migrations with new_sqlite_classes"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ Durable Objects configured correctly"
fi
echo ""

# Check 10: Security package version (Phase 2)
echo "📋 [10/12] Checking security package version..."
if [ ! -f "package.json" ]; then
  echo "⚠️  WARNING: package.json not found"
  WARNINGS=$((WARNINGS + 1))
elif ! grep -q "@pilpat/mcp-security" package.json 2>/dev/null; then
  echo "❌ ERROR: @pilpat/mcp-security package not found in package.json"
  echo "   This is MANDATORY for Phase 2 security (PII redaction & output sanitization)"
  echo "   Fix: npm install @pilpat/mcp-security@^1.1.0"
  ERRORS=$((ERRORS + 1))
else
  # Extract version (handles both "^1.1.0" and "1.1.0")
  VERSION=$(grep "@pilpat/mcp-security" package.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  MAJOR=$(echo "$VERSION" | cut -d. -f1)
  MINOR=$(echo "$VERSION" | cut -d. -f2)

  if [ "$MAJOR" -lt 1 ] || { [ "$MAJOR" -eq 1 ] && [ "$MINOR" -lt 1 ]; }; then
    echo "❌ ERROR: @pilpat/mcp-security version $VERSION is too old (need v1.1.0+)"
    echo "   Fix: npm install @pilpat/mcp-security@^1.1.0"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ Security package v$VERSION installed (v1.1.0+ required for Polish PII)"
  fi
fi
echo ""

# Check 11: Security imports in server.ts (OAuth path)
echo "📋 [11/12] Checking security imports in server.ts..."
if [ ! -f "src/server.ts" ]; then
  echo "⚠️  WARNING: src/server.ts not found"
  WARNINGS=$((WARNINGS + 1))
elif ! grep -q "from '@pilpat/mcp-security'" src/server.ts 2>/dev/null; then
  echo "❌ ERROR: Missing security imports in src/server.ts"
  echo "   Add: import { sanitizeOutput, redactPII, validateOutput } from '@pilpat/mcp-security';"
  echo "   This is MANDATORY for Phase 2 security (Step 4.5)"
  ERRORS=$((ERRORS + 1))
elif ! grep -q "sanitizeOutput\|redactPII\|validateOutput" src/server.ts 2>/dev/null; then
  echo "⚠️  WARNING: Security imports exist but functions may not be used"
  echo "   Verify all tools implement Step 4.5 security processing"
  WARNINGS=$((WARNINGS + 1))
else
  echo "✅ Security imports present in server.ts"
fi
echo ""

# Check 12: Security imports in api-key-handler.ts (API key path)
echo "📋 [12/12] Checking security imports in api-key-handler.ts..."
if [ ! -f "src/api-key-handler.ts" ]; then
  echo "⚠️  WARNING: src/api-key-handler.ts not found"
  WARNINGS=$((WARNINGS + 1))
elif ! grep -q "from '@pilpat/mcp-security'" src/api-key-handler.ts 2>/dev/null; then
  echo "❌ ERROR: Missing security imports in api-key-handler.ts"
  echo "   Add: import { sanitizeOutput, redactPII, validateOutput } from '@pilpat/mcp-security';"
  echo "   API key path MUST have same security as OAuth path"
  ERRORS=$((ERRORS + 1))
elif ! grep -q "sanitizeOutput\|redactPII\|validateOutput" src/api-key-handler.ts 2>/dev/null; then
  echo "⚠️  WARNING: Security imports exist but functions may not be used"
  echo "   Verify all tools implement Step 4.5 security processing"
  WARNINGS=$((WARNINGS + 1))
else
  echo "✅ Security imports present in api-key-handler.ts"
fi
echo ""

# Final summary
echo "================================"
echo "📊 Consistency Check Complete"
echo "================================"
echo "Errors:   $ERRORS"
echo "Warnings: $WARNINGS"
echo ""

if [ $ERRORS -gt 0 ]; then
  echo "❌ FAILED: Fix $ERRORS error(s) before deploying"
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo "⚠️  PASSED with $WARNINGS warning(s)"
  echo "   Warnings are non-blocking but should be reviewed"
  exit 0
else
  echo "✅ ALL CHECKS PASSED"
  echo "   Server is ready for deployment"
  exit 0
fi
