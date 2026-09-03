import { join } from "node:path";

import {
	CurrentLunaWorkerProtocol,
	type DecisionEvidenceCitation,
	type DecisionProposal,
	type DecisionQualityReport,
	type ReviewPacket,
	type RunConfig,
	SchemaVersion,
	type SourceDecision,
	SourceDecisionSchema,
} from "./contracts.ts";
import { auditDecisionQuality, validateDecisionAgainstPacket } from "./decision-quality.ts";
import { nextPackets, recordDecisionValues, runStatus } from "./decisions.ts";
import {
	appendRunEvent,
	listPartFiles,
	nowIso,
	readJsonLines,
	runDirectory,
	withFileLock,
} from "./io.ts";
import {
	CodexLunaDecisionWorker,
	type DecisionWorker,
	type DecisionWorkItem,
	LunaModel,
	LunaPromptRevision,
	LunaWorkerFailure,
} from "./model-worker.ts";
import { readPacketCheckpoint } from "./packets.ts";
import {
	type DecisionWorkerFeedback,
	DecisionWorkerValidationError,
	workerValidationError,
} from "./worker-feedback.ts";

export const WorkDefaults = {
	concurrency: 32,
	packetsPerWorker: 2,
	maxAttempts: 3,
	progressEvery: 1_000,
} as const;

export type WorkProgress = {
	readonly decisionCount: number;
	readonly recorded: number;
	readonly workerRetries: number;
	readonly elapsedSeconds: number;
	readonly decisionsPerMinute: number;
};

export type WorkResult = {
	readonly decisionCount: number;
	readonly onlineComplete: boolean;
	readonly workerRetries: number;
	readonly audit: DecisionQualityReport;
};

type WorkDependencies = {
	readonly worker: DecisionWorker;
	readonly next: typeof nextPackets;
	readonly record: typeof recordDecisionValues;
	readonly status: typeof runStatus;
	readonly audit: typeof auditDecisionQuality;
};

export type WorkOptions = {
	readonly concurrency?: number;
	readonly packetsPerWorker?: number;
	readonly maxAttempts?: number;
	readonly progressEvery?: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: WorkProgress) => void;
	readonly dependencies?: Partial<WorkDependencies>;
};

export function assertAuditAllowsResume(report: DecisionQualityReport): void {
	const blockingIssues = Object.entries(report.issueCounts).filter(
		([code, count]) => code !== "missing_decision" && count > 0,
	);
	if (blockingIssues.length > 0)
		throw new Error(
			`Existing decisions fail audit (${blockingIssues.map(([code, count]) => `${code}:${count}`).join(", ")}); preserve this run and initialize a replacement`,
		);
}

export function assertCurrentWorkerProtocol(config: RunConfig): void {
	if (
		config.workerProtocol?.kind !== CurrentLunaWorkerProtocol.kind ||
		config.workerProtocol.model !== CurrentLunaWorkerProtocol.model ||
		config.workerProtocol.promptRevision !== CurrentLunaWorkerProtocol.promptRevision ||
		config.workerProtocol.proposalProtocol !== CurrentLunaWorkerProtocol.proposalProtocol
	)
		throw new Error(
			`Run is not pinned to ${CurrentLunaWorkerProtocol.promptRevision}; initialize a fresh full run with --worker-protocol ${CurrentLunaWorkerProtocol.promptRevision}`,
		);
}

function positiveBoundedInteger(value: number, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
		throw new Error(`${name} must be an integer from 1 through ${maximum}`);
	return value;
}

function proposalDecision(
	config: RunConfig,
	packet: ReviewPacket,
	proposal: DecisionProposal,
): SourceDecision {
	const citations: DecisionEvidenceCitation[] = [];
	const citationIndexes = new Map<string, number>();
	const linkCitations = (claimCitations: readonly DecisionEvidenceCitation[]): number[] => [
		...new Set(
			claimCitations.map((citation) => {
				const key = JSON.stringify([citation.unitId, citation.field, citation.excerpt]);
				const existing = citationIndexes.get(key);
				if (existing !== undefined) return existing;
				const index = citations.length;
				citations.push(citation);
				citationIndexes.set(key, index);
				return index;
			}),
		),
	];
	const { note, ...proposalFields } = proposal;
	const semanticFields =
		proposalFields.disposition === "review"
			? {
					...proposalFields,
					uncertainties: proposalFields.uncertainties.map(
						({ citations: claimCitations, ...uncertainty }) => ({
							...uncertainty,
							citationIndexes: linkCitations(claimCitations),
						}),
					),
				}
			: {
					...proposalFields,
					basis: proposalFields.basis.map(({ citations: claimCitations, ...basis }) => ({
						...basis,
						citationIndexes: linkCitations(claimCitations),
					})),
				};
	const decision = SourceDecisionSchema.parse({
		...semanticFields,
		citations,
		...(note === null ? {} : { note }),
		schemaVersion: SchemaVersion,
		runId: config.runId,
		part: packet.part,
		packetId: packet.packetId,
		inputHash: packet.inputHash,
		decidedAt: nowIso(),
		actor: {
			kind: "codex",
			model: LunaModel,
			promptRevision: LunaPromptRevision,
		},
	});
	validateDecisionAgainstPacket(config, packet, decision);
	return decision;
}

export function classifyDecisionWorkerFeedback(error: unknown): DecisionWorkerFeedback {
	if (error instanceof DecisionWorkerValidationError) return error.feedback;
	if (error instanceof SyntaxError || error instanceof TypeError)
		return { category: "output_schema_invalid", issue: "output_schema_contract" };
	if (error && typeof error === "object" && "issues" in error)
		return { category: "output_schema_invalid", issue: "output_schema_contract" };
	return { category: "decision_validation_invalid", issue: "decision_contract" };
}

export class DecisionWorkerAttemptsExhaustedError extends Error {
	readonly feedback: DecisionWorkerFeedback | undefined;

	constructor(maxAttempts: number, feedback: DecisionWorkerFeedback | undefined, cause: unknown) {
		const suffix = feedback === undefined ? "" : ` (${feedback.category}:${feedback.issue})`;
		super(`Luna worker failed after ${maxAttempts} attempts${suffix}`, { cause });
		this.name = "DecisionWorkerAttemptsExhaustedError";
		this.feedback = feedback;
	}
}

function workFailureCode(error: unknown): string {
	if (error instanceof LunaWorkerFailure) return `luna_${error.category}`;
	if (error instanceof DecisionWorkerAttemptsExhaustedError) return "worker_attempts_exhausted";
	return "coordinator_error";
}

export function compileDecisionProposals(
	config: RunConfig,
	items: readonly DecisionWorkItem[],
	proposals: readonly DecisionProposal[],
): SourceDecision[] {
	const packetsBySource = new Map<string, ReviewPacket>();
	for (const item of items)
		for (const sourceUnitId of item.undecidedSourceUnitIds) {
			if (packetsBySource.has(sourceUnitId))
				throw workerValidationError(
					"Worker assignment repeats a source",
					"assignment_invalid",
					"assignment_contract",
				);
			packetsBySource.set(sourceUnitId, item.packet);
		}
	const proposalsBySource = new Map<string, DecisionProposal>();
	for (const proposal of proposals) {
		if (!packetsBySource.has(proposal.sourceUnitId))
			throw workerValidationError(
				"Worker returned an unassigned source",
				"assignment_invalid",
				"assignment_contract",
			);
		if (proposalsBySource.has(proposal.sourceUnitId))
			throw workerValidationError(
				"Worker returned a duplicate source",
				"assignment_invalid",
				"assignment_contract",
			);
		proposalsBySource.set(proposal.sourceUnitId, proposal);
	}
	const decisions: SourceDecision[] = [];
	for (const [sourceUnitId, packet] of packetsBySource) {
		const proposal = proposalsBySource.get(sourceUnitId);
		if (!proposal)
			throw workerValidationError(
				"Worker omitted an assigned source",
				"assignment_invalid",
				"assignment_contract",
			);
		decisions.push(proposalDecision(config, packet, proposal));
	}
	return decisions;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size)
		result.push(values.slice(index, index + size));
	return result;
}

async function decideWithRetry(
	config: RunConfig,
	worker: DecisionWorker,
	items: readonly DecisionWorkItem[],
	maxAttempts: number,
	signal?: AbortSignal,
): Promise<{ readonly decisions: SourceDecision[]; readonly retries: number }> {
	let lastError: unknown;
	let feedback: DecisionWorkerFeedback | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (signal?.aborted) throw signal.reason ?? new Error("Reconciliation interrupted");
		try {
			return {
				decisions: compileDecisionProposals(
					config,
					items,
					await worker.decide(items, {
						...(signal === undefined ? {} : { signal }),
						...(feedback === undefined ? {} : { feedback }),
					}),
				),
				retries: attempt - 1,
			};
		} catch (error) {
			lastError = error;
			if (signal?.aborted) throw signal.reason ?? error;
			if (
				error instanceof LunaWorkerFailure &&
				(error.category === "usage_allowance" || error.category === "authentication")
			)
				throw error;
			if (!(error instanceof LunaWorkerFailure)) feedback = classifyDecisionWorkerFeedback(error);
			if (attempt < maxAttempts)
				await Bun.sleep(
					error instanceof LunaWorkerFailure && error.category === "rate_limit"
						? 5_000 * attempt
						: Math.min(2_000, 250 * 2 ** (attempt - 1)),
				);
		}
	}
	throw new DecisionWorkerAttemptsExhaustedError(maxAttempts, feedback, lastError);
}

async function concurrently<T, R>(
	values: readonly T[],
	concurrency: number,
	operation: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;
	let failed = false;
	const outcomes = await Promise.allSettled(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (!failed && nextIndex < values.length) {
				const index = nextIndex;
				nextIndex += 1;
				const value = values[index];
				if (value === undefined) throw new Error("Worker queue index is out of bounds");
				try {
					results[index] = await operation(value);
				} catch (error) {
					failed = true;
					throw error;
				}
			}
		}),
	);
	for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
	return results;
}

export async function runConcurrentReconciliation(
	config: RunConfig,
	options: WorkOptions = {},
): Promise<WorkResult> {
	assertCurrentWorkerProtocol(config);
	const concurrency = positiveBoundedInteger(
		options.concurrency ?? WorkDefaults.concurrency,
		"concurrency",
		32,
	);
	const packetsPerWorker = positiveBoundedInteger(
		options.packetsPerWorker ?? WorkDefaults.packetsPerWorker,
		"packetsPerWorker",
		5,
	);
	const maxAttempts = positiveBoundedInteger(
		options.maxAttempts ?? WorkDefaults.maxAttempts,
		"maxAttempts",
		5,
	);
	const progressEvery = positiveBoundedInteger(
		options.progressEvery ?? WorkDefaults.progressEvery,
		"progressEvery",
		1_000_000,
	);
	const dependencies: WorkDependencies = {
		worker: options.dependencies?.worker ?? new CodexLunaDecisionWorker(),
		next: options.dependencies?.next ?? nextPackets,
		record: options.dependencies?.record ?? recordDecisionValues,
		status: options.dependencies?.status ?? runStatus,
		audit: options.dependencies?.audit ?? auditDecisionQuality,
	};
	const lockPath = join(runDirectory(config.runId), ".work", "orchestrator.lock");
	return withFileLock(lockPath, async () => {
		const startedAt = Date.now();
		await readPacketCheckpoint(config, { verifyAll: true });
		const initialDecisionCount = (await dependencies.status(config)).decisionCount;
		let decisionCount = initialDecisionCount;
		let workerRetries = 0;
		if (decisionCount > 0) {
			const initialAudit = await dependencies.audit(config, { persist: false });
			assertAuditAllowsResume(initialAudit);
			for (const path of await listPartFiles(join(runDirectory(config.runId), "decisions")))
				for await (const decision of readJsonLines(path, SourceDecisionSchema))
					if (
						decision.actor.kind !== "codex" ||
						decision.actor.model !== LunaModel ||
						decision.actor.promptRevision !== LunaPromptRevision
					)
						throw new Error(
							"Existing decisions do not belong to this Luna worker protocol; initialize a replacement run",
						);
		}
		await appendRunEvent(config.runId, "work.started", {
			workerProtocol: CurrentLunaWorkerProtocol,
			concurrency,
			packetsPerWorker,
			maxAttempts,
			onlineBatchSize: config.onlineBatchSize,
			maximumActiveRequests: Math.min(
				concurrency,
				Math.ceil(config.onlineBatchSize / packetsPerWorker),
			),
		});
		let nextProgress = (Math.floor(decisionCount / progressEvery) + 1) * progressEvery;
		for (;;) {
			if (options.signal?.aborted)
				throw options.signal.reason ?? new Error("Reconciliation interrupted");
			const pending = await dependencies.next(config, config.onlineBatchSize);
			if (pending.length === 0) {
				const status = await dependencies.status(config);
				if (!status.onlineComplete || status.remainingCount !== 0)
					throw new Error("No pending packet is available before online completion");
				const audit = await dependencies.audit(config, { persist: true });
				if (audit.status !== "passed") throw new Error("Final decision-quality audit failed");
				return { decisionCount: status.decisionCount, onlineComplete: true, workerRetries, audit };
			}

			const batches = chunks(pending, packetsPerWorker);
			let decidedBatches: Awaited<ReturnType<typeof decideWithRetry>>[];
			try {
				decidedBatches = await concurrently(batches, concurrency, (batch) =>
					decideWithRetry(config, dependencies.worker, batch, maxAttempts, options.signal),
				);
			} catch (error) {
				await appendRunEvent(
					config.runId,
					"work.failed",
					{
						failureCode: workFailureCode(error),
						part: pending[0]?.packet.part ?? null,
						requestCount: batches.length,
						...(error instanceof DecisionWorkerAttemptsExhaustedError &&
						error.feedback !== undefined
							? {
									feedbackCategory: error.feedback.category,
									feedbackIssue: error.feedback.issue,
								}
							: {}),
					},
					"error",
				);
				throw error;
			}
			const partRetries = decidedBatches.reduce((sum, batch) => sum + batch.retries, 0);
			workerRetries += partRetries;
			if (partRetries > 0)
				await appendRunEvent(
					config.runId,
					"worker.retried",
					{ retries: partRetries, workerRetries },
					"warning",
				);
			const decisions = decidedBatches.flatMap(({ decisions: batch }) => batch);
			const recorded = await dependencies.record(config, decisions);
			if (recorded.recorded !== decisions.length)
				throw new Error(`Recorded ${recorded.recorded} decisions, expected ${decisions.length}`);
			decisionCount += recorded.recorded;
			if (decisionCount >= nextProgress) {
				const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1_000);
				const progress = {
					decisionCount,
					recorded: decisionCount - initialDecisionCount,
					workerRetries,
					elapsedSeconds,
					decisionsPerMinute: ((decisionCount - initialDecisionCount) * 60) / elapsedSeconds,
				};
				options.onProgress?.(progress);
				await appendRunEvent(config.runId, "work.progress", progress);
				while (nextProgress <= decisionCount) nextProgress += progressEvery;
			}
		}
	});
}
