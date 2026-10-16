import { describe, expect, it } from "vitest";
import { diagnoseFailure } from "../src/diagnostics/diagnostician";
import { WorkflowArchitect, WorkflowArchitectInputError } from "../src/workflow/architect";
import { diffWorkflows } from "../src/workflow/diff";
import { WorkflowPlan } from "../src/workflow/schema";

const original: WorkflowPlan = {
  version: 1,
  objective: "Collect and validate a report",
  nodes: [
    { id: "source", type: "browser", title: "Source", description: "Collect source data", dependencies: [] },
    { id: "process", type: "code", title: "Process", description: "Process source data", dependencies: ["source"] },
  ],
};

const diagnosis = (category: "environment_changed" | "missing_capability" | "wrong_plan" | "bad_data" | "unsafe_or_blocked") => {
  const codes = {
    environment_changed: "ENVIRONMENT_CHANGED",
    missing_capability: "MISSING_CAPABILITY",
    wrong_plan: "INVALID_WORKFLOW",
    bad_data: "BAD_DATA",
    unsafe_or_blocked: "SAFETY_BLOCKED",
  } as const;
  return diagnoseFailure({ errorCode: codes[category], message: `Observed ${category}` });
};

describe("WorkflowArchitect", () => {
  it("replaces a missing capability only with an existing supported alternative", () => {
    const proposal = new WorkflowArchitect().propose({
      originalWorkflow: original,
      diagnosis: diagnosis("missing_capability"),
      failureContext: { failedNodeId: "source", supportedAlternativeNodeId: "process" },
    });

    expect(proposal.hasRevision).toBe(true);
    expect(proposal.revisedWorkflow?.version).toBe(2);
    expect(proposal.revisedWorkflow?.nodes.find((node) => node.id === "source")?.type).toBe("code");
    expect(proposal.changes).toHaveLength(1);
    expect(original.nodes[0].type).toBe("browser");
  });

  it("returns no revision when missing capability evidence has no existing alternative", () => {
    const proposal = new WorkflowArchitect().propose({
      originalWorkflow: original,
      diagnosis: diagnosis("missing_capability"),
      failureContext: { failedNodeId: "source" },
    });

    expect(proposal).toMatchObject({ hasRevision: false, changes: [] });
    expect(proposal.rejectionReason).toMatch(/alternative/i);
  });

  it("adds a typed validation step for bad data when the contract is known", () => {
    const proposal = new WorkflowArchitect().propose({
      originalWorkflow: original,
      diagnosis: diagnosis("bad_data"),
      failureContext: {
        failedNodeId: "process",
        validationContract: { kind: "required-fields", target: "source", fields: ["title"] },
      },
    });

    expect(proposal.hasRevision).toBe(true);
    expect(proposal.changes).toHaveLength(2);
    expect(proposal.revisedWorkflow?.nodes.find((node) => node.id === "validate_process")).toMatchObject({
      type: "validator",
      validation: { kind: "required-fields", target: "source", fields: ["title"] },
    });
  });

  it("repairs only an explicitly demonstrated dependency defect", () => {
    const proposal = new WorkflowArchitect().propose({
      originalWorkflow: original,
      diagnosis: diagnosis("wrong_plan"),
      failureContext: { dependencyRepair: { nodeId: "process", dependency: "source", operation: "remove" } },
    });

    expect(proposal.hasRevision).toBe(true);
    expect(proposal.revisedWorkflow?.nodes.find((node) => node.id === "process")?.dependencies).toEqual([]);
  });

  it("adds an explicitly supported environment re-check", () => {
    const proposal = new WorkflowArchitect().propose({
      originalWorkflow: original,
      diagnosis: diagnosis("environment_changed"),
      failureContext: { failedNodeId: "process", supportedRecheckType: "research" },
    });

    expect(proposal.hasRevision).toBe(true);
    expect(proposal.revisedWorkflow?.nodes.find((node) => node.id === "recheck_process")).toMatchObject({ type: "research" });
  });

  it("never proposes an executable revision for unsafe_or_blocked", () => {
    const proposal = new WorkflowArchitect().propose({
      originalWorkflow: original,
      diagnosis: diagnosis("unsafe_or_blocked"),
      failureContext: { failedNodeId: "process", supportedAlternativeNodeId: "source" },
    });

    expect(proposal).toMatchObject({ hasRevision: false, diagnosisCategory: "unsafe_or_blocked", changes: [] });
    expect(proposal.explanation).toMatch(/Safety Gate|blocked/i);
  });

  it("rejects a revision that exceeds the configured change limit", () => {
    const proposal = new WorkflowArchitect({ maxChanges: 1 }).propose({
      originalWorkflow: original,
      diagnosis: diagnosis("bad_data"),
      failureContext: {
        failedNodeId: "process",
        validationContract: { kind: "required-fields", target: "source", fields: ["title"] },
      },
    });

    expect(proposal).toMatchObject({ hasRevision: false, changes: [] });
    expect(proposal.rejectionReason).toMatch(/limit/i);
  });

  it("rejects invalid graph input before proposing a revision", () => {
    const cyclic = {
      ...original,
      nodes: [
        { ...original.nodes[0], dependencies: ["process"] },
        original.nodes[1],
      ],
    };

    expect(() => new WorkflowArchitect().propose({
      originalWorkflow: cyclic,
      diagnosis: diagnosis("wrong_plan"),
      failureContext: {},
    })).toThrow(WorkflowArchitectInputError);
  });

  it("produces deterministic output and does not mutate the original workflow", () => {
    const snapshot = JSON.stringify(original);
    const request = {
      originalWorkflow: original,
      diagnosis: diagnosis("bad_data"),
      failureContext: {
        failedNodeId: "process",
        validationContract: { kind: "required-fields" as const, target: "source", fields: ["title"] },
      },
    };
    const first = new WorkflowArchitect().propose(request);
    const second = new WorkflowArchitect().propose(request);

    expect(second).toEqual(first);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("workflow diff", () => {
  it("identifies added, removed, modified, and dependency changes", () => {
    const revised: WorkflowPlan = {
      ...original,
      version: 2,
      nodes: [
        { ...original.nodes[0], type: "research" },
        { ...original.nodes[1], dependencies: [] },
        { id: "extra", type: "validator", title: "Extra", description: "Check", dependencies: [] },
      ],
    };
    const diff = diffWorkflows(original, revised);

    expect(diff.addedNodeIds).toEqual(["extra"]);
    expect(diff.removedNodeIds).toEqual([]);
    expect(diff.modifiedNodeIds).toEqual(["source"]);
    expect(diff.dependencyChangedNodeIds).toEqual(["process"]);
    expect(diff.changes.map((change) => change.type)).toEqual(["add_node", "modify_node", "change_dependencies"]);
  });
});
