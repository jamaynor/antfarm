# Coding Standards Tag Reference

This file defines the canonical tags used to match standards files to detected tech stacks.
It serves as both a user guide and a reference for the matching logic in `src/lib/standards.ts`.

## How Matching Works

1. The first workflow step (planner/triager/scanner) outputs `TECH_STACK: <free text>`
2. At claim time, each `.md` file in this directory (except this file) is checked against the TECH_STACK string
3. Matching uses **alias normalization + two-pass** to handle short tags, compound names, and common variations

### Alias Normalization (applied first)

Before matching, known aliases in the TECH_STACK string are expanded. The original text is preserved alongside — aliases add to the search surface.

| Input | Expanded to |
|-------|-------------|
| `Node.js` | `Node.js nodejs` |
| `Next.js` | `Next.js nextjs` |
| `Vue.js` | `Vue.js vuejs` |
| `Nuxt.js` | `Nuxt.js nuxtjs` |
| `Express.js` | `Express.js expressjs` |
| `React Native` | `React Native reactnative` |
| `C#` | `C# csharp` |
| `.NET` | `.NET dotnet` |
| `ASP.NET` | `ASP.NET aspnet` |
| `PostgreSQL` | `PostgreSQL postgres` |

### Pass 1 — Word-boundary regex (all tags)

The expanded TECH_STACK string is normalized: dots, hyphens, and underscores are replaced with spaces, then lowercased. Each tag is tested as `\b<tag>\b` (case-insensitive).

Examples:
- `go` matches "Go" but NOT "django" or "mongo"
- `react` matches "React" but NOT "react-native" as a single token
- `node` matches "Node.js" (alias expands to include "nodejs", normalized to "node js") but NOT "nodemon"

### Pass 2 — Substring match (tags with 5+ characters only)

The expanded TECH_STACK string is fully stripped: all non-alphanumeric characters removed, then lowercased. Each tag (5+ chars) is checked as a substring.

This catches compound names:
- `nextjs` matches "Next.js" (alias expands to "nextjs", stripped matches)
- `reactnative` matches "React Native" (alias expands to "reactnative")

Short tags (< 5 chars) are excluded from pass 2 to prevent false positives like `rust` matching "frustrating".

### Fallback Detection

When `TECH_STACK` is empty or missing, the system detects the stack from well-known files in the repo root:

| File | Detected tag |
|------|-------------|
| `tsconfig.json` | `typescript` |
| `pyproject.toml`, `requirements.txt` | `python` |
| `Cargo.toml` | `rust` |
| `go.mod` | `go` |
| `Gemfile` | `ruby` |
| `composer.json` | `php` |
| `pom.xml`, `build.gradle` | `java` |
| `next.config.js/ts/mjs` | `nextjs` |
| `nuxt.config.ts` | `nuxt` |
| `vue.config.js` | `vue` |
| `angular.json` | `angular` |
| `svelte.config.js` | `svelte` |
| `package.json` | `javascript` |

Marker detection is best-effort — it supplements agent detection, not replaces it.

### Combined result

A tag matches if **either** pass succeeds (after alias expansion). All matching files are sorted alphabetically, concatenated with `---` separators, and injected as `{{coding_standards}}`.

## Naming Convention

- **Lowercase, no dots, no hyphens, no spaces**: `nextjs` not `Next.js` or `next-js`
- **Common shorthand**: use the name developers type daily, not the formal brand name
- **One file per tag**: each `.md` file is self-contained

## Canonical Tags

### Languages

| Tag          | Filename         | Matches (examples)                                       |
|--------------|------------------|----------------------------------------------------------|
| `typescript` | `typescript.md`  | "TypeScript", "typescript", "TS project"                 |
| `javascript` | `javascript.md`  | "JavaScript", "javascript", "vanilla JS"                 |
| `python`     | `python.md`      | "Python", "python 3.12"                                  |
| `go`         | `go.md`          | "Go", "go 1.22" (NOT "django", "mongo")                  |
| `rust`       | `rust.md`        | "Rust", "rust with cargo" (NOT "frustrating")             |
| `csharp`     | `csharp.md`      | "C#" (via alias), "csharp"                               |
| `ruby`       | `ruby.md`        | "Ruby", "ruby on rails"                                  |
| `php`        | `php.md`         | "PHP", "php 8.3"                                         |
| `swift`      | `swift.md`       | "Swift", "SwiftUI"                                       |
| `kotlin`     | `kotlin.md`      | "Kotlin", "kotlin multiplatform"                         |

### Frontend Frameworks

| Tag            | Filename           | Matches                                                    |
|----------------|--------------------|------------------------------------------------------------|
| `react`        | `react.md`         | "React", "react 19" (pass 1 word boundary)                 |
| `reactnative`  | `reactnative.md`   | "React Native" (via alias), "react-native"                 |
| `nextjs`       | `nextjs.md`        | "Next.js" (via alias), "NextJS"                            |
| `vue`          | `vue.md`           | "Vue", "Vue.js" (pass 1: "vue js" has word boundary)       |
| `nuxt`         | `nuxt.md`          | "Nuxt", "Nuxt.js" (pass 1 word boundary)                  |
| `angular`      | `angular.md`       | "Angular", "angular 18"                                    |
| `svelte`       | `svelte.md`        | "Svelte", "SvelteKit"                                      |

### Backend Frameworks

| Tag          | Filename         | Matches                                                    |
|--------------|------------------|------------------------------------------------------------|
| `express`    | `express.md`     | "Express", "Express.js" (via alias)                        |
| `fastify`    | `fastify.md`     | "Fastify", "fastify server"                                |
| `django`     | `django.md`      | "Django", "django REST"                                    |
| `flask`      | `flask.md`       | "Flask", "flask API"                                       |
| `rails`      | `rails.md`       | "Rails", "ruby on rails"                                   |
| `spring`     | `spring.md`      | "Spring", "Spring Boot"                                    |
| `dotnet`     | `dotnet.md`      | ".NET" (via alias), "dotnet", "ASP.NET"                    |

### Runtimes & Platforms

| Tag        | Filename       | Matches                                                      |
|------------|----------------|--------------------------------------------------------------|
| `node`     | `node.md`      | "Node", "Node.js" (via alias) (NOT "nodemon")                |
| `nodejs`   | `nodejs.md`    | "Node.js" (via alias), "nodejs"                              |
| `deno`     | `deno.md`      | "Deno", "deno 2"                                             |
| `bun`      | `bun.md`       | "Bun", "bun runtime"                                        |
| `docker`   | `docker.md`    | "Docker", "dockerfile"                                       |

### Databases

| Tag          | Filename         | Matches                                                    |
|--------------|------------------|------------------------------------------------------------|
| `postgres`   | `postgres.md`   | "PostgreSQL" (via alias), "Postgres" (pass 1 word boundary) |
| `mongodb`    | `mongodb.md`    | "MongoDB" (pass 2 substring)                               |
| `redis`      | `redis.md`      | "Redis", "redis cache"                                     |
| `sqlite`     | `sqlite.md`     | "SQLite", "sqlite3" (pass 2 substring)                     |

## Adding a New Tag

1. Create `<tag>.md` in this directory
2. Use the naming convention: lowercase, no dots/hyphens/spaces
3. Add the tag to the table above
4. Keep the file under 4KB — the system truncates at line boundaries beyond this
5. Total injected standards are capped at 8KB across all matched files
6. If your tag involves a common alias (e.g., "Vue.js" → "vuejs"), add it to the ALIASES map in `src/lib/standards.ts`
7. Files excluded from matching: `TAGS.md` (this file)

## Budget and Truncation

- **Per-file limit:** 4KB. Truncated at the last complete line under the limit.
- **Total budget:** 8KB across all matched files. Files that exceed the remaining budget are listed but not included.
- **File ordering:** Alphabetical by filename. Deterministic — same inputs always produce the same output.
- **Truncation markers:** Appended to truncated files and to the overall output when files are skipped.
