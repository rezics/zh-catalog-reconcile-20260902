import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
	type BookEvidence,
	BookEvidenceSchema,
	ManifestActionSchema,
	PacketCheckpointSchema,
	SchemaVersion,
} from "../src/contracts.ts";
import { nextPackets, recordDecisions } from "../src/decisions.ts";
import { sha256 } from "../src/hash.ts";
import {
	nowIso,
	partFileName,
	readJsonLines,
	runDirectory,
	writeJsonAtomic,
	writeJsonLinesAtomic,
} from "../src/io.ts";
import { buildReviewPacket, readPacketCheckpoint } from "../src/packets.ts";
import { generateManifest } from "../src/planner.ts";
import { initializeRun } from "../src/run.ts";

const SourceId = "019fe7de-74bd-7ea3-a33d-1d38c590e187";

function sourceBook(): BookEvidence {
	const unhashed = {
		schemaVersion: SchemaVersion,
		id: SourceId,
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
				title: "天蚕土豆最新",
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

test("fixture run reaches a validated manifest without an apply surface", async () => {
	const runId = `pipeline-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const config = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		const source = sourceBook();
		const packet = buildReviewPacket(config, 0, "天蚕土豆", [source], []);
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(0)), [packet]);
		const recovered = await readPacketCheckpoint(config);
		expect(recovered).toMatchObject({
			sourceCount: 1,
			packetCount: 1,
			nextPart: 1,
			complete: false,
			lastSourceUnitId: SourceId,
		});
		await writeJsonAtomic(
			join(directory, "packets", "checkpoint.json"),
			PacketCheckpointSchema.parse({
				schemaVersion: SchemaVersion,
				runId,
				evidenceMode: "online-batched",
				lastSourceCreatedAt: source.createdAt,
				lastSourceUnitId: SourceId,
				sourceCount: 1,
				packetCount: 1,
				nextPart: 1,
				complete: true,
				updatedAt: nowIso(),
			}),
		);

		const [nextPacket] = await nextPackets(config, 1);
		expect(nextPacket).toBeDefined();
		if (!nextPacket) throw new Error("Fixture packet was not created");
		const { packet: pendingPacket } = nextPacket;
		expect(nextPacket.undecidedSourceUnitIds).toEqual([SourceId]);
		const decisionPath = join(directory, ".work", "decisions.json");
		await writeJsonAtomic(decisionPath, [
			{
				schemaVersion: SchemaVersion,
				runId,
				part: pendingPacket.part,
				packetId: pendingPacket.packetId,
				inputHash: pendingPacket.inputHash,
				sourceUnitId: SourceId,
				decidedAt: nowIso(),
				actor: { kind: "codex", model: "fixture", promptRevision: "decision-policy-v2" },
				confidence: "high",
				reason: "query_fragment",
				citations: [
					{
						unitId: SourceId,
						field: "localization_title",
						excerpt: "天蚕土豆最新",
					},
				],
				basis: [{ code: "query_like_title", citationIndexes: [0] }],
				disposition: "soft_delete",
			},
		]);
		expect((await recordDecisions(config, decisionPath)).recorded).toBe(1);
		const summary = await generateManifest(config);
		expect(summary.actionCount).toBe(1);

		const actions: unknown[] = [];
		for await (const action of readJsonLines(
			join(directory, "manifests", "actions.jsonl"),
			ManifestActionSchema,
		))
			actions.push(action);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ kind: "soft_delete", sourceUnitId: SourceId });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
