# Plan v2: Spec Injection via `--spec` Flag

## Summary

Add `--spec <path>` to `antfarm workflow run`.

When provided, Antfarm loads `.md` files from the spec directory, concatenates them with file headers, and stores the result in run context as `spec`. Workflow templates can reference `{{spec}}`.

When not provided, Antfarm still sets `spec: ""` so templates using `{{spec}}` never fail missing-key validation.

## Why this design

- Spec is immutable input for a run, so load once at run creation.
- Persisting `spec` in `runs.context` keeps template resolution simple (no special claim-time hook).
- `coding_standards` remains claim-time computed and non-persistent (current behavior).
- Explicit `--spec` path failures are user-facing errors; do not silently swallow.

## Scope and Non-goals

### In scope

- New `--spec <path>` flag on `workflow run`
- New loader module for spec directory ingestion
- `runWorkflow` support for `specPath` and persisted `spec`
- Template updates for selected workflow steps
- Unit + integration tests

### Out of scope

- Loading non-Markdown files
- Live reloading spec during a run
- Backfilling older runs

## Architecture

```text
CLI: workflow run ... [--spec <path>] [--notify-url <url>]
   -> parse known flags in any order from run args
   -> runWorkflow({ workflowId, taskTitle, notifyUrl, specPath })

run.ts:
   -> initialContext = { task, ...workflow.context, spec: loadSpec(path) or "" }
   -> persist context to runs.context

step-ops.ts:
   -> unchanged template resolution path; {{spec}} behaves like any other key
```

## 1) New loader: `src/lib/spec-loader.ts`

### API

```ts
export function loadSpec(specPath: string): string
```

### Behavior

1. Resolve `specPath` to absolute path.
2. Validate directory exists.
   - If missing: throw `Error` with descriptive message.
3. Read only `.md` files from the directory (non-recursive), sorted alphabetically.
4. For each file:
   - Read UTF-8 text
   - Trim trailing whitespace
   - Per-file truncate at line boundary to 8KB
   - Prefix with header:
     - `--- <filename> ---`
5. Concatenate all file blocks.
6. Enforce total max 32KB:
   - Keep whole blocks while possible.
   - Append marker listing skipped files:
     - `[...additional spec files skipped: ...]`
7. Return final string.

### Error policy

- Missing directory: throw (hard fail).
- Per-file read failure: warn and skip file.
- Empty directory or no readable `.md`: return `""`.

### Logging

- Info log when spec loads successfully (file count, bytes).
- Warn log when truncation occurs (which files skipped).
- Warn log when file read fails.

## 2) CLI changes: `src/cli/cli.ts`

## Command shape

```bash
antfarm workflow run <workflow-id> <task...> [--spec <path>] [--notify-url <url>]
```

### Parsing rules (must be explicit)

- Parse `--spec` and `--notify-url` from run args in any order.
- Remaining tokens form `taskTitle`.
- If a flag is present without a value, exit with descriptive error.
- If a flag appears multiple times:
  - last value wins (documented behavior).
- Unknown flags remain part of `taskTitle` (preserves current loose parsing style).

### Precedence

- `notifyUrl` behavior stays unchanged versus workflow default.
- `specPath` is optional; absence must still set `spec: ""` downstream.

## 3) Run wiring: `src/installer/run.ts`

### Signature

```ts
export async function runWorkflow(params: {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  specPath?: string;
}): Promise<...>
```

### Context init

```ts
const initialContext: Record<string, string> = {
  task: params.taskTitle,
  ...workflow.context,
  spec: params.specPath ? loadSpec(params.specPath) : "",
};
```

### Failure behavior

- If `loadSpec` throws, abort run creation before DB insert (CLI exits non-zero with message).

## 4) Template updates

Add `SPEC` block to selected steps.

### Placement

Insert after task block and before repo/build context:

```yaml
SPEC:
{{spec}}
```

### Step selection

- `feature-dev`: `plan`, `implement`, `verify`, `review`
- `bug-fix`: `triage`, `investigate`, `fix`, `verify`
- `security-audit`: `scan`, `fix`, `verify`

### Empty spec behavior

`spec` is always defined in run context (`""` default), so `{{spec}}` never triggers missing-key failure.

## 5) Performance and storage notes

Persisting `spec` increases context size and therefore write size on each `runs.context` update.

Mitigations:

- Keep hard total cap (32KB).
- Keep concise truncation markers.
- Avoid adding other large persistent context keys in this change.

Future optimization (not in this change): split static run context into a separate table.

## 6) Tests

## Unit tests: `src/lib/spec-loader.test.ts`

1. Loads all `.md` files from directory.
2. Sorts files alphabetically.
3. Adds `--- filename ---` headers.
4. Ignores non-`.md` files.
5. Returns `""` for empty directory.
6. Throws on missing directory.
7. Truncates per-file at 8KB on line boundary.
8. Enforces 32KB total and lists skipped files.
9. Skips unreadable file and continues.
10. Resolves relative path correctly.

## Integration tests

### CLI parsing tests (`src/cli/cli.test.ts`)

11. `workflow run ... --spec <path>` passes `specPath` through.
12. `workflow run ... --notify-url ... --spec ...` works in both flag orders.
13. Missing `--spec` value errors clearly.
14. Repeated flags use last value.

### Run/context tests (`tests/spec-injection.test.ts`)

15. `runWorkflow` with `specPath` persists non-empty `context.spec`.
16. `runWorkflow` without `specPath` persists `context.spec === ""`.
17. A step template containing `{{spec}}` does not fail missing-key validation when no `--spec` was provided.

## 7) Implementation order

### Phase 1: Loader + unit tests

1. Add `src/lib/spec-loader.ts`
2. Add `src/lib/spec-loader.test.ts`
3. Build and run targeted tests

### Phase 2: CLI + run wiring

4. Update `src/cli/cli.ts` flag parsing
5. Update `src/installer/run.ts` signature/context init
6. Add/extend CLI + run integration tests

### Phase 3: templates + regression coverage

7. Update workflow templates (`feature-dev`, `bug-fix`, `security-audit`)
8. Add missing-key regression test for `{{spec}}`
9. Run full test suite

## 8) File change list

- `src/lib/spec-loader.ts` (new)
- `src/lib/spec-loader.test.ts` (new)
- `src/cli/cli.ts` (modify)
- `src/cli/cli.test.ts` (modify)
- `src/installer/run.ts` (modify)
- `workflows/feature-dev/workflow.yml` (modify)
- `workflows/bug-fix/workflow.yml` (modify)
- `workflows/security-audit/workflow.yml` (modify)
- `tests/spec-injection.test.ts` (new)

## Acceptance criteria

- `--spec` works with existing `workflow run` semantics and `--notify-url`.
- Missing `--spec` path fails clearly.
- `spec` key always exists in persisted run context.
- Steps with `{{spec}}` render successfully with and without `--spec`.
- Truncation and skip behavior is deterministic and covered by tests.
