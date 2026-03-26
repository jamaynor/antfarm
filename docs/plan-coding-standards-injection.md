# Plan: Auto-Inject Coding Standards by Tech Stack

## Summary

Inject coding standards from `<target-repo>/agent-os/standards/*.md` into workflow step instructions at runtime, filtered by the target repo's detected tech stack.

## Architecture

```
Target repo:    agent-os/standards/*.md      (standards files + TAGS.md reference)
Antfarm:        src/lib/standards.ts         (loader: normalize, two-pass match, truncation, cache)
                src/installer/step-ops.ts    (single injection point + DB write strip)
                workflows/*/workflow.yml     (TECH_STACK output + {{coding_standards}} in templates)
                tests/standards.test.ts      (unit tests)
```

## 1. `src/lib/standards.ts` — Loader

### Function signature

```typescript
export function loadStandards(techStack: string, repoDir: string): string
```

### Canonical normalization map

Before matching, normalize known aliases in the TECH_STACK string. This runs once per `loadStandards` call, converting agent free-text into canonical tags that the two-pass matcher can reliably find:

```typescript
const ALIASES: Record<string, string> = {
  "node.js":    "nodejs",
  "next.js":    "nextjs",
  "vue.js":     "vuejs",
  "nuxt.js":    "nuxtjs",
  "express.js": "expressjs",
  "react native": "reactnative",
  "c#":         "csharp",
  ".net":       "dotnet",
  "asp.net":    "aspnet",
  "postgresql":  "postgres",
  "ts":         "typescript",
  "js":         "javascript",
  "py":         "python",
  "rb":         "ruby",
};
```

Applied case-insensitively before either matching pass. The original text is preserved alongside — aliases expand the search surface, they don't replace it.

### Matching algorithm — two-pass

For each `.md` file in `<repoDir>/agent-os/standards/` (excluding `TAGS.md`):

**Pass 1 — Word-boundary regex (all tags):**
- Normalize TECH_STACK: replace `.` `-` `_` with spaces, lowercase, apply alias expansion
- Test `\b<tag>\b` (case-insensitive) against normalized string
- Handles short tags safely: `go` matches "Go" but not "django"

**Pass 2 — Substring match (tags >= 5 chars only):**
- Strip TECH_STACK: remove all non-alphanumeric chars, lowercase (alias-expanded version)
- Check if tag appears as substring of stripped string
- Handles compound names: `nextjs` matches "Next.js", `reactnative` matches "React Native"
- Short tags excluded to prevent false positives (`rust` in "frustrating")

A tag matches if **either** pass succeeds.

### Fallback detection from repo markers

When `techStack` is empty or produces no matches, attempt lightweight detection from well-known files in `repoDir`:

```typescript
const MARKER_MAP: Record<string, string> = {
  "package.json":     "javascript",
  "tsconfig.json":    "typescript",
  "pyproject.toml":   "python",
  "requirements.txt": "python",
  "Cargo.toml":       "rust",
  "go.mod":           "go",
  "Gemfile":          "ruby",
  "composer.json":    "php",
  "pom.xml":          "java",
  "build.gradle":     "java",
  "*.csproj":         "csharp",
  "next.config.js":   "nextjs",
  "next.config.ts":   "nextjs",
  "nuxt.config.ts":   "nuxt",
  "vue.config.js":    "vue",
  "angular.json":     "angular",
  "svelte.config.js": "svelte",
};
```

This is a best-effort fallback — not a replacement for agent-detected `TECH_STACK`. It uses `fs.existsSync` on each marker (fast, no directory scan). Detected tags are fed back into the two-pass matcher. Logged as `logger.info("Standards loaded via repo marker fallback", { tags, runId })`.

### Truncation contract

**Ordering:** Files are sorted alphabetically by filename before concatenation. This guarantees deterministic output for the same set of matched files.

**Per-file: 4KB**, truncated at last complete line boundary (never mid-line). Partially matched content is included (with truncation marker), never skipped:
```
[...standards truncated — keep <tag>.md under 4KB]
```

**Total budget by role:**

| Role | Budget | Rationale |
|------|--------|-----------|
| coding (developer, fixer) | 8KB (~2K tokens) | Primary consumer — needs full detail |
| verification (verifier) | 4KB (~1K tokens) | Checklist reference, not implementation guide |
| review (reviewer) | 4KB (~1K tokens) | Same as verification |

Role is passed as a parameter: `loadStandards(techStack, repoDir, role)`. The `role` maps to a budget. If not provided, defaults to 8KB.

**Separator:** Files joined with `\n\n---\n\n`.

**Truncation marker (total):** When budget is hit, remaining files are listed but not included:
```
[...additional standards skipped: react.md, node.md — reduce file sizes to fit budget]
```

### Caching

- In-memory `Map` with injectable `now()` function for testability (defaults to `Date.now`)
- Cache key: `techStack + "|" + repoDir + "|" + role`
- 60-second TTL
- Exposed `clearStandardsCache()` for tests

```typescript
type CacheEntry = { value: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();
let _now = () => Date.now();

export function _setNow(fn: () => number): void { _now = fn; }
export function clearStandardsCache(): void { cache.clear(); }
```

### Error handling and observability

Top-level try/catch wrapping the entire function body. Returns `""` on any error — never throws into `claimStep`.

**Structured logging** (not silent):

| Condition | Log level | Message |
|-----------|-----------|---------|
| Standards directory not found | (none) | Expected case for repos without standards |
| Files matched and loaded | `logger.info` | `"Standards loaded"` with `{ tags, totalBytes, source: "tech_stack" \| "marker_fallback" }` |
| File read error (single file) | `logger.warn` | `"Failed to read standards file"` with `{ file, error }` — continues with other files |
| Total budget exceeded | `logger.info` | `"Standards truncated"` with `{ loaded, skipped }` |
| Top-level catch (unexpected) | `logger.error` | `"Standards loading failed"` with `{ error }` — returns `""` |

## 2. Injection in `step-ops.ts`

### Context write invariant

There are exactly four `UPDATE runs SET context` statements in `step-ops.ts`. The `coding_standards` key must never appear in any of them:

| Line | Function | Action required |
|------|----------|-----------------|
| 650 | `claimStep` (loop branch) | **Strip** `coding_standards` via destructuring before write |
| 719 | `completeStep` | No action — reads context fresh from DB, `coding_standards` was never persisted |
| 839 | `handleVerifyEachCompletion` (retry) | No action — reads context fresh from DB |
| 849 | `handleVerifyEachCompletion` (pass) | No action — reads context fresh from DB |

Only line 650 requires modification. Lines 719, 839, 849 are safe because they read context from DB (where `coding_standards` was never written).

### Single injection point at ~line 547

After `has_frontend_changes` injection, before any branch (loop or single). The agent role is derived from the `agent_id` stored on the step:

```typescript
// Inject coding standards from target repo
const agentRole = resolveAgentRole(step.agent_id);
context["coding_standards"] = context["repo"]
  ? loadStandards(context["tech_stack"] ?? "", context["repo"], agentRole)
  : "";

// Warn if standards dir exists but no tech_stack detected and fallback found nothing
if (context["coding_standards"] === "" && context["repo"]) {
  try {
    if (fs.existsSync(path.join(context["repo"], "agent-os", "standards"))) {
      logger.warn("Standards directory exists but no standards matched", {
        runId: step.run_id,
        hasTechStack: !!context["tech_stack"],
      });
    }
  } catch { /* best-effort warning */ }
}
```

`resolveAgentRole` extracts the role from the workflow spec or defaults to `"coding"`. This can be a simple lookup: the `agent_id` format is `<workflow>_<agent>`, and the workflow's agent list in the YAML defines roles. However, at claim time we don't have the workflow spec loaded — so instead, pass the budget directly. The role-to-budget mapping lives in `standards.ts`, and `step-ops.ts` passes a hint:

Simpler approach — the step template itself determines the framing (coding/verify/review). The budget can be inferred from which framing the template uses. But that requires parsing the template. Simplest: always pass `"coding"` as default. Steps that need a smaller budget (verify, review) will naturally have shorter templates with less room. The 8KB cap for coding is still modest.

**Decision:** Single budget of 8KB for all roles. Avoids complexity of role detection. If token pressure becomes a real problem, add role-specific budgets later.

### Strip from DB write in loop path (~line 650)

```typescript
// Original line 650:
// db.prepare("UPDATE runs SET context = ?, ...").run(JSON.stringify(context), step.run_id);

// Replacement:
const { coding_standards: _, ...contextForDb } = context;
db.prepare("UPDATE runs SET context = ?, updated_at = datetime('now') WHERE id = ?")
  .run(JSON.stringify(contextForDb), step.run_id);
```

### Why this works in every code path

| Path | findMissingTemplateKeys | DB write | resolveTemplate |
|------|------------------------|----------|-----------------|
| Loop step (line 643→650→652) | Line 643: sees `coding_standards` | Line 650: stripped via destructuring | Line 652: sees `coding_standards` |
| Single step (line 672→678) | Line 672: sees `coding_standards` | No DB write in this path | Line 678: sees `coding_standards` |
| Loop early returns (lines 552-598) | Not reached — returns `{ found: false }` before any template resolution | N/A | N/A |

### Why other context writes are unaffected

`completeStep` (line 709), `handleVerifyEachCompletion` (lines 839, 849) all read context fresh from DB via `SELECT context FROM runs`. Since `coding_standards` was stripped before the only `claimStep` DB write, it never enters persisted state. These functions merge agent output keys and write back — no stale standards accumulate.

## 3. Workflow Template Changes

### First step — add TECH_STACK detection

Add to plan/triage/scan step instructions and output format in all three workflows:

**Instruction line:**
```
N. Detect the project's tech stack (languages, frameworks, runtimes)
```

**Output format line:**
```
TECH_STACK: comma-separated tags (e.g., typescript, react, node)
```

### Steps that receive `{{coding_standards}}`

| Workflow         | Step      | Agent     | Framing                                              |
|------------------|-----------|-----------|------------------------------------------------------|
| feature-dev      | implement | developer | `CODING STANDARDS (follow these when writing code):`  |
| feature-dev      | verify    | verifier  | `CODING STANDARDS (verify the code follows these):`   |
| feature-dev      | review    | reviewer  | `CODING STANDARDS (evaluate the PR against these):`   |
| bug-fix          | fix       | fixer     | `CODING STANDARDS (follow these when writing code):`  |
| bug-fix          | verify    | verifier  | `CODING STANDARDS (verify the code follows these):`   |
| security-audit   | fix       | fixer     | `CODING STANDARDS (follow these when writing code):`  |
| security-audit   | verify    | verifier  | `CODING STANDARDS (verify the code follows these):`   |

### Template placement

Insert after build/test context but before the main instructions block:

```yaml
    input: |
      ...
      BUILD_CMD: {{build_cmd}}
      TEST_CMD: {{test_cmd}}

      CODING STANDARDS (follow these when writing code):
      {{coding_standards}}

      Instructions:
      ...
```

## 4. Standards File Reference

See `agent-os/standards/TAGS.md` for the canonical tag list, naming conventions, matching behavior, and known limitations.

Key points:
- Files live at `<target-repo>/agent-os/standards/<tag>.md`
- No auto-include files — every file matches on its own merit
- Filename convention: lowercase, no dots/hyphens/spaces (`nextjs`, `postgres`, `reactnative`)
- `TAGS.md` is excluded from matching

## 5. Tests — `tests/standards.test.ts`

### Conventions (matching this repo)

- Framework: `node:test` (`describe`, `it`, `beforeEach`, `afterEach`) + `node:assert/strict`
- Location: `tests/standards.test.ts` (matches existing `tests/*.test.ts` convention)
- Imports: from `../dist/lib/standards.js` (build-first, compiled output)
- Filesystem fixtures: `fs.mkdtempSync` + `fs.rmSync` in `afterEach`
- No external test dependencies — Node.js built-ins only

### Build and run

```bash
npm run build && node --test tests/standards.test.ts
```

No `npm test` script exists in this repo. Tests are run directly via `node --test`.

### Test cases

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | Pass 1: word-boundary match | `"TypeScript"`, has `typescript.md` | Returns content |
| 2 | Pass 2: compound tag match | `"Next.js"`, has `nextjs.md` | Returns content |
| 3 | Pass 2: multi-word compound | `"React Native"`, has `reactnative.md` | Returns content |
| 4 | Short tag: no false positive | `"frustrating API"`, has `rust.md` | Returns `""` |
| 5 | Short tag: correct match | `"Rust with cargo"`, has `rust.md` | Returns content |
| 6 | Word boundary: go vs django | `"Django REST"`, has `go.md` + `django.md` | Only `django.md` content |
| 7 | Alias: "Node.js" matches `nodejs.md` | `"Node.js backend"`, has `nodejs.md` | Returns content |
| 8 | Alias: "C#" matches `csharp.md` | `"C# with .NET"`, has `csharp.md` + `dotnet.md` | Both files |
| 9 | Alias: "PostgreSQL" matches `postgres.md` | `"PostgreSQL 16"`, has `postgres.md` | Returns content |
| 10 | Multiple matches | `"TypeScript, React, Node.js"` | All three files concatenated |
| 11 | No matching files | `"COBOL"` | `""` |
| 12 | Missing directory | nonexistent repo path | `""` |
| 13 | Empty tech_stack | `""` | `""` |
| 14 | Per-file line-boundary truncation | 6KB file | Last complete line under 4KB + marker |
| 15 | Total truncation at 8KB | Three 4KB files | First two + truncation note listing third |
| 16 | TAGS.md excluded | dir has only `TAGS.md` | `""` |
| 17 | Node vs nodemon (word boundary) | `"nodemon"`, has `node.md` | `""` |
| 18 | Deterministic ordering | `"TypeScript, React"`, has both | Alphabetical: `react.md` before `typescript.md` |
| 19 | Special chars in content safe | `$1`, `\n`, `{{foo}}` in file | Returned literally |
| 20 | Fallback: marker detection | empty techStack, repo has `tsconfig.json` + `typescript.md` | Returns typescript standards |
| 21 | Fallback: no markers, no match | empty techStack, repo has no markers | `""` |
| 22 | Cache hit within TTL | Call twice (inject clock), modify file between | Second returns cached |
| 23 | Cache miss after TTL | Call, advance clock past 60s, call again | Returns fresh content |
| 24 | `clearStandardsCache` resets | Call, clear, call again | Second reads from disk |
| 25 | Error resilience: unreadable file | write file then make unreadable via rename-to-dir trick | `""` for that file, other files still loaded |
| 26 | Integration: claimStep with missing TECH_STACK + existing standards dir | Mock DB with run context lacking `tech_stack`, standards dir exists | `coding_standards` is `""`, logger.warn emitted |

**Notes on test practicality:**

- **TTL tests (#22, #23):** Use `_setNow()` to inject a fake clock. No real `setTimeout` or sleep.
- **Error resilience (#25):** Windows has no `chmod 000`. Instead, create a directory with the same name as the expected file (reading a directory as a file throws `EISDIR`). Or write to a path, then rename parent to make the path invalid.
- **Determinism (#18):** Verifies alphabetical sort. Same inputs always produce same output regardless of filesystem iteration order.
- **Integration (#26):** Uses real `getDb()` with test run inserted into DB, same pattern as `tests/frontend-context.test.ts`. Cleanup in `afterEach`.

## 6. File Changes Summary

| File | Change | Description |
|------|--------|-------------|
| `src/lib/standards.ts` | **New** | Loader: alias map, two-pass match, line truncation, 8KB budget, 60s cache, injectable clock, structured logging |
| `src/installer/step-ops.ts` | **Modify** | Import `loadStandards`; inject at ~line 547; destructure strip at ~line 650; `logger.warn` for no-match with existing dir |
| `workflows/feature-dev/workflow.yml` | **Modify** | `TECH_STACK` in plan output; `{{coding_standards}}` in implement, verify, review |
| `workflows/bug-fix/workflow.yml` | **Modify** | `TECH_STACK` in triage output; `{{coding_standards}}` in fix, verify |
| `workflows/security-audit/workflow.yml` | **Modify** | `TECH_STACK` in scan output; `{{coding_standards}}` in fix, verify |
| `agent-os/standards/TAGS.md` | **Done** | Canonical tag reference (update to reflect aliases and fallback) |
| `tests/standards.test.ts` | **New** | 26 test cases matching repo conventions |

## 7. Implementation Sequence

### Phase 1: Foundation
1. Create `src/lib/standards.ts` with full implementation (aliases, two-pass, fallback, cache, logging)
2. Build: `npm run build`
3. Create `tests/standards.test.ts` with all 26 test cases
4. Run: `node --test tests/standards.test.ts`
5. Verify all pass

### Phase 2: Wiring
6. Add import to `src/installer/step-ops.ts`: `import { loadStandards } from "../lib/standards.js"`
7. Add injection at ~line 547 (after `has_frontend_changes`)
8. Modify DB write at ~line 650 (destructure strip `coding_standards`)
9. Add `logger.warn` block for missing-match-with-existing-dir
10. Build: `npm run build`
11. Run existing tests to verify no regressions: `node --test tests/*.test.ts`

### Phase 3: Templates
12. Update `workflows/feature-dev/workflow.yml` (plan output + implement/verify/review templates)
13. Update `workflows/bug-fix/workflow.yml` (triage output + fix/verify templates)
14. Update `workflows/security-audit/workflow.yml` (scan output + fix/verify templates)
15. Build and run all tests: `npm run build && node --test tests/*.test.ts`

### Phase 4: TAGS.md update
16. Update `agent-os/standards/TAGS.md` to reflect alias map and fallback detection
