import { describe, expect, it } from "vitest";
import { diagnoseFailure, DiagnosticFailure, diagnosisResultSchema } from "../src/diagnostics/diagnostician";
import { SafetyGate } from "../src/safety/safety-gate";
import { WorkflowOrchestrator } from "../src/orchestrator";

describe("Workflow Diagnostician", () => {
  it.each([
    ["environment_changed", { errorCode: "ENVIRONMENT_CHANGED", metadata: { environmentChanged: true } }, true],
    ["missing_capability", { errorCode: "MISSING_CAPABILITY", metadata: { requiredCapability: "research-agent", capabilityAvailable: false } }, false],
    ["wrong_plan", { errorCode: "INVALID_WORKFLOW", metadata: { workflowValid: false } }, false],
    ["bad_data", { errorCode: "SCHEMA_INVALID_INPUT", metadata: { schemaValid: false } }, false],
  ] as const)("classifies %s using structured rules", (category, input, retryable) => {
    const diagnosis = diagnoseFailure(input);

    expect(diagnosisResultSchema.safeParse(diagnosis).success).toBe(true);
    expect(diagnosis.category).toBe(category);
    expect(diagnosis.retryable).toBe(retryable);
    expect(diagnosis.evidence.length).toBeGreaterThan(0);
    expect(diagnosis.recommendedAction).toBeTruthy();
  });

  it("classifies an explicit Safety Gate block as unsafe_or_blocked without authorizing retry", () => {
    const decision = new SafetyGate().evaluate({ type: "shell.execute", input: { command: "rm -rf /" } });
    const diagnosis = diagnoseFailure({ errorCode: "SAFETY_BLOCKED", safetyDecision: decision });

    expect(diagnosis).toMatchObject({ category: "unsafe_or_blocked", retryable: false });
    expect(diagnosis.reason).toMatch(/Safety Gate/i);
  });

  it("uses a conservative non-retryable diagnosis for unknown failures", () => {
    const diagnosis = diagnoseFailure({ errorCode: "UNRECOGNIZED_FAILURE", message: "something happened" });

    expect(diagnosis.category).toBe("bad_data");
    expect(diagnosis.retryable).toBe(false);
    expect(diagnosis.reason).toMatch(/ambiguous|conservative/i);
    expect(diagnosis.evidence.join(" ")).toContain("UNRECOGNIZED_FAILURE");
  });

  it("fails closed for malformed diagnosis input", () => {
    const diagnosis = diagnoseFailure({ errorCode: "MISSING_INPUT", metadata: { unexpected: true } });

    expect(diagnosis).toMatchObject({ category: "bad_data", retryable: false });
    expect(diagnosis.evidence.join(" ")).toMatch(/schema validation/i);
  });

  it("does not let diagnosis override a blocked Safety Gate decision", async () => {
    const handler = () => {
      throw new Error("must not execute");
    };
    const result = await new WorkflowOrchestrator(handler, {
      safetyGate: {
        evaluateNode: () => new SafetyGate().evaluate({ type: "external.write", input: { target: "outside" } }),
      } as SafetyGate,
    }).execute({
      version: 1,
      objective: "Blocked action",
      nodes: [{ id: "blocked", type: "code", title: "Blocked", description: "Run", dependencies: [] }],
    });

    expect(result.nodes.blocked.status).toBe("failed");
    expect(result.nodes.blocked.diagnosis).toMatchObject({ category: "unsafe_or_blocked", retryable: false });
    expect(result.nodes.blocked.output).toMatchObject({ allowed: false });
  });

  it("uses structured DiagnosticFailure metadata instead of message substring matching", async () => {
    const result = await new WorkflowOrchestrator(async () => {
      throw new DiagnosticFailure("MISSING_CAPABILITY", "The message intentionally says nothing useful", {
        requiredCapability: "browser-agent",
        capabilityAvailable: false,
      });
    }).execute({
      version: 1,
      objective: "Missing capability",
      nodes: [{ id: "step", type: "browser", title: "Step", description: "Run", dependencies: [] }],
    });

    expect(result.nodes.step.diagnosis).toMatchObject({ category: "missing_capability", retryable: false });
  });
});
