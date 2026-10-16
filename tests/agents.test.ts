import { describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../src/agents/dispatcher";
import { ValidatorAgent } from "../src/agents/validator";
import { WorkflowOrchestrator } from "../src/orchestrator";
import { WorkflowNode } from "../src/workflow/schema";

const validatorNode: WorkflowNode = {
  id: "validate",
  type: "validator",
  title: "Validate",
  description: "Validate the dependency output",
  dependencies: ["source"],
  validation: { kind: "required-fields", target: "source", fields: ["title", "url"] },
};

const context = (dependencyOutputs: Record<string, unknown>) => ({ dependencyOutputs });

describe("ValidatorAgent", () => {
  it("passes when dependency output satisfies a required-fields contract", () => {
    const result = new ValidatorAgent().execute({ node: validatorNode, context: context({ source: { title: "ASTRA", url: "https://example.test" } }) });

    expect(result).toEqual({
      status: "passed",
      passed: true,
      findings: [],
      reason: "Validation target contained all required fields: title, url.",
    });
  });

  it("fails with useful findings when a required field is absent", () => {
    const result = new ValidatorAgent().execute({ node: validatorNode, context: context({ source: { title: "ASTRA" } }) });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("url");
    expect(result.findings).toContainEqual({ code: "MISSING_FIELD", field: "url", message: "Required field 'url' was not present." });
  });

  it("fails closed for missing or malformed validation input", () => {
    const agent = new ValidatorAgent();
    const missing = agent.execute({ node: { ...validatorNode, validation: undefined }, context: context({ source: {} }) });
    const malformed = agent.validate({ node: validatorNode, context: context({ source: {} }), contract: { kind: "unknown" } });

    expect(missing).toMatchObject({ status: "failed", passed: false, findings: [{ code: "MISSING_CONTRACT" }] });
    expect(malformed).toMatchObject({ status: "failed", passed: false, findings: [{ code: "MISSING_CONTRACT" }] });
  });

  it("does not claim a target exists when it was not received", () => {
    const result = new ValidatorAgent().execute({ node: validatorNode, context: context({}) });

    expect(result).toMatchObject({ status: "failed", passed: false, findings: [{ code: "MISSING_TARGET" }] });
  });

  it("supports exact typed value validation", () => {
    const result = new ValidatorAgent().validate({
      node: { ...validatorNode, validation: undefined },
      context: context({ source: { count: 2, ok: true } }),
      contract: { kind: "equals", target: "source", expected: { count: 2, ok: true } },
    });

    expect(result.status).toBe("passed");
  });
});

describe("AgentDispatcher", () => {
  it("dispatches validator nodes to the validator agent and other nodes to injected handlers", async () => {
    const codeHandler = vi.fn(async ({ node }: { node: WorkflowNode }) => `handled:${node.id}`);
    const dispatcher = new AgentDispatcher({ handlers: { code: codeHandler } });
    const validator = await dispatcher.dispatch({ node: validatorNode, context: context({ source: { title: "A", url: "B" } }) });
    const code = await dispatcher.dispatch({
      node: { id: "transform", type: "code", title: "Transform", description: "Transform", dependencies: [] },
      context: context({}),
    });

    expect(validator).toMatchObject({ status: "passed", passed: true });
    expect(code).toBe("handled:transform");
    expect(codeHandler).toHaveBeenCalledOnce();
  });

  it("uses deterministic side-effect-free placeholders for unimplemented specialists", async () => {
    const output = await new AgentDispatcher().dispatch({
      node: { id: "browse", type: "browser", title: "Browse", description: "Browse", dependencies: [] },
      context: context({}),
    });

    expect(output).toEqual({
      nodeId: "browse",
      type: "browser",
      status: "placeholder",
      description: "Browse",
      dependencyOutputs: {},
    });
  });

  it("integrates with the existing orchestrator handler injection", async () => {
    const plan = {
      version: 1,
      objective: "Validate output",
      nodes: [
        { id: "source", type: "code" as const, title: "Source", description: "Produce output", dependencies: [] },
        validatorNode,
      ],
    };
    const result = await new WorkflowOrchestrator(new AgentDispatcher().asWorkflowNodeHandler()).execute(plan);

    expect(result.status).toBe("succeeded");
    expect(result.nodes.source.status).toBe("succeeded");
    expect(result.nodes.validate.status).toBe("succeeded");
    expect(result.outputs.validate).toMatchObject({ status: "failed", passed: false });
  });
});
