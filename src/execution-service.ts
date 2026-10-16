import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WorkflowExecutionResult, WorkflowOrchestrator } from "./orchestrator";
import { WorkflowPlan } from "./workflow/schema";
import { validateWorkflowPlan } from "./workflow/validate";

export type ExecutionStatus = "queued" | "running" | "completed" | "failed";

export interface ExecutionSnapshot {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly plan: WorkflowPlan;
  readonly result?: WorkflowExecutionResult;
  readonly error?: string;
}

export interface ExecutionService {
  start(plan: WorkflowPlan): string;
  get(id: string): ExecutionSnapshot | undefined;
}

interface StoredExecution {
  id: string;
  status: ExecutionStatus;
  plan: WorkflowPlan;
  result?: WorkflowExecutionResult;
  error?: string;
}

/** Starts and tracks workflow executions in memory for the lifetime of this service. */
export class WorkflowExecutionService implements ExecutionService {
  private readonly executions = new Map<string, StoredExecution>();

  constructor(private readonly orchestrator: WorkflowOrchestrator) {}

  /**
   * Validate and enqueue a workflow. The returned ID can be used immediately to
   * observe the queued state while the orchestrator runs asynchronously.
   */
  start(plan: WorkflowPlan): string {
    const validatedPlan = validateWorkflowPlan(plan);
    const id = randomUUID();
    const execution: StoredExecution = { id, status: "queued", plan: validatedPlan };
    this.executions.set(id, execution);

    // Deliberately schedule the work after returning so callers can observe queued.
    void Promise.resolve().then(async () => {
      execution.status = "running";
      try {
        const result = await this.orchestrator.execute(validatedPlan);
        execution.result = result;
        execution.status = result.status === "succeeded" ? "completed" : "failed";
      } catch (error) {
        execution.error = error instanceof Error ? error.message : String(error);
        execution.status = "failed";
      }
    });

    return id;
  }

  /** Return the current execution state, or undefined when the ID is unknown. */
  get(id: string): ExecutionSnapshot | undefined {
    const execution = this.executions.get(id);
    if (!execution) return undefined;

    return {
      id: execution.id,
      status: execution.status,
      plan: execution.plan,
      result: execution.result,
      error: execution.error,
    };
  }
}

type ExecutionRow = {
  id: string;
  status: ExecutionStatus;
  plan_json: string;
  result_json: string | null;
  error: string | null;
};

/** Persists workflow executions in SQLite while retaining asynchronous orchestration. */
export class SQLiteExecutionService implements ExecutionService {
  private readonly database: DatabaseSync;
  private readonly orchestrator: WorkflowOrchestrator;

  constructor(databasePath: string, orchestrator: WorkflowOrchestrator);
  constructor(orchestrator: WorkflowOrchestrator, databasePath: string);
  constructor(first: string | WorkflowOrchestrator, second: string | WorkflowOrchestrator) {
    const databasePath = typeof first === "string" ? first : second as string;
    this.orchestrator = typeof first === "string" ? second as WorkflowOrchestrator : first;
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        plan_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT
      )
    `);
  }

  start(plan: WorkflowPlan): string {
    const validatedPlan = validateWorkflowPlan(plan);
    const id = randomUUID();
    this.database
      .prepare("INSERT INTO executions (id, status, plan_json) VALUES (?, ?, ?)")
      .run(id, "queued", JSON.stringify(validatedPlan));

    void Promise.resolve().then(async () => {
      this.updateStatus(id, "running");
      try {
        const result = await this.orchestrator.execute(validatedPlan);
        this.database
          .prepare("UPDATE executions SET status = ?, result_json = ? WHERE id = ?")
          .run(result.status === "succeeded" ? "completed" : "failed", JSON.stringify(result), id);
      } catch (error) {
        this.database
          .prepare("UPDATE executions SET status = ?, error = ? WHERE id = ?")
          .run("failed", error instanceof Error ? error.message : String(error), id);
      }
    });

    return id;
  }

  get(id: string): ExecutionSnapshot | undefined {
    const row = this.database.prepare("SELECT id, status, plan_json, result_json, error FROM executions WHERE id = ?").get(id) as ExecutionRow | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      status: row.status,
      plan: JSON.parse(row.plan_json) as WorkflowPlan,
      result: row.result_json ? (JSON.parse(row.result_json) as WorkflowExecutionResult) : undefined,
      error: row.error ?? undefined,
    };
  }

  close(): void {
    this.database.close();
  }

  private updateStatus(id: string, status: ExecutionStatus): void {
    this.database.prepare("UPDATE executions SET status = ? WHERE id = ?").run(status, id);
  }
}

/** Backwards-compatible descriptive alias for consumers that name services by workflow. */
export { SQLiteExecutionService as SQLiteWorkflowExecutionService };
