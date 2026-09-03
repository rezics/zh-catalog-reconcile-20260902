import { join } from "node:path";

import {
	type BookEvidence,
	type DecisionEvidenceCitation,
	type DecisionQualityIssue,
	DecisionQualityIssueSchema,
	type DecisionQualityReport,
	DecisionQualityReportSchema,
	type JsonValue,
	type PersistedSourceDecision,
	PersistedSourceDecisionSchema,
	type ReviewPacket,
	ReviewPacketSchema,
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

export function isEvidenceGroundedDecision(
	decision: PersistedSourceDecision,
): decision is SourceDecision {
	return "citations" in decision;
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
	if (!decision.evidenceUnitIds.includes(decision.sourceUnitId))
		throw new Error("Decision evidence must include the source Unit");
	for (const evidenceUnitId of decision.evidenceUnitIds)
		if (!evidenceIds.has(evidenceUnitId))
			throw new Error(`Decision cites evidence outside the packet: ${evidenceUnitId}`);

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

export function validateDecisionAgainstPacket(
	config: RunConfig,
	packet: ReviewPacket,
	decision: SourceDecision,
): void {
	if (config.decisionPolicyRevision !== "evidence-grounded-v2")
		throw new Error(
			`Run decision policy ${config.decisionPolicyRevision} is read-only; initialize a new run`,
		);
	validateDecisionBindingAgainstPacket(config, packet, decision);

	const citationKeys = new Set<string>();
	for (const citation of decision.citations) {
		const key = `${citation.unitId}\u0000${citation.field}\u0000${normalizedText(citation.excerpt)}`;
		if (citationKeys.has(key)) throw new Error("Decision contains a duplicate evidence citation");
		citationKeys.add(key);
		validateCitation(packet, citation);
		if (!decision.evidenceUnitIds.includes(citation.unitId))
			throw new Error(`Decision evidenceUnitIds omit cited Unit: ${citation.unitId}`);
	}
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

export function decisionPartQualityIssues(
	part: number,
	decisions: readonly PersistedSourceDecision[],
	expectedSourceCount: number,
): DecisionQualityIssue[] {
	const issues: DecisionQualityIssue[] = [];
	const byExplanation = Map.groupBy(decisions, ({ explanation }) => normalizedText(explanation));
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
	private readonly issueCounts: Record<string, number> = {};
	private readonly sampleIssues: DecisionQualityIssue[] = [];

	constructor(private readonly config: RunConfig) {
		if (config.decisionPolicyRevision === "legacy-v1")
			this.addIssue({
				code: "legacy_decision_contract",
				part: null,
				sourceUnitIds: [],
				message:
					"The run predates evidence-grounded-v2; its decisions remain readable but cannot pass quality planning.",
			});
	}

	addSources(count: number): void {
		this.sourceCount += count;
	}

	addDecision(decision: PersistedSourceDecision): void {
		this.decisionCount += 1;
		if (!isEvidenceGroundedDecision(decision)) this.legacyDecisionCount += 1;
		this.byDisposition[decision.disposition] = (this.byDisposition[decision.disposition] ?? 0) + 1;
		this.byReason[decision.reason] = (this.byReason[decision.reason] ?? 0) + 1;
		this.byConfidence[decision.confidence] = (this.byConfidence[decision.confidence] ?? 0) + 1;
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
					if (isEvidenceGroundedDecision(decision))
						validateDecisionAgainstPacket(config, packet, decision);
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
