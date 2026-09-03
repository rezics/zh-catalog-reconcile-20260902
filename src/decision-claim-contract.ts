import type { DecisionBasisCode, DecisionEvidenceCitation, SourceDecision } from "./contracts.ts";

export type ActionDisposition = Exclude<SourceDecision["disposition"], "review">;
export type BasisCitationUnitRule =
	| "source-only"
	| "source-required"
	| "source-and-target"
	| "source-and-non-source-candidate";

export type BasisClaimContract = {
	readonly dispositions: readonly ActionDisposition[];
	readonly citationFields: readonly DecisionEvidenceCitation["field"][];
	readonly citationUnitRule: BasisCitationUnitRule;
	readonly note?: string;
};

export const IdentityEvidenceFieldValues = [
	"localization_title",
	"localization_summary",
	"localization_description",
	"alias",
	"attribution",
	"book_isbn13",
	"book_publication_date",
	"book_page_count",
	"book_word_count",
	"suspicious_signal",
] as const satisfies readonly DecisionEvidenceCitation["field"][];

export const SynopsisFieldValues = [
	"localization_summary",
	"localization_description",
] as const satisfies readonly DecisionEvidenceCitation["field"][];

export const TitleFieldValues = [
	"localization_title",
	"alias",
] as const satisfies readonly DecisionEvidenceCitation["field"][];

export const TitleVariantEvidenceFieldValues = [
	...TitleFieldValues,
	...SynopsisFieldValues,
] as const satisfies readonly DecisionEvidenceCitation["field"][];

export const CorrectionEvidenceFieldValues = [
	...IdentityEvidenceFieldValues,
	"book_release_status",
] as const satisfies readonly DecisionEvidenceCitation["field"][];

const sourceOnly = "source-only" as const;
const sourceAndTarget = "source-and-target" as const;

export const BasisClaimContracts = {
	booklike_title: {
		dispositions: ["keep"],
		citationFields: TitleFieldValues,
		citationUnitRule: sourceOnly,
	},
	synopsis_describes_work: {
		dispositions: ["keep"],
		citationFields: SynopsisFieldValues,
		citationUnitRule: sourceOnly,
	},
	author_attribution_present: {
		dispositions: ["keep"],
		citationFields: ["attribution"],
		citationUnitRule: sourceOnly,
	},
	identifier_present: {
		dispositions: ["keep"],
		citationFields: ["book_isbn13"],
		citationUnitRule: sourceOnly,
	},
	distinct_candidate_evidence: {
		dispositions: ["keep"],
		citationFields: IdentityEvidenceFieldValues,
		citationUnitRule: "source-and-non-source-candidate",
		note: "Use only when cited stored differences support a distinct-work conclusion; ordinary keep does not require this optional basis.",
	},
	same_title: {
		dispositions: ["merge"],
		citationFields: ["localization_title"],
		citationUnitRule: sourceAndTarget,
	},
	title_variant_same_work: {
		dispositions: ["merge"],
		citationFields: TitleVariantEvidenceFieldValues,
		citationUnitRule: sourceAndTarget,
		note: "Synopsis fields may be used only when their stored text explicitly states the alternate title.",
	},
	same_synopsis: {
		dispositions: ["merge"],
		citationFields: SynopsisFieldValues,
		citationUnitRule: sourceAndTarget,
	},
	same_attribution: {
		dispositions: ["merge"],
		citationFields: ["attribution"],
		citationUnitRule: sourceAndTarget,
	},
	same_identifier: {
		dispositions: ["merge"],
		citationFields: ["book_isbn13"],
		citationUnitRule: sourceAndTarget,
	},
	query_like_title: {
		dispositions: ["soft_delete"],
		citationFields: ["localization_title", "suspicious_signal"],
		citationUnitRule: sourceOnly,
	},
	question_like_title: {
		dispositions: ["soft_delete"],
		citationFields: ["localization_title", "suspicious_signal"],
		citationUnitRule: sourceOnly,
	},
	character_identity: {
		dispositions: ["soft_delete"],
		citationFields: IdentityEvidenceFieldValues,
		citationUnitRule: sourceOnly,
	},
	person_or_entity_identity: {
		dispositions: ["soft_delete"],
		citationFields: IdentityEvidenceFieldValues,
		citationUnitRule: sourceOnly,
	},
	malformed_metadata: {
		dispositions: ["soft_delete"],
		citationFields: IdentityEvidenceFieldValues,
		citationUnitRule: sourceOnly,
	},
	placeholder_metadata: {
		dispositions: ["soft_delete"],
		citationFields: IdentityEvidenceFieldValues,
		citationUnitRule: sourceOnly,
	},
	non_book_identity: {
		dispositions: ["soft_delete"],
		citationFields: IdentityEvidenceFieldValues,
		citationUnitRule: sourceOnly,
	},
	metadata_correction_supported: {
		dispositions: ["revise"],
		citationFields: CorrectionEvidenceFieldValues,
		citationUnitRule: "source-required",
	},
	attribution_correction_supported: {
		dispositions: ["revise"],
		citationFields: ["attribution"],
		citationUnitRule: "source-required",
	},
} as const satisfies Record<DecisionBasisCode, BasisClaimContract>;

const UnitRuleInstructions: Readonly<Record<BasisCitationUnitRule, string>> = {
	"source-only": "every citation must name sourceUnitId",
	"source-required": "citations must include sourceUnitId",
	"source-and-target": "citations must include sourceUnitId and targetUnitId",
	"source-and-non-source-candidate":
		"citations must include sourceUnitId and at least one packet candidate whose ID differs from sourceUnitId",
};

export function renderBasisClaimContract(): string {
	return (Object.entries(BasisClaimContracts) as [DecisionBasisCode, BasisClaimContract][])
		.map(([code, contract]) => {
			const suffix = contract.note === undefined ? "" : ` ${contract.note}`;
			return `- ${code} [${contract.dispositions.join("|")}]: fields=${contract.citationFields.join(",")}; ${UnitRuleInstructions[contract.citationUnitRule]}.${suffix}`;
		})
		.join("\n");
}
