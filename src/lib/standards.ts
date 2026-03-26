// Responsibility: Load coding standards from <repo>/agent-os/standards/*.md filtered by tech stack.
// Exported interface (ASCII):
// loadStandards(techStack, repoDir)
// └─ returns concatenated standards content filtered by two-pass tag matching
// clearStandardsCache()
// └─ clears the in-memory cache (for tests)
// _setNow(fn)
// └─ injects a fake clock (for tests)
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

// ── Canonical alias map ─────────────────────────────────────────────
// Applied case-insensitively to TECH_STACK before matching.
// Expands the search surface — originals are preserved alongside.
const ALIASES: [RegExp, string][] = [
  [/\bnode\.js\b/gi,       "nodejs"],
  [/\bnext\.js\b/gi,       "nextjs"],
  [/\bvue\.js\b/gi,        "vuejs"],
  [/\bnuxt\.js\b/gi,       "nuxtjs"],
  [/\bexpress\.js\b/gi,    "expressjs"],
  [/\breact[\s\-_]native\b/gi, "reactnative"],
  [/\bc#/gi,               "csharp"],
  [/(?<=^|[\s,;])\.net\b/gi, "dotnet"],
  [/\basp\.net\b/gi,       "aspnet"],
  [/\bpostgresql\b/gi,     "postgres"],
  [/\bpostgre\b/gi,        "postgres"],
  [/\bts\b/gi,             "typescript"],
  [/\bjs\b/gi,             "javascript"],
  [/\bpy\b/gi,             "python"],
  [/\brb\b/gi,             "ruby"],
];

// ── Repo marker fallback ────────────────────────────────────────────
// When TECH_STACK is empty or produces no matches, detect from well-known files.
const MARKER_MAP: Record<string, string> = {
  "tsconfig.json":    "typescript",
  "pyproject.toml":   "python",
  "requirements.txt": "python",
  "Cargo.toml":       "rust",
  "go.mod":           "go",
  "Gemfile":          "ruby",
  "composer.json":    "php",
  "pom.xml":          "java",
  "build.gradle":     "java",
  "next.config.js":   "nextjs",
  "next.config.ts":   "nextjs",
  "next.config.mjs":  "nextjs",
  "nuxt.config.ts":   "nuxt",
  "vue.config.js":    "vue",
  "angular.json":     "angular",
  "svelte.config.js": "svelte",
  "package.json":     "javascript",  // last — most generic
};

// ── Constants ────────────────────────────────────────────────────────
const MAX_PER_FILE_CHARS = 4096;   // 4KB per file
const MAX_TOTAL_CHARS    = 8192;   // 8KB total budget
const CACHE_TTL_MS       = 60_000; // 60 seconds
const EXCLUDED_FILES     = new Set(["tags.md"]);

// ── Cache ────────────────────────────────────────────────────────────
type CacheEntry = { value: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();
let _now = () => Date.now();

export function _setNow(fn: () => number): void { _now = fn; }
export function clearStandardsCache(): void { cache.clear(); }

// ── Normalization ────────────────────────────────────────────────────

function applyAliases(text: string): string {
  let result = text;
  for (const [pattern, replacement] of ALIASES) {
    result = result.replace(pattern, (match) => `${match} ${replacement}`);
  }
  return result;
}

/** Pass 1 normalization: dots/hyphens/underscores → spaces, lowercase. */
function normalizeForWordBoundary(text: string): string {
  return applyAliases(text).replace(/[.\-_]/g, " ").toLowerCase();
}

/** Pass 2 normalization: strip all non-alphanumeric, lowercase. */
function stripForSubstring(text: string): string {
  return applyAliases(text).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

// ── Matching ─────────────────────────────────────────────────────────

function tagMatches(tag: string, normalizedText: string, strippedText: string): boolean {
  // Pass 1: word-boundary regex (all tags)
  try {
    const re = new RegExp(`\\b${escapeRegex(tag)}\\b`, "i");
    if (re.test(normalizedText)) return true;
  } catch {
    // Invalid regex from tag name — skip pass 1
  }

  // Pass 2: substring match (tags >= 5 chars only)
  if (tag.length >= 5 && strippedText.includes(tag)) {
    return true;
  }

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Fallback detection ───────────────────────────────────────────────

function detectFromMarkers(repoDir: string): string[] {
  const detected = new Set<string>();
  for (const [marker, tag] of Object.entries(MARKER_MAP)) {
    try {
      if (fs.existsSync(path.join(repoDir, marker))) {
        detected.add(tag);
      }
    } catch {
      // best-effort
    }
  }
  return [...detected];
}

// ── File reading ─────────────────────────────────────────────────────

function readAndTruncate(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return null;
    if (content.length <= MAX_PER_FILE_CHARS) return content;

    // Line-boundary truncation
    const lines = content.split("\n");
    const kept: string[] = [];
    let total = 0;
    for (const line of lines) {
      const lineLen = line.length + 1; // +1 for newline
      if (total + lineLen > MAX_PER_FILE_CHARS) break;
      kept.push(line);
      total += lineLen;
    }
    const tag = path.basename(filePath);
    return kept.join("\n") + `\n[...standards truncated — keep ${tag} under 4KB]`;
  } catch (err) {
    logger.warn(`Failed to read standards file: ${filePath} — ${String(err)}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

export function loadStandards(techStack: string, repoDir: string): string {
  try {
    if (!repoDir) return "";

    // Check cache
    const cacheKey = JSON.stringify([techStack, repoDir]);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > _now()) {
      return cached.value;
    }

    const standardsDir = path.join(repoDir, "agent-os", "standards");
    if (!fs.existsSync(standardsDir)) return "";

    // List available tag files
    const files = fs.readdirSync(standardsDir)
      .filter(f => f.endsWith(".md") && !EXCLUDED_FILES.has(f.toLowerCase()))
      .sort(); // alphabetical for deterministic ordering

    if (files.length === 0) return "";

    // Build search text
    let searchStack = techStack.trim();
    let source: "tech_stack" | "marker_fallback" = "tech_stack";

    // Fallback to repo markers if no tech_stack
    if (!searchStack) {
      const markerTags = detectFromMarkers(repoDir);
      if (markerTags.length === 0) return cacheAndReturn(cacheKey, "");
      searchStack = markerTags.join(", ");
      source = "marker_fallback";
    }

    const normalizedText = normalizeForWordBoundary(searchStack);
    const strippedText = stripForSubstring(searchStack);

    // Match files
    const matched: string[] = [];
    const matchedTags: string[] = [];
    const skippedTags: string[] = [];
    let totalChars = 0;

    for (const file of files) {
      const tag = file.replace(/\.md$/, "").toLowerCase();
      if (!tagMatches(tag, normalizedText, strippedText)) continue;

      const filePath = path.join(standardsDir, file);
      const content = readAndTruncate(filePath);
      if (!content) continue;

      if (totalChars + content.length > MAX_TOTAL_CHARS) {
        skippedTags.push(file);
        continue;
      }

      matched.push(content);
      matchedTags.push(tag);
      totalChars += content.length;
    }

    if (matched.length === 0) return cacheAndReturn(cacheKey, "");

    let result = matched.join("\n\n---\n\n");

    if (skippedTags.length > 0) {
      result += `\n\n[...additional standards skipped: ${skippedTags.join(", ")} — reduce file sizes to fit budget]`;
      logger.info(`Standards truncated — loaded: [${matchedTags.join(", ")}], skipped: [${skippedTags.join(", ")}]`);
    }

    logger.info(`Standards loaded (${source}) — tags: [${matchedTags.join(", ")}], ${totalChars} bytes`);

    return cacheAndReturn(cacheKey, result);
  } catch (err) {
    logger.error(`Standards loading failed: ${String(err)}`);
    return "";
  }
}

function cacheAndReturn(key: string, value: string): string {
  cache.set(key, { value, expiresAt: _now() + CACHE_TTL_MS });
  return value;
}
