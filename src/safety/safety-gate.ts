import { z } from "zod";
import type { WorkflowNode } from "../workflow/schema";
import type { WorkflowNodeContext } from "../orchestrator";

export const allowedActionTypeSchema = z.enum([
  "validator.validate",
  "browser.read",
  "research.read",
  "code.compute",
]);

export const safetyActionSchema = z.object({
  type: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
}).strict();

export const safetyDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().min(1),
  policyRuleId: z.string().min(1),
  action: safetyActionSchema,
});

export type AllowedActionType = z.infer<typeof allowedActionTypeSchema>;
export type SafetyAction = z.infer<typeof safetyActionSchema>;

export interface SafetyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly policyRuleId: string;
  readonly action: SafetyAction;
}

const nodeActionTypes: Record<WorkflowNode["type"], AllowedActionType> = {
  validator: "validator.validate",
  browser: "browser.read",
  research: "research.read",
  code: "code.compute",
};

const destructiveActionTypes = new Set([
  "file.delete",
  "record.delete",
  "shell.execute",
  "secret.exfiltrate",
  "external.write",
]);

/** Deterministic policy boundary. Unknown and malformed actions fail closed. */
export class SafetyGate {
  evaluate(input: unknown): SafetyDecision {
    const action = this.normalizedAction(input);
    const parsed = safetyActionSchema.safeParse(input);
    if (!parsed.success) {
      return this.block(action, "Safety action input was missing or malformed.", "safety.invalid-input");
    }

    if (!allowedActionTypeSchema.safeParse(parsed.data.type).success) {
      const policyRuleId = destructiveActionTypes.has(parsed.data.type)
        ? "safety.destructive-action"
        : "safety.unknown-action";
      const reason = destructiveActionTypes.has(parsed.data.type)
        ? `Action type '${parsed.data.type}' is destructive and is blocked by policy.`
        : `Action type '${parsed.data.type}' is not allowlisted.`;
      return this.block(parsed.data, reason, policyRuleId);
    }

    return {
      allowed: true,
      reason: `Action type '${parsed.data.type}' is explicitly allowlisted as benign for this milestone.`,
      policyRuleId: "safety.allowlisted-benign-action",
      action: parsed.data,
    };
  }

  evaluateNode(node: WorkflowNode, context: WorkflowNodeContext): SafetyDecision {
    return this.evaluate({
      type: nodeActionTypes[node.type],
      // Policy uses only typed execution metadata. Node descriptions and planner text
      // are deliberately excluded from the authorization decision.
      input: {
        nodeId: node.id,
        nodeType: node.type,
        dependencyCount: Object.keys(context.dependencyOutputs).length,
      },
    });
  }

  private normalizedAction(input: unknown): SafetyAction {
    if (typeof input === "object" && input !== null && "type" in input && typeof input.type === "string") {
      const candidate = input as { type: string; input?: unknown };
      return {
        type: candidate.type,
        input: typeof candidate.input === "object" && candidate.input !== null && !Array.isArray(candidate.input)
          ? candidate.input as Record<string, unknown>
          : {},
      };
    }
    return { type: "<malformed>", input: {} };
  }

  private block(action: SafetyAction, reason: string, policyRuleId: string): SafetyDecision {
    return { allowed: false, reason, policyRuleId, action };
  }
}

export class SafetyGateBlockedError extends Error {
  constructor(readonly decision: SafetyDecision) {
    super(`Safety Gate blocked action: ${decision.reason}`);
    this.name = "SafetyGateBlockedError";
  }
}
