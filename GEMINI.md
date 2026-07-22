# Project Rules: iMessage MCP Server

## Pop-Culture Franchise Placeholders
- **Franchise:** Dune (e.g., Arrakis, Paul Atreides, Fremen, Caladan, Harkonnen, CHOAM, Spice Melange).

---

## 1. Test-Driven Development (TDD) Protocol

- **Red-Green-Refactor Cycle:**
  1. **Red:** Write a failing test in `tests/` defining expected component or API contract behavior *before* modifying or adding implementation code.
  2. **Green:** Write minimal implementation code necessary to satisfy test assertions.
  3. **Refactor:** Clean up implementation code while ensuring all tests continue to pass.
- **Mandatory Test Verification:**
  - Run `pnpm test` (Vitest) and `pnpm build` (`tsc`) after every code change.
  - Never declare a feature or refactor complete without verifying passing automated tests.
- **Test Scoping:**
  - Unit tests for tool argument parsing, binary message parsing (`parse_attributed_body`), and payload schema outputs.
  - Integration tests for Express routes (`/health`, `/discover`, `/mcp`, `/sse`).

---

## 2. Schema-Driven Development (SDD) Protocol

- **Schema as Single Source of Truth:**
  - All MCP tool signatures, request payloads, and API outputs must be formally defined as explicit JSON schemas or TypeScript interfaces in `TOOLS` within [src/index.ts](file:///Users/matthias/github/imessage-mcp-server/src/index.ts).
  - Runtime validation must strictly match published schema signatures.
- **Contract Driven API Endpoints:**
  - `/discover` endpoint output must be derived dynamically from the canonical `TOOLS` array schema to ensure documentation and runtime contracts never drift.
  - Any parameter change in `TOOLS` must update corresponding CLI interface specifications and unit tests.
- **Input Boundary Sanitization:**
  - Validate all input parameters (e.g. `limit`, `days`, `chat`, `query`, `recipient`, `path`) at entry point using strict boundary checks before executing CLI subcommands.

---

## 3. General Development Standards

- **Package Manager:** `pnpm` ONLY. Use `pnpm install`, `pnpm run`, `pnpm add`.
- **Node.js Engine:** `>=24.0.0` (Active LTS). Enforced via `package.json`.
- **Imports:** Absolute imports or relative ESM imports with `.js` extensions as required by NodeNext module resolution.
