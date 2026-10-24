
# Astral Atlas

**Webster 2026 · Problem Statement 06 — The Astral Cartographer**

Astral Atlas is a browser-based repository intelligence tool for
exploring JavaScript and TypeScript projects through interactive
dependency graphs, AST-derived metrics, cycle detection, and
developer onboarding recommendations.

## Core principle

Source analysis happens in the user's browser. Repository code is
not uploaded to Atlas Edge. The optional Cloudflare Worker is
restricted to read-only GitHub metadata requests.

## Planned architecture

- React and Vite provide the user interface and development tooling.
- A modular JavaScript engine handles repository ingestion,
  caching, parsing orchestration, graph construction, and analysis.
- Web Workers handle AST parsing so the UI thread remains responsive.
- IndexedDB stores reusable parse summaries.
- Cytoscape.js renders the dependency atlas.
- Atlas Edge provides an optional, stateless metadata relay.

## Requirements

- Node.js 24 LTS
- npm
- Git

## Run locally

Install the declared dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build the site:

```bash
npm run build
```

Run tests:

```bash
npm test
```

## Documentation

The completed README will include the architecture diagram, AST
algorithms, rendering optimizations, privacy and security decisions,
tool disclosure, setup instructions, limitations, and benchmark results.

Actual benchmark results will be recorded only after measurements.
