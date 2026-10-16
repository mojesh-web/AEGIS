import { WorkflowNode, WorkflowPlan } from "./workflow/schema";
import { validateWorkflowPlan } from "./workflow/validate";
import { SafetyGate, SafetyGateBlockedError } from "./safety/safety-gate";
import { diagnoseFailure, DiagnosticFailure, DiagnosisResult, diagnosisFromSafetyDecision } from "./diagnostics/diagnostician";

export type WorkflowNodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type WorkflowExecutionStatus = "succeeded" | "failed";

export interface WorkflowNodeContext {
  /** Outputs from the node's dependencies, keyed by node ID. */
  readonly dependencyOutputs: Readonly<Record<string, unknown>>;
}

export type WorkflowNodeHandler = (
  node: WorkflowNode,
  context: WorkflowNodeContext,
) => unknown | Promise<unknown>;

export interface WorkflowNodeExecution {
  status: WorkflowNodeStatus;
  output?: unknown;
  error?: string;
  diagnosis?: DiagnosisResult;
}

export interface WorkflowExecutionResult {
  status: WorkflowExecutionStatus;
  nodes: Record<string, WorkflowNodeExecution>;
  outputs: Record<string, unknown>;
}

export interface WorkflowOrchestratorOptions {
  onStatusChange?: (node: WorkflowNode, status: WorkflowNodeStatus) => void;
  safetyGate?: SafetyGate;
}

/** Executes a validated workflow plan with deterministic, in-memory node handling. */
export class WorkflowOrchestrator {
  private readonly handler: WorkflowNodeHandler;
  private readonly onStatusChange?: WorkflowOrchestratorOptions["onStatusChange"];
  private readonly safetyGate: SafetyGate;

  constructor(handler: WorkflowNodeHandler, options: WorkflowOrchestratorOptions = {}) {
    this.handler = handler;
    this.onStatusChange = options.onStatusChange;
    this.safetyGate = options.safetyGate ?? new SafetyGate();
  }

  async execute(input: WorkflowPlan): Promise<WorkflowExecutionResult> {
    const plan = validateWorkflowPlan(input);
    const executions: Record<string, WorkflowNodeExecution> = {};
    const outputs: Record<string, unknown> = {};

    for (const node of plan.nodes) {
      executions[node.id] = { status: "pending" };
      this.onStatusChange?.(node, "pending");
    }

    // Validation guarantees this loop can make progress. Selecting the first ready
    // node in plan order makes execution deterministic without parallel side effects.
    const remaining = new Set(plan.nodes.map((node) => node.id));

    while (remaining.size > 0) {
      const node = plan.nodes.find(
        (candidate) =>
          remaining.has(candidate.id) &&
          candidate.dependencies.every((dependency) => executions[dependency].status !== "pending" && executions[dependency].status !== "running"),
      );

      if (!node) {
        // This is defensive: validateWorkflowPlan rejects cycles and malformed edges.
        throw new Error("Workflow could not make progress");
      }

      remaining.delete(node.id);
      const dependencyExecutions = node.dependencies.map((dependency) => executions[dependency]);
      if (dependencyExecutions.some((dependency) => dependency.status !== "succeeded")) {
        executions[node.id] = {
          status: "skipped",
          error: "Skipped because a dependency failed or was skipped",
        };
        this.onStatusChange?.(node, "skipped");
        continue;
      }

      executions[node.id] = { status: "running" };
      this.onStatusChange?.(node, "running");
      const dependencyOutputs = Object.fromEntries(node.dependencies.map((dependency) => [dependency, outputs[dependency]]));

      try {
        const decision = this.safetyGate.evaluateNode(node, { dependencyOutputs });
        if (!decision.allowed) {
          throw new SafetyGateBlockedError(decision);
        }
        const output = await this.handler(node, { dependencyOutputs });
        executions[node.id] = { status: "succeeded", output };
        outputs[node.id] = output;
        this.onStatusChange?.(node, "succeeded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        executions[node.id] = {
          status: "failed",
          output: error instanceof SafetyGateBlockedError ? error.decision : undefined,
          error: message,
          diagnosis: error instanceof SafetyGateBlockedError
            ? diagnosisFromSafetyDecision(error.decision)
            : diagnoseFailure(error instanceof DiagnosticFailure
              ? { errorCode: error.errorCode, message: error.message, metadata: error.metadata }
              : { errorCode: "UNKNOWN_FAILURE", message }),
        };
        if (error instanceof SafetyGateBlockedError) {
          outputs[node.id] = error.decision;
        }
        this.onStatusChange?.(node, "failed");
      }
    }

    return {
      status: Object.values(executions).some((execution) => execution.status === "failed") ? "failed" : "succeeded",
      nodes: executions,
      outputs,
    };
  }
}

export async function executeWorkflow(
  plan: WorkflowPlan,
  handler: WorkflowNodeHandler,
  options?: WorkflowOrchestratorOptions,
): Promise<WorkflowExecutionResult> {
  return new WorkflowOrchestrator(handler, options).execute(plan);
}
