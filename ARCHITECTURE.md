# Brain Memory MCP - Architecture Documentation

**Version**: 2.0.0 (2025-11-03)
**Author**: Nox (Ant Colony)
**Purpose**: Technical architecture reference for memory system internals

---

## System Overview

Brain Memory MCP implements a hierarchical memory system with three memory types, automatic lifecycle management, and semantic search via Redis + OpenAI embeddings.

### Key Features
- **Memory type separation**: Semantic, episodic, procedural
- **Automatic expiration**: TTL-based cleanup for episodic memories
- **Confidence decay**: Time-based confidence scoring
- **Consolidation**: Manual promotion tool for pattern graduation
- **Vector search**: HNSW indexing with cosine similarity

---

## Memory Types

### 1. SEMANTIC Memory
**Purpose**: Facts and validated knowledge that should persist indefinitely

**Characteristics**:
- TTL: None (permanent storage)
- Pattern ID: `pattern:semantic:{category}:{hash}`
- Use cases: Validated solutions, canonical patterns, best practices

**Storage Strategy**:
- Direct storage without expiration
- Survives consolidation cycles
- Can graduate to `knowledge/` markdown if canonical

**Example**:
```
Pattern: "Redis vector search performs 3-9x faster than Qdrant for <100M vectors"
Category: solution
Confidence: 0.95
Evidence Count: 12
```

### 2. EPISODIC Memory
**Purpose**: Interaction histories and temporary patterns

**Characteristics**:
- TTL: 90 days (7,776,000 seconds)
- Pattern ID: `pattern:episodic:{category}:{hash}`
- Use cases: Session learnings, user preferences, experimental patterns

**Lifecycle**:
1. **Created**: Pattern stored with 90-day TTL via Redis EXPIRE
2. **Validation Period**: Evidence accumulates over time
3. **Promotion**: If evidence_count >= 5, eligible for semantic promotion
4. **Expiration**: Automatically deleted by Redis after 90 days if not promoted

**Storage Strategy**:
```javascript
// Store pattern
await redis.hSet(patternId, { ... });

// Set TTL
await redis.expire(patternId, 7776000); // 90 days
```

**Example**:
```
Pattern: "User prefers dark mode during evening work sessions (19:00-23:00)"
Category: preference
Confidence: 0.7
Evidence Count: 3
TTL Remaining: 45 days
```

### 3. PROCEDURAL Memory
**Purpose**: Behavioral rules and successful workflows

**Characteristics**:
- TTL: None (permanent storage)
- Pattern ID: `pattern:procedural:{category}:{hash}`
- Use cases: Workflows, process patterns, decision trees

**Storage Strategy**:
- Similar to semantic (no TTL)
- Distinguished by usage context (how vs what)
- Evolves through feedback and refinement

**Example**:
```
Pattern: "When deploying to K8s: 1) Check limits, 2) Validate YAML, 3) Apply with --dry-run, 4) Monitor logs"
Category: pattern
Confidence: 0.9
Evidence Count: 25
```

---

## Redis Schema

### Pattern Storage (Hash)

**Key Format**: `pattern:{memory_type}:{category}:{hash}`

**Hash Fields**:
```
category          TEXT      Pattern category (solution/failure/preference/etc)
memory_type       TEXT      Memory type (semantic/episodic/procedural)
content           TEXT      Pattern description (searchable)
metadata          TEXT      JSON-encoded metadata
embedding         BINARY    FLOAT32 vector (1536 dimensions)
```

**Metadata JSON Structure**:
```json
{
  "confidence": 0.9,
  "confidence_original": 0.9,
  "confidence_current": 0.86,
  "evidence_count": 5,
  "tags": ["kubernetes", "deployment"],
  "source": "production-incident",
  "validation_contexts": ["k8s-prod", "staging"],
  "created_at": "2025-10-01T12:00:00Z",
  "last_validated": "2025-11-03T15:30:00Z",
  "promoted_from": "episodic",  // If promoted
  "promoted_at": "2025-11-01T10:00:00Z",
  "original_pattern_id": "pattern:episodic:..."
}
```

### Vector Index (RediSearch)

**Index Name**: `pattern_index`

**Schema**:
```
FT.CREATE pattern_index
  ON HASH
  PREFIX 1 pattern:
  SCHEMA
    category TAG
    memory_type TAG
    content TEXT
    metadata TEXT
    embedding VECTOR HNSW 6
      TYPE FLOAT32
      DIM 1536
      DISTANCE_METRIC COSINE
```

**Index Capabilities**:
- **TAG filters**: `@category:{solution}`, `@memory_type:{semantic}`
- **Full-text search**: `@content:(kubernetes deployment)`
- **Vector KNN**: `=>[KNN 10 @embedding $vec AS score]`
- **Combined queries**: `(@category:{solution} @memory_type:{semantic})=>[KNN 10 @embedding $vec]`

### Reminder Storage (Hash)

**Key Format**: `reminder:{task_type}`

**Hash Fields**:
```
{reminder_id}: JSON-encoded reminder object
```

**Reminder Object**:
```json
{
  "reminder_id": "r_1762183628663",
  "content": "Check .env files in nested directories",
  "priority": "critical",
  "created_at": "2025-11-03T..."
}
```

---

## Confidence Decay Algorithm

### Formula
```
confidence_current = confidence_original * (0.95 ^ months_since_last_use)
```

### Implementation
```javascript
function calculateConfidenceDecay(confidence, lastValidated) {
  if (!lastValidated) return confidence;

  const now = new Date();
  const lastValidatedDate = new Date(lastValidated);
  const monthsSinceLastUse = (now - lastValidatedDate) / (1000 * 60 * 60 * 24 * 30);

  const decayedConfidence = confidence * Math.pow(0.95, monthsSinceLastUse);
  return Math.max(0, Math.min(1, decayedConfidence));
}
```

### Decay Timeline

| Time Since Last Use | Confidence Multiplier | Example (0.9 → ?) |
|---------------------|----------------------|-------------------|
| 0 months            | 1.00x                | 0.90              |
| 1 month             | 0.95x                | 0.86              |
| 3 months            | 0.86x                | 0.77              |
| 6 months            | 0.73x                | 0.66              |
| 12 months           | 0.54x                | 0.49              |
| 24 months           | 0.29x                | 0.26              |

**Rationale**: Patterns become less reliable over time if not re-validated. Exponential decay encourages periodic validation.

---

## Memory Consolidation

### Promotion Thresholds

```javascript
const PROMOTION_THRESHOLDS = {
  EPISODIC_TO_SEMANTIC: 5,      // Min evidence_count
  SEMANTIC_TO_LONGTERM: 20,     // Min evidence_count for canonical
  MIN_CONFIDENCE: 0.95          // Min confidence for canonical
};
```

### Consolidation Workflow

#### 1. Episodic → Semantic Promotion

**Trigger**: Manual via `consolidate_memories` tool

**Criteria**:
- Memory type: `episodic`
- Evidence count: `>= 5`
- Any confidence level

**Process**:
1. Query all episodic patterns
2. Filter by evidence threshold
3. For each candidate:
   - Copy pattern content
   - Create new semantic pattern
   - Preserve metadata + add promotion tracking
   - Original episodic pattern remains until TTL expires

**Result**:
- Semantic pattern created (no TTL)
- Episodic pattern still exists (will expire naturally)
- Metadata tracks promotion: `promoted_from`, `promoted_at`, `original_pattern_id`

#### 2. Semantic → Canonical Graduation

**Trigger**: Manual via `consolidate_memories` tool

**Criteria**:
- Memory type: `semantic`
- Evidence count: `>= 20`
- Confidence: `>= 0.95`

**Process**:
1. Query all semantic patterns
2. Filter by evidence + confidence thresholds
3. Identify candidates ready for export
4. **Manual step**: Export to `knowledge/` markdown
5. Pattern remains in Redis (not deleted)

**Result**:
- Candidate list for manual review
- Patterns stay in Redis as backup/search
- `knowledge/` receives markdown documentation

### Consolidation Tool Usage

**Preview Mode** (default):
```javascript
await consolidate_memories({
  dry_run: true,  // No changes made
  promotion_type: "episodic_to_semantic",
  min_evidence: 5
});

// Returns: { candidates: [...], promoted: 0 }
```

**Promotion Mode**:
```javascript
await consolidate_memories({
  dry_run: false,  // Actually promotes
  promotion_type: "episodic_to_semantic",
  min_evidence: 5
});

// Returns: { candidates: [...], promoted: 3 }
```

**Full Consolidation**:
```javascript
await consolidate_memories({
  dry_run: false,
  promotion_type: "both",  // Episodic + canonical
  min_evidence: 5
});
```

---

## Vector Search Details

### Embedding Generation

**Model**: OpenAI `text-embedding-3-small`
**Dimensions**: 1536
**Encoding**: FLOAT32 binary (6144 bytes per vector)

```javascript
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding; // Array of 1536 floats
}
```

### Binary Encoding

**Reason**: Redis stores vectors as binary blobs for efficiency

```javascript
function encodeVector(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4); // 4 bytes per FLOAT32
  vector.forEach((val, i) => buffer.writeFloatLE(val, i * 4));
  return buffer;
}

function decodeVector(buffer) {
  const vector = [];
  for (let i = 0; i < buffer.length; i += 4) {
    vector.push(buffer.readFloatLE(i));
  }
  return vector;
}
```

### Search Query Construction

**Basic Semantic Search**:
```
*=>[KNN 10 @embedding $vec AS score]
```

**Filtered Search** (category + memory type):
```
(@category:{solution} @memory_type:{semantic})=>[KNN 10 @embedding $vec AS score]
```

**Redis Command**:
```bash
FT.SEARCH pattern_index
  "(@category:{solution})=>[KNN 10 @embedding $vec AS score]"
  PARAMS 2 vec <binary_vector>
  RETURN 4 category memory_type content metadata
  SORTBY score
  DIALECT 2
```

### Performance Characteristics

**Query Latency**: Sub-millisecond for <10M patterns
**Index Size**: ~6KB per pattern (embedding + metadata)
**Search Accuracy**: HNSW provides ~99% recall for top-10

---

## Server Lifecycle

### Startup Sequence

1. **Load Environment**:
   - `REDIS_URL` (default: `redis://localhost:6379/0`)
   - `OPENAI_API_KEY`

2. **Initialize Clients**:
   - Redis client (with error handling)
   - OpenAI client (with API key validation)

3. **Ensure Vector Index**:
   - Check if `pattern_index` exists via `FT.INFO`
   - If missing, create with schema (category, memory_type, embedding)
   - Auto-recovery on index errors

4. **Start MCP Server**:
   - Stdio transport (for CLI integration)
   - Register 6 tool handlers
   - Listen for tool calls

### Shutdown Sequence

1. **Disconnect Redis**: `await redis.quit()`
2. **Close MCP Server**: Transport cleanup
3. **Exit Process**: Clean shutdown

---

## Error Handling

### Redis Connection Failures

**Strategy**: Fail fast with clear error messages

```javascript
redis.on("error", (err) => console.error("Redis error:", err));

try {
  await redis.ping();
} catch (error) {
  return { redis: `error: ${error.message}` };
}
```

### OpenAI API Failures

**Strategy**: Graceful degradation

```javascript
try {
  await generateEmbedding("test");
} catch (error) {
  return { openai: `error: ${error.message}` };
}
```

### Vector Index Errors

**Strategy**: Auto-recreation on missing index

```javascript
try {
  await redis.ft.info("pattern_index");
} catch (error) {
  console.error("Creating pattern_index...");
  await createIndex(); // Auto-recovery
}
```

---

## Migration Notes

### Upgrading from v1.x to v2.0

**Breaking Changes**: None (backward compatible)

**Schema Changes**:
- Added `memory_type` TAG field to index
- Pattern IDs now include memory type prefix
- Metadata structure expanded

**Migration Strategy**:

1. **No migration required** for existing patterns
   - Old patterns without `memory_type` default to `semantic`
   - Old pattern IDs still searchable (prefix match)

2. **Optional backfill** (if desired):
```javascript
// Enumerate all old patterns
const keys = await redis.keys("pattern:solution:*");

// Add memory_type field
for (const key of keys) {
  await redis.hSet(key, "memory_type", "semantic");
}
```

3. **Index rebuild** (if schema change needed):
```bash
# Drop old index
redis-cli FT.DROPINDEX pattern_index

# Restart server (auto-creates new index)
# Existing patterns will be re-indexed automatically
```

---

## Performance Tuning

### Redis Configuration

**Recommended Settings**:
```conf
# redis.conf
maxmemory 4gb
maxmemory-policy allkeys-lru  # Evict least-recently-used keys
save 900 1                    # Persistence (save after 900s if 1 key changed)
appendonly yes                # AOF for durability
```

### Index Optimization

**HNSW Parameters**:
```
M = 16        # Number of connections per layer (default: balance speed/recall)
EF_CONSTRUCTION = 200  # Construction time factor (higher = better recall, slower indexing)
```

**Custom tuning** (if needed):
```bash
FT.CREATE pattern_index
  ...
  embedding VECTOR HNSW 10
    TYPE FLOAT32
    DIM 1536
    DISTANCE_METRIC COSINE
    M 32                  # More connections (better recall, more memory)
    EF_CONSTRUCTION 400   # Higher quality index (slower build)
```

### Query Optimization

**Batch Operations**:
```javascript
// Store multiple patterns in pipeline
const pipeline = redis.pipeline();
patterns.forEach(p => {
  pipeline.hSet(p.id, p.fields);
  if (p.ttl) pipeline.expire(p.id, p.ttl);
});
await pipeline.exec();
```

---

## Security Considerations

### API Key Management

- **Never commit** `.env` file with `OPENAI_API_KEY`
- Use environment variable expansion: `${OPENAI_API_KEY}`
- Rotate keys periodically

### Redis Access

- **Bind to localhost** for local development
- Use **Redis AUTH** for network deployments
- Consider **TLS** for production

### Data Privacy

- Embeddings are NOT reversible (one-way transformation)
- Pattern content stored as plaintext in Redis
- Consider encryption at rest for sensitive data

---

## Monitoring & Observability

### Key Metrics

1. **Pattern Count by Type**:
```bash
FT.SEARCH pattern_index "@memory_type:{semantic}" LIMIT 0 0
FT.SEARCH pattern_index "@memory_type:{episodic}" LIMIT 0 0
FT.SEARCH pattern_index "@memory_type:{procedural}" LIMIT 0 0
```

2. **TTL Distribution** (episodic memories):
```bash
redis-cli --scan --pattern "pattern:episodic:*" | xargs -L1 redis-cli TTL
```

3. **Search Latency**:
```bash
# Add timing to queries
redis-cli --latency-history -i 1 -- FT.SEARCH pattern_index "*"
```

4. **Memory Usage**:
```bash
redis-cli INFO memory
redis-cli MEMORY STATS
```

### Health Checks

**Tool**: `health_check()` (built-in)
**Checks**:
- Redis connection
- OpenAI API connectivity
- Vector index existence

**Alerting Triggers**:
- Redis disconnected
- OpenAI API failures
- Index missing (auto-recreates, but flag for review)

---

## References

- **Redis Vector Search**: https://redis.io/docs/stack/search/reference/vectors/
- **OpenAI Embeddings**: https://platform.openai.com/docs/guides/embeddings
- **RediSearch Docs**: https://redis.io/docs/stack/search/
- **HNSW Algorithm**: https://arxiv.org/abs/1603.09320

---

**Last Updated**: 2025-11-03
**Version**: 2.0.0
