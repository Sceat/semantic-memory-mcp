# Semantic Memory MCP

Semantic memory with Redis + OpenAI embeddings. Pattern storage, confidence decay, memory consolidation for AI agents.

**Abstracts**: Redis + OpenAI embeddings + vector search
**Provides**: Hierarchical semantic memory with automatic lifecycle management

**Latest Update (2025-11-03)**: Memory type separation, enhanced metadata, confidence decay, consolidation tool

## Why This Exists

**Before**: Two MCPs, 11 low-level tools
- `mcp__redis__hset("reminder:git-review", ...)` - manual key naming
- `mcp__embeddings__store_pattern(...)` - separate from Redis ops
- Agents need to understand Redis internals

**After**: One MCP, 5 semantic tools
- `store_pattern(category, content, metadata)` - learning discipline
- `search_patterns(query, k)` - semantic recall
- `set_reminder(task_type, reminder)` - contextual reminders
- Agents just think about memory, not Redis

## Memory Types (NEW)

The system implements three memory types with different lifecycles:

### SEMANTIC
**Facts & Knowledge** - Persist indefinitely
- Use for: Validated solutions, canonical patterns, established practices
- TTL: None (permanent storage)
- Example: "Redis performs 3-9x faster than Qdrant for sub-millisecond queries"

### EPISODIC
**Interaction Histories** - 90-day TTL, auto-expire
- Use for: Session learnings, user preferences, temporary patterns
- TTL: 90 days (automatic cleanup via Redis EXPIRE)
- Example: "User prefers concise terminal output during evening work"
- **Auto-consolidation**: High-evidence patterns can be promoted to semantic

### PROCEDURAL
**Behavioral Rules** - Persist indefinitely
- Use for: Workflows, process patterns, successful strategies
- TTL: None (permanent storage)
- Example: "When deploying K8s, check resource limits before applying manifests"

---

## Tools (6 total)

### Learning Discipline (20-60-20 pattern)

**`store_pattern`**
Store what you learned after completing a task (20% of time).

```javascript
store_pattern(
  category: "solution" | "failure" | "preference" | "reminder" | "pattern",
  memory_type: "semantic" | "episodic" | "procedural",  // NEW (default: semantic)
  content: "Natural language description of what worked/failed",
  metadata: {
    confidence: 0.9,
    evidence_count: 1,
    tags: ["kubernetes", "crashloop"],
    source: "production-incident",                       // NEW: Origin of pattern
    validation_contexts: ["k8s-prod", "staging"],        // NEW: Where validated
    // created_at and last_validated auto-added
  }
)
```

**Returns**:
```javascript
{
  pattern_id: "pattern:semantic:solution:12345678",
  memory_type: "semantic",
  ttl_seconds: null,  // Or 7776000 for episodic (90 days)
  status: "stored"
}
```

**`search_patterns`**
Recall similar patterns before starting a task (20% of time).

```javascript
search_patterns(
  query: "kubernetes pod crashing with OOM",
  k: 10,  // number of results
  category: "solution",  // optional filter
  memory_type: "semantic"  // NEW: optional filter by type
)
```

**Returns**:
```javascript
{
  results: [
    {
      pattern_id: "pattern:semantic:solution:...",
      category: "solution",
      memory_type: "semantic",
      content: "...",
      metadata: {
        confidence_original: 0.9,         // Original confidence
        confidence_current: 0.86,         // NEW: Decayed confidence
        evidence_count: 5,
        created_at: "2025-10-01T...",
        last_validated: "2025-10-15T...",
        // ... other fields
      }
    }
  ],
  filters: { category: "solution", memory_type: "semantic" },
  count: 10
}
```

**Confidence Decay** (NEW): Patterns decay over time if not used
- Formula: `confidence *= 0.95 ^ months_since_last_use`
- Results show both `confidence_original` and `confidence_current`

### Reminders

**`set_reminder`**
Store reminder for specific task type.

```javascript
set_reminder(
  task_type: "git-security-review",
  reminder: "Check .env files in nested directories too",
  priority: "critical" | "important" | "info"
)
```

**`check_reminders`**
Get reminders before executing task.

```javascript
check_reminders(task_type: "git-security-review")
```

Returns reminders sorted by priority.

### Consolidation (NEW)

**`consolidate_memories`**
Manually trigger memory consolidation (promote episodic → semantic, identify canonical).

```javascript
consolidate_memories(
  dry_run: true,  // Preview without promoting (default: true)
  promotion_type: "episodic_to_semantic" | "semantic_to_canonical" | "both",
  min_evidence: 5  // Minimum evidence_count for promotion
)
```

**Returns**:
```javascript
{
  dry_run: true,
  episodic_to_semantic: {
    candidates: [/* patterns ready for promotion */],
    promoted: 0  // Or count if dry_run=false
  },
  semantic_to_canonical: {
    candidates: [/* patterns ready for knowledge/ export */],
    graduated: 0
  },
  summary: {
    episodic_candidates: 3,
    episodic_promoted: 0,
    canonical_candidates: 1,
    note: "Canonical graduation to knowledge/ requires manual review"
  }
}
```

**Usage**:
```javascript
// Preview what would be promoted
await consolidate_memories({ dry_run: true });

// Actually promote patterns
await consolidate_memories({ dry_run: false });
```

### Utility

**`health_check`**
Verify Redis + OpenAI connectivity.

```javascript
health_check()
```

## Installation

```bash
cd ~/semantic-memory-mcp
npm install
```

## Configuration

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["~/semantic-memory-mcp/src/index.js"],
      "env": {
        "REDIS_URL": "redis://localhost:6379/0",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

**Note**: `${OPENAI_API_KEY}` expands from shell environment.

## Usage Example

### Learning Discipline Workflow

**Before task (20% time):**
```javascript
// Check for reminders
const reminders = await check_reminders("git-security-review");

// Recall similar patterns
const solutions = await search_patterns("security violations in git commits", 10, "solution");
const failures = await search_patterns("false positives to avoid", 5, "failure");
```

**After task (20% time):**
```javascript
// Store what worked
await store_pattern(
  "solution",
  "Found hardcoded API key in config.yaml - use git-secrets hook to prevent",
  { confidence: 1.0, evidence_count: 1, severity: "critical" }
);

// Store reminder for next time
await set_reminder(
  "git-security-review",
  "Check YAML files for secrets, not just .env",
  "important"
);
```

## Context Usage

**6 tools, ~3-4k tokens** (vs 11 tools, ~6k tokens before)

**Further reduction**: 40% less context than split MCPs.
**New features**: Memory types, metadata tracking, confidence decay, consolidation

## Implementation Details

**Vector storage:**
- Patterns stored in Redis hashes with 1536-dim embeddings (OpenAI text-embedding-3-small)
- HNSW index for fast similarity search
- COSINE distance metric

**Memory lifecycle:**
- SEMANTIC & PROCEDURAL: No TTL (permanent)
- EPISODIC: 90-day TTL via Redis EXPIRE
- Consolidation: Manual tool promotes high-evidence patterns

**Automatic index creation:**
- Server creates `pattern_index` on startup if missing
- Schema includes: category (TAG), memory_type (TAG), content (TEXT), metadata (TEXT), embedding (VECTOR)
- No manual setup required

**Enhanced metadata:**
- Confidence decay: `confidence *= 0.95 ^ months_since_last_use`
- Validation tracking: source, validation_contexts, timestamps
- Automatic enrichment on store

**Binary vector encoding:**
- Vectors stored as FLOAT32 binary in Redis
- Efficient storage and search

## Pattern References

See `knowledge/learning-discipline.md` for 20-60-20 workflow.
