# Semantic Memory MCP - Testing Guide

**Version**: 2.0.0 (2025-11-03)
**Purpose**: Comprehensive testing checklist and migration procedures

---

## Pre-Deployment Checklist

### 1. Syntax Validation

**Verify code has no syntax errors**:
```bash
cd ~/semantic-memory-mcp
node --check src/index.js
```

**Expected output**: No errors (silent success)

**If errors**: Fix syntax before proceeding

---

### 2. Dependency Check

**Verify all dependencies installed**:
```bash
npm install
```

**Check critical packages**:
```bash
npm list redis openai @modelcontextprotocol/sdk
```

**Expected output**:
```
├── @modelcontextprotocol/sdk@X.X.X
├── openai@X.X.X
└── redis@X.X.X
```

---

### 3. Environment Configuration

**Check .env file exists**:
```bash
ls -la .env
```

**Verify required variables**:
```bash
grep -E "(REDIS_URL|OPENAI_API_KEY)" .env
```

**Expected**:
```
REDIS_URL=redis://localhost:6379/0
OPENAI_API_KEY=sk-...
```

---

## Redis Index Migration

### Strategy: Drop and Recreate (RECOMMENDED)

**WARNING**: This will rebuild the index but NOT delete patterns

**Steps**:

1. **Backup current patterns** (optional, for safety):
```bash
redis-cli --scan --pattern "pattern:*" > pattern_backup.txt
redis-cli BGSAVE  # Create RDB snapshot
```

2. **Drop old index**:
```bash
redis-cli FT.DROPINDEX pattern_index
```

3. **Restart MCP server** (auto-creates new index with memory_type field):
```bash
# MCP server will auto-create index on startup
# Check logs for "Creating pattern_index..." or "pattern_index created successfully"
```

4. **Verify new index schema**:
```bash
redis-cli FT.INFO pattern_index
```

**Expected output** (should include `memory_type TAG`):
```
...
attributes:
  - category (TAG)
  - memory_type (TAG)  # <-- NEW FIELD
  - content (TEXT)
  - metadata (TEXT)
  - embedding (VECTOR)
...
```

### Alternative: Keep Old Index (Not Recommended)

**Consequences**:
- Old patterns won't have `memory_type` field
- Memory type filtering won't work on old patterns
- Search still works, but less efficient

**If you choose this**:
- New patterns will use new schema
- Old patterns remain searchable (generic queries)
- Consider backfill script (see Migration section)

---

## Post-Deployment Testing

### Test Suite Overview

| Test Category | Tools Used | Success Criteria |
|---------------|------------|------------------|
| Health Check | `health_check` | All checks pass |
| Store Patterns | `store_pattern` | Returns pattern_id + TTL |
| Search Patterns | `search_patterns` | Returns results with confidence_current |
| Memory Types | `store_pattern`, `search_patterns` | Filters work correctly |
| TTL Verification | Redis CLI | Episodic has TTL, semantic doesn't |
| Confidence Decay | `search_patterns` | Shows decayed confidence |
| Consolidation | `consolidate_memories` | Identifies candidates correctly |

---

### Test 1: Health Check

**Command**:
```javascript
await mcp__memory__health_check();
```

**Expected Result**:
```json
{
  "status": "healthy",
  "checks": {
    "redis": "connected",
    "openai": "connected",
    "vector_index": "exists"
  }
}
```

**If Failed**:
- `redis: "disconnected"` → Start Redis: `redis-server`
- `openai: "error: ..."` → Check `OPENAI_API_KEY` in .env
- `vector_index: "missing"` → Restart MCP server (auto-creates)

---

### Test 2: Store Semantic Pattern

**Command**:
```javascript
await mcp__memory__store_pattern({
  category: "solution",
  memory_type: "semantic",
  content: "Test semantic memory: Redis performs better than alternatives for <100M vectors",
  metadata: {
    confidence: 0.9,
    evidence_count: 1,
    tags: ["test", "redis", "performance"],
    source: "testing-session",
    validation_contexts: ["test-env"]
  }
});
```

**Expected Result**:
```json
{
  "pattern_id": "pattern:semantic:solution:12345678",
  "memory_type": "semantic",
  "ttl_seconds": null,
  "status": "stored"
}
```

**Verification**:
```bash
# Check pattern exists
redis-cli EXISTS pattern:semantic:solution:12345678

# Check no TTL (should return -1)
redis-cli TTL pattern:semantic:solution:12345678
```

**Expected**: `EXISTS` returns `1`, `TTL` returns `-1` (no expiration)

---

### Test 3: Store Episodic Pattern

**Command**:
```javascript
await mcp__memory__store_pattern({
  category: "preference",
  memory_type: "episodic",
  content: "Test episodic memory: User prefers concise output in terminal",
  metadata: {
    confidence: 0.7,
    evidence_count: 1,
    tags: ["test", "user-preference"],
    source: "testing-session"
  }
});
```

**Expected Result**:
```json
{
  "pattern_id": "pattern:episodic:preference:87654321",
  "memory_type": "episodic",
  "ttl_seconds": 7776000,
  "status": "stored"
}
```

**Verification**:
```bash
# Check TTL is set (should return ~7776000)
redis-cli TTL pattern:episodic:preference:87654321
```

**Expected**: TTL returns a number close to 7,776,000 (90 days in seconds)

---

### Test 4: Search with Memory Type Filter

**Command**:
```javascript
await mcp__memory__search_patterns({
  query: "test memory redis",
  k: 10,
  memory_type: "semantic"
});
```

**Expected Result**:
```json
{
  "results": [
    {
      "pattern_id": "pattern:semantic:solution:...",
      "category": "solution",
      "memory_type": "semantic",
      "content": "Test semantic memory: ...",
      "metadata": {
        "confidence_original": 0.9,
        "confidence_current": 0.9,  // No decay yet (just created)
        "evidence_count": 1,
        "created_at": "2025-11-03T...",
        "last_validated": "2025-11-03T...",
        ...
      }
    }
  ],
  "filters": {
    "category": null,
    "memory_type": "semantic"
  },
  "count": 1
}
```

**Verification**:
- Only semantic patterns returned (no episodic)
- `memory_type` field present in results
- `confidence_current` shown alongside `confidence_original`

---

### Test 5: Confidence Decay (Simulated)

**Setup**: Store pattern with old `last_validated` timestamp

**Command** (manual Redis update for testing):
```bash
# Store a pattern first via store_pattern tool
# Then manually update last_validated to 6 months ago
redis-cli HGET pattern:semantic:solution:12345678 metadata
# Copy JSON, modify last_validated to 6 months ago, then:
redis-cli HSET pattern:semantic:solution:12345678 metadata '{"confidence":0.9,"last_validated":"2025-05-03T...","..."}'
```

**Search**:
```javascript
await mcp__memory__search_patterns({
  query: "test redis",
  k: 10
});
```

**Expected**:
```json
{
  "results": [{
    "metadata": {
      "confidence_original": 0.9,
      "confidence_current": 0.66,  // 0.9 * (0.95^6) ≈ 0.66
      ...
    }
  }]
}
```

**Verification**: `confidence_current` is lower than `confidence_original` (decay applied)

---

### Test 6: Consolidation Tool (Dry Run)

**Setup**: Ensure you have episodic patterns with evidence_count >= 5

**Command**:
```javascript
await mcp__memory__consolidate_memories({
  dry_run: true,
  promotion_type: "episodic_to_semantic",
  min_evidence: 5
});
```

**Expected Result**:
```json
{
  "dry_run": true,
  "promotion_type": "episodic_to_semantic",
  "episodic_to_semantic": {
    "candidates": [
      {
        "pattern_id": "pattern:episodic:solution:...",
        "category": "solution",
        "content": "...",
        "evidence_count": 7,
        "confidence": 0.85
      }
    ],
    "promoted": 0
  },
  "summary": {
    "episodic_candidates": 1,
    "episodic_promoted": 0,
    ...
  }
}
```

**Verification**:
- Candidates listed (if any exist)
- `promoted: 0` (dry run doesn't actually promote)

---

### Test 7: Consolidation Tool (Actual Promotion)

**Command**:
```javascript
await mcp__memory__consolidate_memories({
  dry_run: false,
  promotion_type: "episodic_to_semantic",
  min_evidence: 5
});
```

**Expected Result**:
```json
{
  "dry_run": false,
  "episodic_to_semantic": {
    "candidates": [...],
    "promoted": 1  // Actually promoted
  },
  "summary": {
    "episodic_promoted": 1
  }
}
```

**Verification**:
```bash
# Check new semantic pattern created
redis-cli --scan --pattern "pattern:semantic:*" | tail -1

# Check original episodic pattern still exists
redis-cli EXISTS pattern:episodic:solution:...
```

**Expected**: New semantic pattern exists, old episodic still present (will expire naturally)

---

## Migration for Existing Patterns

### Scenario: Upgrading from v1.x with existing patterns

**Goal**: Add `memory_type` field to existing patterns

### Option 1: Do Nothing (Backward Compatible)

**Consequence**:
- Old patterns work fine (default to semantic)
- Memory type filtering only works on new patterns
- No data loss

**Recommended if**: You have < 100 patterns or don't need memory type filtering on old data

### Option 2: Backfill Script

**Create backfill script** (`scripts/backfill-memory-type.js`):

```javascript
import { createClient } from 'redis';

async function backfillMemoryType() {
  const redis = createClient({ url: 'redis://localhost:6379/0' });
  await redis.connect();

  // Get all pattern keys
  const keys = [];
  for await (const key of redis.scanIterator({ MATCH: 'pattern:*' })) {
    // Skip new-format patterns (already have memory type in key)
    if (!key.match(/^pattern:(semantic|episodic|procedural):/)) {
      keys.push(key);
    }
  }

  console.log(`Found ${keys.length} patterns to backfill`);

  // Add memory_type field (default to semantic)
  for (const key of keys) {
    await redis.hSet(key, 'memory_type', 'semantic');
    console.log(`Backfilled: ${key}`);
  }

  await redis.quit();
  console.log('Backfill complete');
}

backfillMemoryType().catch(console.error);
```

**Run**:
```bash
node scripts/backfill-memory-type.js
```

**Verification**:
```bash
# Check old pattern now has memory_type
redis-cli HGET pattern:solution:12345678 memory_type
```

**Expected**: Returns `semantic`

---

## Troubleshooting

### Issue: "Unknown tool: consolidate_memories"

**Cause**: MCP server not restarted with new code

**Solution**:
1. Stop MCP server (if running standalone)
2. Restart Claude Code (if using via .mcp.json)
3. Run `mcp__memory__health_check()` to verify connection

---

### Issue: Search returns no results

**Possible Causes**:
1. **Index missing**: Run `redis-cli FT.INFO pattern_index`
   - If error → Restart MCP server (auto-creates)
2. **No patterns stored**: Store a test pattern first
3. **Wrong filter**: Check `memory_type` and `category` filters

**Debug**:
```bash
# Check pattern count
redis-cli --scan --pattern "pattern:*" | wc -l

# Check index exists
redis-cli FT.INFO pattern_index

# Test raw search
redis-cli FT.SEARCH pattern_index "*" LIMIT 0 10
```

---

### Issue: TTL not set on episodic patterns

**Symptoms**: `redis-cli TTL pattern:episodic:...` returns `-1`

**Possible Causes**:
1. Code not setting TTL (check implementation)
2. Pattern created before TTL code added

**Verification**:
```bash
# Create new episodic pattern via tool
# Then check TTL immediately
redis-cli TTL pattern:episodic:preference:...
```

**Expected**: Returns ~7776000

**If still -1**: Code bug, check `storePattern` function has:
```javascript
if (ttl) {
  await binaryRedis.expire(patternId, ttl);
}
```

---

### Issue: Confidence decay not working

**Symptoms**: `confidence_current` always equals `confidence_original`

**Possible Causes**:
1. Pattern just created (no time passed)
2. `last_validated` field missing

**Debug**:
```bash
# Check metadata has last_validated
redis-cli HGET pattern:semantic:solution:... metadata | jq .last_validated
```

**If missing**: Pattern created before metadata enhancement. Consider backfill or wait for natural validation updates.

---

## Performance Baseline

### Expected Metrics (Local Development)

| Operation | Expected Latency | Notes |
|-----------|------------------|-------|
| `store_pattern` | 100-300ms | Includes OpenAI embedding call (~50ms) + Redis write |
| `search_patterns` (k=10) | 50-150ms | Includes embedding + vector search |
| `consolidate_memories` | 1-5s | Depends on pattern count (1000 patterns ≈ 2s) |
| `health_check` | 50-100ms | Redis ping + OpenAI test embed |

### Redis Memory Usage

**Formula**: `~6KB per pattern` (1536-dim vector + metadata)

| Pattern Count | Estimated Memory |
|---------------|------------------|
| 1,000         | ~6 MB            |
| 10,000        | ~60 MB           |
| 100,000       | ~600 MB          |
| 1,000,000     | ~6 GB            |

**Monitoring**:
```bash
redis-cli INFO memory | grep used_memory_human
```

---

## Continuous Integration

### Automated Test Script

**Create** `scripts/test-memory-system.js`:

```javascript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runTests() {
  console.log('=== Memory System Test Suite ===\n');

  // Test 1: Syntax check
  console.log('[1/7] Syntax validation...');
  await execAsync('node --check src/index.js');
  console.log('✓ No syntax errors\n');

  // Test 2: Redis connection
  console.log('[2/7] Redis connection...');
  const { stdout } = await execAsync('redis-cli PING');
  if (stdout.trim() !== 'PONG') throw new Error('Redis not responding');
  console.log('✓ Redis connected\n');

  // Test 3: Index exists
  console.log('[3/7] Vector index...');
  try {
    await execAsync('redis-cli FT.INFO pattern_index');
    console.log('✓ Vector index exists\n');
  } catch (error) {
    console.log('⚠ Index missing (will be auto-created)\n');
  }

  // Add more tests as needed...

  console.log('=== All Tests Passed ===');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
```

**Run**:
```bash
node scripts/test-memory-system.js
```

---

## Rollback Procedure

### If Issues Arise After Deployment

**Step 1: Identify Issue**
- Check MCP server logs
- Run `health_check()` tool
- Verify Redis connection

**Step 2: Rollback Code**
```bash
cd ~/semantic-memory-mcp
git log --oneline -5
git checkout <previous-commit-hash>
npm install
```

**Step 3: Restart MCP Server**
- Old code loaded
- Existing patterns still accessible
- New features disabled

**Step 4: Investigate**
- Review error logs
- Test in isolation
- Fix issues

**Step 5: Re-deploy**
- After fixes verified
- Run test suite
- Monitor for issues

---

## Test Completion Checklist

Before marking deployment as successful:

- [ ] Syntax validation passed
- [ ] Dependencies installed
- [ ] Environment configured (.env valid)
- [ ] Redis index created/updated
- [ ] Health check returns "healthy"
- [ ] Semantic pattern stored successfully
- [ ] Episodic pattern has TTL set
- [ ] Memory type filtering works
- [ ] Confidence decay calculates correctly
- [ ] Consolidation tool dry-run works
- [ ] Consolidation tool promotion works
- [ ] Existing patterns still accessible
- [ ] Performance within baseline
- [ ] No errors in MCP server logs

---

**Last Updated**: 2025-11-03
**Version**: 2.0.0
