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
async function generateEmbedding(text) {
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
function encodeVector(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((val, i) => buffer.writeFloatLE(val, i * 4));
  return buffer;
}

/**
 * Decode vector from Redis binary
 * @param {Buffer} buffer - Binary buffer
 * @returns {number[]} Float array
 */
function decodeVector(buffer) {
  const vector = [];
  for (let i = 0; i < buffer.length; i += 4) {
    vector.push(buffer.readFloatLE(i));
  }
  return vector;
}

/**
 * Create vector index if it doesn't exist
 */
async function ensureVectorIndex() {
  try {
    // Check if index exists
    await redis.ft.info("pattern_index");
  } catch (error) {
    // Index doesn't exist, create it
    console.error("Creating pattern_index...");

    // Need to use raw client for binary operations
    const binaryRedis = createClient({ url: REDIS_URL });
    await binaryRedis.connect();

    try {
      await binaryRedis.sendCommand([
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
      await binaryRedis.quit();
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
 * @param {string} lastValidated - ISO timestamp of last validation
 * @returns {number} Decayed confidence
 */
function calculateConfidenceDecay(confidence, lastValidated) {
  if (!lastValidated) return confidence;

  const now = new Date();
  const lastValidatedDate = new Date(lastValidated);
  const monthsSinceLastUse = (now - lastValidatedDate) / (1000 * 60 * 60 * 24 * 30);

  const decayedConfidence = confidence * Math.pow(0.95, monthsSinceLastUse);
  return Math.max(0, Math.min(1, decayedConfidence)); // Clamp to [0, 1]
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Store pattern with embedding
 * @param {string} category - Pattern category
 * @param {string} memoryType - Memory type (semantic/episodic/procedural)
 * @param {string} content - Pattern content
 * @param {object} metadata - Pattern metadata
 */
async function storePattern(category, memoryType = "semantic", content, metadata) {
  // Generate embedding
  const embedding = await generateEmbedding(content);

  // Generate unique pattern ID with memory type prefix
  const patternId = `pattern:${memoryType}:${category}:${Math.abs(hashCode(content)) % 100000000}`;

  // Add enhanced metadata with timestamps
  const enrichedMetadata = {
    ...metadata,
    created_at: new Date().toISOString(),
    last_validated: new Date().toISOString(),
    source: metadata.source || "unknown",
    validation_contexts: metadata.validation_contexts || [],
  };

  // Get TTL based on memory type
  const memoryConfig = Object.values(MEMORY_TYPES).find(m => m.name === memoryType);
  const ttl = memoryConfig?.ttl;

  // Store in Redis hash (using binary client for vector)
  const binaryRedis = createClient({ url: REDIS_URL });
  await binaryRedis.connect();

  try {
    await binaryRedis.hSet(patternId, {
      category,
      memory_type: memoryType,
      content,
      metadata: JSON.stringify(enrichedMetadata),
      embedding: encodeVector(embedding),
    });

    // Set TTL if applicable (episodic memories)
    if (ttl) {
      await binaryRedis.expire(patternId, ttl);
    }
  } finally {
    await binaryRedis.quit();
  }

  return {
    pattern_id: patternId,
    memory_type: memoryType,
    ttl_seconds: ttl,
    status: "stored",
  };
}

/**
 * Search patterns by semantic similarity
 * @param {string} query - Search query
 * @param {number} k - Number of results
 * @param {string} category - Optional category filter
 * @param {string} memoryType - Optional memory type filter
 */
async function searchPatterns(query, k = 5, category = null, memoryType = null) {
  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  const queryVector = encodeVector(queryEmbedding);

  // Build search query with filters
  const filters = [];
  if (category) filters.push(`@category:{${category}}`);
  if (memoryType) filters.push(`@memory_type:{${memoryType}}`);

  const baseQuery = filters.length > 0 ? `(${filters.join(" ")})` : "*";
  const searchQuery = `${baseQuery}=>[KNN ${k} @embedding $vec AS score]`;

  // Execute vector search (using binary client)
  const binaryRedis = createClient({ url: REDIS_URL });
  await binaryRedis.connect();

  try {
    const results = await binaryRedis.sendCommand([
      "FT.SEARCH",
      "pattern_index",
      searchQuery,
      "PARAMS", "2", "vec", queryVector,
      "RETURN", "4", "category", "memory_type", "content", "metadata",
      "SORTBY", "score",
      "DIALECT", "2",
    ]);

    // Parse results
    const patterns = [];
    const numResults = results[0];

    for (let i = 1; i < results.length; i += 2) {
      const docId = results[i];
      const fields = results[i + 1];

      const pattern = { pattern_id: docId };
      for (let j = 0; j < fields.length; j += 2) {
        const fieldName = fields[j];
        const fieldValue = fields[j + 1];

        if (fieldName === "metadata") {
          const metadata = JSON.parse(fieldValue);

          // Apply confidence decay if applicable
          if (metadata.confidence && metadata.last_validated) {
            metadata.confidence_current = calculateConfidenceDecay(
              metadata.confidence,
              metadata.last_validated
            );
            metadata.confidence_original = metadata.confidence;
          }

          pattern.metadata = metadata;
        } else {
          pattern[fieldName] = fieldValue;
        }
      }

      patterns.push(pattern);
    }

    return {
      results: patterns,
      query,
      filters: { category, memory_type: memoryType },
      count: patterns.length,
    };
  } finally {
    await binaryRedis.quit();
  }
}

/**
 * Set reminder for task type
 */
async function setReminder(taskType, reminder, priority = "info") {
  const reminderKey = `reminder:${taskType}`;
  const reminderId = `r_${Date.now()}`;

  const reminderData = {
    reminder_id: reminderId,
    content: reminder,
    priority,
    created_at: new Date().toISOString(),
  };

  await redis.hSet(reminderKey, reminderId, JSON.stringify(reminderData));

  return {
    status: "ok",
    reminder_id: reminderId,
  };
}

/**
 * Get all reminders for task type
 */
async function checkReminders(taskType) {
  const reminderKey = `reminder:${taskType}`;
  const data = await redis.hGetAll(reminderKey);

  const reminders = Object.values(data).map((val) => JSON.parse(val));

  // Sort by priority (critical > important > info)
  const priorityOrder = { critical: 0, important: 1, info: 2 };
  reminders.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return {
    task_type: taskType,
    reminders,
    count: reminders.length,
  };
}

/**
 * Health check
 */
async function healthCheck() {
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
    await generateEmbedding("test");
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
 * @param {boolean} dryRun - Preview mode without actual promotion
 * @param {string} promotionType - Type of promotion
 * @param {number} minEvidence - Minimum evidence count
 */
async function consolidateMemories(
  dryRun = true,
  promotionType = "episodic_to_semantic",
  minEvidence = 5
) {
  const results = {
    dry_run: dryRun,
    promotion_type: promotionType,
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
  if (promotionType === "episodic_to_semantic" || promotionType === "both") {
    // Query all episodic patterns
    const episodicPatterns = await searchPatterns("*", 1000, null, "episodic");

    for (const pattern of episodicPatterns.results) {
      const evidenceCount = pattern.metadata?.evidence_count || 0;

      // Check if meets promotion threshold
      if (evidenceCount >= minEvidence) {
        results.episodic_to_semantic.candidates.push({
          pattern_id: pattern.pattern_id,
          category: pattern.category,
          content: pattern.content.substring(0, 100) + "...", // Preview
          evidence_count: evidenceCount,
          confidence: pattern.metadata.confidence,
        });

        // Promote if not dry run
        if (!dryRun) {
          // Create semantic version
          await storePattern(
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
  if (promotionType === "semantic_to_canonical" || promotionType === "both") {
    // Query all semantic patterns
    const semanticPatterns = await searchPatterns("*", 1000, null, "semantic");

    for (const pattern of semanticPatterns.results) {
      const evidenceCount = pattern.metadata?.evidence_count || 0;
      const confidence = pattern.metadata?.confidence || 0;

      // Check if meets canonical threshold
      if (
        evidenceCount >= PROMOTION_THRESHOLDS.SEMANTIC_TO_LONGTERM &&
        confidence >= PROMOTION_THRESHOLDS.MIN_CONFIDENCE
      ) {
        results.semantic_to_canonical.candidates.push({
          pattern_id: pattern.pattern_id,
          category: pattern.category,
          content: pattern.content.substring(0, 100) + "...",
          evidence_count: evidenceCount,
          confidence: confidence,
          ready_for_export: true,
        });

        // Note: Actual graduation to knowledge/ requires manual review
        // This just identifies candidates
        if (!dryRun) {
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
function hashCode(str) {
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
        result = await storePattern(
          args.category,
          args.memory_type || "semantic",
          args.content,
          args.metadata
        );
        break;

      case "search_patterns":
        result = await searchPatterns(
          args.query,
          args.k,
          args.category,
          args.memory_type
        );
        break;

      case "set_reminder":
        result = await setReminder(args.task_type, args.reminder, args.priority);
        break;

      case "check_reminders":
        result = await checkReminders(args.task_type);
        break;

      case "health_check":
        result = await healthCheck();
        break;

      case "consolidate_memories":
        result = await consolidateMemories(
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
  await ensureVectorIndex();

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Brain Memory MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
