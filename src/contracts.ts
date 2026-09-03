import { z } from "zod";

import { sha256 } from "./hash.ts";

export const SchemaVersion = 1 as const;

export const UuidSchema = z.uuid();
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const DateTimeSchema = z.iso.datetime({ offset: true });
export const RunIdSchema = z
	.string()
	.min(3)
	.max(80)
	.regex(/^[a-z0-9][a-z0-9-]*$/u);

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

export const LocalizationSchema = z
	.object({
		language: z.string().min(1).max(35),
		title: z.string().nullable(),
		summary: z.string().nullable(),
		description: JsonValueSchema.nullable(),
		position: z.string().min(1),
		updatedAt: DateTimeSchema,
	})
	.strict();

export const AliasSchema = z
	.object({
		id: UuidSchema,
		language: z.string().min(1).max(35).nullable(),
		term: z.string().min(1),
		kind: z.string().min(1),
	})
	.strict();

export const CreditedLocalizationSchema = z
	.object({
		language: z.string().min(1).max(35),
		title: z.string().nullable(),
		summary: z.string().nullable(),
	})
	.strict();

export const AttributionSchema = z
	.object({
		id: UuidSchema,
		role: z.string().min(1),
		creditedUnitId: UuidSchema,
		creditedUnitKind: z.string().min(1),
		entityKind: z.string().min(1).nullable(),
		entityVerified: z.boolean().nullable(),
		localizations: z.array(CreditedLocalizationSchema),
	})
	.strict();

export const BookDetailsSchema = z
	.object({
		releaseStatus: z.string().min(1),
		isbn13: z.string().nullable(),
		publicationDate: z.string().nullable(),
		pageCount: z.int().positive().nullable(),
		wordCount: z.int().nonnegative().nullable(),
	})
	.strict();

export const RawBookEvidenceSchema = z
	.object({
		id: UuidSchema,
		createdAt: DateTimeSchema,
		updatedAt: DateTimeSchema,
		publishedAt: DateTimeSchema,
		status: z.literal("published"),
		visibility: z.literal("public"),
		moderationStatus: z.literal("approved"),
		contentRating: z.string().min(1),
		aiDisclosure: z.string().min(1),
		details: BookDetailsSchema,
		localizations: z.array(LocalizationSchema).min(1),
		aliases: z.array(AliasSchema),
		attributions: z.array(AttributionSchema),
	})
	.strict();

export const BookEvidenceSchema = RawBookEvidenceSchema.extend({
	schemaVersion: z.literal(SchemaVersion),
	sourceEligible: z.boolean(),
	localizationLanguages: z.array(z.string().min(1).max(35)).min(1),
	evidenceHash: Sha256Schema,
})
	.strict()
	.superRefine((book, context) => {
		const actualLanguages = [...new Set(book.localizations.map(({ language }) => language))].sort();
		if (JSON.stringify(book.localizationLanguages) !== JSON.stringify(actualLanguages))
			context.addIssue({
				code: "custom",
				message: "localizationLanguages does not match the stored localizations",
				path: ["localizationLanguages"],
			});
		const actualEligibility = actualLanguages.length === 1 && actualLanguages[0] === "zh";
		if (book.sourceEligible !== actualEligibility)
			context.addIssue({
				code: "custom",
				message: "sourceEligible does not match exact-zh metadata eligibility",
				path: ["sourceEligible"],
			});
		const { evidenceHash, ...unhashed } = book;
		if (sha256(unhashed) !== evidenceHash)
			context.addIssue({
				code: "custom",
				message: "evidenceHash does not match the online evidence",
				path: ["evidenceHash"],
			});
	});
export type BookEvidence = z.infer<typeof BookEvidenceSchema>;

export const DecisionPolicyRevisionSchema = z.enum(["legacy-v1", "evidence-grounded-v2"]);
export type DecisionPolicyRevision = z.infer<typeof DecisionPolicyRevisionSchema>;

export const RunConfigSchema = z
	.object({
		schemaVersion: z.literal(SchemaVersion),
		runId: RunIdSchema,
		createdAt: DateTimeSchema,
		cutoff: DateTimeSchema,
		rezicsRef: z.string().min(1),
		sourcePolicy: z
			.object({
				kind: z.literal("book"),
				metadataLanguagesExactly: z.tuple([z.literal("zh")]),
				status: z.literal("published"),
				visibility: z.literal("public"),
				moderationStatus: z.literal("approved"),
				deleted: z.literal(false),
			})
			.strict(),
		networkPolicy: z.literal("rezics-only-no-external-metadata"),
		evidenceMode: z.literal("online-batched"),
		applyState: z.literal("locked"),
		decisionPolicyRevision: DecisionPolicyRevisionSchema.default("legacy-v1"),
		onlineBatchSize: z.int().min(1).max(100),
		maxCandidatesPerPacket: z.int().min(2).max(50),
	})
	.strict();
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const PacketCheckpointSchema = z
	.object({
		schemaVersion: z.literal(SchemaVersion),
		runId: RunIdSchema,
		evidenceMode: z.literal("online-batched"),
		lastSourceCreatedAt: DateTimeSchema.nullable(),
		lastSourceUnitId: UuidSchema.nullable(),
		sourceCount: z.int().nonnegative(),
		packetCount: z.int().nonnegative(),
		nextPart: z.int().nonnegative(),
		complete: z.boolean(),
		updatedAt: DateTimeSchema,
	})
	.strict()
	.superRefine((checkpoint, context) => {
		if ((checkpoint.lastSourceCreatedAt === null) !== (checkpoint.lastSourceUnitId === null))
			context.addIssue({
				code: "custom",
				message: "Online source cursor fields must both be null or both be present",
				path: ["lastSourceUnitId"],
			});
		if (checkpoint.sourceCount === 0 && checkpoint.lastSourceUnitId !== null)
			context.addIssue({
				code: "custom",
				message: "An empty online stream cannot have a source cursor",
				path: ["sourceCount"],
			});
	});
export type PacketCheckpoint = z.infer<typeof PacketCheckpointSchema>;

export const InventorySchema = z
	.object({
		schemaVersion: z.literal(SchemaVersion),
		runId: RunIdSchema,
		capturedAt: DateTimeSchema,
		cutoff: DateTimeSchema,
		publicBooks: z.int().nonnegative(),
		exactZhSources: z.int().nonnegative(),
		withJapaneseMetadata: z.int().nonnegative(),
		withNoMetadataLocalization: z.int().nonnegative(),
		earliestSourceCreatedAt: DateTimeSchema.nullable(),
		latestSourceCreatedAt: DateTimeSchema.nullable(),
		languageSets: z.array(
			z
				.object({
					languages: z.array(z.string().min(1).max(35)),
					count: z.int().nonnegative(),
				})
				.strict(),
		),
	})
	.strict();
export type Inventory = z.infer<typeof InventorySchema>;

export const SuspiciousSignalSchema = z.enum([
	"empty_title",
	"query_phrase",
	"question_title",
	"trailing_noise",
	"very_long_title",
	"no_attribution",
	"sparse_metadata",
]);

export const ReviewPacketSchema = z
	.object({
		schemaVersion: z.literal(SchemaVersion),
		runId: RunIdSchema,
		part: z.int().nonnegative(),
		packetId: Sha256Schema,
		inputHash: Sha256Schema,
		normalizedPrefix: z.string(),
		sourceUnitIds: z.array(UuidSchema).min(1).max(20),
		suspiciousSignals: z.record(UuidSchema, z.array(SuspiciousSignalSchema)),
		candidates: z.array(BookEvidenceSchema).min(1).max(50),
	})
	.strict()
	.superRefine((packet, context) => {
		const candidateIds = new Set(packet.candidates.map(({ id }) => id));
		for (const sourceUnitId of packet.sourceUnitIds) {
			const source = packet.candidates.find(({ id }) => id === sourceUnitId);
			if (!candidateIds.has(sourceUnitId) || !source?.sourceEligible)
				context.addIssue({
					code: "custom",
					message: "Packet source must be an exact-zh candidate",
					path: ["sourceUnitIds"],
				});
		}
		const { inputHash, ...unhashed } = packet;
		if (sha256(unhashed) !== inputHash)
			context.addIssue({
				code: "custom",
				message: "inputHash does not match the packet evidence",
				path: ["inputHash"],
			});
	});
export type ReviewPacket = z.infer<typeof ReviewPacketSchema>;

export const DecisionConfidenceSchema = z.enum(["high", "medium", "low"]);
export const DecisionReasonSchema = z.enum([
	"duplicate_identity",
	"query_fragment",
	"character_as_book",
	"person_or_entity_as_book",
	"malformed_scrape",
	"placeholder",
	"wrong_attribution",
	"wrong_metadata",
	"distinct_work",
	"insufficient_evidence",
	"other",
]);

const DecisionActorSchema = z
	.object({
		kind: z.enum(["codex", "model_api", "human"]),
		model: z.string().min(1),
		promptRevision: z.string().min(1),
	})
	.strict();

export const DecisionEvidenceFieldSchema = z.enum([
	"localization_title",
	"localization_summary",
	"localization_description",
	"alias",
	"attribution",
	"book_release_status",
	"book_isbn13",
	"book_publication_date",
	"book_page_count",
	"book_word_count",
	"unit_created_at",
	"unit_updated_at",
	"localization_languages",
	"suspicious_signal",
]);

export const DecisionEvidenceCitationSchema = z
	.object({
		unitId: UuidSchema,
		field: DecisionEvidenceFieldSchema,
		excerpt: z.string().trim().min(1).max(240),
	})
	.strict();
export type DecisionEvidenceCitation = z.infer<typeof DecisionEvidenceCitationSchema>;

export const DecisionUncertaintyKindSchema = z.enum([
	"candidate_identity_ambiguous",
	"conflicting_stored_evidence",
	"correction_not_proven",
	"non_book_status_unclear",
	"required_target_absent",
	"other",
]);

export const DecisionUncertaintySchema = z
	.object({
		kind: DecisionUncertaintyKindSchema,
		detail: z.string().trim().min(8).max(240),
		relatedUnitIds: z.array(UuidSchema).max(20),
	})
	.strict();
export type DecisionUncertainty = z.infer<typeof DecisionUncertaintySchema>;

const LegacyDecisionBaseFields = {
	schemaVersion: z.literal(SchemaVersion),
	runId: RunIdSchema,
	part: z.int().nonnegative(),
	packetId: Sha256Schema,
	inputHash: Sha256Schema,
	sourceUnitId: UuidSchema,
	decidedAt: DateTimeSchema,
	actor: DecisionActorSchema,
	confidence: DecisionConfidenceSchema,
	explanation: z.string().min(1).max(500),
	evidenceUnitIds: z.array(UuidSchema).min(1).max(50),
} as const;

const DecisionBaseFields = {
	...LegacyDecisionBaseFields,
	citations: z.array(DecisionEvidenceCitationSchema).min(1).max(20),
} as const;

export const RevisionPatchSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("localization_text_field"),
			language: z.literal("zh"),
			field: z.enum(["title", "summary"]),
			value: z.string().nullable(),
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("localization_description"),
			language: z.literal("zh"),
			value: JsonValueSchema,
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("book_release_status"),
			value: z.string().min(1),
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("book_isbn13"),
			value: z
				.string()
				.regex(/^[0-9]{13}$/u)
				.nullable(),
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("book_publication_date"),
			value: z.iso.date().nullable(),
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("book_page_count"),
			value: z.int().positive().nullable(),
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("book_word_count"),
			value: z.int().nonnegative().nullable(),
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("credit_replacement"),
			role: z.string().min(1),
			removeAttributionId: UuidSchema.nullable(),
			creditedUnitId: UuidSchema,
			evidenceUnitIds: z.array(UuidSchema).min(1).max(20),
		})
		.strict(),
]);
export type RevisionPatch = z.infer<typeof RevisionPatchSchema>;

export const SourceDecisionSchema = z.discriminatedUnion("disposition", [
	z
		.object({
			...DecisionBaseFields,
			disposition: z.literal("keep"),
			reason: z.literal("distinct_work"),
		})
		.strict(),
	z
		.object({
			...DecisionBaseFields,
			disposition: z.literal("merge"),
			reason: z.literal("duplicate_identity"),
			targetUnitId: UuidSchema,
		})
		.strict(),
	z
		.object({
			...DecisionBaseFields,
			disposition: z.literal("soft_delete"),
			reason: z.enum([
				"query_fragment",
				"character_as_book",
				"person_or_entity_as_book",
				"malformed_scrape",
				"placeholder",
				"other",
			]),
		})
		.strict(),
	z
		.object({
			...DecisionBaseFields,
			disposition: z.literal("revise"),
			reason: z.enum(["wrong_attribution", "wrong_metadata"]),
			patches: z.array(RevisionPatchSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			...DecisionBaseFields,
			disposition: z.literal("review"),
			reason: z.enum(["insufficient_evidence", "other"]),
			uncertainties: z.array(DecisionUncertaintySchema).min(1).max(10),
		})
		.strict(),
]);
export type SourceDecision = z.infer<typeof SourceDecisionSchema>;

export const LegacySourceDecisionSchema = z.discriminatedUnion("disposition", [
	z
		.object({
			...LegacyDecisionBaseFields,
			disposition: z.literal("keep"),
			reason: z.literal("distinct_work"),
		})
		.strict(),
	z
		.object({
			...LegacyDecisionBaseFields,
			disposition: z.literal("merge"),
			reason: z.literal("duplicate_identity"),
			targetUnitId: UuidSchema,
		})
		.strict(),
	z
		.object({
			...LegacyDecisionBaseFields,
			disposition: z.literal("soft_delete"),
			reason: z.enum([
				"query_fragment",
				"character_as_book",
				"person_or_entity_as_book",
				"malformed_scrape",
				"placeholder",
				"other",
			]),
		})
		.strict(),
	z
		.object({
			...LegacyDecisionBaseFields,
			disposition: z.literal("revise"),
			reason: z.enum(["wrong_attribution", "wrong_metadata"]),
			patches: z.array(RevisionPatchSchema).min(1).max(20),
		})
		.strict(),
	z
		.object({
			...LegacyDecisionBaseFields,
			disposition: z.literal("review"),
			reason: z.enum(["insufficient_evidence", "other"]),
		})
		.strict(),
]);
export type LegacySourceDecision = z.infer<typeof LegacySourceDecisionSchema>;

export const PersistedSourceDecisionSchema = z.union([
	SourceDecisionSchema,
	LegacySourceDecisionSchema,
]);
export type PersistedSourceDecision = z.infer<typeof PersistedSourceDecisionSchema>;

export const DecisionQualityIssueCodeSchema = z.enum([
	"legacy_decision_contract",
	"invalid_decision",
	"missing_decision",
	"duplicate_decision",
	"unexpected_decision",
	"duplicate_explanation",
	"blanket_review",
]);

export const DecisionQualityIssueSchema = z
	.object({
		code: DecisionQualityIssueCodeSchema,
		part: z.int().nonnegative().nullable(),
		sourceUnitIds: z.array(UuidSchema).max(20),
		message: z.string().min(1).max(500),
	})
	.strict();
export type DecisionQualityIssue = z.infer<typeof DecisionQualityIssueSchema>;

export const DecisionQualityReportSchema = z
	.object({
		schemaVersion: z.literal(SchemaVersion),
		runId: RunIdSchema,
		generatedAt: DateTimeSchema,
		decisionPolicyRevision: DecisionPolicyRevisionSchema,
		status: z.enum(["passed", "failed"]),
		sourceCount: z.int().nonnegative(),
		decisionCount: z.int().nonnegative(),
		legacyDecisionCount: z.int().nonnegative(),
		byDisposition: z.record(z.string(), z.int().nonnegative()),
		byReason: z.record(z.string(), z.int().nonnegative()),
		byConfidence: z.record(z.string(), z.int().nonnegative()),
		issueCount: z.int().nonnegative(),
		issueCounts: z.record(z.string(), z.int().nonnegative()),
		sampleIssues: z.array(DecisionQualityIssueSchema).max(100),
	})
	.strict();
export type DecisionQualityReport = z.infer<typeof DecisionQualityReportSchema>;

const ManifestBaseFields = {
	schemaVersion: z.literal(SchemaVersion),
	runId: RunIdSchema,
	actionId: Sha256Schema,
	packetId: Sha256Schema,
	inputHash: Sha256Schema,
	decisionHash: Sha256Schema,
	sourceUnitId: UuidSchema,
	expectedSourceUpdatedAt: DateTimeSchema,
	confidence: DecisionConfidenceSchema,
	reason: DecisionReasonSchema,
	approval: z.enum(["canary_candidate", "human_required"]),
} as const;

export const ManifestActionSchema = z.discriminatedUnion("kind", [
	z
		.object({
			...ManifestBaseFields,
			kind: z.literal("merge"),
			targetUnitId: UuidSchema,
			expectedTargetUpdatedAt: DateTimeSchema,
			idempotencyKey: z.string().min(1).max(200),
		})
		.strict(),
	z
		.object({
			...ManifestBaseFields,
			kind: z.literal("soft_delete"),
			idempotencyKey: z.string().min(1).max(200),
		})
		.strict(),
	z
		.object({
			...ManifestBaseFields,
			kind: z.literal("revision_proposal"),
			approval: z.literal("human_required"),
			patches: z.array(RevisionPatchSchema).min(1).max(20),
			idempotencyKey: z.string().min(1).max(200),
		})
		.strict(),
]);
export type ManifestAction = z.infer<typeof ManifestActionSchema>;

export const EventSchema = z
	.object({
		schemaVersion: z.literal(SchemaVersion),
		timestamp: DateTimeSchema,
		runId: RunIdSchema,
		level: z.enum(["info", "warning", "error"]),
		event: z.string().min(1),
		data: z.record(z.string(), JsonValueSchema),
	})
	.strict();
export type RunEvent = z.infer<typeof EventSchema>;

export const GeneratedSchemas = {
	"run-config": RunConfigSchema,
	"book-evidence": BookEvidenceSchema,
	"packet-checkpoint": PacketCheckpointSchema,
	"review-packet": ReviewPacketSchema,
	"source-decision": SourceDecisionSchema,
	"decision-quality-report": DecisionQualityReportSchema,
	"manifest-action": ManifestActionSchema,
	"run-event": EventSchema,
} as const;
