import { z } from "zod";
import { DiagnosisCategory, DiagnosisResult, diagnosisResultSchema } from "../diagnostics/diagnostician";
import { ValidationContract, WorkflowNode, WorkflowPlan, nodeTypeSchema, validationContractSchema, workflowPlanSchema } from "./schema";
import { validateWorkflowPlan, WorkflowValidationError } from "./validate";
import { diffWorkflows, WorkflowDiff, workflowChangeSchema } from "./diff";

const dependencyRepairSchema = z.object({
  nodeId: z.string().min(1),
  dependency: z.string().min(1),
  operation: z.enum(["add", "remove"]),
}).strict();

export const failureContextSchema = z.object({
  diagnosisReference: z.string().min(1).optional(),
  failedNodeId: z.string().min(1).optional(),
  supportedAlternativeNodeId: z.string().min(1).optional(),
  validationContract: validationContractSchema.optional(),
  supportedRecheckType: z.enum(["research", "validator"]).optional(),
  dependencyRepair: dependencyRepairSchema.optional(),
}).strict();

export const architectRequestSchema = z.object({
  originalWorkflow: workflowPlanSchema,
  diagnosis: diagnosisResultSchema,
  failureContext: failureContextSchema,
}).strict();

export const workflowRevisionProposalSchema = z.object({
  originalWorkflowVersion: z.number().int().positive(),
  revisedWorkflowVersion: z.number().int().positive(),
  diagnosisReference: z.string().min(1),
  diagnosisCategory: z.enum(["environment_changed", "missing_capability", "wrong_plan", "bad_data", "unsafe_or_blocked"]),
  explanation: z.string().min(1),
  changes: z.array(workflowChangeSchema),
  hasRevision: z.boolean(),
  revisedWorkflow: workflowPlanSchema.optional(),
  rejectionReason: z.string().min(1).optional(),
});

export type ArchitectFailureContext = z.infer<typeof failureContextSchema>;
export type ArchitectRequest = z.infer<typeof architectRequestSchema>;
export type WorkflowRevisionProposal = z.infer<typeof workflowRevisionProposalSchema>;

export interface WorkflowArchitectOptions {
  readonly maxChanges?: number;
}

export class WorkflowArchitectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowArchitectInputError";
  }
}

/** Proposal-only architect. It never executes or retries a revised workflow. */
export class WorkflowArchitect {
  private readonly maxChanges: number;

  constructor(options: WorkflowArchitectOptions = {}) {
    this.maxChanges = options.maxChanges ?? 3;
    if (!Number.isInteger(this.maxChanges) || this.maxChanges < 1) {
      throw new WorkflowArchitectInputError("maxChanges must be a positive integer");
    }
  }

  propose(input: unknown): WorkflowRevisionProposal {
    const parsed = architectRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkflowArchitectInputError(`Invalid architect request: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }

    const request = parsed.data;
    let original: WorkflowPlan;
    try {
      original = validateWorkflowPlan(request.originalWorkflow);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkflowArchitectInputError(`Invalid original workflow: ${message}`);
    }
    const context = request.failureContext;
    const diagnosis = request.diagnosis;
    const reference = context.diagnosisReference ?? diagnosis.category;

    if (diagnosis.category === "unsafe_or_blocked") {
      return this.noRevision(original, diagnosis, reference, "No executable revision is proposed because the Safety Gate blocked the action. The architect cannot weaken or bypass that decision.");
    }

    const candidate = this.buildCandidate(original, diagnosis, context);
    if (!candidate) {
      return this.noRevision(original, diagnosis, reference, this.noChangeReason(diagnosis.category));
    }

    const diff = diffWorkflows(original, candidate);
    if (diff.changes.length === 0) {
      return this.noRevision(original, diagnosis, reference, "No material, justified workflow change was available from the supplied evidence.");
    }
    if (diff.changes.length > this.maxChanges) {
      return this.noRevision(original, diagnosis, reference, `The proposed revision has ${diff.changes.length} changes, exceeding the configured limit of ${this.maxChanges}.`);
    }

    let revised: WorkflowPlan;
    try {
      revised = validateWorkflowPlan({ ...candidate, version: original.version + 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.noRevision(original, diagnosis, reference, `The proposed revision was rejected by workflow validation: ${message}`);
    }

    const finalDiff = diffWorkflows(original, revised);
    return workflowRevisionProposalSchema.parse({
      originalWorkflowVersion: original.version,
      revisedWorkflowVersion: revised.version,
      diagnosisReference: reference,
      diagnosisCategory: diagnosis.category,
      explanation: this.explanation(diagnosis.category, finalDiff),
      changes: finalDiff.changes,
      hasRevision: true,
      revisedWorkflow: revised,
    });
  }

  private buildCandidate(original: WorkflowPlan, diagnosis: DiagnosisResult, context: ArchitectFailureContext): WorkflowPlan | undefined {
    switch (diagnosis.category) {
      case "missing_capability":
        return this.replaceWithExistingAlternative(original, context);
      case "bad_data":
        return this.addValidationStep(original, context);
      case "wrong_plan":
        return this.repairDependency(original, context);
      case "environment_changed":
        return this.addRecheckStep(original, context);
      case "unsafe_or_blocked":
        return undefined;
    }
  }

  private replaceWithExistingAlternative(original: WorkflowPlan, context: ArchitectFailureContext): WorkflowPlan | undefined {
    if (!context.failedNodeId || !context.supportedAlternativeNodeId || context.failedNodeId === context.supportedAlternativeNodeId) return undefined;
    const failed = original.nodes.find((node) => node.id === context.failedNodeId);
    const alternative = original.nodes.find((node) => node.id === context.supportedAlternativeNodeId);
    if (!failed || !alternative || failed.type === alternative.type) return undefined;
    return { ...original, nodes: original.nodes.map((node) => node.id === failed.id ? { ...node, type: alternative.type } : { ...node }) };
  }

  private addValidationStep(original: WorkflowPlan, context: ArchitectFailureContext): WorkflowPlan | undefined {
    if (!context.failedNodeId || !context.validationContract) return undefined;
    const failed = original.nodes.find((node) => node.id === context.failedNodeId);
    if (!failed) return undefined;
    if (failed.type === "validator") {
      return { ...original, nodes: original.nodes.map((node) => node.id === failed.id ? { ...node, validation: context.validationContract } : { ...node }) };
    }
    const id = `validate_${failed.id}`;
    if (original.nodes.some((node) => node.id === id)) return undefined;
    const validationNode: WorkflowNode = {
      id,
      type: "validator",
      title: `Validate input for ${failed.title}`,
      description: "Validate required input before the failed step.",
      dependencies: [...failed.dependencies],
      validation: context.validationContract,
    };
    return {
      ...original,
      nodes: original.nodes.map((node) => node.id === failed.id ? { ...node, dependencies: [...node.dependencies, id] } : { ...node }).concat(validationNode),
    };
  }

  private repairDependency(original: WorkflowPlan, context: ArchitectFailureContext): WorkflowPlan | undefined {
    const repair = context.dependencyRepair;
    if (!repair) return undefined;
    const node = original.nodes.find((candidate) => candidate.id === repair.nodeId);
    const dependencyExists = original.nodes.some((candidate) => candidate.id === repair.dependency);
    if (!node || !dependencyExists || node.id === repair.dependency) return undefined;
    if (repair.operation === "add" && node.dependencies.includes(repair.dependency)) return undefined;
    if (repair.operation === "remove" && !node.dependencies.includes(repair.dependency)) return undefined;
    return {
      ...original,
      nodes: original.nodes.map((candidate) => candidate.id === node.id
        ? { ...candidate, dependencies: repair.operation === "add" ? [...candidate.dependencies, repair.dependency] : candidate.dependencies.filter((id) => id !== repair.dependency) }
        : { ...candidate }),
    };
  }

  private addRecheckStep(original: WorkflowPlan, context: ArchitectFailureContext): WorkflowPlan | undefined {
    if (!context.failedNodeId || !context.supportedRecheckType) return undefined;
    const failed = original.nodes.find((node) => node.id === context.failedNodeId);
    if (!failed) return undefined;
    const id = `recheck_${failed.id}`;
    if (original.nodes.some((node) => node.id === id)) return undefined;
    const recheck: WorkflowNode = {
      id,
      type: context.supportedRecheckType,
      title: `Re-check before ${failed.title}`,
      description: "Re-check the changed environment or resource before continuing.",
      dependencies: [...failed.dependencies],
    };
    return {
      ...original,
      nodes: original.nodes.map((node) => node.id === failed.id ? { ...node, dependencies: [...node.dependencies, id] } : { ...node }).concat(recheck),
    };
  }

  private noChangeReason(category: DiagnosisCategory): string {
    const reasons: Record<DiagnosisCategory, string> = {
      environment_changed: "No supported re-check type and failed node context were supplied, so no safe revision is available.",
      missing_capability: "No existing supported alternative node was supplied, so the architect will not invent a capability.",
      wrong_plan: "No demonstrable dependency repair was supplied, so the original plan remains unchanged.",
      bad_data: "No typed validation contract and failed node were supplied, so no validation step can be justified.",
      unsafe_or_blocked: "The Safety Gate decision prevents an executable revision.",
    };
    return reasons[category];
  }

  private explanation(category: DiagnosisCategory, diff: WorkflowDiff): string {
    return `Proposed the smallest deterministic revision for ${category}: ${diff.changes.map((change) => change.explanation).join(" ")} The revised workflow has not been executed and is not claimed to succeed.`;
  }

  private noRevision(original: WorkflowPlan, diagnosis: DiagnosisResult, reference: string, rejectionReason: string): WorkflowRevisionProposal {
    return workflowRevisionProposalSchema.parse({
      originalWorkflowVersion: original.version,
      revisedWorkflowVersion: original.version,
      diagnosisReference: reference,
      diagnosisCategory: diagnosis.category,
      explanation: rejectionReason,
      changes: [],
      hasRevision: false,
      rejectionReason,
    });
  }
}
