# Graph Report - .  (2026-07-22)

## Corpus Check
- Corpus is ~5,007 words - fits in a single context window. You may not need a graph.

## Summary
- 83 nodes · 87 edges · 14 communities (9 shown, 5 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.5)
- Token cost: 4,067 input · 1,272 output

## Community Hubs (Navigation)
- Package Core Metadata
- Development Dependencies
- TypeScript Compiler Options
- iMessage Python CLI Engine
- Express MCP Server Implementation
- MCP Protocol & Web Dependencies
- Package Build & Test Scripts
- TLS Certificate Generator
- macOS Contacts Integration
- Project Rules & Governance
- macOS iMessage SQLite DB
- Documentation & Setup Guide

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 10 edges
2. `scripts` - 5 edges
3. `repository` - 3 edges
4. `engines` - 2 edges
5. `@modelcontextprotocol/sdk` - 2 edges
6. `cors` - 2 edges
7. `dotenv` - 2 edges
8. `express` - 2 edges
9. `@types/cors` - 2 edges
10. `@types/express` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (14 total, 5 thin omitted)

### Community 0 - "Package Core Metadata"
Cohesion: 0.15
Nodes (12): author, description, engines, node, license, main, name, repository (+4 more)

### Community 1 - "Development Dependencies"
Cohesion: 0.15
Nodes (13): devDependencies, tsx, @types/cors, @types/express, @types/node, typescript, vitest, tsx (+5 more)

### Community 2 - "TypeScript Compiler Options"
Cohesion: 0.15
Nodes (12): src/**/*, compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, rootDir (+4 more)

### Community 3 - "iMessage Python CLI Engine"
Cohesion: 0.38
Nodes (11): format_size(), get_attachment_payload(), get_db_connection(), get_members(), list_chats(), main(), parse_attributed_body(), read_messages() (+3 more)

### Community 4 - "Express MCP Server Implementation"
Cohesion: 0.22
Nodes (8): app, createMcpServer(), __dir, execFileAsync, httpSessions, PORT, sseSessions, TOOLS

### Community 5 - "MCP Protocol & Web Dependencies"
Cohesion: 0.22
Nodes (9): cors, dotenv, express, @modelcontextprotocol/sdk, dependencies, cors, dotenv, express (+1 more)

### Community 6 - "Package Build & Test Scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, start, test

## Knowledge Gaps
- **45 isolated node(s):** `name`, `version`, `description`, `main`, `type` (+40 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Development Dependencies` to `Package Core Metadata`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **Why does `dependencies` connect `MCP Protocol & Web Dependencies` to `Package Core Metadata`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `scripts` connect `Package Build & Test Scripts` to `Package Core Metadata`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `main()` (e.g. with `get_attachment_payload()` and `get_members()`) actually correct?**
  _`main()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _45 weakly-connected nodes found - possible documentation gaps or missing edges._