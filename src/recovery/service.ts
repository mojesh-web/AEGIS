import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RecoveryController, RecoveryResult } from "./controller";
import { ArchitectFailureContext } from "../workflow/architect";
import { WorkflowPlan } from "../workflow/schema";
import { validateWorkflowPlan } from "../workflow/validate";

export type RecoveryStatus = "queued" | "running" | "completed" | "failed";

export interface RecoverySnapshot {
  readonly id: string;
  readonly status: RecoveryStatus;
  readonly plan: WorkflowPlan;
  readonly result?: RecoveryResult;
  readonly error?: string;
}

export interface RecoveryService {
  start(plan: WorkflowPlan, context?: ArchitectFailureContext): string;
  get(id: string): RecoverySnapshot | undefined;
}

interface StoredRecovery {
  id: string;
  status: RecoveryStatus;
  plan: WorkflowPlan;
  result?: RecoveryResult;
  error?: string;
}

export class WorkflowRecoveryService implements RecoveryService {
  private readonly recoveries = new Map<string, StoredRecovery>();

  constructor(private readonly controller: RecoveryController) {}

  start(plan: WorkflowPlan, context: ArchitectFailureContext = {}): string {
    const validatedPlan = validateWorkflowPlan(plan);
    const id = randomUUID();
    const recovery: StoredRecovery = { id, status: "queued", plan: validatedPlan };
    this.recoveries.set(id, recovery);
    void Promise.resolve().then(async () => {
      recovery.status = "running";
      try {
        recovery.result = await this.controller.recover(validatedPlan, context);
        recovery.status = "completed";
      } catch (error) {
        recovery.error = error instanceof Error ? error.message : String(error);
        recovery.status = "failed";
      }
    });
    return id;
  }

  get(id: string): RecoverySnapshot | undefined {
    const recovery = this.recoveries.get(id);
    if (!recovery) return undefined;
    return { id: recovery.id, status: recovery.status, plan: recovery.plan, result: recovery.result, error: recovery.error };
  }
}

type RecoveryRow = {
  id: string;
  status: RecoveryStatus;
  plan_json: string;
  result_json: string | null;
  error: string | null;
};

/** Stores recovery snapshots in a separate compatible table without changing executions. */
export class SQLiteRecoveryService implements RecoveryService {
  private readonly database: DatabaseSync;
  private readonly controller: RecoveryController;

  constructor(databasePath: string, controller: RecoveryController);
  constructor(controller: RecoveryController, databasePath: string);
  constructor(first: string | RecoveryController, second: string | RecoveryController) {
    const databasePath = typeof first === "string" ? first : second as string;
    this.controller = typeof first === "string" ? second as RecoveryController : first;
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS recovery_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        plan_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT
      )
    `);
  }

  start(plan: WorkflowPlan, context: ArchitectFailureContext = {}): string {
    const validatedPlan = validateWorkflowPlan(plan);
    const id = randomUUID();
    this.database.prepare("INSERT INTO recovery_runs (id, status, plan_json) VALUES (?, ?, ?)").run(id, "queued", JSON.stringify(validatedPlan));
    void Promise.resolve().then(async () => {
      this.updateStatus(id, "running");
      try {
        const result = await this.controller.recover(validatedPlan, context);
        this.database.prepare("UPDATE recovery_runs SET status = ?, result_json = ? WHERE id = ?").run("completed", JSON.stringify(result), id);
      } catch (error) {
        this.database.prepare("UPDATE recovery_runs SET status = ?, error = ? WHERE id = ?").run("failed", error instanceof Error ? error.message : String(error), id);
      }
    });
    return id;
  }

  get(id: string): RecoverySnapshot | undefined {
    const row = this.database.prepare("SELECT id, status, plan_json, result_json, error FROM recovery_runs WHERE id = ?").get(id) as RecoveryRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      plan: JSON.parse(row.plan_json) as WorkflowPlan,
      result: row.result_json ? JSON.parse(row.result_json) as RecoveryResult : undefined,
      error: row.error ?? undefined,
    };
  }

  close(): void {
    this.database.close();
  }

  private updateStatus(id: string, status: RecoveryStatus): void {
    this.database.prepare("UPDATE recovery_runs SET status = ? WHERE id = ?").run(status, id);
  }
}
