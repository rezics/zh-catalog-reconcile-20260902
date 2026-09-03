import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
	type BookEvidence,
	BookEvidenceSchema,
	DecisionProgressCheckpointSchema,
	type DecisionProposal,
	DecisionProposalBatchSchema,
	type DecisionQualityReport,
	PacketCheckpointSchema,
	SchemaVersion,
	SourceDecisionSchema,
} from "../src/contracts.ts";
import { sha256 } from "../src/hash.ts";
import {
	nowIso,
	partFileName,
	pathExists,
	readJson,
	readJsonLines,
	runDirectory,
	withFileLock,
	writeJsonAtomic,
	writeJsonLinesAtomic,
} from "../src/io.ts";
import {
	classifyLunaWorkerFailure,
	codexLunaArguments,
	type DecisionWorkItem,
	LunaModel,
	LunaPromptRevision,
	LunaWorkerFailure,
} from "../src/model-worker.ts";
import {
	assertAuditAllowsResume,
	compileDecisionProposals,
	runConcurrentReconciliation,
} from "../src/orchestrator.ts";
import { buildReviewPacket } from "../src/packets.ts";
import { initializeRun } from "../src/run.ts";

test("worker output schema uses the supported closed-object structured-output subset", () => {
	const schema = z.toJSONSchema(DecisionProposalBatchSchema, {
		target: "draft-2020-12",
		unrepresentable: "throw",
	});
	const serialized = JSON.stringify(schema);
	expect(serialized).not.toContain('"oneOf"');
	const inspect = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) inspect(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		const object = value as Record<string, unknown>;
		if (object.type === "object" && object.properties) {
			expect(object.additionalProperties).toBeFalse();
			const properties = Object.keys(object.properties as Record<string, unknown>).sort();
			const required = [...((object.required as string[] | undefined) ?? [])].sort();
			expect(required).toEqual(properties);
		}
		for (const child of Object.values(object)) inspect(child);
	};
	inspect(schema);
});

test("Luna worker isolates semantic inference from Fast mode, tools, and API-key billing", () => {
	const arguments_ = codexLunaArguments("C:\\temp\\response.json", "C:\\temp\\worker");
	expect(arguments_).toContain("--ignore-user-config");
	expect(arguments_).toContain("fast_mode");
	expect(arguments_).toContain("shell_tool");
	expect(arguments_).toContain('forced_login_method="chatgpt"');
	expect(arguments_).toContain('service_tier="default"');
	expect(arguments_).toContain('model_reasoning_effort="medium"');
	expect(arguments_).toContain('web_search="disabled"');
	expect(arguments_).toContain("project_doc_max_bytes=0");
	expect(arguments_).toContain("--skip-git-repo-check");
	expect(arguments_.at(-1)).toBe("-");
});

test("worker failures distinguish exhausted allowance from transient rate limiting", () => {
	expect(classifyLunaWorkerFailure("429 rate limit: usage_limit_reached")).toBe("usage_allowance");
	expect(classifyLunaWorkerFailure("429 too many requests")).toBe("rate_limit");
	expect(classifyLunaWorkerFailure("401 unauthorized")).toBe("authentication");
	expect(classifyLunaWorkerFailure("unexpected process exit")).toBe("execution");
});

function sourceBook(id: string, title: string): BookEvidence {
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
				summary: "一部具有完整人物与情节设定的小说。",
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

function proposal(source: BookEvidence): DecisionProposal {
	const title = source.localizations[0]?.title;
	const summary = source.localizations[0]?.summary;
	if (!title || !summary) throw new Error("Fixture metadata is missing");
	return {
		sourceUnitId: source.id,
		confidence: "high",
		citations: [
			{ unitId: source.id, field: "localization_title", excerpt: title },
			{ unitId: source.id, field: "localization_summary", excerpt: summary },
		],
		note: null,
		disposition: "keep",
		reason: "distinct_work",
		basis: [
			{ code: "booklike_title", citationIndexes: [0] },
			{ code: "synopsis_describes_work", citationIndexes: [1] },
		],
	};
}

function report(runId: string, decisionCount: number): DecisionQualityReport {
	return {
		schemaVersion: SchemaVersion,
		runId,
		generatedAt: "2026-09-03T16:00:00.000Z",
		decisionPolicyRevision: "evidence-claims-v3",
		status: "passed",
		sourceCount: decisionCount,
		decisionCount,
		legacyDecisionCount: 0,
		byDisposition: {},
		byReason: {},
		byConfidence: {},
		byBasis: {},
		byUncertainty: {},
		issueCount: 0,
		issueCounts: {},
		sampleIssues: [],
	};
}

test("resume allows only missing undecided work and rejects persisted decision defects", () => {
	const baseline = report("resume-audit", 10);
	expect(() =>
		assertAuditAllowsResume({
			...baseline,
			status: "failed",
			issueCount: 2,
			issueCounts: { missing_decision: 2 },
		}),
	).not.toThrow();
	expect(() =>
		assertAuditAllowsResume({
			...baseline,
			status: "failed",
			issueCount: 1,
			issueCounts: { invalid_decision: 1 },
		}),
	).toThrow("invalid_decision:1");
});

test("proposal compilation owns immutable envelope fields and rejects incomplete worker output", async () => {
	const runId = `proposal-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const config = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		const source = sourceBook(randomUUID(), "完整作品");
		const packet = buildReviewPacket(config, 0, "完整作品", [source], []);
		const item = { packet, undecidedSourceUnitIds: [source.id] };
		const [decision] = compileDecisionProposals(config, [item], [proposal(source)]);
		expect(decision?.actor).toEqual({
			kind: "codex",
			model: LunaModel,
			promptRevision: LunaPromptRevision,
		});
		expect(decision?.packetId).toBe(packet.packetId);
		expect(() => compileDecisionProposals(config, [item], [])).toThrow("omitted assigned source");
		expect(() =>
			compileDecisionProposals(config, [item], [proposal(source), proposal(source)]),
		).toThrow("duplicate source");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("coordinator bounds concurrency, preserves assignment order, and retries worker failure", async () => {
	const runId = `work-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const config = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		const sources = Array.from({ length: 4 }, (_, index) =>
			sourceBook(randomUUID(), `作品${index}`),
		);
		const items: DecisionWorkItem[] = sources.map((source, index) => ({
			packet: buildReviewPacket(config, 0, `作品${index}`, [source], []),
			undecidedSourceUnitIds: [source.id],
		}));
		let active = 0;
		let maximumActive = 0;
		let failedOnce = false;
		const recordedIds: string[] = [];
		let nextCalls = 0;
		const result = await runConcurrentReconciliation(config, {
			concurrency: 2,
			packetsPerWorker: 1,
			progressEvery: 4,
			dependencies: {
				worker: {
					async decide(batch) {
						active += 1;
						maximumActive = Math.max(maximumActive, active);
						try {
							if (!failedOnce) {
								failedOnce = true;
								await Bun.sleep(5);
								throw new Error("transient fixture failure");
							}
							await Bun.sleep(batch[0]?.packet.normalizedPrefix === "作品0" ? 15 : 1);
							return batch.map(({ packet }) => {
								const source = packet.candidates.find(({ id }) =>
									packet.sourceUnitIds.includes(id),
								);
								if (!source) throw new Error("Fixture source missing");
								return proposal(source);
							});
						} finally {
							active -= 1;
						}
					},
				},
				next: async () => (nextCalls++ === 0 ? items : []),
				record: async (_config, decisions) => {
					recordedIds.push(...decisions.map(({ sourceUnitId }) => sourceUnitId));
					return { recorded: decisions.length };
				},
				status: async () => ({
					packetCount: nextCalls === 0 ? 0 : 4,
					sourceCount: nextCalls === 0 ? 0 : 4,
					decisionCount: nextCalls < 2 ? 0 : 4,
					remainingCount: nextCalls < 2 ? 4 : 0,
					onlineComplete: nextCalls >= 2,
				}),
				audit: async () => report(runId, 4),
			},
		});
		expect(result.onlineComplete).toBeTrue();
		expect(result.workerRetries).toBe(1);
		expect(maximumActive).toBe(2);
		expect(recordedIds).toEqual(sources.map(({ id }) => id));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("orchestration lock rejects a second coordinator", async () => {
	const runId = `work-lock-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const config = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		const lockPath = join(directory, ".work", "orchestrator.lock");
		await withFileLock(lockPath, async () => {
			await expect(runConcurrentReconciliation(config)).rejects.toThrow("Could not acquire lock");
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed worker drains in-flight work without recording and releases the coordinator lock", async () => {
	const runId = `work-failure-${Date.now()}`;
	const directory = runDirectory(runId);
	try {
		const config = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		const sources = [sourceBook(randomUUID(), "失败作品"), sourceBook(randomUUID(), "在途作品")];
		const items: DecisionWorkItem[] = sources.map((source) => ({
			packet: buildReviewPacket(config, 0, source.localizations[0]?.title ?? "作品", [source], []),
			undecidedSourceUnitIds: [source.id],
		}));
		let drained = false;
		let recorded = false;
		await expect(
			runConcurrentReconciliation(config, {
				concurrency: 2,
				packetsPerWorker: 1,
				maxAttempts: 1,
				dependencies: {
					worker: {
						async decide(batch) {
							if (batch[0]?.packet.normalizedPrefix === "失败作品")
								throw new Error("fixture failure");
							await Bun.sleep(10);
							drained = true;
							const source = batch[0]?.packet.candidates[0];
							if (!source) throw new Error("Fixture source missing");
							return [proposal(source)];
						},
					},
					next: async () => items,
					record: async (_config, decisions) => {
						recorded = true;
						return { recorded: decisions.length };
					},
					status: async () => ({
						packetCount: 0,
						sourceCount: 0,
						decisionCount: 0,
						remainingCount: 0,
						onlineComplete: false,
					}),
				},
			}),
		).rejects.toThrow("Luna worker failed after 1 attempts");
		expect(drained).toBeTrue();
		expect(recorded).toBeFalse();
		expect(await pathExists(join(directory, ".work", "orchestrator.lock"))).toBeFalse();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(["usage_allowance", "authentication"] as const)(
	"coordinator stops on %s without spending retries or recording fallback decisions",
	async (category) => {
		const runId = `work-stop-${category.replaceAll("_", "-")}-${Date.now()}`;
		const directory = runDirectory(runId);
		try {
			const config = await initializeRun({
				runId,
				rezicsRef: "v1.7.0",
				cutoff: "2026-09-02T16:00:00.000Z",
			});
			const source = sourceBook(randomUUID(), "额度停止测试");
			const item = {
				packet: buildReviewPacket(config, 0, "额度停止测试", [source], []),
				undecidedSourceUnitIds: [source.id],
			};
			let attempts = 0;
			let recorded = false;
			await expect(
				runConcurrentReconciliation(config, {
					maxAttempts: 3,
					dependencies: {
						worker: {
							async decide() {
								attempts += 1;
								throw new LunaWorkerFailure(category, "fixture");
							},
						},
						next: async () => [item],
						record: async () => {
							recorded = true;
							return { recorded: 0 };
						},
						status: async () => ({
							packetCount: 0,
							sourceCount: 0,
							decisionCount: 0,
							remainingCount: 0,
							onlineComplete: false,
						}),
					},
				}),
			).rejects.toThrow(category.replaceAll("_", " "));
			expect(attempts).toBe(1);
			expect(recorded).toBeFalse();
			expect(await pathExists(join(directory, ".work", "orchestrator.lock"))).toBeFalse();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("default 32-by-2 workers persist a 64-source part and odd tail then resume without duplication", async () => {
	const runId = `work-defaults-${randomUUID()}`;
	const directory = runDirectory(runId);
	try {
		const config = await initializeRun({
			runId,
			rezicsRef: "v1.7.0",
			cutoff: "2026-09-02T16:00:00.000Z",
		});
		expect(config.onlineBatchSize).toBe(64);
		const sources = Array.from({ length: 65 }, (_, index) =>
			sourceBook(randomUUID(), `完整作品${index}`),
		).sort((left, right) => left.id.localeCompare(right.id));
		const packets = sources.map((source, index) =>
			buildReviewPacket(config, Math.floor(index / 64), source.id, [source], []),
		);
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(0)), packets.slice(0, 64));
		await writeJsonLinesAtomic(join(directory, "packets", partFileName(1)), packets.slice(64));
		const lastSource = sources.at(-1);
		if (!lastSource) throw new Error("Fixture source missing");
		await writeJsonAtomic(
			join(directory, "packets", "checkpoint.json"),
			PacketCheckpointSchema.parse({
				schemaVersion: SchemaVersion,
				runId,
				evidenceMode: "online-batched",
				lastSourceCreatedAt: lastSource.createdAt,
				lastSourceUnitId: lastSource.id,
				sourceCount: 65,
				packetCount: 65,
				nextPart: 2,
				complete: true,
				updatedAt: nowIso(),
			}),
		);
		let active = 0;
		let maximumActive = 0;
		const batchSizes: number[] = [];
		const worker = {
			async decide(batch: readonly DecisionWorkItem[]) {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				batchSizes.push(batch.length);
				try {
					await Bun.sleep(5);
					return batch.map(({ packet }) => {
						const source = packet.candidates[0];
						if (!source) throw new Error("Fixture source missing");
						return proposal(source);
					});
				} finally {
					active -= 1;
				}
			},
		};
		const result = await runConcurrentReconciliation(config, { dependencies: { worker } });
		expect(maximumActive).toBe(32);
		expect(batchSizes).toEqual([...Array.from({ length: 32 }, () => 2), 1]);
		expect(result).toMatchObject({ decisionCount: 65, onlineComplete: true, workerRetries: 0 });
		expect(result.audit.status).toBe("passed");
		const recordedIds: string[] = [];
		for (const part of [0, 1])
			for await (const decision of readJsonLines(
				join(directory, "decisions", partFileName(part)),
				SourceDecisionSchema,
			))
				recordedIds.push(decision.sourceUnitId);
		expect(recordedIds).toEqual(sources.map(({ id }) => id));
		expect(
			await readJson(
				join(directory, "decisions", "checkpoint.json"),
				DecisionProgressCheckpointSchema,
			),
		).toMatchObject({ completedThroughPart: 1 });
		const resumed = await runConcurrentReconciliation(config, { dependencies: { worker } });
		expect(resumed.decisionCount).toBe(65);
		expect(batchSizes).toHaveLength(33);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
