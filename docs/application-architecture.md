# Antfarm Architecture (Jr Dev Guide)

Antfarm is a TypeScript CLI that provisions and runs multi-agent workflows on OpenClaw. It is intentionally small: YAML workflow specs, SQLite state, cron-driven agent sessions, and a lightweight dashboard.

## Core Components
- **CLI** – Entry point for commands like install, run, status, dashboard. See src/cli/cli.ts.
- **Installer** – Fetches workflow bundles, writes OpenClaw agent configs, and provisions workspaces/files. See src/installer/install.ts and src/installer/agent-provision.ts.
- **Workflow spec & assets** – YAML + agent files under workflows/. Bundled examples: feature-dev, bug-fix, security-audit.
- **Scheduler (OpenClaw cron)** – Polls for work and launches agent sessions. Cron jobs are configured by the installer; no extra queue service.
- **Runner / Step Orchestration** – Reads workflow.yml, creates runs/steps in the DB, claims steps, and hands prompts to agents. See src/installer/step-ops.ts and src/installer/run.ts.
- **Gateway + CLI fallback** – Talks to OpenClaw via HTTP; falls back to openclaw CLI if the gateway tool is missing. See src/installer/gateway-api.ts.
- **Database** – SQLite stored at ~/.openclaw/antfarm/antfarm.db. Tables: runs, steps, stories. See src/db.ts.
- **Medic** – Health checks and auto-remediation for stuck/abandoned steps. See src/medic/medic.ts and src/medic/checks.ts.
- **Dashboard** – Static HTML/JS served by the CLI for run visibility. See src/server/index.html and src/server/dashboard.ts.

## Data Model (SQLite)
- **runs**: id, workflow_id, task, status, context JSON, timestamps, optional notify_url and run_number.
- **steps**: id, run_id, step_id, agent_id, step_index, input_template, expects, status/output, retry_count, max_retries, type (single/loop), loop_config, current_story_id, abandoned_count.
- **stories**: per-story tracking for multi-story workflows (feature-dev). Holds title, description, acceptance_criteria, status, output, retries.

## Process Flow
1. **Install**
   - `antfarm install` downloads workflow bundles, writes metadata, and updates OpenClaw config.
   - Adds workflow agents with per-role tool policies and timeouts (analysis/coding/verification/testing/pr/scanning) to openclaw.json.
   - Sets cron session retention and session maintenance defaults; links skill packages if needed.

2. **Run a workflow**
   - `antfarm workflow run <id> "task"` loads workflow.yml, seeds a `runs` row, and expands steps/stories into `steps`/`stories` rows.
   - OpenClaw cron jobs poll for runnable steps. Each agent claims one step at a time.

3. **Step execution**
   - The runner fills the step’s `input` template with context (task + prior KEY: value outputs) and sends it to the agent session.
   - On success (`expects` string found), the step is marked done and its outputs are merged into run context.
   - On failure, retries are applied; `on_fail` can trigger retry of another step or escalate to human.

4. **Verification loops & stories**
   - feature-dev uses loop steps to iterate stories; verifier/tester can trigger developer re-runs with `verify_feedback`.
   - Story progress is tracked separately in `stories`; `current_story_id` ties steps to the active story.

5. **Health & recovery (Medic)**
   - Periodic checks scan for stuck steps or stalled runs using role timeouts + small buffers.
   - Abandoned steps reset a limited number of times, then escalate.

6. **Dashboard**
   - `antfarm dashboard` serves a static UI (port 3333) that reads run/step data from the local DB to show live status.

## Key Modules to Know
- Configuration & installation: src/installer/install.ts, src/installer/openclaw-config.ts, src/installer/agent-provision.ts, src/installer/main-agent-guidance.ts.
- Workflow parsing & runtime: src/installer/workflow-spec.ts, src/installer/step-ops.ts, src/installer/run.ts.
- IO to OpenClaw: src/installer/gateway-api.ts (HTTP) with CLI fallback logic.
- Persistence: src/db.ts (getDb, migrations, nextRunNumber).
- Health checks: src/medic/medic.ts, src/medic/checks.ts.
- Server/Dashboard: src/server/dashboard.ts, src/server/index.html.

## How the Pieces Fit
- The CLI drives everything: install configures OpenClaw + workspaces; run seeds DB state; dashboard reads the same DB.
- Cron jobs (OpenClaw) are the executor: they claim runnable steps, invoke the right agent with filled prompts, and update the DB.
- The DB is the single source of truth: run state, step status, story progress, retries, and abandonment counts all live here.
- Medic and dashboard are sidecars: medic heals slow/stuck work; dashboard visualizes progress without affecting execution.

## Mental Model for a Jr Dev
- Think of Antfarm as: **YAML workflow → SQLite state machine → cron-driven agents → HTML dashboard**.
- If something looks off: check the DB state, then step runner logs, then gateway/CLI connectivity to OpenClaw.
- When adding a new workflow: define agents + steps in workflow.yml, supply agent files, and rely on the installer to wire tools and cron.
