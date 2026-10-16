import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteExecutionService, WorkflowExecutionService } from "../src/execution-service";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { WorkflowPlan } from "../src/workflow/schema";

const plan: WorkflowPlan = {
  version: 1,
  objective: "Run a workflow",
  nodes: [{ id: "step", type: "code", title: "Step", description: "Run a step", dependencies: [] }],
};

describe("WorkflowExecutionService", () => {
  it("exposes queued, running, and completed snapshots", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new WorkflowExecutionService(new WorkflowOrchestrator(async () => {
      await blocked;
      return "done";
    }));

    const id = service.start(plan);
    expect(service.get(id)).toMatchObject({ id, status: "queued" });

    await Promise.resolve();
    expect(service.get(id)).toMatchObject({ id, status: "running" });

    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.get(id)).toMatchObject({
      id,
      status: "completed",
      result: { status: "succeeded", outputs: { step: "done" } },
    });
  });

  it("stores failed results and returns undefined for unknown IDs", async () => {
    const service = new WorkflowExecutionService(new WorkflowOrchestrator(async () => {
      throw new Error("node failed");
    }));
    const id = service.start(plan);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.get(id)).toMatchObject({
      id,
      status: "failed",
      result: { status: "failed" },
    });
    expect(service.get("does-not-exist")).toBeUndefined();
  });

  it("stores a deterministic diagnosis with a failed result", async () => {
    const service = new WorkflowExecutionService(new WorkflowOrchestrator(async () => {
      throw new Error("node failed");
    }));
    const id = service.start(plan);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.get(id)?.result?.nodes.step.diagnosis).toMatchObject({
      category: "bad_data",
      retryable: false,
    });
  });

  it("rejects invalid plans before storing an execution", () => {
    const service = new WorkflowExecutionService(new WorkflowOrchestrator(async () => undefined));
    expect(() => service.start({ ...plan, nodes: [{ ...plan.nodes[0], dependencies: ["missing"] }] })).toThrow(/missing node/i);
  });
});

describe("SQLiteExecutionService", () => {
  it("persists a completed execution for a second service instance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "execution-service-"));
    const databasePath = join(directory, "executions.sqlite");

    try {
      const first = new SQLiteExecutionService(databasePath, new WorkflowOrchestrator(async () => "persisted"));
      const id = first.start(plan);
      expect(first.get(id)).toMatchObject({ id, status: "queued", plan });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(first.get(id)).toMatchObject({ id, status: "completed", result: { status: "succeeded" } });
      first.close();

      const second = new SQLiteExecutionService(databasePath, new WorkflowOrchestrator(async () => "unused"));
      expect(second.get(id)).toMatchObject({
        id,
        status: "completed",
        plan,
        result: { status: "succeeded", outputs: { step: "persisted" } },
      });
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates before inserting and persists orchestration failures", async () => {
    const service = new SQLiteExecutionService(":memory:", new WorkflowOrchestrator(async () => {
      throw new Error("node failed");
    }));

    expect(() => service.start({ ...plan, nodes: [{ ...plan.nodes[0], dependencies: ["missing"] }] })).toThrow(/missing node/i);
    const id = service.start(plan);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.get(id)).toMatchObject({ id, status: "failed", result: { status: "failed" } });
    service.close();
  });

  it("persists diagnosis data without changing the existing record shape", async () => {
    const service = new SQLiteExecutionService(":memory:", new WorkflowOrchestrator(async () => {
      throw new Error("node failed");
    }));
    const id = service.start(plan);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.get(id)).toMatchObject({
      id,
      status: "failed",
      result: { nodes: { step: { diagnosis: { category: "bad_data", retryable: false } } } },
    });
    service.close();
  });
});
