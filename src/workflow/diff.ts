import { z } from "zod";
import { WorkflowNode, WorkflowPlan, workflowNodeSchema } from "./schema";

export const workflowChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), nodeId: z.string(), explanation: z.string(), node: workflowNodeSchema }),
  z.object({ type: z.literal("remove_node"), nodeId: z.string(), explanation: z.string(), node: workflowNodeSchema }),
  z.object({ type: z.literal("modify_node"), nodeId: z.string(), explanation: z.string(), before: workflowNodeSchema, after: workflowNodeSchema }),
  z.object({ type: z.literal("change_dependencies"), nodeId: z.string(), explanation: z.string(), before: z.array(z.string()), after: z.array(z.string()) }),
]);

export type WorkflowChange = z.infer<typeof workflowChangeSchema>;

export interface WorkflowDiff {
  readonly changes: readonly WorkflowChange[];
  readonly addedNodeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  readonly modifiedNodeIds: readonly string[];
  readonly dependencyChangedNodeIds: readonly string[];
}

/** Creates a stable, order-preserving diff without modifying either workflow. */
export function diffWorkflows(original: WorkflowPlan, revised: WorkflowPlan): WorkflowDiff {
  const originalById = new Map(original.nodes.map((node) => [node.id, node]));
  const revisedById = new Map(revised.nodes.map((node) => [node.id, node]));
  const changes: WorkflowChange[] = [];

  for (const node of revised.nodes) {
    if (!originalById.has(node.id)) {
      changes.push({ type: "add_node", nodeId: node.id, explanation: `Added node '${node.id}'.`, node });
    }
  }

  for (const node of original.nodes) {
    if (!revisedById.has(node.id)) {
      changes.push({ type: "remove_node", nodeId: node.id, explanation: `Removed node '${node.id}'.`, node });
    }
  }

  for (const originalNode of original.nodes) {
    const revisedNode = revisedById.get(originalNode.id);
    if (!revisedNode) continue;

    const { dependencies: originalDependencies, ...originalWithoutDependencies } = originalNode;
    const { dependencies: revisedDependencies, ...revisedWithoutDependencies } = revisedNode;
    if (JSON.stringify(originalWithoutDependencies) !== JSON.stringify(revisedWithoutDependencies)) {
      changes.push({
        type: "modify_node",
        nodeId: originalNode.id,
        explanation: `Modified node '${originalNode.id}'.`,
        before: originalNode,
        after: revisedNode,
      });
    }
    if (JSON.stringify(originalDependencies) !== JSON.stringify(revisedDependencies)) {
      changes.push({
        type: "change_dependencies",
        nodeId: originalNode.id,
        explanation: `Changed dependencies for node '${originalNode.id}'.`,
        before: originalDependencies,
        after: revisedDependencies,
      });
    }
  }

  return {
    changes,
    addedNodeIds: changes.filter((change) => change.type === "add_node").map((change) => change.nodeId),
    removedNodeIds: changes.filter((change) => change.type === "remove_node").map((change) => change.nodeId),
    modifiedNodeIds: changes.filter((change) => change.type === "modify_node").map((change) => change.nodeId),
    dependencyChangedNodeIds: changes.filter((change) => change.type === "change_dependencies").map((change) => change.nodeId),
  };
}
