import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createApp } from "./app";
import { SQLiteExecutionService } from "./execution-service";
import { WorkflowOrchestrator } from "./orchestrator";
import { RecoveryController } from "./recovery/controller";
import { SQLiteRecoveryService } from "./recovery/service";
import { WorkflowArchitect } from "./workflow/architect";

const port = Number(process.env.PORT ?? 3000);
const databasePath = resolve(process.env.SQLITE_PATH ?? "data/aegis.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const orchestrator = new WorkflowOrchestrator(async (node, context) => ({
  nodeId: node.id,
  type: node.type,
  description: node.description,
  dependencyOutputs: context.dependencyOutputs,
}));
const executionService = new SQLiteExecutionService(databasePath, orchestrator);
const recoveryService = new SQLiteRecoveryService(databasePath, new RecoveryController(orchestrator, new WorkflowArchitect()));

createApp(undefined, orchestrator, executionService, recoveryService).listen(port, () => {
  console.log(`AEGIS backend listening on http://localhost:${port}`);
  console.log(`SQLite execution store: ${databasePath}`);
});
