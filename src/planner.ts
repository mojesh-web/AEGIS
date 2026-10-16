import OpenAI from "openai";
import { WorkflowPlan, workflowPlanJsonSchema } from "./workflow/schema";
import { validateWorkflowPlan } from "./workflow/validate";

export interface Planner {
  createPlan(objective: string): Promise<WorkflowPlan>;
}

export class OpenAIPlanner implements Planner {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string | undefined, model: string | undefined) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    if (!model) throw new Error("OPENAI_MODEL is not configured");
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async createPlan(objective: string): Promise<WorkflowPlan> {
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: "system",
          content: "You are the AEGIS workflow planner. Return only a safe, dependency-correct workflow plan. Use specialist node types only: browser, code, research, validator.",
        },
        { role: "user", content: objective },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "workflow_plan",
          strict: true,
          schema: workflowPlanJsonSchema,
        },
      },
    });

    if (!response.output_text) throw new Error("OpenAI returned an empty plan");
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.output_text);
    } catch {
      throw new Error("OpenAI returned invalid JSON for the workflow plan");
    }
    return validateWorkflowPlan(decoded);
  }
}
