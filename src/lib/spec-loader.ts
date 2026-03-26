// Responsibility: Load and concatenate all .md files from a spec directory for injection into run context.
// Exported interface (ASCII):
// loadSpec(specPath)
// └─ reads .md files from specPath, concatenates with headers, returns combined string
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const MAX_PER_FILE_CHARS = 8192;   // 8KB per file
const MAX_TOTAL_CHARS    = 32_768; // 32KB total budget

function readAndTruncate(filePath: string, fileName: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8").trimEnd();
    if (!content.trim()) return null;
    if (content.length <= MAX_PER_FILE_CHARS) return content;

    // Line-boundary truncation
    const lines = content.split("\n");
    const kept: string[] = [];
    let total = 0;
    for (const line of lines) {
      const lineLen = line.length + 1;
      if (total + lineLen > MAX_PER_FILE_CHARS) {
        // If no lines kept yet, include a char-truncated portion of the first line
        if (kept.length === 0) {
          kept.push(line.slice(0, MAX_PER_FILE_CHARS - 100));
        }
        break;
      }
      kept.push(line);
      total += lineLen;
    }
    return kept.join("\n") + `\n[...spec file truncated — keep ${fileName} under 8KB]`;
  } catch (err) {
    logger.warn(`Failed to read spec file: ${filePath} — ${String(err)}`);
    return null;
  }
}

/**
 * Load all .md files from a spec directory, concatenate with file headers.
 * Throws if the directory does not exist (caller-facing error).
 * Returns "" if the directory is empty or contains no readable .md files.
 */
export function loadSpec(specPath: string): string {
  const resolved = path.resolve(specPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Spec directory not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Spec path is not a directory: ${resolved}`);
  }

  const files = fs.readdirSync(resolved)
    .filter(f => f.endsWith(".md"))
    .sort();

  if (files.length === 0) return "";

  const blocks: string[] = [];
  const loadedFiles: string[] = [];
  const skippedFiles: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    const filePath = path.join(resolved, file);
    const content = readAndTruncate(filePath, file);
    if (!content) continue;

    const block = `--- ${file} ---\n\n${content}`;
    if (totalChars + block.length > MAX_TOTAL_CHARS) {
      skippedFiles.push(file);
      continue;
    }

    blocks.push(block);
    loadedFiles.push(file);
    totalChars += block.length;
  }

  if (blocks.length === 0) return "";

  let result = blocks.join("\n\n");

  if (skippedFiles.length > 0) {
    result += `\n\n[...additional spec files skipped: ${skippedFiles.join(", ")} — reduce file sizes to fit budget]`;
    logger.warn(`Spec truncated — loaded: [${loadedFiles.join(", ")}], skipped: [${skippedFiles.join(", ")}]`);
  }

  logger.info(`Spec loaded — ${loadedFiles.length} file(s), ${totalChars} bytes`);

  return result;
}
