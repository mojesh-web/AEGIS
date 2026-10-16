import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticFailure } from "../src/diagnostics/diagnostician";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { SafetyGate } from "../src/safety/safety-gate";
import { WorkflowArchitect } from "../src/workflow/architect";
import { WorkflowPlan } from "../src/workflow/schema";
import { RecoveryController } from "../src/recovery/controller";
import { SQLiteRecoveryService, WorkflowRecoveryService } from "../src/recovery/service";

const plan: WorkflowPlan = {
  version: 1,
  objective: "Run a bounded recovery",
  nodes: [
    { id: "source", type: "code", title: "Source", description: "Produce data", dependencies: [] },
    { id: "process", type: "code", title: "Process", description: "Process data", dependencies: ["source"] },
  ],
};

function environmentalArchitect() {
  return new WorkflowArchitect();
}

describe("RecoveryController", () => {
  it("returns initial success without recovery", async () => {
    const handler = vi.fn(async (node) => node.id);
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), environmentalArchitect()).recover(plan);

    expect(result).toMatchObject({ status: "succeeded", finalOutcome: "succeeded", stopReason: "initial_succeeded" });
    expect(result.attempts).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("retries a retryable failure with a revised workflow and records both attempts", async () => {
    let firstProcessAttempt = true;
    const handler = async (node: { id: string }) => {
      if (node.id === "process" && firstProcessAttempt) {
        firstProcessAttempt = false;
        throw new DiagnosticFailure("ENVIRONMENT_CHANGED", "resource changed", { environmentChanged: true });
      }
      return node.id;
    };
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), environmentalArchitect()).recover(plan, { supportedRecheckType: "research" });

    expect(result).toMatchObject({ status: "succeeded", finalOutcome: "succeeded", stopReason: "recovery_succeeded", finalWorkflowVersion: 2 });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].diagnosis?.category).toBe("environment_changed");
    expect(result.attempts[0].proposal?.hasRevision).toBe(true);
    expect(result.attempts[0].diff?.changes.length).toBe(2);
    expect(result.attempts[1].workflowVersion).toBe(2);
  });

  it("stops immediately on a non-retryable failure", async () => {
    const handler = async () => {
      throw new DiagnosticFailure("MISSING_INPUT", "input missing", { inputPresent: false });
    };
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), environmentalArchitect()).recover(plan, { supportedRecheckType: "research" });

    expect(result).toMatchObject({ status: "stopped", stopReason: "non_retryable_diagnosis", finalOutcome: "failed" });
    expect(result.attempts).toHaveLength(1);
  });

  it("never retries a Safety Gate block", async () => {
    const handler = vi.fn(async () => "must not execute");
    const blockedGate = {
      evaluateNode: () => new SafetyGate().evaluate({ type: "shell.execute", input: { command: "rm -rf /" } }),
    } as SafetyGate;
    const result = await new RecoveryController(
      new WorkflowOrchestrator(handler, { safetyGate: blockedGate }),
      environmentalArchitect(),
    ).recover(plan, { supportedRecheckType: "research" });

    expect(result).toMatchObject({ status: "stopped", stopReason: "unsafe_or_blocked" });
    expect(result.attempts).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops when the Architect returns no safe revision", async () => {
    const handler = async () => {
      throw new DiagnosticFailure("ENVIRONMENT_CHANGED", "resource changed", { environmentChanged: true });
    };
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), environmentalArchitect()).recover(plan);

    expect(result).toMatchObject({ status: "stopped", stopReason: "no_safe_revision" });
    expect(result.attempts[0].proposal).toMatchObject({ hasRevision: false });
  });

  it("rejects an invalid revised workflow", async () => {
    const handler = async () => {
      throw new DiagnosticFailure("ENVIRONMENT_CHANGED", "resource changed", { environmentChanged: true });
    };
    const invalidArchitect = {
      propose: () => ({
        originalWorkflowVersion: 1,
        revisedWorkflowVersion: 2,
        diagnosisReference: "test",
        diagnosisCategory: "environment_changed" as const,
        explanation: "invalid proposal",
        changes: [],
        hasRevision: true,
        revisedWorkflow: { ...plan, version: 2, nodes: [{ ...plan.nodes[0], dependencies: ["missing"] }, plan.nodes[1]] },
      }),
    } as unknown as WorkflowArchitect;
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), invalidArchitect).recover(plan);

    expect(result).toMatchObject({ status: "stopped", stopReason: "invalid_revision" });
  });

  it("enforces the maximum recovery attempt limit", async () => {
    const handler = async () => {
      throw new DiagnosticFailure("ENVIRONMENT_CHANGED", "resource changed", { environmentChanged: true });
    };
    const changingArchitect = {
      propose: ({ originalWorkflow }: { originalWorkflow: WorkflowPlan }) => ({
        originalWorkflowVersion: originalWorkflow.version,
        revisedWorkflowVersion: originalWorkflow.version + 1,
        diagnosisReference: "environment_changed",
        diagnosisCategory: "environment_changed" as const,
        explanation: "bounded test revision",
        changes: [],
        hasRevision: true,
        revisedWorkflow: { ...originalWorkflow, version: originalWorkflow.version + 1, objective: `${originalWorkflow.objective}!` },
      }),
    } as unknown as WorkflowArchitect;
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), changingArchitect, { maxRecoveryAttempts: 2 }).recover(plan);

    expect(result).toMatchObject({ status: "stopped", stopReason: "max_attempts_reached" });
    expect(result.attempts.map((attempt) => attempt.attempt)).toEqual([0, 1, 2]);
  });

  it("detects repeated revisions before executing them", async () => {
    const handler = async () => {
      throw new DiagnosticFailure("ENVIRONMENT_CHANGED", "resource changed", { environmentChanged: true });
    };
    const repeatedArchitect = {
      propose: ({ originalWorkflow }: { originalWorkflow: WorkflowPlan }) => ({
        originalWorkflowVersion: originalWorkflow.version,
        revisedWorkflowVersion: originalWorkflow.version + 1,
        diagnosisReference: "environment_changed",
        diagnosisCategory: "environment_changed" as const,
        explanation: "repeated test revision",
        changes: [],
        hasRevision: true,
        revisedWorkflow: { ...originalWorkflow, version: originalWorkflow.version + 1 },
      }),
    } as unknown as WorkflowArchitect;
    const result = await new RecoveryController(new WorkflowOrchestrator(handler), repeatedArchitect).recover(plan);

    expect(result).toMatchObject({ status: "stopped", stopReason: "repeated_revision" });
    expect(result.attempts).toHaveLength(1);
  });
});

describe("Recovery persistence", () => {
  it("persists completed recovery attempts in SQLite and reads them after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recovery-service-"));
    const databasePath = join(directory, "recovery.sqlite");
    try {
      const first = new SQLiteRecoveryService(databasePath, new RecoveryController(new WorkflowOrchestrator(async (node) => node.id), environmentalArchitect()));
      const id = first.start(plan);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(first.get(id)).toMatchObject({ status: "completed", result: { attempts: [{ attempt: 0, workflowVersion: 1 }] } });
      first.close();

      const second = new SQLiteRecoveryService(databasePath, new RecoveryController(new WorkflowOrchestrator(async (node) => node.id), environmentalArchitect()));
      expect(second.get(id)).toMatchObject({ id, status: "completed", result: { finalOutcome: "succeeded" } });
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the in-memory service lifecycle compatible with queued and completed states", async () => {
    const service = new WorkflowRecoveryService(new RecoveryController(new WorkflowOrchestrator(async (node) => node.id), environmentalArchitect()));
    const id = service.start(plan);
    expect(service.get(id)).toMatchObject({ id, status: "queued" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.get(id)).toMatchObject({ id, status: "completed" });
  });
});
