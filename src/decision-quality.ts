import { join } from "node:path";

import {
	type BookEvidence,
	CurrentDecisionPolicyRevision,
	type DecisionBasis,
	type DecisionBasisCode,
	type DecisionEvidenceCitation,
	type DecisionQualityIssue,
	DecisionQualityIssueSchema,
	type DecisionQualityReport,
	DecisionQualityReportSchema,
	type EvidenceGroundedSourceDecision,
	type JsonValue,
	type PersistedSourceDecision,
	PersistedSourceDecisionSchema,
	type ReviewPacket,
	ReviewPacketSchema,
	type RevisionPatch,
	type RunConfig,
	SchemaVersion,
	type SourceDecision,
} from "./contracts.ts";
import {
	listPartFiles,
	nowIso,
	partFileName,
	pathExists,
	readJsonLines,
	runDirectory,
	writeJsonAtomic,
} from "./io.ts";

const MaximumSampleIssues = 100;
const BlanketReviewMinimum = 10;
const DuplicateExplanationMinimum = 3;
const IdentityEvidenceFields = new Set<DecisionEvidenceCitation["field"]>([
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
]);
const SynopsisFields = new Set<DecisionEvidenceCitation["field"]>([
	"localization_summary",
	"localization_description",
]);
const TitleFields = new Set<DecisionEvidenceCitation["field"]>(["localization_title", "alias"]);
const CorrectionEvidenceFields = new Set<DecisionEvidenceCitation["field"]>([
	...IdentityEvidenceFields,
	"book_release_status",
]);

function revisionEvidenceField(patch: RevisionPatch): DecisionEvidenceCitation["field"] {
	switch (patch.kind) {
		case "localization_text_field":
			return patch.field === "title" ? "localization_title" : "localization_summary";
		case "localization_description":
			return "localization_description";
		case "book_release_status":
			return "book_release_status";
		case "book_isbn13":
			return "book_isbn13";
		case "book_publication_date":
			return "book_publication_date";
		case "book_page_count":
			return "book_page_count";
		case "book_word_count":
			return "book_word_count";
		case "credit_replacement":
			return "attribution";
	}
}

function packetEvidenceIds(packet: ReviewPacket): Set<string> {
	const ids = new Set(packet.candidates.map(({ id }) => id));
	for (const candidate of packet.candidates)
		for (const attribution of candidate.attributions) ids.add(attribution.creditedUnitId);
	return ids;
}

function normalizedText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

function jsonStrings(value: JsonValue): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(jsonStrings);
	if (value && typeof value === "object") return Object.values(value).flatMap(jsonStrings);
	return [];
}

function citationValues(
	packet: ReviewPacket,
	book: BookEvidence,
	citation: DecisionEvidenceCitation,
): string[] {
	switch (citation.field) {
		case "localization_title":
			return book.localizations.flatMap(({ title }) => (title === null ? [] : [title]));
		case "localization_summary":
			return book.localizations.flatMap(({ summary }) => (summary === null ? [] : [summary]));
		case "localization_description":
			return book.localizations.flatMap(({ description }) =>
				description === null ? [] : jsonStrings(description),
			);
		case "alias":
			return book.aliases.map(({ term }) => term);
		case "attribution":
			return book.attributions.flatMap((attribution) => [
				attribution.role,
				attribution.creditedUnitId,
				attribution.creditedUnitKind,
				...(attribution.entityKind === null ? [] : [attribution.entityKind]),
				...attribution.localizations.flatMap(({ title, summary }) => [
					...(title === null ? [] : [title]),
					...(summary === null ? [] : [summary]),
				]),
			]);
		case "book_release_status":
			return [book.details.releaseStatus];
		case "book_isbn13":
			return book.details.isbn13 === null ? [] : [book.details.isbn13];
		case "book_publication_date":
			return book.details.publicationDate === null ? [] : [book.details.publicationDate];
		case "book_page_count":
			return book.details.pageCount === null ? [] : [String(book.details.pageCount)];
		case "book_word_count":
			return book.details.wordCount === null ? [] : [String(book.details.wordCount)];
		case "unit_created_at":
			return [book.createdAt];
		case "unit_updated_at":
			return [book.updatedAt];
		case "localization_languages":
			return [...book.localizationLanguages, book.localizationLanguages.join(",")];
		case "suspicious_signal":
			return packet.suspiciousSignals[citation.unitId] ?? [];
	}
}

function validateCitation(packet: ReviewPacket, citation: DecisionEvidenceCitation): void {
	const book = packet.candidates.find(({ id }) => id === citation.unitId);
	if (!book) throw new Error(`Decision citation Unit is outside the packet: ${citation.unitId}`);
	const excerpt = normalizedText(citation.excerpt);
	if (
		!citationValues(packet, book, citation).some((value) => normalizedText(value).includes(excerpt))
	)
		throw new Error(
			`Decision citation does not match stored ${citation.field} evidence for ${citation.unitId}`,
		);
}

export function isCurrentDecision(decision: PersistedSourceDecision): decision is SourceDecision {
	return !("explanation" in decision);
}

export function isEvidenceGroundedV2Decision(
	decision: PersistedSourceDecision,
): decision is EvidenceGroundedSourceDecision {
	return "citations" in decision && "explanation" in decision;
}

export function validateDecisionBindingAgainstPacket(
	config: RunConfig,
	packet: ReviewPacket,
	decision: PersistedSourceDecision,
): void {
	if (decision.runId !== config.runId || packet.runId !== config.runId)
		throw new Error("Run ID mismatch");
	if (decision.part !== packet.part) throw new Error("Decision part does not match packet part");
	if (decision.packetId !== packet.packetId || decision.inputHash !== packet.inputHash)
		throw new Error("Decision is not bound to the packet hash");
	if (!packet.sourceUnitIds.includes(decision.sourceUnitId))
		throw new Error(`Decision source is not a packet source: ${decision.sourceUnitId}`);
	const source = packet.candidates.find(({ id }) => id === decision.sourceUnitId);
	if (!source?.sourceEligible)
		throw new Error(`Decision attempts to mutate a protected source: ${decision.sourceUnitId}`);

	const evidenceIds = packetEvidenceIds(packet);
	if ("evidenceUnitIds" in decision) {
		if (!decision.evidenceUnitIds.includes(decision.sourceUnitId))
			throw new Error("Decision evidence must include the source Unit");
		for (const evidenceUnitId of decision.evidenceUnitIds)
			if (!evidenceIds.has(evidenceUnitId))
				throw new Error(`Decision cites evidence outside the packet: ${evidenceUnitId}`);
	}

	if (decision.disposition === "merge") {
		if (decision.targetUnitId === decision.sourceUnitId)
			throw new Error("A Unit cannot merge into itself");
		if (!packet.candidates.some(({ id }) => id === decision.targetUnitId))
			throw new Error(`Merge target is outside the packet: ${decision.targetUnitId}`);
	}
	if (decision.disposition === "revise") {
		for (const patch of decision.patches) {
			for (const evidenceUnitId of patch.evidenceUnitIds)
				if (!evidenceIds.has(evidenceUnitId))
					throw new Error(`Revision patch cites evidence outside the packet: ${evidenceUnitId}`);
			if (patch.kind === "credit_replacement" && !evidenceIds.has(patch.creditedUnitId))
				throw new Error(`Replacement credit is outside the packet: ${patch.creditedUnitId}`);
		}
	}
}

function validateCitationSet(
	packet: ReviewPacket,
	citations: readonly DecisionEvidenceCitation[],
): void {
	const citationKeys = new Set<string>();
	for (const citation of citations) {
		const key = `${citation.unitId}\u0000${citation.field}\u0000${normalizedText(citation.excerpt)}`;
		if (citationKeys.has(key)) throw new Error("Decision contains a duplicate evidence citation");
		citationKeys.add(key);
		validateCitation(packet, citation);
	}
}

export function validateEvidenceGroundedV2DecisionAgainstPacket(
	config: RunConfig,
	packet: ReviewPacket,
	decision: EvidenceGroundedSourceDecision,
): void {
	if (config.decisionPolicyRevision !== "evidence-grounded-v2")
		throw new Error(`Decision contract does not match run policy ${config.decisionPolicyRevision}`);
	validateDecisionBindingAgainstPacket(config, packet, decision);
	validateCitationSet(packet, decision.citations);
	for (const citation of decision.citations)
		if (!decision.evidenceUnitIds.includes(citation.unitId))
			throw new Error(`Decision evidenceUnitIds omit cited Unit: ${citation.unitId}`);
	if (
		!decision.citations.some(
			({ unitId, field }) => unitId === decision.sourceUnitId && IdentityEvidenceFields.has(field),
		)
	)
		throw new Error("Decision must cite concrete stored evidence from the source Unit");
	const explanation = normalizedText(decision.explanation);
	if (
		!decision.citations.some(
			({ field, excerpt }) =>
				IdentityEvidenceFields.has(field) && explanation.includes(normalizedText(excerpt)),
		)
	)
		throw new Error("Decision explanation must mention at least one cited evidence excerpt");

	if (decision.disposition === "merge") {
		if (!decision.evidenceUnitIds.includes(decision.targetUnitId))
			throw new Error("Merge evidence must include the target Unit");
		if (
			!decision.citations.some(
				({ unitId, field }) =>
					unitId === decision.targetUnitId && IdentityEvidenceFields.has(field),
			)
		)
			throw new Error("Merge decision must cite concrete stored evidence from the target Unit");
	}
	if (decision.disposition === "review") {
		const evidenceIds = packetEvidenceIds(packet);
		const candidateIds = new Set(packet.candidates.map(({ id }) => id));
		for (const uncertainty of decision.uncertainties) {
			for (const relatedUnitId of uncertainty.relatedUnitIds) {
				if (!evidenceIds.has(relatedUnitId))
					throw new Error(
						`Review uncertainty references evidence outside the packet: ${relatedUnitId}`,
					);
				if (!decision.evidenceUnitIds.includes(relatedUnitId))
					throw new Error(`Decision evidenceUnitIds omit uncertainty Unit: ${relatedUnitId}`);
			}
			if (
				uncertainty.kind === "candidate_identity_ambiguous" &&
				!uncertainty.relatedUnitIds.some(
					(unitId) => unitId !== decision.sourceUnitId && candidateIds.has(unitId),
				)
			)
				throw new Error("Candidate ambiguity must identify a non-source candidate Unit");
		}
	}
}

function citationsForIndexes(
	decision: SourceDecision,
	indexes: readonly number[],
	usedIndexes: Set<number>,
	label: string,
): DecisionEvidenceCitation[] {
	const citations: DecisionEvidenceCitation[] = [];
	const uniqueIndexes = new Set<number>();
	for (const index of indexes) {
		if (uniqueIndexes.has(index)) throw new Error(`${label} repeats citation index ${index}`);
		uniqueIndexes.add(index);
		const citation = decision.citations[index];
		if (!citation) throw new Error(`${label} references missing citation index ${index}`);
		usedIndexes.add(index);
		citations.push(citation);
	}
	return citations;
}

function requireOnly(
	code: string,
	citations: readonly DecisionEvidenceCitation[],
	predicate: (citation: DecisionEvidenceCitation) => boolean,
): void {
	if (!citations.every(predicate))
		throw new Error(`Basis ${code} contains a citation that does not prove that claim`);
}

function requireUnits(
	code: string,
	citations: readonly DecisionEvidenceCitation[],
	unitIds: readonly string[],
): void {
	for (const unitId of unitIds)
		if (!citations.some((citation) => citation.unitId === unitId))
			throw new Error(`Basis ${code} must cite Unit ${unitId}`);
}

function validateBasisClaim(
	decision: Exclude<SourceDecision, { readonly disposition: "review" }>,
	basis: DecisionBasis,
	citations: readonly DecisionEvidenceCitation[],
): void {
	const sourceId = decision.sourceUnitId;
	const targetId = decision.disposition === "merge" ? decision.targetUnitId : null;
	switch (basis.code) {
		case "booklike_title":
			requireOnly(
				basis.code,
				citations,
				(citation) => citation.unitId === sourceId && TitleFields.has(citation.field),
			);
			return;
		case "synopsis_describes_work":
			requireOnly(
				basis.code,
				citations,
				(citation) => citation.unitId === sourceId && SynopsisFields.has(citation.field),
			);
			return;
		case "author_attribution_present":
			requireOnly(
				basis.code,
				citations,
				(citation) => citation.unitId === sourceId && citation.field === "attribution",
			);
			return;
		case "identifier_present":
			requireOnly(
				basis.code,
				citations,
				(citation) => citation.unitId === sourceId && citation.field === "book_isbn13",
			);
			return;
		case "distinct_candidate_evidence":
			requireOnly(basis.code, citations, (citation) => IdentityEvidenceFields.has(citation.field));
			requireUnits(basis.code, citations, [sourceId]);
			if (!citations.some(({ unitId }) => unitId !== sourceId))
				throw new Error("Basis distinct_candidate_evidence must cite a non-source candidate");
			return;
		case "same_title":
			if (targetId === null) throw new Error("Basis same_title is valid only for merge");
			requireOnly(basis.code, citations, (citation) => citation.field === "localization_title");
			requireUnits(basis.code, citations, [sourceId, targetId]);
			return;
		case "title_variant_same_work":
			if (targetId === null) throw new Error(`Basis ${basis.code} is valid only for merge`);
			requireOnly(basis.code, citations, (citation) => TitleFields.has(citation.field));
			requireUnits(basis.code, citations, [sourceId, targetId]);
			return;
		case "same_synopsis":
			if (targetId === null) throw new Error("Basis same_synopsis is valid only for merge");
			requireOnly(basis.code, citations, (citation) => SynopsisFields.has(citation.field));
			requireUnits(basis.code, citations, [sourceId, targetId]);
			return;
		case "same_attribution":
			if (targetId === null) throw new Error("Basis same_attribution is valid only for merge");
			requireOnly(basis.code, citations, (citation) => citation.field === "attribution");
			requireUnits(basis.code, citations, [sourceId, targetId]);
			return;
		case "same_identifier":
			if (targetId === null) throw new Error("Basis same_identifier is valid only for merge");
			requireOnly(basis.code, citations, (citation) => citation.field === "book_isbn13");
			requireUnits(basis.code, citations, [sourceId, targetId]);
			return;
		case "query_like_title":
		case "question_like_title":
			requireOnly(
				basis.code,
				citations,
				(citation) =>
					citation.unitId === sourceId &&
					(citation.field === "localization_title" || citation.field === "suspicious_signal"),
			);
			return;
		case "character_identity":
		case "person_or_entity_identity":
		case "malformed_metadata":
		case "placeholder_metadata":
		case "non_book_identity":
			requireOnly(
				basis.code,
				citations,
				(citation) => citation.unitId === sourceId && IdentityEvidenceFields.has(citation.field),
			);
			return;
		case "metadata_correction_supported":
			requireOnly(basis.code, citations, (citation) =>
				CorrectionEvidenceFields.has(citation.field),
			);
			requireUnits(basis.code, citations, [sourceId]);
			return;
		case "attribution_correction_supported":
			requireOnly(basis.code, citations, (citation) => citation.field === "attribution");
			requireUnits(basis.code, citations, [sourceId]);
			return;
	}
}

const BasisCodesByDisposition: Readonly<
	Record<Exclude<SourceDecision["disposition"], "review">, ReadonlySet<DecisionBasisCode>>
> = {
	keep: new Set([
		"booklike_title",
		"synopsis_describes_work",
		"author_attribution_present",
		"identifier_present",
		"distinct_candidate_evidence",
	]),
	merge: new Set([
		"same_title",
		"title_variant_same_work",
		"same_synopsis",
		"same_attribution",
		"same_identifier",
	]),
	soft_delete: new Set([
		"query_like_title",
		"question_like_title",
		"character_identity",
		"person_or_entity_identity",
		"malformed_metadata",
		"placeholder_metadata",
		"non_book_identity",
	]),
	revise: new Set(["metadata_correction_supported", "attribution_correction_supported"]),
};

function validateBasis(
	decision: Exclude<SourceDecision, { readonly disposition: "review" }>,
	usedCitationIndexes: Set<number>,
): void {
	const codes = new Set<DecisionBasisCode>();
	for (const basis of decision.basis) {
		if (codes.has(basis.code)) throw new Error(`Decision repeats basis code ${basis.code}`);
		codes.add(basis.code);
		if (!BasisCodesByDisposition[decision.disposition].has(basis.code))
			throw new Error(`Basis ${basis.code} is not valid for ${decision.disposition}`);
		const citations = citationsForIndexes(
			decision,
			basis.citationIndexes,
			usedCitationIndexes,
			`Basis ${basis.code}`,
		);
		validateBasisClaim(decision, basis, citations);
	}

	if (decision.disposition === "keep") {
		if (!codes.has("booklike_title")) throw new Error("Keep requires basis booklike_title");
		if (
			!["synopsis_describes_work", "author_attribution_present", "identifier_present"].some(
				(code) => codes.has(code as DecisionBasisCode),
			)
		)
			throw new Error("Keep requires synopsis, attribution, or identifier corroboration");
	}
	if (decision.disposition === "merge") {
		const titleSupported = codes.has("same_title") || codes.has("title_variant_same_work");
		const corroborated =
			codes.has("same_synopsis") || codes.has("same_attribution") || codes.has("same_identifier");
		if (!codes.has("same_identifier") && !(titleSupported && corroborated))
			throw new Error(
				"Merge requires a shared identifier or title correspondence plus synopsis/attribution corroboration",
			);
	}
	if (decision.disposition === "soft_delete") {
		if (
			decision.reason === "query_fragment" &&
			!codes.has("query_like_title") &&
			!codes.has("question_like_title")
		)
			throw new Error("Soft-delete reason query_fragment lacks its required title basis");
		const requiredCode: Readonly<
			Record<Exclude<typeof decision.reason, "query_fragment">, DecisionBasisCode>
		> = {
			character_as_book: "character_identity",
			person_or_entity_as_book: "person_or_entity_identity",
			malformed_scrape: "malformed_metadata",
			placeholder: "placeholder_metadata",
			other: "non_book_identity",
		};
		if (decision.reason !== "query_fragment" && !codes.has(requiredCode[decision.reason]))
			throw new Error(`Soft-delete reason ${decision.reason} lacks its required basis`);
	}
	if (decision.disposition === "revise") {
		const requiredCode =
			decision.reason === "wrong_attribution"
				? "attribution_correction_supported"
				: "metadata_correction_supported";
		if (!codes.has(requiredCode))
			throw new Error(`Revision reason ${decision.reason} lacks its required basis`);
		for (const patch of decision.patches) {
			const field = revisionEvidenceField(patch);
			if (
				!decision.citations.some(
					(citation) => citation.field === field && patch.evidenceUnitIds.includes(citation.unitId),
				)
			)
				throw new Error(`Revision patch ${patch.kind} lacks a linked ${field} citation`);
		}
	}
}

function validateUncertainties(
	packet: ReviewPacket,
	decision: Extract<SourceDecision, { readonly disposition: "review" }>,
	usedCitationIndexes: Set<number>,
): void {
	const candidateIds = new Set(packet.candidates.map(({ id }) => id));
	const evidenceIds = packetEvidenceIds(packet);
	const kinds = new Set<string>();
	for (const uncertainty of decision.uncertainties) {
		if (kinds.has(uncertainty.kind))
			throw new Error(`Decision repeats uncertainty kind ${uncertainty.kind}`);
		kinds.add(uncertainty.kind);
		const citations = citationsForIndexes(
			decision,
			uncertainty.citationIndexes,
			usedCitationIndexes,
			`Uncertainty ${uncertainty.kind}`,
		);
		if (!citations.some(({ unitId }) => unitId === decision.sourceUnitId))
			throw new Error(`Uncertainty ${uncertainty.kind} must cite the source Unit`);
		for (const relatedUnitId of uncertainty.relatedUnitIds) {
			if (!evidenceIds.has(relatedUnitId))
				throw new Error(
					`Review uncertainty references evidence outside the packet: ${relatedUnitId}`,
				);
			if (
				candidateIds.has(relatedUnitId) &&
				!citations.some(({ unitId }) => unitId === relatedUnitId)
			)
				throw new Error(`Review uncertainty must cite related candidate ${relatedUnitId}`);
		}
		if (uncertainty.kind === "candidate_identity_ambiguous") {
			const relatedCandidateIds = uncertainty.relatedUnitIds.filter(
				(unitId) => unitId !== decision.sourceUnitId && candidateIds.has(unitId),
			);
			if (relatedCandidateIds.length === 0)
				throw new Error("Candidate ambiguity must identify a non-source candidate Unit");
			for (const unitId of relatedCandidateIds)
				if (!citations.some((citation) => citation.unitId === unitId))
					throw new Error(`Candidate ambiguity must cite candidate Unit ${unitId}`);
		}
		if (
			uncertainty.kind === "non_book_status_unclear" &&
			!citations.every(
				(citation) =>
					citation.unitId === decision.sourceUnitId &&
					(citation.field === "localization_title" || citation.field === "suspicious_signal"),
			)
		)
			throw new Error("Non-Book uncertainty must cite the source title or suspicious signal");
	}
}

export function validateDecisionAgainstPacket(
	config: RunConfig,
	packet: ReviewPacket,
	decision: SourceDecision,
): void {
	if (config.decisionPolicyRevision !== CurrentDecisionPolicyRevision)
		throw new Error(
			`Run decision policy ${config.decisionPolicyRevision} is read-only; initialize a new run`,
		);
	validateDecisionBindingAgainstPacket(config, packet, decision);
	validateCitationSet(packet, decision.citations);
	if (decision.disposition === "soft_delete" && decision.reason === "query_fragment") {
		const source = packet.candidates.find(({ id }) => id === decision.sourceUnitId);
		const hasSynopsis = source?.localizations.some(
			({ summary, description }) =>
				(summary?.trim().length ?? 0) >= 40 ||
				(description !== null && jsonStrings(description).some((text) => text.trim().length >= 40)),
		);
		const hasAuthorship = source?.attributions.some(
			({ role, localizations }) =>
				role.toLocaleLowerCase("en-US") === "author" &&
				localizations.some(({ title }) => Boolean(title?.trim())),
		);
		if ((hasSynopsis && hasAuthorship) || source?.details.isbn13)
			throw new Error(
				"Query-fragment deletion conflicts with stored synopsis/authorship or identifier evidence; use semantic review, not title-shape deletion",
			);
	}

	const usedCitationIndexes = new Set<number>();
	if (decision.disposition === "review")
		validateUncertainties(packet, decision, usedCitationIndexes);
	else validateBasis(decision, usedCitationIndexes);

	for (const index of decision.citations.keys())
		if (!usedCitationIndexes.has(index))
			throw new Error(`Citation index ${index} is not linked to a basis or uncertainty`);
}

function normalizedExplanationTemplate(decision: PersistedSourceDecision): string | null {
	if (!("explanation" in decision)) return null;
	let result = normalizedText(decision.explanation).replace(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
		"<unit>",
	);
	if ("citations" in decision)
		for (const excerpt of [...decision.citations]
			.map(({ excerpt }) => normalizedText(excerpt))
			.sort((left, right) => right.length - left.length))
			result = result.split(excerpt).join("<evidence>");
	return result;
}

export function decisionPartQualityIssues(
	part: number,
	decisions: readonly PersistedSourceDecision[],
	expectedSourceCount: number,
): DecisionQualityIssue[] {
	const issues: DecisionQualityIssue[] = [];
	const explainedDecisions = decisions.filter(
		(decision): decision is Extract<PersistedSourceDecision, { readonly explanation: string }> =>
			"explanation" in decision,
	);
	const byExplanation = Map.groupBy(explainedDecisions, ({ explanation }) =>
		normalizedText(explanation),
	);
	for (const duplicateDecisions of byExplanation.values()) {
		if (duplicateDecisions.length < DuplicateExplanationMinimum) continue;
		issues.push(
			DecisionQualityIssueSchema.parse({
				code: "duplicate_explanation",
				part,
				sourceUnitIds: duplicateDecisions.map(({ sourceUnitId }) => sourceUnitId).slice(0, 20),
				message:
					"Different source Books use the same explanation; explanations must identify source-specific stored evidence.",
			}),
		);
	}

	const templated = Map.groupBy(explainedDecisions, (decision) =>
		normalizedExplanationTemplate(decision),
	);
	for (const templateDecisions of templated.values()) {
		if (!templateDecisions || templateDecisions.length < DuplicateExplanationMinimum) continue;
		issues.push(
			DecisionQualityIssueSchema.parse({
				code: "templated_explanation",
				part,
				sourceUnitIds: templateDecisions.map(({ sourceUnitId }) => sourceUnitId).slice(0, 20),
				message:
					"Different source Books use the same explanation template after evidence values are removed.",
			}),
		);
	}

	if (
		decisions.length === expectedSourceCount &&
		decisions.length >= BlanketReviewMinimum &&
		decisions.every(
			(decision) =>
				decision.disposition === "review" &&
				decision.reason === "insufficient_evidence" &&
				decision.confidence === "low",
		)
	)
		issues.push(
			DecisionQualityIssueSchema.parse({
				code: "blanket_review",
				part,
				sourceUnitIds: decisions.map(({ sourceUnitId }) => sourceUnitId).slice(0, 20),
				message:
					"A complete packet part was classified entirely as low-confidence insufficient-evidence review; human canary review is required before continuing.",
			}),
		);
	return issues;
}

export function assertDecisionPartQuality(
	part: number,
	decisions: readonly SourceDecision[],
	expectedSourceCount: number,
): void {
	const [issue] = decisionPartQualityIssues(part, decisions, expectedSourceCount);
	if (issue) throw new Error(`Decision quality gate failed (${issue.code}): ${issue.message}`);
}

export class DecisionQualityCollector {
	private sourceCount = 0;
	private decisionCount = 0;
	private legacyDecisionCount = 0;
	private issueCount = 0;
	private readonly byDisposition: Record<string, number> = {};
	private readonly byReason: Record<string, number> = {};
	private readonly byConfidence: Record<string, number> = {};
	private readonly byBasis: Record<string, number> = {};
	private readonly byUncertainty: Record<string, number> = {};
	private readonly issueCounts: Record<string, number> = {};
	private readonly sampleIssues: DecisionQualityIssue[] = [];

	constructor(private readonly config: RunConfig) {
		if (config.decisionPolicyRevision !== CurrentDecisionPolicyRevision)
			this.addIssue({
				code: "legacy_decision_contract",
				part: null,
				sourceUnitIds: [],
				message: `The run uses ${config.decisionPolicyRevision}; its decisions remain readable but cannot pass ${CurrentDecisionPolicyRevision} quality planning.`,
			});
	}

	addSources(count: number): void {
		this.sourceCount += count;
	}

	addDecision(decision: PersistedSourceDecision): void {
		this.decisionCount += 1;
		if (!isCurrentDecision(decision)) this.legacyDecisionCount += 1;
		this.byDisposition[decision.disposition] = (this.byDisposition[decision.disposition] ?? 0) + 1;
		this.byReason[decision.reason] = (this.byReason[decision.reason] ?? 0) + 1;
		this.byConfidence[decision.confidence] = (this.byConfidence[decision.confidence] ?? 0) + 1;
		if (isCurrentDecision(decision)) {
			if (decision.disposition === "review")
				for (const uncertainty of decision.uncertainties)
					this.byUncertainty[uncertainty.kind] = (this.byUncertainty[uncertainty.kind] ?? 0) + 1;
			else
				for (const basis of decision.basis)
					this.byBasis[basis.code] = (this.byBasis[basis.code] ?? 0) + 1;
		}
	}

	addIssue(input: DecisionQualityIssue): void {
		const issue = DecisionQualityIssueSchema.parse(input);
		this.issueCount += 1;
		this.issueCounts[issue.code] = (this.issueCounts[issue.code] ?? 0) + 1;
		if (this.sampleIssues.length < MaximumSampleIssues) this.sampleIssues.push(issue);
	}

	finish(): DecisionQualityReport {
		return DecisionQualityReportSchema.parse({
			schemaVersion: SchemaVersion,
			runId: this.config.runId,
			generatedAt: nowIso(),
			decisionPolicyRevision: this.config.decisionPolicyRevision,
			status: this.issueCount === 0 ? "passed" : "failed",
			sourceCount: this.sourceCount,
			decisionCount: this.decisionCount,
			legacyDecisionCount: this.legacyDecisionCount,
			byDisposition: this.byDisposition,
			byReason: this.byReason,
			byConfidence: this.byConfidence,
			byBasis: this.byBasis,
			byUncertainty: this.byUncertainty,
			issueCount: this.issueCount,
			issueCounts: this.issueCounts,
			sampleIssues: this.sampleIssues,
		});
	}
}

export async function auditDecisionQuality(
	config: RunConfig,
	options: { readonly persist?: boolean } = {},
): Promise<DecisionQualityReport> {
	const directory = runDirectory(config.runId);
	const collector = new DecisionQualityCollector(config);
	for (const packetPath of await listPartFiles(join(directory, "packets"))) {
		const match = /part-(\d{5,12})\.jsonl$/u.exec(packetPath);
		if (!match?.[1]) throw new Error(`Unexpected packet part path: ${packetPath}`);
		const part = Number(match[1]);
		const packets: ReviewPacket[] = [];
		for await (const packet of readJsonLines(packetPath, ReviewPacketSchema)) packets.push(packet);
		const expectedSourceIds = new Set(packets.flatMap(({ sourceUnitIds }) => sourceUnitIds));
		collector.addSources(expectedSourceIds.size);

		const decisions: PersistedSourceDecision[] = [];
		const decisionPath = join(directory, "decisions", partFileName(part));
		if (await pathExists(decisionPath))
			for await (const decision of readJsonLines(decisionPath, PersistedSourceDecisionSchema)) {
				decisions.push(decision);
				collector.addDecision(decision);
			}

		const decisionsBySource = new Map<string, PersistedSourceDecision>();
		for (const decision of decisions) {
			if (decisionsBySource.has(decision.sourceUnitId))
				collector.addIssue({
					code: "duplicate_decision",
					part,
					sourceUnitIds: [decision.sourceUnitId],
					message: `Source ${decision.sourceUnitId} has more than one persisted decision.`,
				});
			else decisionsBySource.set(decision.sourceUnitId, decision);
		}

		for (const packet of packets)
			for (const sourceUnitId of packet.sourceUnitIds) {
				const decision = decisionsBySource.get(sourceUnitId);
				if (!decision) {
					collector.addIssue({
						code: "missing_decision",
						part,
						sourceUnitIds: [sourceUnitId],
						message: `Source ${sourceUnitId} has no persisted decision.`,
					});
					continue;
				}
				try {
					if (isCurrentDecision(decision)) validateDecisionAgainstPacket(config, packet, decision);
					else if (isEvidenceGroundedV2Decision(decision))
						validateEvidenceGroundedV2DecisionAgainstPacket(config, packet, decision);
					else validateDecisionBindingAgainstPacket(config, packet, decision);
				} catch (error) {
					collector.addIssue({
						code: "invalid_decision",
						part,
						sourceUnitIds: [sourceUnitId],
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}

		for (const decision of decisions)
			if (!expectedSourceIds.has(decision.sourceUnitId))
				collector.addIssue({
					code: "unexpected_decision",
					part,
					sourceUnitIds: [decision.sourceUnitId],
					message: `Decision source ${decision.sourceUnitId} is absent from packet part ${part}.`,
				});
		for (const issue of decisionPartQualityIssues(part, decisions, expectedSourceIds.size))
			collector.addIssue(issue);
	}

	const report = collector.finish();
	if (options.persist)
		await writeJsonAtomic(join(directory, "reports", "decision-quality.json"), report);
	return report;
}
