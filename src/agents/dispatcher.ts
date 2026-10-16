import { WorkflowNodeHandler } from "../orchestrator";
import { AgentRequest, SpecialistAgent, SpecialistHandler } from "./types";
import { ValidatorAgent } from "./validator";

export type AgentHandlers = Partial<Record<AgentRequest["node"]["type"], SpecialistHandler>>;

export interface AgentDispatcherOptions {
  readonly validator?: SpecialistAgent;
  readonly handlers?: AgentHandlers;
}

/** Routes workflow nodes to typed specialists while keeping placeholder agents deterministic. */
export class AgentDispatcher {
  private readonly validator: SpecialistAgent;
  private readonly handlers: AgentHandlers;

  constructor(options: AgentDispatcherOptions = {}) {
    this.validator = options.validator ?? new ValidatorAgent();
    this.handlers = options.handlers ?? {};
  }

  async dispatch(request: AgentRequest): Promise<unknown> {
    if (request.node.type === "validator") {
      return this.validator.execute(request);
    }

    const handler = this.handlers[request.node.type];
    if (handler) {
      return handler(request);
    }

    return {
      nodeId: request.node.id,
      type: request.node.type,
      status: "placeholder",
      description: request.node.description,
      dependencyOutputs: request.context.dependencyOutputs,
    };
  }

  asWorkflowNodeHandler(): WorkflowNodeHandler {
    return (node, context) => this.dispatch({ node, context });
  }
}
