import { WorkflowPlan, workflowPlanSchema } from "./schema";

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export function validateWorkflowPlan(input: unknown): WorkflowPlan {
  const parsed = workflowPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkflowValidationError(`Invalid workflow plan: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  const plan = parsed.data;
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) {
      throw new WorkflowValidationError(`Duplicate node ID: ${node.id}`);
    }
    ids.add(node.id);
  }

  for (const node of plan.nodes) {
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) {
        throw new WorkflowValidationError(`Node '${node.id}' depends on missing node '${dependency}'`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));

  function visit(id: string): void {
    if (visiting.has(id)) throw new WorkflowValidationError(`Workflow contains a cycle involving node '${id}'`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }

  for (const node of plan.nodes) visit(node.id);
  return plan;
}
