#!/usr/bin/env node
// Responsibility: Daemon process entrypoint that writes dashboard PID file, handles SIGTERM cleanup, and starts the dashboard server.
// Exported interface (ASCII):
// (none — executable entry script)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startDashboard } from "./dashboard.js";

const port = parseInt(process.argv[2], 10) || 3333;

const pidDir = path.join(os.homedir(), ".openclaw", "antfarm");
const pidFile = path.join(pidDir, "dashboard.pid");

fs.mkdirSync(pidDir, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

process.on("SIGTERM", () => {
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});

startDashboard(port);
