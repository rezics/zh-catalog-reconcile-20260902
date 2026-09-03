import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
	type BookEvidence,
	BookEvidenceSchema,
	type DecisionPolicyRevision,
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
				description: null,
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
	decisionPolicyRevision: DecisionPolicyRevision = "evidence-grounded-v2",
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

function keepDecision(packet: ReviewPacket, source: BookEvidence, explanation: string) {
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
		actor: { kind: "codex", model: "fixture", promptRevision: "evidence-grounded-v2" },
		confidence: "high",
		reason: "distinct_work",
		explanation,
		evidenceUnitIds: [source.id],
		citations: [{ unitId: source.id, field: "localization_title", excerpt: title }],
		disposition: "keep",
	});
}

test("evidence-grounded decisions must cite stored text in their explanation", () => {
	const runConfig = config(`quality-${Date.now()}`);
	const source = book(randomUUID(), "具体书名");
	const packet = buildReviewPacket(runConfig, 0, "具体书名", [source], []);
	const grounded = keepDecision(packet, source, 'The stored title "具体书名" identifies a Book.');
	expect(() => validateDecisionAgainstPacket(runConfig, packet, grounded)).not.toThrow();

	const generic = SourceDecisionSchema.parse({
		...grounded,
		explanation: "The packet provides enough evidence to keep this record.",
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, generic)).toThrow(
		"must mention at least one cited evidence excerpt",
	);

	const invented = SourceDecisionSchema.parse({
		...grounded,
		explanation: 'The stored title "不存在的书名" identifies a Book.',
		citations: [{ unitId: source.id, field: "localization_title", excerpt: "不存在的书名" }],
	});
	expect(() => validateDecisionAgainstPacket(runConfig, packet, invented)).toThrow(
		"does not match stored localization_title evidence",
	);
});

test("record rejects a repeated explanation before persisting the batch", async () => {
	const runId = `quality-record-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const runConfig = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		expect(runConfig.decisionPolicyRevision).toBe("evidence-grounded-v2");
		const sources = [
			book(randomUUID(), "共同标题"),
			book(randomUUID(), "共同标题"),
			book(randomUUID(), "共同标题"),
		];
		const packets = sources.map((source) =>
			buildReviewPacket(runConfig, 0, "共同标题", [source], []),
		);
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(0)), packets);
		const repeated = 'The stored title "共同标题" identifies a distinct Book.';
		const decisions = packets.map((packet, index) => {
			const source = sources[index];
			if (!source) throw new Error("Fixture source is missing");
			return keepDecision(packet, source, repeated);
		});
		const inputPath = join(directory, ".work", "decisions.json");
		await writeJsonAtomic(inputPath, decisions);

		await expect(recordDecisions(runConfig, inputPath)).rejects.toThrow("duplicate_explanation");
		expect(await pathExists(join(directory, "decisions", partFileName(0)))).toBe(false);
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
			blanket_review: 1,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
