import { WorkflowExecutionResult, WorkflowOrchestrator } from "../orchestrator";
import { DiagnosisResult } from "../diagnostics/diagnostician";
import { WorkflowArchitect, ArchitectFailureContext, WorkflowRevisionProposal, workflowRevisionProposalSchema } from "../workflow/architect";
import { WorkflowPlan } from "../workflow/schema";
import { diffWorkflows, WorkflowDiff } from "../workflow/diff";
import { validateWorkflowPlan } from "../workflow/validate";

export type RecoveryStopReason =
  | "initial_succeeded"
  | "recovery_succeeded"
  | "max_attempts_reached"
  | "non_retryable_diagnosis"
  | "unsafe_or_blocked"
  | "insufficient_evidence"
  | "no_safe_revision"
  | "invalid_revision"
  | "repeated_revision";

export interface RecoveryAttempt {
  readonly attempt: number;
  readonly workflowVersion: number;
  readonly workflow: WorkflowPlan;
  readonly outcome: WorkflowExecutionResult["status"];
  readonly result: WorkflowExecutionResult;
  readonly diagnosis?: DiagnosisResult;
  readonly proposal?: WorkflowRevisionProposal;
  readonly diff?: WorkflowDiff;
}

export interface RecoveryResult {
  readonly status: "succeeded" | "stopped";
  readonly finalOutcome: WorkflowExecutionResult["status"];
  readonly attempts: readonly RecoveryAttempt[];
  readonly finalWorkflowVersion: number;
  readonly stopReason: RecoveryStopReason;
}

export interface RecoveryControllerOptions {
  readonly maxRecoveryAttempts?: number;
}

/** Coordinates bounded recovery without executing anything outside the existing orchestrator. */
export class RecoveryController {
  private readonly maxRecoveryAttempts: number;

  constructor(
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly architect: WorkflowArchitect,
    options: RecoveryControllerOptions = {},
  ) {
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 2;
    if (!Number.isInteger(this.maxRecoveryAttempts) || this.maxRecoveryAttempts < 0) {
      throw new Error("maxRecoveryAttempts must be a non-negative integer");
    }
  }

  async recover(originalInput: WorkflowPlan, context: ArchitectFailureContext = {}): Promise<RecoveryResult> {
    const original = validateWorkflowPlan(originalInput);
    const attempts: RecoveryAttempt[] = [];
    const seenWorkflows = new Set<string>([stableWorkflowKey(original)]);
    let currentWorkflow = original;
    let execution = await this.orchestrator.execute(currentWorkflow);
    let diagnosis = firstDiagnosis(execution);

    attempts.push({
      attempt: 0,
      workflowVersion: currentWorkflow.version,
      workflow: currentWorkflow,
      outcome: execution.status,
      result: execution,
      diagnosis,
    });

    if (execution.status === "succeeded") {
      return this.complete("succeeded", execution, attempts, currentWorkflow.version, "initial_succeeded");
    }

    for (let recoveryAttempt = 1; recoveryAttempt <= this.maxRecoveryAttempts; recoveryAttempt += 1) {
      if (!diagnosis) {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "insufficient_evidence");
      }
      if (diagnosis.category === "unsafe_or_blocked") {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "unsafe_or_blocked");
      }
      if (!diagnosis.retryable) {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "non_retryable_diagnosis");
      }

      let proposal: WorkflowRevisionProposal;
      try {
        proposal = this.architect.propose({
          originalWorkflow: currentWorkflow,
          diagnosis,
          failureContext: { ...context, failedNodeId: failedNodeId(execution) ?? context.failedNodeId },
        });
      } catch {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "invalid_revision");
      }

      if (!workflowRevisionProposalSchema.safeParse(proposal).success) {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "invalid_revision");
      }

      const previous = attempts[attempts.length - 1];
      attempts[attempts.length - 1] = {
        ...previous,
        proposal,
        diff: proposal.revisedWorkflow ? diffWorkflows(currentWorkflow, proposal.revisedWorkflow) : undefined,
      };

      if (!proposal.hasRevision || !proposal.revisedWorkflow) {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "no_safe_revision");
      }

      let revised: WorkflowPlan;
      try {
        revised = validateWorkflowPlan(proposal.revisedWorkflow);
      } catch {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "invalid_revision");
      }

      const workflowKey = stableWorkflowKey(revised);
      if (seenWorkflows.has(workflowKey)) {
        return this.complete("stopped", execution, attempts, currentWorkflow.version, "repeated_revision");
      }
      seenWorkflows.add(workflowKey);

      currentWorkflow = revised;
      execution = await this.orchestrator.execute(currentWorkflow);
      diagnosis = firstDiagnosis(execution);
      attempts.push({
        attempt: recoveryAttempt,
        workflowVersion: currentWorkflow.version,
        workflow: currentWorkflow,
        outcome: execution.status,
        result: execution,
        diagnosis,
      });

      if (execution.status === "succeeded") {
        return this.complete("succeeded", execution, attempts, currentWorkflow.version, "recovery_succeeded");
      }
    }

    return this.complete("stopped", execution, attempts, currentWorkflow.version, "max_attempts_reached");
  }

  private complete(
    status: RecoveryResult["status"],
    execution: WorkflowExecutionResult,
    attempts: RecoveryAttempt[],
    finalWorkflowVersion: number,
    stopReason: RecoveryStopReason,
  ): RecoveryResult {
    return { status, finalOutcome: execution.status, attempts, finalWorkflowVersion, stopReason };
  }
}

function firstDiagnosis(result: WorkflowExecutionResult): DiagnosisResult | undefined {
  return Object.values(result.nodes).find((node) => node.status === "failed" && node.diagnosis)?.diagnosis;
}

function failedNodeId(result: WorkflowExecutionResult): string | undefined {
  return Object.entries(result.nodes).find(([, node]) => node.status === "failed" && node.diagnosis)?.[0];
}

function stableWorkflowKey(workflow: WorkflowPlan): string {
  return JSON.stringify({
    objective: workflow.objective,
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      description: node.description,
      dependencies: [...node.dependencies],
      validation: node.validation,
    })),
  });
}
