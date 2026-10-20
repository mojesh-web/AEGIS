import express, { ErrorRequestHandler } from "express";
import { Planner, GroqPlanner } from "./planner";
import { WorkflowOrchestrator } from "./orchestrator";
import { ExecutionService, WorkflowExecutionService } from "./execution-service";
import { validateWorkflowPlan, WorkflowValidationError } from "./workflow/validate";
import { AgentDispatcher } from "./agents/dispatcher";
import { RecoveryService, WorkflowRecoveryService } from "./recovery/service";
import { RecoveryController } from "./recovery/controller";
import { WorkflowArchitect, failureContextSchema } from "./workflow/architect";

export function createApp(planner?: Planner, orchestrator?: WorkflowOrchestrator, executionService?: ExecutionService, recoveryService?: RecoveryService) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  const activeOrchestrator = orchestrator ?? new WorkflowOrchestrator(new AgentDispatcher().asWorkflowNodeHandler());
  const activeExecutionService = executionService ?? new WorkflowExecutionService(activeOrchestrator);
  const activeRecoveryService = recoveryService ?? new WorkflowRecoveryService(new RecoveryController(activeOrchestrator, new WorkflowArchitect()));

  app.get("/", (_request, response) => {
    response.json({
      name: "AEGIS",
      status: "running",
      endpoints: ["GET /health", "POST /api/plan", "POST /api/execute", "POST /api/executions", "GET /api/executions/:id", "POST /api/recoveries", "GET /api/recoveries/:id"],
    });
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/api/plan", async (request, response, next) => {
    try {
      const objective = request.body?.objective;
      if (typeof objective !== "string" || objective.trim().length === 0) {
        response.status(400).json({ error: "objective must be a non-empty string" });
        return;
      }
      if (objective.length > 4000) {
        response.status(400).json({ error: "objective must be 4000 characters or fewer" });
        return;
      }
      const activePlanner = planner ?? new GroqPlanner(process.env.GROQ_API_KEY, process.env.GROQ_MODEL);
      const plan = validateWorkflowPlan(await activePlanner.createPlan(objective.trim()));
      response.status(200).json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/execute", async (request, response, next) => {
    try {
      const plan = validateWorkflowPlan(request.body?.plan);
      const result = await activeOrchestrator.execute(plan);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/executions", (request, response, next) => {
    try {
      const plan = validateWorkflowPlan(request.body?.plan);
      const executionId = activeExecutionService.start(plan);
      response.status(202).json({ executionId, status: "queued" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/executions/:id", (request, response, next) => {
    try {
      const snapshot = activeExecutionService.get(request.params.id);
      if (!snapshot) {
        response.status(404).json({ error: "Execution not found" });
        return;
      }
      response.status(200).json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/recoveries", (request, response, next) => {
    try {
      const plan = validateWorkflowPlan(request.body?.plan);
      const contextResult = failureContextSchema.safeParse(request.body?.context ?? {});
      if (!contextResult.success) {
        response.status(400).json({ error: `Invalid recovery context: ${contextResult.error.issues.map((issue) => issue.message).join("; ")}` });
        return;
      }
      const recoveryId = activeRecoveryService.start(plan, contextResult.data);
      response.status(202).json({ recoveryId, status: "queued" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/recoveries/:id", (request, response) => {
    const snapshot = activeRecoveryService.get(request.params.id);
    if (!snapshot) {
      response.status(404).json({ error: "Recovery not found" });
      return;
    }
    response.status(200).json(snapshot);
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    if (error instanceof WorkflowValidationError) {
      response.status(400).json({ error: message });
      return;
    }
    if (message.startsWith("Execution service")) {
      response.status(500).json({ error: "Execution service failed" });
      return;
    }
    if (message.includes("not configured")) {
      response.status(503).json({ error: "Planning service is not configured", details: message });
      return;
    }
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    if (status === 401 || status === 403) {
      response.status(502).json({ error: "Groq API authentication failed" });
      return;
    }
    response.status(502).json({ error: "Planning service failed", details: message });
  };
  app.use(errorHandler);
  return app;
}
