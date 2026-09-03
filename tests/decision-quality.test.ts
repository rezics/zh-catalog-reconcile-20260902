import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
	type BookEvidence,
	BookEvidenceSchema,
	CurrentDecisionPolicyRevision,
	type DecisionPolicyRevision,
	EvidenceGroundedSourceDecisionSchema,
	LegacySourceDecisionSchema,
	type ReviewPacket,
	type RunConfig,
	RunConfigSchema,
	SchemaVersion,
	SourceDecisionSchema,
} from "../src/contracts.ts";
import { captureInventory } from "../src/database.ts";
import { auditDecisionQuality, validateDecisionAgainstPacket } from "../src/decision-quality.ts";
import { nextPackets, recordDecisions, runStatus } from "../src/decisions.ts";
import { sha256 } from "../src/hash.ts";
import {
	nowIso,
	partFileName,
	pathExists,
	runDirectory,
	writeJsonAtomic,
	writeJsonLinesAtomic,
} from "../src/io.ts";
import { buildReviewPacket } from "../src/packets.ts";
import { initializeRun } from "../src/run.ts";

const Description = "这是一部围绕主角成长展开的长篇小说。";

function book(id: string, title: string): BookEvidence {
	const unhashed = {
		schemaVersion: SchemaVersion,
		id,
		createdAt: "2026-08-09T18:52:23.601Z",
		updatedAt: "2026-08-09T18:52:24.000Z",
		publishedAt: "2026-08-09T18:52:24.000Z",
		status: "published" as const,
		visibility: "public" as const,
		moderationStatus: "approved" as const,
		contentRating: "r15",
		aiDisclosure: "unknown",
		details: {
			releaseStatus: "ongoing",
			isbn13: null,
			publicationDate: null,
			pageCount: null,
			wordCount: null,
		},
		localizations: [
			{
				language: "zh",
				title,
				summary: null,
				description: Description,
				position: "a0",
				updatedAt: "2026-08-09T18:52:24.000Z",
			},
		],
		aliases: [],
		attributions: [],
		sourceEligible: true,
		localizationLanguages: ["zh"],
	};
	return BookEvidenceSchema.parse({ ...unhashed, evidenceHash: sha256(unhashed) });
}

function config(
	runId: string,
	decisionPolicyRevision: DecisionPolicyRevision = CurrentDecisionPolicyRevision,
): RunConfig {
	return RunConfigSchema.parse({
		schemaVersion: SchemaVersion,
		runId,
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
		decisionPolicyRevision,
		onlineBatchSize: 20,
		maxCandidatesPerPacket: 20,
	});
}

function keepDecision(packet: ReviewPacket, source: BookEvidence) {
	const title = source.localizations[0]?.title;
	if (!title) throw new Error("Fixture source title is missing");
	return SourceDecisionSchema.parse({
		schemaVersion: SchemaVersion,
		runId: packet.runId,
		part: packet.part,
		packetId: packet.packetId,
		inputHash: packet.inputHash,
		sourceUnitId: source.id,
		decidedAt: nowIso(),
		actor: { kind: "codex", model: "fixture", promptRevision: "evidence-claims-v3" },
		confidence: "high",
		reason: "distinct_work",
		citations: [
			{ unitId: source.id, field: "localization_title", excerpt: title },
			{ unitId: source.id, field: "localization_description", excerpt: Description },
		],
		basis: [
			{ code: "booklike_title", citationIndexes: [0] },
			{ code: "synopsis_describes_work", citationIndexes: [1] },
		],
		disposition: "keep",
	});
}

test("structured basis must be linked to stored evidence with disposition-specific proof", () => {
	const runConfig = config(`quality-${Date.now()}`);
	const source = book(randomUUID(), "具体书名");
	const packet = buildReviewPacket(runConfig, 0, "具体书名", [source], []);
	const grounded = keepDecision(packet, source);
	expect(() => validateDecisionAgainstPacket(runConfig, packet, grounded)).not.toThrow();

	const titleOnly = SourceDecisionSchema.parse({
		...grounded,
		citations: [grounded.citations[0]],
		basis: [{ code: "booklike_title", citationIndexes: [0] }],
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, titleOnly)).toThrow(
		"requires synopsis, attribution, or identifier corroboration",
	);

	const falseSynopsisClaim = SourceDecisionSchema.parse({
		...grounded,
		basis: [
			{ code: "booklike_title", citationIndexes: [0] },
			{ code: "synopsis_describes_work", citationIndexes: [0, 1] },
		],
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, falseSynopsisClaim)).toThrow(
		"does not prove that claim",
	);

	const invented = SourceDecisionSchema.parse({
		...grounded,
		citations: [
			{ unitId: source.id, field: "localization_title", excerpt: "不存在的书名" },
			grounded.citations[1],
		],
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, invented)).toThrow(
		"does not match stored localization_title evidence",
	);

	expect(() =>
		SourceDecisionSchema.parse({ ...grounded, note: "Routine prose is redundant." }),
	).toThrow("Routine decisions must use typed basis");
});

test("review uncertainty must cite both the source and its related candidate", () => {
	const runConfig = config(`quality-review-${Date.now()}`);
	const source = book(randomUUID(), "同名作品");
	const candidate = book(randomUUID(), "同名作品");
	const packet = buildReviewPacket(runConfig, 0, "同名作品", [source], [candidate]);
	const decision = SourceDecisionSchema.parse({
		schemaVersion: SchemaVersion,
		runId: packet.runId,
		part: packet.part,
		packetId: packet.packetId,
		inputHash: packet.inputHash,
		sourceUnitId: source.id,
		decidedAt: nowIso(),
		actor: { kind: "codex", model: "fixture", promptRevision: "evidence-claims-v3" },
		confidence: "low",
		reason: "insufficient_evidence",
		citations: [
			{ unitId: source.id, field: "localization_title", excerpt: "同名作品" },
			{ unitId: candidate.id, field: "localization_title", excerpt: "同名作品" },
		],
		disposition: "review",
		uncertainties: [
			{
				kind: "candidate_identity_ambiguous",
				citationIndexes: [0, 1],
				relatedUnitIds: [candidate.id],
			},
		],
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, decision)).not.toThrow();
	if (decision.disposition !== "review") throw new Error("Fixture decision is not review");
	const uncertainty = decision.uncertainties[0];
	if (!uncertainty) throw new Error("Fixture uncertainty is missing");

	const sourceOnly = SourceDecisionSchema.parse({
		...decision,
		uncertainties: [{ ...uncertainty, citationIndexes: [0] }],
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, sourceOnly)).toThrow(
		"must cite related candidate",
	);
});

test("record accepts repeated typed basis when each claim is bound to its source evidence", async () => {
	const runId = `quality-record-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const runConfig = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		expect(runConfig.decisionPolicyRevision).toBe(CurrentDecisionPolicyRevision);
		const sources = Array.from({ length: 3 }, () => book(randomUUID(), "共同标题"));
		const packets = sources.map((source) =>
			buildReviewPacket(runConfig, 0, "共同标题", [source], []),
		);
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(0)), packets);
		const decisions = packets.map((packet, index) => {
			const source = sources[index];
			if (!source) throw new Error("Fixture source is missing");
			return keepDecision(packet, source);
		});
		const inputPath = join(directory, ".work", "decisions.json");
		await writeJsonAtomic(inputPath, decisions);

		expect((await recordDecisions(runConfig, inputPath)).recorded).toBe(3);
		expect(await pathExists(join(directory, "decisions", partFileName(0)))).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("audit flags evidence-grounded v2 explanation templates as non-current", async () => {
	const runId = `quality-v2-audit-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const v2Config = config(runId, "evidence-grounded-v2");
		await mkdir(join(directory, "packets"), { recursive: true });
		await mkdir(join(directory, "decisions"), { recursive: true });
		const sources = ["甲书", "乙书", "丙书"].map((title) => book(randomUUID(), title));
		const packets = sources.map((source) => buildReviewPacket(v2Config, 0, "作品", [source], []));
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(0)), packets);
		const decisions = packets.map((packet, index) => {
			const source = sources[index];
			const title = source?.localizations[0]?.title;
			if (!source || !title) throw new Error("Fixture source is missing");
			return EvidenceGroundedSourceDecisionSchema.parse({
				schemaVersion: SchemaVersion,
				runId,
				part: 0,
				packetId: packet.packetId,
				inputHash: packet.inputHash,
				sourceUnitId: source.id,
				decidedAt: nowIso(),
				actor: { kind: "codex", model: "fixture", promptRevision: "evidence-grounded-v2" },
				confidence: "high",
				reason: "distinct_work",
				explanation: `Stored title "${title}" identifies a distinct Book.`,
				evidenceUnitIds: [source.id],
				citations: [{ unitId: source.id, field: "localization_title", excerpt: title }],
				disposition: "keep",
			});
		});
		await writeJsonLinesAtomic(join(directory, "decisions", partFileName(0)), decisions);

		const report = await auditDecisionQuality(v2Config);
		expect(report).toMatchObject({
			status: "failed",
			sourceCount: 3,
			decisionCount: 3,
			legacyDecisionCount: 3,
		});
		expect(report.issueCounts).toMatchObject({
			legacy_decision_contract: 1,
			templated_explanation: 1,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("audit identifies a legacy blanket decision batch as failed", async () => {
	const runId = `quality-audit-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const legacyConfig = config(runId, "legacy-v1");
		await mkdir(join(directory, "packets"), { recursive: true });
		await mkdir(join(directory, "decisions"), { recursive: true });
		const sources = Array.from({ length: 10 }, () => book(randomUUID(), "共同标题")).sort(
			(left, right) => left.id.localeCompare(right.id),
		);
		const packets = sources.map((source) =>
			buildReviewPacket(legacyConfig, 0, "共同标题", [source], []),
		);
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(0)), packets);
		const decisions = packets.map((packet, index) => {
			const source = sources[index];
			if (!source) throw new Error("Fixture source is missing");
			return LegacySourceDecisionSchema.parse({
				schemaVersion: SchemaVersion,
				runId,
				part: 0,
				packetId: packet.packetId,
				inputHash: packet.inputHash,
				sourceUnitId: source.id,
				decidedAt: nowIso(),
				actor: { kind: "codex", model: "fixture", promptRevision: "legacy-v1" },
				confidence: "low",
				reason: "insufficient_evidence",
				explanation: "Insufficient evidence; deferring to human review.",
				evidenceUnitIds: [source.id],
				disposition: "review",
			});
		});
		await writeJsonLinesAtomic(join(directory, "decisions", partFileName(0)), decisions);

		expect(await runStatus(legacyConfig)).toMatchObject({
			sourceCount: 10,
			decisionCount: 10,
			remainingCount: 0,
		});
		await expect(captureInventory(legacyConfig)).rejects.toThrow("legacy-v1 is read-only");
		await expect(nextPackets(legacyConfig, 1)).rejects.toThrow("legacy-v1 is read-only");
		const report = await auditDecisionQuality(legacyConfig);
		expect(report).toMatchObject({
			status: "failed",
			sourceCount: 10,
			decisionCount: 10,
			legacyDecisionCount: 10,
		});
		expect(report.issueCounts).toMatchObject({
			legacy_decision_contract: 1,
			duplicate_explanation: 1,
			templated_explanation: 1,
			blanket_review: 1,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
