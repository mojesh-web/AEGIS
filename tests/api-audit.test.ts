import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Planner } from "../src/planner";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { WorkflowExecutionService } from "../src/execution-service";
import { RecoveryController } from "../src/recovery/controller";
import { WorkflowRecoveryService } from "../src/recovery/service";
import { WorkflowArchitect } from "../src/workflow/architect";

const plan = {
  version: 1,
  objective: "Audit API behavior",
  nodes: [{ id: "step", type: "code", title: "Step", description: "Deterministic step", dependencies: [] }],
} as const;

const planner: Planner = { createPlan: async () => plan };

describe("public API audit", () => {
  it("supports health, valid planning, invalid planning, execution, and history retrieval", async () => {
    const orchestrator = new WorkflowOrchestrator(async (node) => `done:${node.id}`);
    const executionService = new WorkflowExecutionService(orchestrator);
    const app = createApp(planner, orchestrator, executionService);

    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });

    const planned = await request(app).post("/api/plan").send({ objective: "Audit API behavior" });
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ version: 1, nodes: [{ id: "step" }] });

    const invalidPlan = await request(app).post("/api/plan").send({ objective: "" });
    expect(invalidPlan.status).toBe(400);

    const directExecution = await request(app).post("/api/execute").send({ plan });
    expect(directExecution.status).toBe(200);
    expect(directExecution.body).toMatchObject({ status: "succeeded", outputs: { step: "done:step" } });

    const invalidExecution = await request(app).post("/api/execute").send({ plan: { ...plan, nodes: [{ ...plan.nodes[0], dependencies: ["missing"] }] } });
    expect(invalidExecution.status).toBe(400);

    const queued = await request(app).post("/api/executions").send({ plan });
    expect(queued.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const history = await request(app).get(`/api/executions/${queued.body.executionId}`);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ status: "completed", result: { status: "succeeded" } });
  });

  it("supports recovery start/read and rejects malformed recovery context", async () => {
    const orchestrator = new WorkflowOrchestrator(async (node) => node.id);
    const recoveryService = new WorkflowRecoveryService(new RecoveryController(orchestrator, new WorkflowArchitect()));
    const app = createApp(planner, orchestrator, new WorkflowExecutionService(orchestrator), recoveryService);

    const queued = await request(app).post("/api/recoveries").send({ plan, context: {} });
    expect(queued.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovery = await request(app).get(`/api/recoveries/${queued.body.recoveryId}`);
    expect(recovery.status).toBe(200);
    expect(recovery.body).toMatchObject({ status: "completed", result: { finalOutcome: "succeeded", attempts: [{ attempt: 0 }] } });

    const malformed = await request(app).post("/api/recoveries").send({ plan, context: { unsupported: true } });
    expect(malformed.status).toBe(400);

    const missing = await request(app).get("/api/recoveries/does-not-exist");
    expect(missing.status).toBe(404);
  });
});
