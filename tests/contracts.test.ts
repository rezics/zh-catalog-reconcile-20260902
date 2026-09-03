import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type BookEvidence,
	BookEvidenceSchema,
	CurrentDecisionPolicyRevision,
	DecisionBasisCodeSchema,
	DecisionUncertaintyKindSchema,
	type RunConfig,
	RunConfigSchema,
	SchemaVersion,
	SourceDecisionSchema,
} from "../src/contracts.ts";
import { isExactZhSource } from "../src/database.ts";
import { sha256 } from "../src/hash.ts";
import { repositoryRoot } from "../src/io.ts";
import { buildReviewPacket } from "../src/packets.ts";
import { compileDecision } from "../src/planner.ts";

const SourceId = "019fe73e-8927-701e-becf-64aee50c9594";
const TargetId = "019fe546-26fb-7cac-9225-70ffa348df8a";
const ActorEntityId = "019fe714-d85f-7f35-aeb4-cdcd44edcb6b";

test("decision template covers every basis and uncertainty code", async () => {
	const template = await readFile(
		join(repositoryRoot, "references", "decision-template.md"),
		"utf8",
	);
	for (const code of DecisionBasisCodeSchema.options) expect(template).toContain(`\`${code}\``);
	for (const kind of DecisionUncertaintyKindSchema.options)
		expect(template).toContain(`\`${kind}\``);
});

function book(id: string, languages: readonly string[], title = "斗破苍穹萧炎"): BookEvidence {
	const evidence = {
		id,
		createdAt: "2026-08-09T15:57:43.064Z",
		updatedAt: "2026-08-09T15:57:44.881Z",
		publishedAt: "2026-08-09T15:57:44.881Z",
		status: "published" as const,
		visibility: "public" as const,
		moderationStatus: "approved" as const,
		contentRating: "r15",
		aiDisclosure: "unknown",
		details: {
			releaseStatus: "completed",
			isbn13: null,
			publicationDate: null,
			pageCount: null,
			wordCount: null,
		},
		localizations: languages.map((language, index) => ({
			language,
			title: index === 0 ? title : "バトルスルー・ザ・ヘブンズ",
			summary: null,
			description: null,
			position: `a${index}`,
			updatedAt: "2026-08-09T15:57:44.881Z",
		})),
		aliases: [],
		attributions: [
			{
				id: "019fe73e-8ba4-7679-ad55-cd89ca4ad198",
				role: "author",
				creditedUnitId: ActorEntityId,
				creditedUnitKind: "entity",
				entityKind: "person",
				entityVerified: false,
				localizations: [{ language: "zh", title: "天蚕土豆", summary: null }],
			},
		],
	};
	const localizationLanguages = [...languages].sort();
	const unhashed = {
		...evidence,
		schemaVersion: SchemaVersion,
		sourceEligible: localizationLanguages.length === 1 && localizationLanguages[0] === "zh",
		localizationLanguages,
	};
	return BookEvidenceSchema.parse({ ...unhashed, evidenceHash: sha256(unhashed) });
}

const config: RunConfig = RunConfigSchema.parse({
	schemaVersion: SchemaVersion,
	runId: "test-run",
	createdAt: "2026-09-02T16:00:00.000Z",
	cutoff: "2026-09-02T16:00:00.000Z",
	rezicsRef: "v1.7.0",
	sourcePolicy: {
		kind: "book",
		metadataLanguagesExactly: ["zh"],
		status: "published",
		visibility: "public",
		moderationStatus: "approved",
		deleted: false,
	},
	networkPolicy: "rezics-only-no-external-metadata",
	evidenceMode: "online-batched",
	applyState: "locked",
	decisionPolicyRevision: CurrentDecisionPolicyRevision,
	onlineBatchSize: 20,
	maxCandidatesPerPacket: 20,
});

describe("source eligibility", () => {
	test("accepts exactly zh metadata", () => {
		expect(isExactZhSource(book(SourceId, ["zh"]))).toBe(true);
	});

	test("protects a Book as soon as ja metadata exists", () => {
		expect(isExactZhSource(book(TargetId, ["zh", "ja"], "斗破苍穹"))).toBe(false);
	});

	test("rejects evidence that lies about exact-zh eligibility", () => {
		const protectedBook = book(TargetId, ["zh", "ja"], "斗破苍穹");
		const { evidenceHash: _evidenceHash, ...changed } = protectedBook;
		expect(() =>
			BookEvidenceSchema.parse({
				...changed,
				sourceEligible: true,
				evidenceHash: sha256({ ...changed, sourceEligible: true }),
			}),
		).toThrow("sourceEligible");
	});
});

describe("decision compilation", () => {
	test("allows an exact-zh source to merge into a protected multilingual target", () => {
		const source = book(SourceId, ["zh"]);
		const target = book(TargetId, ["zh", "ja"], "斗破苍穹");
		const packet = buildReviewPacket(config, 3, "斗破苍穹", [source], [target]);
		const decision = SourceDecisionSchema.parse({
			schemaVersion: SchemaVersion,
			runId: config.runId,
			part: 3,
			packetId: packet.packetId,
			inputHash: packet.inputHash,
			sourceUnitId: SourceId,
			decidedAt: "2026-09-02T16:10:00.000Z",
			actor: { kind: "codex", model: "gpt-5", promptRevision: "1" },
			confidence: "high",
			reason: "duplicate_identity",
			citations: [
				{
					unitId: SourceId,
					field: "localization_title",
					excerpt: "斗破苍穹萧炎",
				},
				{
					unitId: TargetId,
					field: "localization_title",
					excerpt: "斗破苍穹",
				},
				{
					unitId: SourceId,
					field: "attribution",
					excerpt: "天蚕土豆",
				},
				{
					unitId: TargetId,
					field: "attribution",
					excerpt: "天蚕土豆",
				},
			],
			basis: [
				{ code: "title_variant_same_work", citationIndexes: [0, 1] },
				{ code: "same_attribution", citationIndexes: [2, 3] },
			],
			disposition: "merge",
			targetUnitId: TargetId,
		});
		const action = compileDecision(config, packet, decision);
		expect(action?.kind).toBe("merge");
		if (action?.kind === "merge") expect(action.targetUnitId).toBe(TargetId);

		const sourceOnlyCitation = SourceDecisionSchema.parse({
			...decision,
			citations: [
				{
					unitId: SourceId,
					field: "localization_title",
					excerpt: "斗破苍穹萧炎",
				},
				{
					unitId: SourceId,
					field: "attribution",
					excerpt: "天蚕土豆",
				},
			],
			basis: [
				{ code: "same_title", citationIndexes: [0] },
				{ code: "same_attribution", citationIndexes: [1] },
			],
		});
		expect(() => compileDecision(config, packet, sourceOnlyCitation)).toThrow(
			"must cite the target Unit",
		);
	});

	test("rejects a merge target absent from the packet", () => {
		const source = book(SourceId, ["zh"]);
		const packet = buildReviewPacket(config, 3, "斗破苍穹", [source], []);
		const decision = SourceDecisionSchema.parse({
			schemaVersion: SchemaVersion,
			runId: config.runId,
			part: 3,
			packetId: packet.packetId,
			inputHash: packet.inputHash,
			sourceUnitId: SourceId,
			decidedAt: "2026-09-02T16:10:00.000Z",
			actor: { kind: "codex", model: "gpt-5", promptRevision: "1" },
			confidence: "high",
			reason: "duplicate_identity",
			citations: [
				{
					unitId: SourceId,
					field: "localization_title",
					excerpt: "斗破苍穹萧炎",
				},
			],
			basis: [{ code: "same_title", citationIndexes: [0] }],
			disposition: "merge",
			targetUnitId: TargetId,
		});
		expect(() => compileDecision(config, packet, decision)).toThrow("outside the packet");
	});
});
