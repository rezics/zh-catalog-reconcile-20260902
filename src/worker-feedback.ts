export type DecisionWorkerFeedbackCode =
	| "assignment_invalid"
	| "basis_invalid"
	| "citation_invalid"
	| "decision_validation_invalid"
	| "disposition_evidence_invalid"
	| "output_schema_invalid"
	| "uncertainty_invalid";

export type DecisionWorkerFeedbackIssue =
	| "assignment_contract"
	| "basis_claim_contract"
	| "citation_contract"
	| "decision_contract"
	| "disposition_evidence_contract"
	| "distinct_candidate_missing_non_source_candidate"
	| "distinct_candidate_missing_source"
	| "output_schema_contract"
	| "uncertainty_contract";

export type DecisionWorkerFeedback = {
	readonly category: DecisionWorkerFeedbackCode;
	readonly issue: DecisionWorkerFeedbackIssue;
};

export class DecisionWorkerValidationError extends Error {
	readonly feedback: DecisionWorkerFeedback;

	constructor(message: string, feedback: DecisionWorkerFeedback) {
		super(message);
		this.name = "DecisionWorkerValidationError";
		this.feedback = feedback;
	}
}

export function workerValidationError(
	message: string,
	category: DecisionWorkerFeedbackCode,
	issue: DecisionWorkerFeedbackIssue,
): DecisionWorkerValidationError {
	return new DecisionWorkerValidationError(message, { category, issue });
}
