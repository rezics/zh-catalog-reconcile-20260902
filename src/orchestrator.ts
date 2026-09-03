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
import {
	decisionProgressStart,
	nextPackets,
	pendingPacketsForPart,
	recordDecisionValues,
	runStatus,
} from "./decisions.ts";
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
	CodexLunaTriageWorker,
	type DecisionWorker,
	type DecisionWorkItem,
	LunaModel,
	LunaPromptRevision,
	LunaTriagePromptRevision,
	LunaWorkerFailure,
	type TriageWorker,
} from "./model-worker.ts";
import { captureNextOnlinePacketBatch, readPacketCheckpoint } from "./packets.ts";
import {
	type DecisionWorkerFeedback,
	DecisionWorkerValidationError,
	workerValidationError,
} from "./worker-feedback.ts";

export const WorkDefaults = {
	concurrency: 128,
	packetsPerWorker: 4,
	triageConcurrency: 64,
	triagePacketsPerWorker: 20,
	maxActiveParts: 16,
	maxAttempts: 5,
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
	readonly triage: TriageWorker;
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
	readonly usePipeline?: boolean;
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
		config.workerProtocol.triagePromptRevision !== CurrentLunaWorkerProtocol.triagePromptRevision ||
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

function normalizedCitationText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

function differsByOneCharacter(left: string, right: string): boolean {
	const leftCharacters = [...left];
	const rightCharacters = [...right];
	if (leftCharacters.length !== rightCharacters.length || leftCharacters.length < 2) return false;
	let differences = 0;
	for (let index = 0; index < leftCharacters.length; index += 1) {
		if (leftCharacters[index] === rightCharacters[index]) continue;
		differences += 1;
		if (differences > 1) return false;
	}
	return differences === 1;
}

function repairNearMissTitleCitation(
	packet: ReviewPacket,
	citation: DecisionEvidenceCitation,
	transforms: readonly { readonly from: string; readonly to: string }[],
): DecisionEvidenceCitation {
	if (citation.field !== "localization_title") return citation;
	const book = packet.candidates.find(({ id }) => id === citation.unitId);
	if (!book) return citation;
	const transformedExcerpt = transforms.reduce(
		(value, { from, to }) => value.replaceAll(from, to),
		citation.excerpt,
	);
	const excerpt = normalizedCitationText(transformedExcerpt);
	const titles = book.localizations.flatMap(({ title }) => (title === null ? [] : [title]));
	if (titles.some((title) => normalizedCitationText(title).includes(excerpt)))
		return transformedExcerpt === citation.excerpt
			? citation
			: { ...citation, excerpt: transformedExcerpt };
	const nearMatches = titles.filter((title) =>
		differsByOneCharacter(normalizedCitationText(title), excerpt),
	);
	const replacement = nearMatches.length === 1 ? nearMatches[0] : undefined;
	return replacement === undefined ? citation : { ...citation, excerpt: replacement };
}

function repairNearMissTitleCitations(
	packet: ReviewPacket,
	proposal: DecisionProposal,
): DecisionProposal {
	const transforms =
		proposal.disposition === "keep"
			? proposal.basis
					.filter(({ code }) => code === "booklike_title")
					.flatMap(({ citations }) => citations)
					.flatMap((citation) => {
						if (citation.field !== "localization_title") return [];
						const book = packet.candidates.find(({ id }) => id === citation.unitId);
						if (!book) return [];
						const titles = [
							...new Set(
								book.localizations.flatMap(({ title }) => (title === null ? [] : [title])),
							),
						];
						const title = titles.length === 1 ? titles[0] : undefined;
						if (
							title === undefined ||
							[...normalizedCitationText(title)].length !==
								[...normalizedCitationText(citation.excerpt)].length
						)
							return [];
						return [{ from: citation.excerpt, to: title }];
					})
			: [];
	if (proposal.disposition === "review")
		return {
			...proposal,
			uncertainties: proposal.uncertainties.map((uncertainty) => ({
				...uncertainty,
				citations: uncertainty.citations.map((citation) =>
					repairNearMissTitleCitation(packet, citation, transforms),
				),
			})),
		};
	return {
		...proposal,
		basis: proposal.basis.map((basis) => ({
			...basis,
			citations: basis.citations.map((citation) =>
				repairNearMissTitleCitation(packet, citation, transforms),
			),
		})),
	};
}

function repairMergeTargetUnitId(
	packet: ReviewPacket,
	proposal: DecisionProposal,
): DecisionProposal {
	if (
		proposal.disposition !== "merge" ||
		packet.candidates.some(({ id }) => id === proposal.targetUnitId)
	)
		return proposal;
	const candidateIds = new Set(packet.candidates.map(({ id }) => id));
	const citedCandidates = new Set(
		proposal.basis
			.flatMap(({ citations }) => citations)
			.map(({ unitId }) => unitId)
			.filter((unitId) => unitId !== proposal.sourceUnitId && candidateIds.has(unitId)),
	);
	const [targetUnitId] = citedCandidates;
	return citedCandidates.size === 1 && targetUnitId !== undefined
		? { ...proposal, targetUnitId }
		: proposal;
}

function buildProposalDecision(
	config: RunConfig,
	packet: ReviewPacket,
	proposal: DecisionProposal,
	promptRevision: string,
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
			promptRevision,
		},
	});
	validateDecisionAgainstPacket(config, packet, decision);
	return decision;
}

function countBits(value: number): number {
	let remaining = value;
	let count = 0;
	while (remaining > 0) {
		count += remaining & 1;
		remaining >>>= 1;
	}
	return count;
}

function proposalDecision(
	config: RunConfig,
	packet: ReviewPacket,
	proposal: DecisionProposal,
	promptRevision: string,
): SourceDecision {
	const repairedProposal = repairNearMissTitleCitations(
		packet,
		repairMergeTargetUnitId(packet, proposal),
	);
	const candidates: DecisionProposal[] = [repairedProposal];
	if (repairedProposal.disposition !== "review" && repairedProposal.basis.length > 1) {
		const fullMask = 2 ** repairedProposal.basis.length - 1;
		const masks = Array.from({ length: fullMask - 1 }, (_, index) => fullMask - index - 1).sort(
			(left, right) => countBits(right) - countBits(left),
		);
		for (const mask of masks) {
			const basis = repairedProposal.basis.filter((_, index) => (mask & (1 << index)) !== 0);
			if (basis.length > 0) candidates.push({ ...repairedProposal, basis });
		}
	}
	let firstError: unknown;
	for (const candidate of candidates)
		try {
			return buildProposalDecision(config, packet, candidate, promptRevision);
		} catch (error) {
			firstError ??= error;
		}
	throw firstError ?? new Error("Proposal produced no valid basis subset");
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
	readonly decisions: readonly SourceDecision[];

	constructor(
		maxAttempts: number,
		feedback: DecisionWorkerFeedback | undefined,
		cause: unknown,
		decisions: readonly SourceDecision[] = [],
	) {
		const suffix = feedback === undefined ? "" : ` (${feedback.category}:${feedback.issue})`;
		super(`Luna worker failed after ${maxAttempts} attempts${suffix}`, { cause });
		this.name = "DecisionWorkerAttemptsExhaustedError";
		this.feedback = feedback;
		this.decisions = decisions;
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
	promptRevision: string = LunaPromptRevision,
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
		decisions.push(proposalDecision(config, packet, proposal, promptRevision));
	}
	return decisions;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size)
		result.push(values.slice(index, index + size));
	return result;
}

function jsonTextValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(jsonTextValues);
	if (value && typeof value === "object") return Object.values(value).flatMap(jsonTextValues);
	return [];
}

function boundedExcerpt(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed.slice(0, 240);
}

function routineKeepProposal(item: DecisionWorkItem): DecisionProposal | undefined {
	if (item.undecidedSourceUnitIds.length !== 1 || item.packet.candidates.length !== 1)
		return undefined;
	const sourceUnitId = item.undecidedSourceUnitIds[0];
	const source = item.packet.candidates.find(({ id }) => id === sourceUnitId);
	if (!source) return undefined;
	const title = source.localizations
		.map(({ title: value }) => (value === null ? undefined : boundedExcerpt(value)))
		.find((value) => value !== undefined);
	if (!title) return undefined;
	const synopsis = source.localizations
		.flatMap(({ summary, description }) => [
			...(summary === null ? [] : [summary]),
			...(description === null ? [] : jsonTextValues(description)),
		])
		.map(boundedExcerpt)
		.find((value) => value !== undefined);
	const author = source.attributions
		.filter(({ role }) => role.toLocaleLowerCase("en-US") === "author")
		.flatMap(({ role, localizations }) => [
			...localizations.flatMap(({ title: value }) => (value === null ? [] : [value])),
			role,
		])
		.map(boundedExcerpt)
		.find((value) => value !== undefined);
	const isbn = source.details.isbn13 === null ? undefined : boundedExcerpt(source.details.isbn13);
	const corroboration = synopsis
		? {
				code: "synopsis_describes_work" as const,
				citations: [
					{
						unitId: source.id,
						field: source.localizations.some(({ summary }) => summary?.includes(synopsis))
							? ("localization_summary" as const)
							: ("localization_description" as const),
						excerpt: synopsis,
					},
				],
			}
		: author
			? {
					code: "author_attribution_present" as const,
					citations: [{ unitId: source.id, field: "attribution" as const, excerpt: author }],
				}
			: isbn
				? {
						code: "identifier_present" as const,
						citations: [{ unitId: source.id, field: "book_isbn13" as const, excerpt: isbn }],
					}
				: undefined;
	if (!corroboration) return undefined;
	return {
		sourceUnitId: source.id,
		confidence: "medium",
		note: null,
		disposition: "keep",
		reason: "distinct_work",
		basis: [
			{
				code: "booklike_title",
				citations: [{ unitId: source.id, field: "localization_title", excerpt: title }],
			},
			corroboration,
		],
	};
}

type TriageResult = {
	readonly decisions: SourceDecision[];
	readonly fallbackItems: DecisionWorkItem[];
	readonly routineKeeps: number;
	readonly triageFallbacks: number;
};

async function triageDecisionItems(
	config: RunConfig,
	triage: TriageWorker,
	items: readonly DecisionWorkItem[],
	signal?: AbortSignal,
): Promise<TriageResult> {
	let results: Awaited<ReturnType<TriageWorker["decide"]>>;
	try {
		results = await triage.decide(items, signal === undefined ? {} : { signal });
	} catch (error) {
		if (
			error instanceof LunaWorkerFailure &&
			(error.category === "usage_allowance" || error.category === "authentication")
		)
			throw error;
		return {
			decisions: [],
			fallbackItems: [...items],
			routineKeeps: 0,
			triageFallbacks: items.length,
		};
	}
	const assigned = new Set(items.flatMap(({ undecidedSourceUnitIds }) => undecidedSourceUnitIds));
	const bySource = new Map<string, (typeof results)[number]>();
	for (const result of results) {
		if (!assigned.has(result.sourceUnitId) || bySource.has(result.sourceUnitId))
			return {
				decisions: [],
				fallbackItems: [...items],
				routineKeeps: 0,
				triageFallbacks: items.length,
			};
		bySource.set(result.sourceUnitId, result);
	}
	if (bySource.size !== assigned.size)
		return {
			decisions: [],
			fallbackItems: [...items],
			routineKeeps: 0,
			triageFallbacks: items.length,
		};

	const decisions: SourceDecision[] = [];
	const fallbackItems: DecisionWorkItem[] = [];
	for (const item of items) {
		const sourceUnitId = item.undecidedSourceUnitIds[0];
		const proposal = sourceUnitId ? routineKeepProposal(item) : undefined;
		const result = sourceUnitId ? bySource.get(sourceUnitId) : undefined;
		const source = sourceUnitId
			? item.packet.candidates.find(({ id }) => id === sourceUnitId)
			: undefined;
		const suspiciousSignals = sourceUnitId
			? (item.packet.suspiciousSignals[sourceUnitId] ?? [])
			: [];
		const hasGuardedCorroboration =
			(source?.localizations.some(
				({ summary, description }) =>
					Boolean(summary?.trim()) ||
					(typeof description === "string" && Boolean(description.trim())),
			) ??
				false) ||
			(source?.attributions.some(({ role }) => role.toLocaleLowerCase("en-US") === "author") ??
				false) ||
			Boolean(source?.details.isbn13);
		if (
			!sourceUnitId ||
			result?.disposition !== "keep" ||
			result.reason !== "distinct_work" ||
			result.confidence !== "high" ||
			result.targetUnitId !== null ||
			suspiciousSignals.length !== 0 ||
			!hasGuardedCorroboration ||
			!proposal
		) {
			fallbackItems.push(item);
			continue;
		}
		try {
			decisions.push(
				...compileDecisionProposals(config, [item], [proposal], LunaTriagePromptRevision),
			);
		} catch {
			fallbackItems.push(item);
		}
	}
	return {
		decisions,
		fallbackItems,
		routineKeeps: decisions.length,
		triageFallbacks: fallbackItems.length,
	};
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
	let pending = [...items];
	const decisions: SourceDecision[] = [];
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (signal?.aborted) throw signal.reason ?? new Error("Reconciliation interrupted");
		try {
			const proposals = await worker.decide(pending, {
				...(signal === undefined ? {} : { signal }),
				...(feedback === undefined ? {} : { feedback }),
			});
			const assigned = new Set(
				pending.flatMap(({ undecidedSourceUnitIds }) => undecidedSourceUnitIds),
			);
			if (proposals.some(({ sourceUnitId }) => !assigned.has(sourceUnitId)))
				throw workerValidationError(
					"Worker returned an unassigned source",
					"assignment_invalid",
					"assignment_contract",
				);
			const remaining: DecisionWorkItem[] = [];
			let firstError: unknown;
			for (const item of pending) {
				const itemSourceIds = new Set(item.undecidedSourceUnitIds);
				try {
					decisions.push(
						...compileDecisionProposals(
							config,
							[item],
							proposals.filter(({ sourceUnitId }) => itemSourceIds.has(sourceUnitId)),
						),
					);
				} catch (error) {
					firstError ??= error;
					remaining.push(item);
				}
			}
			if (remaining.length === 0) return { decisions, retries: attempt - 1 };
			lastError = firstError;
			feedback = classifyDecisionWorkerFeedback(firstError);
			pending = remaining;
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
	throw new DecisionWorkerAttemptsExhaustedError(maxAttempts, feedback, lastError, decisions);
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

class Semaphore {
	#active = 0;
	readonly #waiters: (() => void)[] = [];

	constructor(readonly capacity: number) {}

	async run<Result>(operation: () => Promise<Result>): Promise<Result> {
		if (this.#active >= this.capacity)
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		this.#active += 1;
		try {
			return await operation();
		} finally {
			this.#active -= 1;
			this.#waiters.shift()?.();
		}
	}
}

type PipelinedPartResult = {
	readonly part: number;
	readonly recorded: number;
	readonly workerRetries: number;
	readonly routineKeeps: number;
	readonly triageFallbacks: number;
};

class PartialPipelinedBatchError extends Error {
	constructor(
		readonly decisions: readonly SourceDecision[],
		readonly workerRetries: number,
		readonly routineKeeps: number,
		readonly triageFallbacks: number,
		readonly originalError: unknown,
	) {
		super("A pipelined batch failed after producing validated partial decisions", {
			cause: originalError,
		});
	}
}

async function processPipelinedPart(
	config: RunConfig,
	part: number,
	dependencies: WorkDependencies,
	requestLimit: Semaphore,
	triageLimit: Semaphore,
	packetsPerWorker: number,
	maxAttempts: number,
	signal?: AbortSignal,
): Promise<PipelinedPartResult> {
	const pending = await pendingPacketsForPart(config, part);
	if (pending.length === 0)
		return { part, recorded: 0, workerRetries: 0, routineKeeps: 0, triageFallbacks: 0 };
	const triageBatches = chunks(pending, WorkDefaults.triagePacketsPerWorker);
	const batchOutcomes = await Promise.allSettled(
		triageBatches.map(async (triageBatch) => {
			const triaged = await triageLimit.run(() =>
				requestLimit.run(() =>
					triageDecisionItems(config, dependencies.triage, triageBatch, signal),
				),
			);
			const fullOutcomes = await Promise.allSettled(
				chunks(triaged.fallbackItems, packetsPerWorker).map((batch) =>
					requestLimit.run(() =>
						decideWithRetry(config, dependencies.worker, batch, maxAttempts, signal),
					),
				),
			);
			const decisions = [...triaged.decisions];
			let workerRetries = 0;
			let firstError: unknown;
			for (const outcome of fullOutcomes) {
				if (outcome.status === "fulfilled") {
					decisions.push(...outcome.value.decisions);
					workerRetries += outcome.value.retries;
					continue;
				}
				firstError ??= outcome.reason;
				if (outcome.reason instanceof DecisionWorkerAttemptsExhaustedError) {
					decisions.push(...outcome.reason.decisions);
					workerRetries += maxAttempts - 1;
				}
			}
			if (firstError !== undefined)
				throw new PartialPipelinedBatchError(
					decisions,
					workerRetries,
					triaged.routineKeeps,
					triaged.triageFallbacks,
					firstError,
				);
			return {
				decisions,
				workerRetries,
				routineKeeps: triaged.routineKeeps,
				triageFallbacks: triaged.triageFallbacks,
			};
		}),
	);
	const decisions: SourceDecision[] = [];
	let workerRetries = 0;
	let routineKeeps = 0;
	let triageFallbacks = 0;
	let firstError: unknown;
	for (const outcome of batchOutcomes) {
		if (outcome.status === "fulfilled") {
			decisions.push(...outcome.value.decisions);
			workerRetries += outcome.value.workerRetries;
			routineKeeps += outcome.value.routineKeeps;
			triageFallbacks += outcome.value.triageFallbacks;
			continue;
		}
		const error = outcome.reason;
		if (error instanceof PartialPipelinedBatchError) {
			decisions.push(...error.decisions);
			workerRetries += error.workerRetries;
			routineKeeps += error.routineKeeps;
			triageFallbacks += error.triageFallbacks;
			firstError ??= error.originalError;
		} else firstError ??= error;
	}
	let recordedCount = 0;
	if (decisions.length > 0) {
		const recorded = await dependencies.record(config, decisions);
		if (recorded.recorded !== decisions.length)
			throw new Error(`Recorded ${recorded.recorded} decisions, expected ${decisions.length}`);
		recordedCount = recorded.recorded;
	}
	if (firstError !== undefined) throw firstError;
	return {
		part,
		recorded: recordedCount,
		workerRetries,
		routineKeeps,
		triageFallbacks,
	};
}

async function runPipelinedReconciliation(
	config: RunConfig,
	options: WorkOptions,
	dependencies: WorkDependencies,
	initialDecisionCount: number,
	startedAt: number,
	concurrency: number,
	packetsPerWorker: number,
	maxAttempts: number,
	progressEvery: number,
): Promise<WorkResult> {
	const requestLimit = new Semaphore(concurrency);
	const triageLimit = new Semaphore(Math.min(WorkDefaults.triageConcurrency, concurrency));
	let checkpoint = await readPacketCheckpoint(config);
	let nextPart = await decisionProgressStart(config);
	let decisionCount = initialDecisionCount;
	let workerRetries = 0;
	let nextProgress = (Math.floor(decisionCount / progressEvery) + 1) * progressEvery;
	const active = new Map<number, Promise<PipelinedPartResult>>();

	for (;;) {
		if (options.signal?.aborted)
			throw options.signal.reason ?? new Error("Reconciliation interrupted");
		while (active.size < WorkDefaults.maxActiveParts) {
			if (nextPart < checkpoint.nextPart) {
				const part = nextPart++;
				active.set(
					part,
					processPipelinedPart(
						config,
						part,
						dependencies,
						requestLimit,
						triageLimit,
						packetsPerWorker,
						maxAttempts,
						options.signal,
					),
				);
				continue;
			}
			if (checkpoint.complete) break;
			checkpoint = await captureNextOnlinePacketBatch(config);
		}
		if (active.size === 0) break;
		const settled = await Promise.race(
			[...active.entries()].map(([part, promise]) =>
				promise.then(
					(value) => ({ part, value, error: undefined }),
					(error: unknown) => ({ part, value: undefined, error }),
				),
			),
		);
		active.delete(settled.part);
		if (settled.error !== undefined) {
			await Promise.allSettled(active.values());
			await appendRunEvent(
				config.runId,
				"work.failed",
				{ failureCode: workFailureCode(settled.error), part: settled.part },
				"error",
			);
			throw settled.error;
		}
		if (settled.value === undefined) throw new Error("Pipelined part completed without a result");
		const result = settled.value;
		decisionCount += result.recorded;
		workerRetries += result.workerRetries;
		await appendRunEvent(config.runId, "triage.completed", {
			part: result.part,
			routineKeeps: result.routineKeeps,
			fullWorkerSources: result.triageFallbacks,
			workerRetries: result.workerRetries,
		});
		if (result.workerRetries > 0)
			await appendRunEvent(
				config.runId,
				"worker.retried",
				{ retries: result.workerRetries, workerRetries },
				"warning",
			);
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

	const pending = await nextPackets(config, config.onlineBatchSize);
	if (pending.length !== 0) throw new Error("Pipelined work ended with pending packets");
	const status = await dependencies.status(config);
	if (!status.onlineComplete || status.remainingCount !== 0)
		throw new Error("Pipelined work ended before online completion");
	const audit = await dependencies.audit(config, { persist: true });
	if (audit.status !== "passed") throw new Error("Final decision-quality audit failed");
	return { decisionCount: status.decisionCount, onlineComplete: true, workerRetries, audit };
}

export async function runConcurrentReconciliation(
	config: RunConfig,
	options: WorkOptions = {},
): Promise<WorkResult> {
	assertCurrentWorkerProtocol(config);
	const concurrency = positiveBoundedInteger(
		options.concurrency ?? WorkDefaults.concurrency,
		"concurrency",
		128,
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
		triage:
			options.dependencies?.triage ??
			(options.dependencies === undefined
				? new CodexLunaTriageWorker()
				: {
						decide: async (items) =>
							items.flatMap(({ undecidedSourceUnitIds }) =>
								undecidedSourceUnitIds.map((sourceUnitId) => ({
									sourceUnitId,
									confidence: "low" as const,
									disposition: "review" as const,
									reason: "insufficient_evidence" as const,
									targetUnitId: null,
								})),
							),
					}),
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
						(decision.actor.promptRevision !== LunaPromptRevision &&
							decision.actor.promptRevision !== LunaTriagePromptRevision)
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
				Math.ceil((config.onlineBatchSize * WorkDefaults.maxActiveParts) / packetsPerWorker),
			),
			triageConcurrency: Math.min(WorkDefaults.triageConcurrency, concurrency),
			triagePacketsPerWorker: WorkDefaults.triagePacketsPerWorker,
			maxActiveParts: WorkDefaults.maxActiveParts,
		});
		if (options.usePipeline ?? options.dependencies === undefined)
			return runPipelinedReconciliation(
				config,
				options,
				dependencies,
				initialDecisionCount,
				startedAt,
				concurrency,
				packetsPerWorker,
				maxAttempts,
				progressEvery,
			);
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
