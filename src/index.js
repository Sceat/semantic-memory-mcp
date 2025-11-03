#!/usr/bin/env node

/**
 * Brain Memory MCP Server
 *
 * Unified memory interface abstracting Redis + OpenAI embeddings.
 * Implements hierarchical memory architecture with three memory types:
 * - SEMANTIC: Facts & knowledge (persist indefinitely)
 * - EPISODIC: Interaction histories (90-day TTL, promote to semantic if validated)
 * - PROCEDURAL: Behavioral rules (evolve via feedback)
 *
 * Tools:
 * - store_pattern: Store learned pattern with embedding
 * - search_patterns: Semantic similarity search
 * - set_reminder: Store reminder for task type
 * - check_reminders: Get reminders before task
 * - health_check: Verify Redis + OpenAI connectivity
 *
 * Enhanced features (2025-11-03):
 * - Memory type separation with automatic TTL management
 * - Enhanced metadata (validation_contexts, source, last_validated)
 * - Confidence decay formula
 * - Consolidation support (episodic → semantic promotion)
 */

import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "redis";
import OpenAI from "openai";

// Load environment variables from .env file
dotenv.config();

// ============================================================================
// Initialize clients
// ============================================================================

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let redis;
let openai;

// ============================================================================
// Memory Configuration
// ============================================================================

// Memory types with TTL settings
const MEMORY_TYPES = {
  SEMANTIC: {
    name: "semantic",
    description: "Facts & knowledge (persist indefinitely)",
    ttl: null, // No expiration
  },
  EPISODIC: {
    name: "episodic",
    description: "Interaction histories (expire after 90 days unless promoted)",
    ttl: 90 * 24 * 60 * 60, // 90 days in seconds
  },
  PROCEDURAL: {
    name: "procedural",
    description: "Behavioral rules (evolve via feedback)",
    ttl: null, // No expiration
  },
};

// Evidence thresholds for promotion
const PROMOTION_THRESHOLDS = {
  EPISODIC_TO_SEMANTIC: 5, // Min evidence_count to promote episodic → semantic
  SEMANTIC_TO_LONGTERM: 20, // Min evidence_count for canonical status
  MIN_CONFIDENCE: 0.95, // Min confidence for long-term graduation
};

// ============================================================================
// Tool Definitions (5 tools)
// ============================================================================

const tools = [
  {
    name: "store_pattern",
    description: "Store learned pattern with semantic embedding for future recall",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Pattern category: solution, failure, preference, reminder, pattern",
          enum: ["solution", "failure", "preference", "reminder", "pattern"],
        },
        memory_type: {
          type: "string",
          description: "Memory type: semantic (facts, persist forever), episodic (interactions, 90-day TTL), procedural (workflows, persist forever)",
          enum: ["semantic", "episodic", "procedural"],
          default: "semantic",
        },
        content: {
          type: "string",
          description: "Natural language description of the pattern",
        },
        metadata: {
          type: "object",
          description: "Enhanced metadata with validation tracking",
          properties: {
            confidence: { type: "number", description: "0.0-1.0" },
            evidence_count: { type: "number", description: "Number of validations" },
            tags: { type: "array", items: { type: "string" } },
            source: { type: "string", description: "Source of pattern (e.g., 'production-incident', 'research', 'user-feedback')" },
            validation_contexts: { type: "array", items: { type: "string" }, description: "Contexts where pattern was validated" },
          },
        },
      },
      required: ["category", "content", "metadata"],
    },
  },
  {
    name: "search_patterns",
    description: "Search for similar patterns using semantic similarity",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in natural language",
        },
        k: {
          type: "number",
          description: "Number of results to return",
          default: 5,
        },
        category: {
          type: "string",
          description: "Optional filter by category",
          enum: ["solution", "failure", "preference", "reminder", "pattern"],
        },
        memory_type: {
          type: "string",
          description: "Optional filter by memory type",
          enum: ["semantic", "episodic", "procedural"],
        },
      },
      required: ["query"],
    },
  },
  {
    name: "set_reminder",
    description: "Set reminder for specific task type (surfaces before task execution)",
    inputSchema: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description: "Task type identifier (e.g., 'git-security-review', 'k8s-deployment')",
        },
        reminder: {
          type: "string",
          description: "Reminder content",
        },
        priority: {
          type: "string",
          description: "Reminder priority",
          enum: ["critical", "important", "info"],
          default: "info",
        },
      },
      required: ["task_type", "reminder"],
    },
  },
  {
    name: "check_reminders",
    description: "Get all reminders for a specific task type",
    inputSchema: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description: "Task type identifier",
        },
      },
      required: ["task_type"],
    },
  },
  {
    name: "health_check",
    description: "Check Redis and OpenAI connectivity",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "consolidate_memories",
    description: "Identify and promote patterns ready for consolidation (episodic → semantic)",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "Preview mode - show what would be promoted without actually promoting",
          default: true,
        },
        promotion_type: {
          type: "string",
          description: "Type of promotion to perform",
          enum: ["episodic_to_semantic", "semantic_to_canonical", "both"],
          default: "episodic_to_semantic",
        },
        min_evidence: {
          type: "number",
          description: "Minimum evidence_count for promotion",
          default: 5,
        },
      },
    },
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate OpenAI embedding for text
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector (1536 dims)
 */
async function generate_embedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * Encode vector as binary for Redis storage
 * @param {number[]} vector - Float array
 * @returns {Buffer} Binary buffer
 */
function encode_vector(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((val, i) => buffer.writeFloatLE(val, i * 4));
  return buffer;
}

/**
 * Decode vector from Redis binary
 * @param {Buffer} buffer - Binary buffer
 * @returns {number[]} Float array
 */
function decode_vector(buffer) {
  const vector = [];
  for (let i = 0; i < buffer.length; i += 4) {
    vector.push(buffer.readFloatLE(i));
  }
  return vector;
}

/**
 * Create vector index if it doesn't exist
 */
async function ensure_vector_index() {
  try {
    // Check if index exists
    await redis.ft.info("pattern_index");
  } catch (error) {
    // Index doesn't exist, create it
    console.error("Creating pattern_index...");

    // Need to use raw client for binary operations
    const binary_redis = createClient({ url: REDIS_URL });
    await binary_redis.connect();

    try {
      await binary_redis.sendCommand([
        "FT.CREATE",
        "pattern_index",
        "ON", "HASH",
        "PREFIX", "1", "pattern:",
        "SCHEMA",
        "category", "TAG",
        "memory_type", "TAG",
        "content", "TEXT",
        "metadata", "TEXT",
        "embedding", "VECTOR", "HNSW", "6",
        "TYPE", "FLOAT32",
        "DIM", "1536",
        "DISTANCE_METRIC", "COSINE",
      ]);
      console.error("pattern_index created successfully");
    } finally {
      await binary_redis.quit();
    }
  }
}

// ============================================================================
// Helper Functions for Memory Management
// ============================================================================

/**
 * Calculate confidence decay based on time since last use
 * Formula: confidence *= 0.95 ** months_since_last_use
 * @param {number} confidence - Current confidence (0.0-1.0)
 * @param {string} last_validated - ISO timestamp of last validation
 * @returns {number} Decayed confidence
 */
function calculate_confidence_decay(confidence, last_validated) {
  if (!last_validated) return confidence;

  const now = new Date();
  const last_validated_date = new Date(last_validated);
  const months_since_last_use = (now - last_validated_date) / (1000 * 60 * 60 * 24 * 30);

  const decayed_confidence = confidence * Math.pow(0.95, months_since_last_use);
  return Math.max(0, Math.min(1, decayed_confidence)); // Clamp to [0, 1]
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Store pattern with embedding
 * @param {string} category - Pattern category
 * @param {string} memory_type - Memory type (semantic/episodic/procedural)
 * @param {string} content - Pattern content
 * @param {object} metadata - Pattern metadata
 */
async function store_pattern(category, memory_type = "semantic", content, metadata) {
  // Generate embedding
  const embedding = await generate_embedding(content);

  // Generate unique pattern ID with memory type prefix
  const pattern_id = `pattern:${memory_type}:${category}:${Math.abs(hash_code(content)) % 100000000}`;

  // Add enhanced metadata with timestamps
  const enriched_metadata = {
    ...metadata,
    created_at: new Date().toISOString(),
    last_validated: new Date().toISOString(),
    source: metadata.source || "unknown",
    validation_contexts: metadata.validation_contexts || [],
  };

  // Get TTL based on memory type
  const memory_config = Object.values(MEMORY_TYPES).find(m => m.name === memory_type);
  const ttl = memory_config?.ttl;

  // Store in Redis hash (using binary client for vector)
  const binary_redis = createClient({ url: REDIS_URL });
  await binary_redis.connect();

  try {
    await binary_redis.hSet(pattern_id, {
      category,
      memory_type: memory_type,
      content,
      metadata: JSON.stringify(enriched_metadata),
      embedding: encode_vector(embedding),
    });

    // Set TTL if applicable (episodic memories)
    if (ttl) {
      await binary_redis.expire(pattern_id, ttl);
    }
  } finally {
    await binary_redis.quit();
  }

  return {
    pattern_id: pattern_id,
    memory_type: memory_type,
    ttl_seconds: ttl,
    status: "stored",
  };
}

/**
 * Search patterns by semantic similarity
 * @param {string} query - Search query
 * @param {number} k - Number of results
 * @param {string} category - Optional category filter
 * @param {string} memory_type - Optional memory type filter
 */
async function search_patterns(query, k = 5, category = null, memory_type = null) {
  // Generate query embedding
  const query_embedding = await generate_embedding(query);
  const query_vector = encode_vector(query_embedding);

  // Build search query with filters
  const filters = [];
  if (category) filters.push(`@category:{${category}}`);
  if (memory_type) filters.push(`@memory_type:{${memory_type}}`);

  const base_query = filters.length > 0 ? `(${filters.join(" ")})` : "*";
  const search_query = `${base_query}=>[KNN ${k} @embedding $vec AS score]`;

  // Execute vector search (using binary client)
  const binary_redis = createClient({ url: REDIS_URL });
  await binary_redis.connect();

  try {
    const results = await binary_redis.sendCommand([
      "FT.SEARCH",
      "pattern_index",
      search_query,
      "PARAMS", "2", "vec", query_vector,
      "RETURN", "4", "category", "memory_type", "content", "metadata",
      "SORTBY", "score",
      "DIALECT", "2",
    ]);

    // Parse results
    const patterns = [];
    const num_results = results[0];

    for (let i = 1; i < results.length; i += 2) {
      const doc_id = results[i];
      const fields = results[i + 1];

      const pattern = { pattern_id: doc_id };
      for (let j = 0; j < fields.length; j += 2) {
        const field_name = fields[j];
        const field_value = fields[j + 1];

        if (field_name === "metadata") {
          const metadata = JSON.parse(field_value);

          // Apply confidence decay if applicable
          if (metadata.confidence && metadata.last_validated) {
            metadata.confidence_current = calculate_confidence_decay(
              metadata.confidence,
              metadata.last_validated
            );
            metadata.confidence_original = metadata.confidence;
          }

          pattern.metadata = metadata;
        } else {
          pattern[field_name] = field_value;
        }
      }

      patterns.push(pattern);
    }

    return {
      results: patterns,
      query,
      filters: { category, memory_type: memory_type },
      count: patterns.length,
    };
  } finally {
    await binary_redis.quit();
  }
}

/**
 * Set reminder for task type
 */
async function set_reminder(task_type, reminder, priority = "info") {
  const reminder_key = `reminder:${task_type}`;
  const reminder_id = `r_${Date.now()}`;

  const reminder_data = {
    reminder_id: reminder_id,
    content: reminder,
    priority,
    created_at: new Date().toISOString(),
  };

  await redis.hSet(reminder_key, reminder_id, JSON.stringify(reminder_data));

  return {
    status: "ok",
    reminder_id: reminder_id,
  };
}

/**
 * Get all reminders for task type
 */
async function check_reminders(task_type) {
  const reminder_key = `reminder:${task_type}`;
  const data = await redis.hGetAll(reminder_key);

  const reminders = Object.values(data).map((val) => JSON.parse(val));

  // Sort by priority (critical > important > info)
  const priority_order = { critical: 0, important: 1, info: 2 };
  reminders.sort((a, b) => priority_order[a.priority] - priority_order[b.priority]);

  return {
    task_type: task_type,
    reminders,
    count: reminders.length,
  };
}

/**
 * Health check
 */
async function health_check() {
  const checks = {
    redis: "disconnected",
    openai: "unknown",
    vector_index: "missing",
  };

  // Check Redis
  try {
    await redis.ping();
    checks.redis = "connected";
  } catch (error) {
    checks.redis = `error: ${error.message}`;
  }

  // Check OpenAI (attempt to get embeddings)
  try {
    await generate_embedding("test");
    checks.openai = "connected";
  } catch (error) {
    checks.openai = `error: ${error.message}`;
  }

  // Check vector index
  try {
    await redis.ft.info("pattern_index");
    checks.vector_index = "exists";
  } catch (error) {
    checks.vector_index = "missing";
  }

  const healthy = checks.redis === "connected" && checks.openai === "connected";

  return {
    status: healthy ? "healthy" : "degraded",
    checks,
  };
}

/**
 * Consolidate memories - identify and promote patterns
 * @param {boolean} dry_run - Preview mode without actual promotion
 * @param {string} promotion_type - Type of promotion
 * @param {number} min_evidence - Minimum evidence count
 */
async function consolidate_memories(
  dry_run = true,
  promotion_type = "episodic_to_semantic",
  min_evidence = 5
) {
  const results = {
    dry_run: dry_run,
    promotion_type: promotion_type,
    episodic_to_semantic: {
      candidates: [],
      promoted: 0,
    },
    semantic_to_canonical: {
      candidates: [],
      graduated: 0,
    },
  };

  // Phase 1: Episodic → Semantic promotion
  if (promotion_type === "episodic_to_semantic" || promotion_type === "both") {
    // Query all episodic patterns
    const episodic_patterns = await search_patterns("*", 1000, null, "episodic");

    for (const pattern of episodic_patterns.results) {
      const evidence_count = pattern.metadata?.evidence_count || 0;

      // Check if meets promotion threshold
      if (evidence_count >= min_evidence) {
        results.episodic_to_semantic.candidates.push({
          pattern_id: pattern.pattern_id,
          category: pattern.category,
          content: pattern.content.substring(0, 100) + "...", // Preview
          evidence_count: evidence_count,
          confidence: pattern.metadata.confidence,
        });

        // Promote if not dry run
        if (!dry_run) {
          // Create semantic version
          await store_pattern(
            pattern.category,
            "semantic", // Promote to semantic
            pattern.content,
            {
              ...pattern.metadata,
              promoted_from: "episodic",
              promoted_at: new Date().toISOString(),
              original_pattern_id: pattern.pattern_id,
            }
          );

          results.episodic_to_semantic.promoted++;
        }
      }
    }
  }

  // Phase 2: Semantic → Canonical graduation
  if (promotion_type === "semantic_to_canonical" || promotion_type === "both") {
    // Query all semantic patterns
    const semantic_patterns = await search_patterns("*", 1000, null, "semantic");

    for (const pattern of semantic_patterns.results) {
      const evidence_count = pattern.metadata?.evidence_count || 0;
      const confidence = pattern.metadata?.confidence || 0;

      // Check if meets canonical threshold
      if (
        evidence_count >= PROMOTION_THRESHOLDS.SEMANTIC_TO_LONGTERM &&
        confidence >= PROMOTION_THRESHOLDS.MIN_CONFIDENCE
      ) {
        results.semantic_to_canonical.candidates.push({
          pattern_id: pattern.pattern_id,
          category: pattern.category,
          content: pattern.content.substring(0, 100) + "...",
          evidence_count: evidence_count,
          confidence: confidence,
          ready_for_export: true,
        });

        // Note: Actual graduation to knowledge/ requires manual review
        // This just identifies candidates
        if (!dry_run) {
          results.semantic_to_canonical.graduated++;
        }
      }
    }
  }

  return {
    ...results,
    summary: {
      episodic_candidates: results.episodic_to_semantic.candidates.length,
      episodic_promoted: results.episodic_to_semantic.promoted,
      canonical_candidates: results.semantic_to_canonical.candidates.length,
      note:
        "Canonical graduation to knowledge/ requires manual review and markdown export",
    },
  };
}

/**
 * Simple string hash function
 */
function hash_code(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new Server(
  {
    name: "brain-memory",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "store_pattern":
        result = await store_pattern(
          args.category,
          args.memory_type || "semantic",
          args.content,
          args.metadata
        );
        break;

      case "search_patterns":
        result = await search_patterns(
          args.query,
          args.k,
          args.category,
          args.memory_type
        );
        break;

      case "set_reminder":
        result = await set_reminder(args.task_type, args.reminder, args.priority);
        break;

      case "check_reminders":
        result = await check_reminders(args.task_type);
        break;

      case "health_check":
        result = await health_check();
        break;

      case "consolidate_memories":
        result = await consolidate_memories(
          args.dry_run !== false, // Default to true
          args.promotion_type || "episodic_to_semantic",
          args.min_evidence || 5
        );
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: error.message }),
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// Server Lifecycle
// ============================================================================

async function main() {
  // Initialize Redis
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (err) => console.error("Redis error:", err));
  await redis.connect();

  // Initialize OpenAI
  if (!OPENAI_API_KEY) {
    console.error("Warning: OPENAI_API_KEY not set");
  }
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  // Ensure vector index exists
  await ensure_vector_index();

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Brain Memory MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
