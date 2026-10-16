export type NodeType = "browser" | "code" | "research" | "validator";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface ValidationContract {
  kind: "required-fields" | "equals";
  target?: string;
  fields?: string[];
  expected?: unknown;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  title: string;
  description: string;
  dependencies: string[];
  validation?: ValidationContract;
}

export interface WorkflowPlan {
  version: number;
  objective: string;
  nodes: WorkflowNode[];
}

export interface Diagnosis {
  category: string;
  reason: string;
  evidence: string[];
  recommendedAction: string;
  retryable: boolean;
}

export interface SafetyDecision {
  allowed: boolean;
  reason: string;
  policyRuleId: string;
  action: { type: string; input: Record<string, unknown> };
}

export interface NodeExecution {
  status: NodeStatus;
  output?: unknown;
  error?: string;
  diagnosis?: Diagnosis;
}

export interface ExecutionResult {
  status: "succeeded" | "failed";
  nodes: Record<string, NodeExecution>;
  outputs: Record<string, unknown>;
}

export interface ExecutionSnapshot {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  plan: WorkflowPlan;
  result?: ExecutionResult;
  error?: string;
}

export interface WorkflowChange {
  type: "add_node" | "remove_node" | "modify_node" | "change_dependencies";
  nodeId: string;
  explanation: string;
  node?: WorkflowNode;
  before?: unknown;
  after?: unknown;
}

export interface RecoveryAttempt {
  attempt: number;
  workflowVersion: number;
  workflow: WorkflowPlan;
  outcome: "succeeded" | "failed";
  result: ExecutionResult;
  diagnosis?: Diagnosis;
  proposal?: {
    hasRevision: boolean;
    changes: WorkflowChange[];
    revisedWorkflow?: WorkflowPlan;
    explanation: string;
    rejectionReason?: string;
  };
  diff?: { changes: WorkflowChange[] };
}

export interface RecoveryResult {
  status: "succeeded" | "stopped";
  finalOutcome: "succeeded" | "failed";
  attempts: RecoveryAttempt[];
  finalWorkflowVersion: number;
  stopReason: string;
}

export interface RecoverySnapshot {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  plan: WorkflowPlan;
  result?: RecoveryResult;
  error?: string;
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Backend request failed (${response.status})`);
  }
  return body as T;
}

export async function createPlan(objective: string): Promise<WorkflowPlan> {
  return apiRequest<WorkflowPlan>("/api/plan", { method: "POST", body: JSON.stringify({ objective }) });
}

export async function startExecution(plan: WorkflowPlan): Promise<{ executionId: string; status: string }> {
  return apiRequest("/api/executions", { method: "POST", body: JSON.stringify({ plan }) });
}

export async function getExecution(id: string): Promise<ExecutionSnapshot> {
  return apiRequest(`/api/executions/${id}`);
}

export async function startRecovery(plan: WorkflowPlan, context: Record<string, unknown> = {}): Promise<{ recoveryId: string; status: string }> {
  return apiRequest("/api/recoveries", { method: "POST", body: JSON.stringify({ plan, context }) });
}

export async function getRecovery(id: string): Promise<RecoverySnapshot> {
  return apiRequest(`/api/recoveries/${id}`);
}

export async function waitFor<T>(read: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await read();
    if (isDone(value)) return value;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("The backend did not finish within the dashboard polling window.");
}
