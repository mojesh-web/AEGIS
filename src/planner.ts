import OpenAI from "openai";
import { WorkflowPlan, workflowPlanJsonSchema } from "./workflow/schema";
import { validateWorkflowPlan } from "./workflow/validate";

export interface Planner {
  createPlan(objective: string): Promise<WorkflowPlan>;
}

export interface GroqPlannerClient {
  chat: {
    completions: {
      create: (request: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: { type: "json_object" };
      }) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
}

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** Groq planner using only the OpenAI-compatible chat-completions JSON mode. */
export class GroqPlanner implements Planner {
  private readonly client: GroqPlannerClient;
  private readonly model: string;

  constructor(apiKey: string | undefined, model: string | undefined, client?: GroqPlannerClient) {
    if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
    if (!model) throw new Error("GROQ_MODEL is not configured");
    this.client = client ?? new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
    this.model = model;
  }

  async createPlan(objective: string): Promise<WorkflowPlan> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: `You are the AEGIS workflow planner. Return only a JSON workflow plan. Use specialist node types only: browser, code, research, validator. The JSON must match this shape and must include validation as either null or a validation object: ${JSON.stringify(workflowPlanJsonSchema)}`,
        },
        { role: "user", content: objective },
      ],
      response_format: { type: "json_object" },
    });

    const output = response.choices?.[0]?.message?.content;
    if (!output) throw new Error("Groq returned an empty plan");

    let decoded: unknown;
    try {
      decoded = JSON.parse(output);
    } catch {
      throw new Error("Groq returned invalid JSON for the workflow plan");
    }

    return validateWorkflowPlan(decoded);
  }
}
