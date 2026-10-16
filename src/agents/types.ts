import type { WorkflowNode } from "../workflow/schema";
import type { WorkflowNodeContext } from "../orchestrator";

export type AgentNodeType = WorkflowNode["type"];

export interface AgentRequest {
  readonly node: WorkflowNode;
  readonly context: WorkflowNodeContext;
}

/** A typed specialist boundary. Agents receive only the node and dependency outputs. */
export interface SpecialistAgent<TOutput = unknown> {
  readonly nodeType: AgentNodeType;
  execute(request: AgentRequest): TOutput | Promise<TOutput>;
}

export type SpecialistHandler = SpecialistAgent["execute"];
