import { describe, expect, it, vi } from "vitest";
import { SafetyGate } from "../src/safety/safety-gate";
import { WorkflowOrchestrator } from "../src/orchestrator";

describe("SafetyGate", () => {
  it("allows an explicitly permitted benign action", () => {
    const decision = new SafetyGate().evaluate({ type: "validator.validate", input: { nodeId: "check" } });

    expect(decision).toMatchObject({ allowed: true, policyRuleId: "safety.allowlisted-benign-action" });
    expect(decision.action.type).toBe("validator.validate");
  });

  it.each(["file.delete", "record.delete", "shell.execute", "secret.exfiltrate", "external.write"])(
    "blocks destructive action %s",
    (type) => {
      const decision = new SafetyGate().evaluate({ type, input: { target: "sensitive" } });

      expect(decision.allowed).toBe(false);
      expect(decision.policyRuleId).toBe("safety.destructive-action");
    },
  );

  it("blocks unknown action types", () => {
    const decision = new SafetyGate().evaluate({ type: "future.unreviewed-action", input: {} });

    expect(decision).toMatchObject({ allowed: false, policyRuleId: "safety.unknown-action" });
  });

  it.each([undefined, null, {}, { type: "validator.validate" }, { type: "validator.validate", input: [] }])(
    "fails closed for malformed policy input: %j",
    (input) => {
      const decision = new SafetyGate().evaluate(input);

      expect(decision).toMatchObject({ allowed: false, policyRuleId: "safety.invalid-input" });
    },
  );

  it("blocks before an injected agent handler is reached and records the decision", async () => {
    const handler = vi.fn(async () => "must not run");
    class BlockingGate extends SafetyGate {
      override evaluateNode() {
        return this.evaluate({ type: "shell.execute", input: { command: "rm -rf /" } });
      }
    }

    const result = await new WorkflowOrchestrator(handler, { safetyGate: new BlockingGate() }).execute({
      version: 1,
      objective: "Attempt a blocked action",
      nodes: [
        {
          id: "safe-check",
          type: "validator",
          title: "Safe check",
          description: "This text is not policy",
          dependencies: [],
        },
      ],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.nodes["safe-check"]).toMatchObject({
      status: "failed",
      output: {
        allowed: false,
        policyRuleId: "safety.destructive-action",
      },
    });
  });
});
