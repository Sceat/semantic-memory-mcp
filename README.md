<div align="center">

<svg width="600" height="120" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
    </linearGradient>
  </defs>
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="56" font-weight="bold" fill="url(#grad)" text-anchor="middle" dominant-baseline="middle">
    SEMANTIC MEMORY
  </text>
  <text x="50%" y="85%" font-family="Arial, sans-serif" font-size="18" fill="#666" text-anchor="middle" dominant-baseline="middle">
    MCP Server for AI Agents
  </text>
</svg>

<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/redis-7.2%2B-red.svg?style=for-the-badge&logo=redis)](https://redis.io/)
[![OpenAI](https://img.shields.io/badge/OpenAI-embeddings-412991.svg?style=for-the-badge)](https://openai.com/)

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
git clone https://github.com/Sceat/semantic-memory-mcp.git && cd semantic-memory-mcp && npm install
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
│                                                     │
│   Before Task: Query memory for similar patterns   │
│                Check reminders for this task type   │
│                                                     │
│   During Task: Execute with learned context        │
│                                                     │
│   After Task:  Store what you learned              │
│                Set reminders for next time          │
│                                                     │
│   Result: Intelligence compounds over time          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Pattern storage** automatically handles embeddings, categorization, and lifecycle management.

**Semantic search** finds similar patterns by meaning, not keywords.

---

## Requirements

- Node.js ≥ 18
- Redis 7.2+ with RediSearch module
- OpenAI API key

---

## License

MIT
