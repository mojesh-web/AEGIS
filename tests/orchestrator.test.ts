import { describe, expect, it } from "vitest";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { WorkflowPlan } from "../src/workflow/schema";

const plan: WorkflowPlan = {
  version: 1,
  objective: "Run a workflow",
  nodes: [
    { id: "prepare", type: "code", title: "Prepare", description: "Prepare data", dependencies: [] },
    { id: "independent", type: "research", title: "Independent", description: "Run independently", dependencies: [] },
    { id: "process", type: "code", title: "Process", description: "Process data", dependencies: ["prepare"] },
    { id: "finish", type: "validator", title: "Finish", description: "Finish", dependencies: ["process", "independent"] },
  ],
};

describe("WorkflowOrchestrator", () => {
  it("runs nodes in dependency order and provides dependency outputs", async () => {
    const order: string[] = [];
    const result = await new WorkflowOrchestrator(async (node, context) => {
      order.push(node.id);
      return node.id === "process" ? context.dependencyOutputs.prepare : node.id;
    }).execute(plan);

    expect(order).toEqual(["prepare", "independent", "process", "finish"]);
    expect(result.status).toBe("succeeded");
    expect(result.nodes.finish.status).toBe("succeeded");
    expect(result.outputs.process).toBe("prepare");
  });

  it("fails a node and skips its descendants while continuing independent work", async () => {
    const executed: string[] = [];
    const result = await new WorkflowOrchestrator(async (node) => {
      executed.push(node.id);
      if (node.id === "prepare") throw new Error("bad input");
      return node.id;
    }).execute(plan);

    expect(executed).toEqual(["prepare", "independent"]);
    expect(result.status).toBe("failed");
    expect(result.nodes.prepare).toMatchObject({ status: "failed", error: "bad input" });
    expect(result.nodes.process.status).toBe("skipped");
    expect(result.nodes.finish.status).toBe("skipped");
    expect(result.nodes.independent.status).toBe("succeeded");
  });

  it("rejects invalid plans before invoking the handler", async () => {
    const handler = async () => undefined;
    const cyclic = {
      ...plan,
      nodes: [
        { ...plan.nodes[0], dependencies: ["process"] },
        ...plan.nodes.slice(1),
      ],
    };

    await expect(new WorkflowOrchestrator(handler).execute(cyclic)).rejects.toThrow(/cycle/i);
    await expect(
      new WorkflowOrchestrator(handler).execute({ ...plan, nodes: [{ ...plan.nodes[0], dependencies: ["missing"] }, ...plan.nodes.slice(1)] }),
    ).rejects.toThrow(/missing node/i);
  });
});
