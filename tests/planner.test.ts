import { describe, expect, it } from "vitest";
import { GroqPlanner, GroqPlannerClient } from "../src/planner";

const validPlan = {
  version: 1,
  objective: "Collect a report",
  nodes: [
    { id: "collect", type: "research", title: "Collect", description: "Collect data", dependencies: [], validation: null },
    { id: "validate", type: "validator", title: "Validate", description: "Validate data", dependencies: ["collect"], validation: null },
  ],
};

function clientReturning(response: unknown): GroqPlannerClient {
  return {
    chat: {
      completions: {
        create: async () => response as never,
      },
    },
  };
}

describe("GroqPlanner", () => {
  it("parses and validates a successful JSON-mode response", async () => {
    const planner = new GroqPlanner("test-key", "test-model", clientReturning({
      choices: [{ message: { content: JSON.stringify(validPlan) } }],
    }));

    await expect(planner.createPlan("Collect a report")).resolves.toEqual(validPlan);
  });

  it("normalizes JSON-mode nulls for optional validation fields", async () => {
    const planner = new GroqPlanner("test-key", "test-model", clientReturning({
      choices: [{ message: { content: JSON.stringify({
        ...validPlan,
        nodes: validPlan.nodes.map((node) => ({ ...node, validation: { kind: "equals", target: null, fields: null, expected: null } })),
      }) } }],
    }));

    const result = await planner.createPlan("Collect a report");
    expect(result.nodes[0].validation).toEqual({ kind: "equals", expected: null });
  });

  it("rejects invalid JSON output", async () => {
    const planner = new GroqPlanner("test-key", "test-model", clientReturning({ choices: [{ message: { content: "not json" } }] }));

    await expect(planner.createPlan("Collect a report")).rejects.toThrow(/invalid JSON/i);
  });

  it("rejects schema-invalid workflow output", async () => {
    const planner = new GroqPlanner("test-key", "test-model", clientReturning({
      choices: [{ message: { content: JSON.stringify({ ...validPlan, nodes: [{ ...validPlan.nodes[0], dependencies: ["missing"] }] }) } }],
    }));

    await expect(planner.createPlan("Collect a report")).rejects.toThrow(/missing node/i);
  });

  it("rejects empty and malformed model responses", async () => {
    const empty = new GroqPlanner("test-key", "test-model", clientReturning({ choices: [{ message: { content: "" } }] }));
    const malformed = new GroqPlanner("test-key", "test-model", clientReturning({ choices: [] }));

    await expect(empty.createPlan("Collect a report")).rejects.toThrow(/empty plan/i);
    await expect(malformed.createPlan("Collect a report")).rejects.toThrow(/empty plan/i);
  });

  it("preserves provider/authentication errors without exposing credentials", async () => {
    const provider = new GroqPlanner("test-key", "test-model", {
      chat: { completions: { create: async () => { throw Object.assign(new Error("authentication failed"), { status: 401 }); } } },
    });

    await expect(provider.createPlan("Collect a report")).rejects.toMatchObject({ status: 401 });
  });

  it("requires Groq configuration and does not fall back to OpenAI", () => {
    expect(() => new GroqPlanner(undefined, "test-model")).toThrow("GROQ_API_KEY is not configured");
    expect(() => new GroqPlanner("test-key", undefined)).toThrow("GROQ_MODEL is not configured");
  });
});
