import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AgentRequest, SpecialistAgent } from "./types";
import { ValidationContract, validationContractSchema } from "../workflow/schema";

const validatorContextSchema = z.object({ dependencyOutputs: z.record(z.string(), z.unknown()) });

export interface ValidationFinding {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

export interface ValidatorResult {
  readonly status: "passed" | "failed";
  readonly passed: boolean;
  readonly findings: readonly ValidationFinding[];
  readonly reason: string;
}

export interface ValidatorRequest extends AgentRequest {
  readonly node: AgentRequest["node"] & { type: "validator" };
  readonly contract?: unknown;
}

export class ValidatorAgent implements SpecialistAgent<ValidatorResult> {
  readonly nodeType = "validator" as const;

  execute(request: AgentRequest): ValidatorResult {
    return this.validate(request as ValidatorRequest);
  }

  validate(request: ValidatorRequest): ValidatorResult {
    const parsed = validatorContextSchema.safeParse(request.context);
    if (!parsed.success) {
      return this.failure("MALFORMED_INPUT", "Validator input was malformed or did not include dependency outputs.");
    }

    const contract = request.contract ?? request.node.validation;
    const contractResult = validationContractSchema.safeParse(contract);
    if (!contractResult.success) {
      return this.failure("MISSING_CONTRACT", "No valid validation contract was provided.");
    }

    return this.evaluate(contractResult.data, parsed.data.dependencyOutputs);
  }

  private evaluate(contract: ValidationContract, dependencyOutputs: Readonly<Record<string, unknown>>): ValidatorResult {
    const target = contract.target ? dependencyOutputs[contract.target] : dependencyOutputs;
    if (contract.target && !Object.prototype.hasOwnProperty.call(dependencyOutputs, contract.target)) {
      return this.failure("MISSING_TARGET", `Validation target '${contract.target}' was not present in dependency outputs.`);
    }

    if (contract.kind === "equals") {
      if (isDeepStrictEqual(target, contract.expected)) {
        return this.success("Dependency output matched the equals contract.");
      }
      return this.failure("VALUE_MISMATCH", "Dependency output did not match the expected value.");
    }

    if (typeof target !== "object" || target === null || Array.isArray(target)) {
      return this.failure("NOT_AN_OBJECT", "The validation target was not an object, so required fields could not be checked.");
    }

    const missingFields = contract.fields.filter((field) => !Object.prototype.hasOwnProperty.call(target, field));
    if (missingFields.length === 0) {
      return this.success(`Validation target contained all required fields: ${contract.fields.join(", ")}.`);
    }

    return {
      status: "failed",
      passed: false,
      findings: missingFields.map((field) => ({ code: "MISSING_FIELD", field, message: `Required field '${field}' was not present.` })),
      reason: `Validation target was missing required fields: ${missingFields.join(", ")}.`,
    };
  }

  private success(reason: string): ValidatorResult {
    return { status: "passed", passed: true, findings: [], reason };
  }

  private failure(code: string, reason: string): ValidatorResult {
    return { status: "failed", passed: false, findings: [{ code, message: reason }], reason };
  }
}
