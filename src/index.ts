// Responsibility: Re-export primary public API surface for consumers (install workflow and DB helpers).
// Exported interface (ASCII):
// installer/install.ts
// ├─ installWorkflow()
// └─ getMaxRoleTimeoutSeconds()
// db.ts
// ├─ getDb()
// ├─ nextRunNumber()
// └─ getDbPath()
export * from "./installer/install.js";
export * from "./db.js";
