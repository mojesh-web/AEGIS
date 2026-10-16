import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Planner } from "../src/planner";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { WorkflowExecutionService } from "../src/execution-service";

const validPlan = {
  version: 1,
  objective: "Collect a report",
  nodes: [
    { id: "research", type: "research", title: "Research", description: "Find sources", dependencies: [] },
    { id: "validate", type: "validator", title: "Validate", description: "Check sources", dependencies: ["research"] },
  ],
} as const;

function plannerReturning(value: unknown): Planner {
  return { createPlan: async () => value as never };
}

describe("AEGIS planning API", () => {
  it("returns a validated plan", async () => {
    const response = await request(createApp(plannerReturning(validPlan))).post("/api/plan").send({ objective: "Collect a report" });
    expect(response.status).toBe(200);
    expect(response.body.nodes).toHaveLength(2);
  });

  it("rejects missing objectives", async () => {
    const response = await request(createApp(plannerReturning(validPlan))).post("/api/plan").send({});
    expect(response.status).toBe(400);
  });

  it("rejects duplicate IDs, missing dependencies, and cycles", async () => {
    for (const nodes of [
      [validPlan.nodes[0], { ...validPlan.nodes[1], id: "research", dependencies: [] }],
      [{ ...validPlan.nodes[0], dependencies: ["missing"] }, validPlan.nodes[1]],
      [{ ...validPlan.nodes[0], dependencies: ["validate"] }, validPlan.nodes[1]],
    ]) {
      const response = await request(createApp(plannerReturning({ ...validPlan, nodes }))).post("/api/plan").send({ objective: "x" });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/invalid|duplicate|missing|cycle/i);
    }
  });

  it("exposes a health check", async () => {
    const response = await request(createApp(plannerReturning(validPlan))).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("exposes a useful root status response", async () => {
    const response = await request(createApp()).get("/");
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("AEGIS");
    expect(response.body.status).toBe("running");
  });

  it("executes a validated workflow through the orchestrator", async () => {
    const response = await request(createApp(undefined, new WorkflowOrchestrator(async (node) => `done:${node.id}`)))
      .post("/api/execute")
      .send({ plan: validPlan });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("succeeded");
    expect(response.body.outputs).toEqual({ research: "done:research", validate: "done:validate" });
  });

  it("rejects invalid execution plans before running them", async () => {
    const handler = async () => "should not run";
    const orchestrator = new WorkflowOrchestrator(handler);
    const response = await request(createApp(undefined, orchestrator)).post("/api/execute").send({
      plan: { ...validPlan, nodes: [{ ...validPlan.nodes[0], dependencies: ["missing"] }, validPlan.nodes[1]] },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/missing node/i);
  });

  it("queues an execution and allows its status to be fetched", async () => {
    const service = new WorkflowExecutionService(new WorkflowOrchestrator(async (node) => `done:${node.id}`));
    const app = createApp(undefined, undefined, service);
    const created = await request(app).post("/api/executions").send({ plan: validPlan });

    expect(created.status).toBe(202);
    expect(created.body.executionId).toEqual(expect.any(String));
    expect(created.body.status).toBe("queued");

    await new Promise<void>((resolve) => setImmediate(resolve));
    const fetched = await request(app).get(`/api/executions/${created.body.executionId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe("completed");
    expect(fetched.body.result.outputs).toEqual({ research: "done:research", validate: "done:validate" });
  });

  it("returns 400 for invalid queued executions and 404 for unknown IDs", async () => {
    const service = new WorkflowExecutionService(new WorkflowOrchestrator(async () => "done"));
    const app = createApp(undefined, undefined, service);
    const invalid = await request(app).post("/api/executions").send({
      plan: { ...validPlan, nodes: [{ ...validPlan.nodes[0], dependencies: ["missing"] }, validPlan.nodes[1]] },
    });
    expect(invalid.status).toBe(400);

    const missing = await request(app).get("/api/executions/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Execution not found" });
  });
});
