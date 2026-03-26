import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadStandards, clearStandardsCache, _setNow } from "../dist/lib/standards.js";

let tmpDir: string;

function setupStandards(files: Record<string, string>): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-std-test-"));
  const stdDir = path.join(repoDir, "agent-os", "standards");
  fs.mkdirSync(stdDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(stdDir, name), content);
  }
  return repoDir;
}

describe("loadStandards", () => {
  beforeEach(() => {
    clearStandardsCache();
    _setNow(() => Date.now());
  });

  afterEach(() => {
    _setNow(() => Date.now());
    try {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { /* best-effort cleanup */ }
    tmpDir = "";
  });

  // ── Pass 1: word-boundary matching ────────────────────────────────

  it("matches tag via word boundary (pass 1)", () => {
    tmpDir = setupStandards({ "typescript.md": "Use strict mode" });
    const result = loadStandards("TypeScript", tmpDir);
    assert.equal(result, "Use strict mode");
  });

  it("matches short tag via word boundary", () => {
    tmpDir = setupStandards({ "rust.md": "Use cargo" });
    const result = loadStandards("Rust with cargo", tmpDir);
    assert.equal(result, "Use cargo");
  });

  it("short tag does not false-positive via pass 2", () => {
    tmpDir = setupStandards({ "rust.md": "Use cargo" });
    const result = loadStandards("frustrating API", tmpDir);
    assert.equal(result, "");
  });

  it("word boundary: go does not match django", () => {
    tmpDir = setupStandards({ "go.md": "Go rules", "django.md": "Django rules" });
    const result = loadStandards("Django REST", tmpDir);
    assert.ok(result.includes("Django rules"));
    assert.ok(!result.includes("Go rules"));
  });

  it("word boundary: node does not match nodemon", () => {
    tmpDir = setupStandards({ "node.md": "Node rules" });
    const result = loadStandards("nodemon", tmpDir);
    assert.equal(result, "");
  });

  // ── Pass 2: substring matching (>= 5 chars) ──────────────────────

  it("matches compound tag via pass 2 (Next.js → nextjs)", () => {
    tmpDir = setupStandards({ "nextjs.md": "Next rules" });
    const result = loadStandards("Next.js", tmpDir);
    assert.equal(result, "Next rules");
  });

  it("matches multi-word compound via pass 2 (React Native → reactnative)", () => {
    tmpDir = setupStandards({ "reactnative.md": "RN rules" });
    const result = loadStandards("React Native", tmpDir);
    assert.equal(result, "RN rules");
  });

  // ── Alias normalization ───────────────────────────────────────────

  it("alias: Node.js matches nodejs.md", () => {
    tmpDir = setupStandards({ "nodejs.md": "Node rules" });
    const result = loadStandards("Node.js backend", tmpDir);
    assert.equal(result, "Node rules");
  });

  it("alias: C# matches csharp.md", () => {
    tmpDir = setupStandards({ "csharp.md": "C# rules", "dotnet.md": "NET rules" });
    const result = loadStandards("C# with .NET", tmpDir);
    assert.ok(result.includes("C# rules"));
    assert.ok(result.includes("NET rules"));
  });

  it("alias: PostgreSQL matches postgres.md", () => {
    tmpDir = setupStandards({ "postgres.md": "PG rules" });
    const result = loadStandards("PostgreSQL 16", tmpDir);
    assert.equal(result, "PG rules");
  });

  it("alias: ts expands to typescript", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules" });
    const result = loadStandards("ts, react", tmpDir);
    assert.ok(result.includes("TS rules"));
  });

  it("alias: js expands to javascript", () => {
    tmpDir = setupStandards({ "javascript.md": "JS rules" });
    const result = loadStandards("js", tmpDir);
    assert.equal(result, "JS rules");
  });

  // ── Multiple matches ──────────────────────────────────────────────

  it("loads multiple matching files with separator", () => {
    tmpDir = setupStandards({
      "typescript.md": "TS rules",
      "react.md": "React rules",
      "node.md": "Node rules",
    });
    const result = loadStandards("TypeScript, React, Node.js", tmpDir);
    assert.ok(result.includes("TS rules"));
    assert.ok(result.includes("React rules"));
    assert.ok(result.includes("Node rules"));
    // Verify separator between files
    assert.ok(result.includes("\n\n---\n\n"), "Files should be separated by ---");
    // Verify no duplication
    assert.equal(result.split("TS rules").length - 1, 1, "TS rules should appear exactly once");
    assert.equal(result.split("React rules").length - 1, 1, "React rules should appear exactly once");
  });

  // ── No match / missing / edge cases ───────────────────────────────

  it("returns empty for no matching files", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules" });
    const result = loadStandards("COBOL", tmpDir);
    assert.equal(result, "");
  });

  it("returns empty for missing directory", () => {
    const fakePath = path.join(os.tmpdir(), "antfarm-nonexistent-" + Date.now());
    const result = loadStandards("TypeScript", fakePath);
    assert.equal(result, "");
  });

  it("returns empty for empty techStack (no markers)", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules" });
    const result = loadStandards("", tmpDir);
    assert.equal(result, "");
  });

  it("returns empty for empty repoDir", () => {
    const result = loadStandards("TypeScript", "");
    assert.equal(result, "");
  });

  it("returns empty when directory has only TAGS.md", () => {
    tmpDir = setupStandards({ "TAGS.md": "Tag reference only" });
    const result = loadStandards("TypeScript", tmpDir);
    assert.equal(result, "");
  });

  it("skips empty and whitespace-only files", () => {
    tmpDir = setupStandards({
      "typescript.md": "   \n  \n  ",
      "react.md": "React rules",
    });
    const result = loadStandards("TypeScript, React", tmpDir);
    // Empty file should be skipped, react should load
    assert.equal(result, "React rules");
  });

  // ── Truncation ────────────────────────────────────────────────────

  it("truncates at line boundary when file exceeds 4KB", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- Rule ${i}: ${"x".repeat(40)}`);
    const bigContent = lines.join("\n"); // ~9KB
    tmpDir = setupStandards({ "typescript.md": bigContent });
    const result = loadStandards("TypeScript", tmpDir);
    assert.ok(result.length <= 4096 + 100); // allow for truncation marker
    assert.ok(result.endsWith("[...standards truncated — keep typescript.md under 4KB]"));
    // Every line in the result (except the marker) should be complete
    const resultLines = result.split("\n");
    for (const line of resultLines.slice(0, -1)) {
      assert.ok(line.startsWith("- Rule "), `Line should be complete: ${line}`);
    }
  });

  it("skips files when total budget exceeded (8KB)", () => {
    const contentA = "aaa-content-" + "x".repeat(2988);  // 3000 chars
    const contentB = "bbb-content-" + "y".repeat(2988);  // 3000 chars
    const contentC = "ccc-content-" + "z".repeat(2988);  // 3000 chars
    tmpDir = setupStandards({
      "aaa.md": contentA,
      "bbb.md": contentB,
      "ccc.md": contentC,
    });
    // Tags are 3 chars — matched via pass 1 word-boundary regex (NOT pass 2 substring)
    const result = loadStandards("aaa bbb ccc", tmpDir);
    // Budget is 8192. aaa(3000) + bbb(3000) = 6000 fits. ccc(3000) would make 9000 > 8192, skipped.
    assert.ok(result.includes("aaa-content-"), "aaa.md should be loaded");
    assert.ok(result.includes("bbb-content-"), "bbb.md should be loaded");
    assert.ok(!result.includes("ccc-content-"), "ccc.md content should NOT be present");
    assert.ok(result.includes("[...additional standards skipped: ccc.md"), "ccc.md should be listed as skipped");
  });

  // ── TAGS.md excluded ──────────────────────────────────────────────

  it("excludes TAGS.md from matching", () => {
    tmpDir = setupStandards({ "TAGS.md": "This is the tag reference" });
    const result = loadStandards("TAGS", tmpDir);
    assert.equal(result, "");
  });

  // ── Deterministic ordering ────────────────────────────────────────

  it("returns files in alphabetical order", () => {
    tmpDir = setupStandards({
      "typescript.md": "TS_CONTENT",
      "react.md": "REACT_CONTENT",
    });
    const result = loadStandards("TypeScript, React", tmpDir);
    const reactPos = result.indexOf("REACT_CONTENT");
    const tsPos = result.indexOf("TS_CONTENT");
    assert.ok(reactPos < tsPos, "react.md should come before typescript.md alphabetically");
  });

  // ── Special characters in content ─────────────────────────────────

  it("returns special characters literally", () => {
    const content = "Use $1 for backrefs\nAvoid {{foo}} in templates\nBackslash: \\n";
    tmpDir = setupStandards({ "typescript.md": content });
    const result = loadStandards("TypeScript", tmpDir);
    assert.equal(result, content);
  });

  // ── Fallback: repo marker detection ───────────────────────────────

  it("detects tech stack from repo markers when techStack is empty", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules" });
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    const result = loadStandards("", tmpDir);
    assert.equal(result, "TS rules");
  });

  it("detects multiple markers", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules", "nextjs.md": "Next rules" });
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), "module.exports = {}");
    const result = loadStandards("", tmpDir);
    assert.ok(result.includes("TS rules"));
    assert.ok(result.includes("Next rules"));
  });

  it("returns empty when no markers and no techStack", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules" });
    const result = loadStandards("", tmpDir);
    assert.equal(result, "");
  });

  // ── Cache ─────────────────────────────────────────────────────────

  it("returns cached result within TTL", () => {
    let now = 1000000;
    _setNow(() => now);

    tmpDir = setupStandards({ "typescript.md": "TS rules v1" });
    const result1 = loadStandards("TypeScript", tmpDir);
    assert.equal(result1, "TS rules v1");

    // Modify file
    const stdDir = path.join(tmpDir, "agent-os", "standards");
    fs.writeFileSync(path.join(stdDir, "typescript.md"), "TS rules v2");

    // Still within TTL
    now += 30_000;
    const result2 = loadStandards("TypeScript", tmpDir);
    assert.equal(result2, "TS rules v1"); // cached
  });

  it("refreshes after TTL expires", () => {
    let now = 1000000;
    _setNow(() => now);

    tmpDir = setupStandards({ "typescript.md": "TS rules v1" });
    const result1 = loadStandards("TypeScript", tmpDir);
    assert.equal(result1, "TS rules v1");

    // Modify file
    const stdDir = path.join(tmpDir, "agent-os", "standards");
    fs.writeFileSync(path.join(stdDir, "typescript.md"), "TS rules v2");

    // Past TTL
    now += 61_000;
    const result2 = loadStandards("TypeScript", tmpDir);
    assert.equal(result2, "TS rules v2"); // fresh
  });

  it("clearStandardsCache forces fresh read", () => {
    tmpDir = setupStandards({ "typescript.md": "TS rules v1" });
    const result1 = loadStandards("TypeScript", tmpDir);
    assert.equal(result1, "TS rules v1");

    const stdDir = path.join(tmpDir, "agent-os", "standards");
    fs.writeFileSync(path.join(stdDir, "typescript.md"), "TS rules v2");

    clearStandardsCache();
    const result2 = loadStandards("TypeScript", tmpDir);
    assert.equal(result2, "TS rules v2");
  });

  // ── Error resilience ──────────────────────────────────────────────

  it("handles unreadable file gracefully (dir-as-file trick)", () => {
    tmpDir = setupStandards({ "react.md": "React rules" });
    const stdDir = path.join(tmpDir, "agent-os", "standards");
    // Create a directory where a .md file would be — reading it as file throws
    const badPath = path.join(stdDir, "broken.md");
    fs.mkdirSync(badPath, { recursive: true });

    const result = loadStandards("React, broken", tmpDir);
    // react.md should still load despite broken.md failing
    assert.ok(result.includes("React rules"));
  });
});
