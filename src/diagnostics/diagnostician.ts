import { z } from "zod";
import { safetyDecisionSchema, SafetyDecision } from "../safety/safety-gate";

export const diagnosisCategorySchema = z.enum([
  "environment_changed",
  "missing_capability",
  "wrong_plan",
  "bad_data",
  "unsafe_or_blocked",
]);

export const diagnosisResultSchema = z.object({
  category: diagnosisCategorySchema,
  reason: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  recommendedAction: z.string().min(1),
  retryable: z.boolean(),
});

const diagnosisMetadataSchema = z.object({
  environmentChanged: z.boolean().optional(),
  resourceChanged: z.boolean().optional(),
  capabilityAvailable: z.boolean().optional(),
  requiredCapability: z.string().min(1).optional(),
  inputPresent: z.boolean().optional(),
  schemaValid: z.boolean().optional(),
  workflowValid: z.boolean().optional(),
}).strict();

export const diagnosisInputSchema = z.object({
  errorCode: z.string().min(1),
  message: z.string().min(1).optional(),
  metadata: diagnosisMetadataSchema.optional(),
  safetyDecision: safetyDecisionSchema.optional(),
}).strict();

export type DiagnosisCategory = z.infer<typeof diagnosisCategorySchema>;
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;
export type DiagnosisInput = z.infer<typeof diagnosisInputSchema>;
export type DiagnosisMetadata = z.infer<typeof diagnosisMetadataSchema>;

export class DiagnosticFailure extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly metadata?: DiagnosisMetadata,
  ) {
    super(message);
    this.name = "DiagnosticFailure";
  }
}

/**
 * Deterministic failure classification. Rules use structured codes and metadata;
 * free-form messages are retained as evidence but never decide the category.
 */
export function diagnoseFailure(input: unknown): DiagnosisResult {
  const parsed = diagnosisInputSchema.safeParse(input);
  if (!parsed.success) {
    return result(
      "bad_data",
      "The diagnosis input was malformed, so the failure cannot be classified confidently.",
      ["Diagnosis input failed schema validation."],
      "Preserve the failure report and request structured failure metadata before taking action.",
      false,
    );
  }

  const diagnosis = parsed.data;
  const metadata = diagnosis.metadata;

  if (diagnosis.safetyDecision && !diagnosis.safetyDecision.allowed || diagnosis.errorCode === "SAFETY_BLOCKED") {
    const evidence = ["The Safety Gate returned an explicit blocked decision."];
    if (diagnosis.safetyDecision) evidence.push(`Policy rule: ${diagnosis.safetyDecision.policyRuleId}.`);
    return result(
      "unsafe_or_blocked",
      "The action was blocked by the independent Safety Gate and must not be retried automatically.",
      evidence,
      "Keep the action blocked; require an explicit policy review before changing the action.",
      false,
    );
  }

  if (
    diagnosis.errorCode === "ENVIRONMENT_CHANGED" ||
    diagnosis.errorCode === "RESOURCE_CHANGED" ||
    metadata?.environmentChanged === true ||
    metadata?.resourceChanged === true
  ) {
    return result(
      "environment_changed",
      "The failure has explicit evidence that the execution environment or a required resource changed.",
      evidenceFor(diagnosis, ["Environment or resource change was explicitly reported."]),
      "Re-check the current environment and resource state before considering a new execution.",
      true,
    );
  }

  if (
    diagnosis.errorCode === "MISSING_CAPABILITY" ||
    diagnosis.errorCode === "UNSUPPORTED_AGENT" ||
    metadata?.capabilityAvailable === false
  ) {
    const capability = metadata?.requiredCapability ? ` Required capability: ${metadata.requiredCapability}.` : "";
    return result(
      "missing_capability",
      `A required agent or tool capability is unavailable.${capability}`,
      evidenceFor(diagnosis, ["Capability availability was explicitly reported as missing."]),
      "Install, configure, or inject the required capability; do not retry the same execution unchanged.",
      false,
    );
  }

  if (
    diagnosis.errorCode === "INVALID_WORKFLOW" ||
    diagnosis.errorCode === "WORKFLOW_VALIDATION_FAILED" ||
    metadata?.workflowValid === false
  ) {
    return result(
      "wrong_plan",
      "The workflow structure is invalid or contradictory for the requested execution.",
      evidenceFor(diagnosis, ["Workflow validity was explicitly reported as false."]),
      "Correct the workflow dependencies or node definitions before executing it again.",
      false,
    );
  }

  if (
    diagnosis.errorCode === "MISSING_INPUT" ||
    diagnosis.errorCode === "SCHEMA_INVALID_INPUT" ||
    diagnosis.errorCode === "BAD_DATA" ||
    metadata?.inputPresent === false ||
    metadata?.schemaValid === false
  ) {
    return result(
      "bad_data",
      "Required input data is missing or does not satisfy its schema.",
      evidenceFor(diagnosis, ["Input presence or schema validity was explicitly reported as invalid."]),
      "Correct or provide the required input data before considering another execution.",
      false,
    );
  }

  return result(
    "bad_data",
    "The failure is ambiguous and lacks a recognized structured cause; diagnosis is conservative.",
    evidenceFor(diagnosis, ["No explicit Safety Gate, capability, workflow, data, or environment rule matched."]),
    "Preserve the evidence and require an explicit diagnosis before retrying or changing the workflow.",
    false,
  );
}

function evidenceFor(input: DiagnosisInput, extra: string[]): string[] {
  return [
    ...extra,
    `Structured error code: ${input.errorCode}.`,
    ...(input.message ? [`Reported message retained as evidence: ${input.message}`] : []),
  ];
}

function result(
  category: DiagnosisCategory,
  reason: string,
  evidence: string[],
  recommendedAction: string,
  retryable: boolean,
): DiagnosisResult {
  return diagnosisResultSchema.parse({ category, reason, evidence, recommendedAction, retryable });
}

export function diagnosisFromSafetyDecision(decision: SafetyDecision): DiagnosisResult {
  return diagnoseFailure({ errorCode: "SAFETY_BLOCKED", safetyDecision: decision });
}
