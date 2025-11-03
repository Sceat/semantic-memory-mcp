<div align="center">

```
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║   ███████╗███████╗███╗   ███╗ █████╗ ███╗   ██╗████████╗██╗ ██████╗
║   ██╔════╝██╔════╝████╗ ████║██╔══██╗████╗  ██║╚══██╔══╝██║██╔════╝
║   ███████╗█████╗  ██╔████╔██║███████║██╔██╗ ██║   ██║   ██║██║
║   ╚════██║██╔══╝  ██║╚██╔╝██║██╔══██║██║╚██╗██║   ██║   ██║██║
║   ███████║███████╗██║ ╚═╝ ██║██║  ██║██║ ╚████║   ██║   ██║╚██████╗
║   ╚══════╝╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝ ╚═════╝
║                                                                   ║
║                      M E M O R Y   M C P                          ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
```

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/redis-7.2%2B-red.svg)](https://redis.io/)
[![OpenAI](https://img.shields.io/badge/OpenAI-embeddings-412991.svg)](https://openai.com/)

**Semantic memory for AI agents. Store patterns, search by meaning, remember forever.**

📖 **For LLMs**: See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed implementation & [TESTING.md](TESTING.md) for tool reference

</div>

---

## What This Does

Give your AI agents a brain that learns and remembers:

- 🧠 **Semantic Search**: Find patterns by meaning, not keywords
- 💾 **Three Memory Types**: Semantic (forever), Episodic (90 days), Procedural (forever)
- 📈 **Intelligence Compounds**: Learn from every task, recall before you act
- 🔄 **Auto-Consolidation**: Promotes validated patterns automatically

## Quick Start

### 1. Install

```bash
git clone https://github.com/Sceat/semantic-memory-mcp.git
cd semantic-memory-mcp
npm install
```

### 2. Configure

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-memory-mcp/src/index.js"],
      "env": {
        "REDIS_URL": "redis://localhost:6379/0",
        "OPENAI_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### 3. Use

Six tools available immediately:
- `store_pattern` - Save what you learned
- `search_patterns` - Find similar patterns
- `set_reminder` - Never forget important details
- `check_reminders` - Get context before tasks
- `consolidate_memories` - Promote validated patterns
- `health_check` - Verify system status

---

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  Query Memory → Execute Task → Store Learnings      │
│                                                     │
│  Intelligence compounds over time                   │
└─────────────────────────────────────────────────────┘
```

**Example workflow:**

```javascript
// Before starting a task
const patterns = await search_patterns("kubernetes pod crashes", 5);
const reminders = await check_reminders("k8s-deploy");

// After completing a task
await store_pattern(
  "solution",
  "OOM crash fixed by increasing memory limit from 512Mi to 1Gi",
  { confidence: 1.0, tags: ["kubernetes", "memory"] }
);
```

---

## Requirements

- Node.js ≥ 18
- Redis 7.2+ with RediSearch module
- OpenAI API key

---

## License

MIT
