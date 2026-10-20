import { z } from "zod";

export const nodeTypeSchema = z.enum(["browser", "code", "research", "validator"]);

export const validationContractSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("required-fields"),
    target: z.string().min(1).optional(),
    fields: z.array(z.string().min(1)).min(1).max(100),
  }),
  z.object({
    kind: z.literal("equals"),
    target: z.string().min(1).optional(),
    expected: z.unknown(),
  }),
]);

export const workflowNodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "Node IDs must start with a lowercase letter and contain only a-z, 0-9, _ or -"),
  type: nodeTypeSchema,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  dependencies: z.array(z.string()).max(50),
  validation: validationContractSchema.nullable().optional(),
});

export const workflowPlanSchema = z.object({
  version: z.number().int().positive(),
  objective: z.string().min(1).max(4000),
  nodes: z.array(workflowNodeSchema).min(1).max(100),
});

export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type ValidationContract = z.infer<typeof validationContractSchema>;

export const workflowPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "objective", "nodes"],
  properties: {
    version: { type: "integer", minimum: 1 },
    objective: { type: "string", minLength: 1, maxLength: 4000 },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "title", "description", "dependencies", "validation"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_-]*$" },
          type: { type: "string", enum: ["browser", "code", "research", "validator"] },
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", minLength: 1, maxLength: 2000 },
          dependencies: { type: "array", maxItems: 50, items: { type: "string" } },
          validation: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["kind", "target", "fields", "expected"],
            properties: {
              kind: { type: "string", enum: ["required-fields", "equals"] },
              target: { type: ["string", "null"] },
              fields: { type: ["array", "null"], minItems: 1, maxItems: 100, items: { type: "string", minLength: 1 } },
              expected: {},
            },
          },
        },
      },
    },
  },
} as const;
