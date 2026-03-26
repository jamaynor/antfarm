import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSpec } from "../dist/lib/spec-loader.js";

let tmpDirs: string[] = [];

function setupSpec(files: Record<string, string>): string {
  const specDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-spec-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(specDir, name), content);
  }
  tmpDirs.push(specDir);
  return specDir;
}

describe("loadSpec", () => {
  afterEach(() => {
    try {
      for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }
    tmpDirs = [];
  });

  // ── Basic loading ─────────────────────────────────────────────────

  it("loads all .md files from directory", () => {
    const specDir = setupSpec({
      "plan.md": "# Plan\nDo the thing.",
      "shape.md": "# Shape\nScope of the work.",
    });
    const result = loadSpec(specDir);
    assert.ok(result.includes("# Plan"));
    assert.ok(result.includes("Do the thing."));
    assert.ok(result.includes("# Shape"));
    assert.ok(result.includes("Scope of the work."));
  });

  it("sorts files alphabetically", () => {
    const specDir = setupSpec({
      "shape.md": "SHAPE_CONTENT",
      "plan.md": "PLAN_CONTENT",
      "references.md": "REF_CONTENT",
    });
    const result = loadSpec(specDir);
    const planPos = result.indexOf("PLAN_CONTENT");
    const refPos = result.indexOf("REF_CONTENT");
    const shapePos = result.indexOf("SHAPE_CONTENT");
    assert.ok(planPos < refPos, "plan.md should come before references.md");
    assert.ok(refPos < shapePos, "references.md should come before shape.md");
  });

  it("adds file headers", () => {
    const specDir = setupSpec({
      "plan.md": "Plan content",
      "shape.md": "Shape content",
    });
    const result = loadSpec(specDir);
    assert.ok(result.includes("--- plan.md ---"), "Should have plan.md header");
    assert.ok(result.includes("--- shape.md ---"), "Should have shape.md header");
  });

  it("ignores non-.md files", () => {
    const specDir = setupSpec({
      "plan.md": "Plan content",
      "notes.txt": "Text notes",
      "data.json": '{"key": "value"}',
    });
    const result = loadSpec(specDir);
    assert.ok(result.includes("Plan content"));
    assert.ok(!result.includes("Text notes"));
    assert.ok(!result.includes("key"));
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("returns empty string for empty directory", () => {
    const specDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-spec-empty-"));
    tmpDirs.push(specDir);
    const result = loadSpec(specDir);
    assert.equal(result, "");
  });

  it("throws on missing directory", () => {
    const fakePath = path.join(os.tmpdir(), "antfarm-spec-nonexistent-" + Date.now());
    assert.throws(
      () => loadSpec(fakePath),
      { message: /Spec directory not found/ },
    );
  });

  it("throws on file path (not directory)", () => {
    const tmpFile = path.join(os.tmpdir(), "antfarm-spec-file-" + Date.now() + ".md");
    fs.writeFileSync(tmpFile, "not a directory");
    tmpDirs.push(tmpFile); // cleanup via rmSync
    assert.throws(
      () => loadSpec(tmpFile),
      { message: /not a directory/ },
    );
  });

  it("skips empty and whitespace-only .md files", () => {
    const specDir = setupSpec({
      "empty.md": "",
      "whitespace.md": "   \n  \n  ",
      "real.md": "Real content",
    });
    const result = loadSpec(specDir);
    assert.ok(result.includes("Real content"));
    assert.ok(!result.includes("--- empty.md ---"));
    assert.ok(!result.includes("--- whitespace.md ---"));
  });

  // ── Truncation ────────────────────────────────────────────────────

  it("truncates per-file at 8KB on line boundary", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- Rule ${i}: ${"x".repeat(40)}`);
    const bigContent = lines.join("\n"); // ~18KB
    const specDir = setupSpec({ "shape.md": bigContent });
    const result = loadSpec(specDir);
    // Header + truncated content should be under 8KB + header + marker
    assert.ok(result.includes("[...spec file truncated — keep shape.md under 8KB]"));
    // Every line (except header and marker) should be complete
    const resultLines = result.split("\n");
    for (const line of resultLines) {
      if (line.startsWith("- Rule ")) {
        assert.ok(line.includes("x"), `Line should be complete: ${line.slice(0, 50)}`);
      }
    }
  });

  it("enforces 32KB total and lists skipped files", () => {
    // Use multi-line content so line-boundary truncation doesn't collapse it
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"a".repeat(50)}`);
    const content7k = lines.join("\n"); // ~12KB, truncated to ~8KB per file
    const specDir = setupSpec({
      "aaa.md": content7k,
      "bbb.md": content7k,
      "ccc.md": content7k,
      "ddd.md": content7k,
      "eee.md": content7k,
    });
    const result = loadSpec(specDir);
    // Each block is ~8KB (per-file truncated). Budget is 32KB.
    // At least some files should be skipped
    assert.ok(result.includes("--- aaa.md ---"), "aaa.md should be loaded");
    assert.ok(result.includes("--- bbb.md ---"), "bbb.md should be loaded");
    assert.ok(result.includes("[...additional spec files skipped:"), "should list skipped files");
  });

  // ── Error resilience ──────────────────────────────────────────────

  it("skips unreadable file and continues", () => {
    const specDir = setupSpec({ "plan.md": "Plan content" });
    // Create a directory where a .md file would be — reading it as file throws
    fs.mkdirSync(path.join(specDir, "broken.md"), { recursive: true });
    const result = loadSpec(specDir);
    assert.ok(result.includes("Plan content"), "plan.md should still load");
  });

  // ── Relative path ─────────────────────────────────────────────────

  it("resolves relative path", () => {
    const specDir = setupSpec({ "plan.md": "Plan content" });
    // Create a relative path by making it relative to cwd
    const cwd = process.cwd();
    let relativePath: string;
    try {
      relativePath = path.relative(cwd, specDir);
    } catch {
      // If on different drive (Windows), relative won't work — skip test
      return;
    }
    if (path.isAbsolute(relativePath)) return; // can't make relative, skip
    const result = loadSpec(relativePath);
    assert.ok(result.includes("Plan content"));
  });
});
