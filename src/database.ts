import { readFile } from "node:fs/promises";
import { join } from "node:path";

import postgres from "postgres";
import { z } from "zod";

import {
	type BookEvidence,
	BookEvidenceSchema,
	type Inventory,
	InventorySchema,
	RawBookEvidenceSchema,
	type RunConfig,
	SchemaVersion,
} from "./contracts.ts";
import {
	type ActiveDatabaseEndpoint,
	assertReadOnlyPrivilegeProof,
	type CredentialPolicy,
	type ReadOnlyPrivilegeProof,
	withDatabaseTransport,
} from "./database-config.ts";
import { sha256 } from "./hash.ts";
import { appendRunEvent, nowIso, repositoryRoot, runDirectory, writeJsonAtomic } from "./io.ts";

const StatementTimeout = "120s";

type ReadOnlyQuery = <Result extends Record<string, unknown>>(
	operation: (sql: postgres.TransactionSql, proof: ReadOnlyPrivilegeProof) => Promise<Result>,
) => Promise<Result>;

async function withReadOnlyDatabase<Result>(
	operation: (
		queryReadOnly: ReadOnlyQuery,
		endpoint: Pick<ActiveDatabaseEndpoint, "transport" | "credentialPolicy">,
	) => Promise<Result>,
): Promise<Result> {
	return withDatabaseTransport(async (endpoint) => {
		const sql = postgres(endpoint.databaseUrl, {
			max: 1,
			connect_timeout: 15,
			idle_timeout: 5,
			max_lifetime: 60,
			prepare: false,
		});
		const queryReadOnly: ReadOnlyQuery = async <QueryResult extends Record<string, unknown>>(
			queryOperation: (
				transaction: postgres.TransactionSql,
				proof: ReadOnlyPrivilegeProof,
			) => Promise<QueryResult>,
		): Promise<QueryResult> => {
			const result = await sql.begin(async (transaction) => {
				await transaction.unsafe("set transaction isolation level repeatable read, read only");
				await transaction`select set_config('statement_timeout', ${StatementTimeout}, true)`;
				const [verification] = await transaction<readonly Record<string, unknown>[]>`
				with required_relations(relation_name) as (
					values
						('public.unit'),
						('public.book'),
						('public.unit_localization'),
						('public.unit_alias'),
						('public.credit_attribution'),
						('public.entity')
				), role_capabilities as (
					select not (
						rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls
					) as restricted
					from pg_roles
					where rolname = current_user
				)
				select
					current_setting('default_transaction_read_only') = 'on'
						as "defaultTransactionReadOnly",
					current_setting('transaction_read_only') = 'on' as "transactionReadOnly",
					coalesce((select restricted from role_capabilities), false) as "restrictedRole",
					bool_and(has_table_privilege(current_user, relation_name, 'SELECT'))
						as "canSelectAllRequiredRelations",
					has_function_privilege(
						current_user,
						'public.search_text_candidates(text[], text[], text, bigint, uuid, integer, integer)',
						'EXECUTE'
					) as "canExecuteCandidateSearch",
					bool_or(
						has_table_privilege(current_user, relation_name, 'INSERT') or
						has_table_privilege(current_user, relation_name, 'UPDATE') or
						has_table_privilege(current_user, relation_name, 'DELETE') or
						has_table_privilege(current_user, relation_name, 'TRUNCATE') or
						has_table_privilege(current_user, relation_name, 'REFERENCES') or
						has_table_privilege(current_user, relation_name, 'TRIGGER')
					) as "canWriteAnyRequiredRelation",
					bool_or(
						has_any_column_privilege(current_user, relation_name, 'INSERT') or
						has_any_column_privilege(current_user, relation_name, 'UPDATE') or
						has_any_column_privilege(current_user, relation_name, 'REFERENCES')
					) as "canWriteAnyRequiredColumn"
				from required_relations`;
				const proof = assertReadOnlyPrivilegeProof(verification, endpoint.credentialPolicy);
				return queryOperation(transaction, proof);
			});
			// postgres.js models transaction callbacks with an array-unwrapping conditional type.
			// QueryResult is constrained to non-array records, so the runtime value remains intact.
			return result as QueryResult;
		};
		try {
			return await operation(queryReadOnly, endpoint);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});
}

export async function databaseDoctor(): Promise<{
	readonly connected: true;
	readonly transport: ActiveDatabaseEndpoint["transport"];
	readonly credentialPolicy: CredentialPolicy;
	readonly sessionDefaultReadOnly: boolean;
	readonly transactionReadOnly: boolean;
	readonly restrictedRole: boolean;
	readonly requiredRelationsReadable: boolean;
	readonly candidateSearchExecutable: boolean;
	readonly credentialHasWritePrivileges: boolean;
	readonly writesBlockedByRunner: boolean;
}> {
	return withReadOnlyDatabase(async (queryReadOnly, endpoint) => {
		const { proof } = await queryReadOnly(async (_sql, proof) => ({ proof }));
		return {
			connected: true,
			transport: endpoint.transport,
			credentialPolicy: endpoint.credentialPolicy,
			sessionDefaultReadOnly: proof.defaultTransactionReadOnly,
			transactionReadOnly: proof.transactionReadOnly,
			restrictedRole: proof.restrictedRole,
			requiredRelationsReadable: proof.canSelectAllRequiredRelations,
			candidateSearchExecutable: proof.canExecuteCandidateSearch,
			credentialHasWritePrivileges:
				proof.canWriteAnyRequiredRelation || proof.canWriteAnyRequiredColumn,
			writesBlockedByRunner:
				proof.transactionReadOnly &&
				(endpoint.credentialPolicy === "least-privilege" || proof.defaultTransactionReadOnly),
		};
	});
}

export function isExactZhSource(book: {
	readonly localizations: readonly { language: string }[];
}): boolean {
	const languages = new Set(book.localizations.map((localization) => localization.language));
	return languages.size === 1 && languages.has("zh");
}

function toEvidence(value: unknown): BookEvidence {
	const evidence = RawBookEvidenceSchema.parse(value);
	const localizationLanguages = [
		...new Set(evidence.localizations.map(({ language }) => language)),
	].sort();
	const unhashed = {
		...evidence,
		schemaVersion: SchemaVersion,
		sourceEligible: isExactZhSource(evidence),
		localizationLanguages,
	};
	return BookEvidenceSchema.parse({ ...unhashed, evidenceHash: sha256(unhashed) });
}

function numeric(value: unknown, field: string): number {
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result < 0)
		throw new Error(`Inventory field ${field} is not a safe non-negative integer`);
	return result;
}

export async function captureInventory(config: RunConfig): Promise<Inventory> {
	if (config.decisionPolicyRevision !== "evidence-grounded-v2")
		throw new Error(
			`Run decision policy ${config.decisionPolicyRevision} is read-only; initialize a new run`,
		);
	const query = await readFile(join(repositoryRoot, "sql", "inventory.sql"), "utf8");
	const { raw } = await withReadOnlyDatabase(async (queryReadOnly) =>
		queryReadOnly(async (sql) => {
			const [row] = await sql.unsafe<{ readonly inventory: Record<string, unknown> }[]>(query, [
				config.cutoff,
			]);
			if (!row) throw new Error("Inventory query returned no row");
			return { raw: row.inventory };
		}),
	);
	const languageSets = Array.isArray(raw.languageSets) ? raw.languageSets : [];
	const inventory = InventorySchema.parse({
		schemaVersion: SchemaVersion,
		runId: config.runId,
		capturedAt: nowIso(),
		cutoff: config.cutoff,
		publicBooks: numeric(raw.publicBooks, "publicBooks"),
		exactZhSources: numeric(raw.exactZhSources, "exactZhSources"),
		withJapaneseMetadata: numeric(raw.withJapaneseMetadata, "withJapaneseMetadata"),
		withNoMetadataLocalization: numeric(
			raw.withNoMetadataLocalization,
			"withNoMetadataLocalization",
		),
		earliestSourceCreatedAt: raw.earliestSourceCreatedAt ?? null,
		latestSourceCreatedAt: raw.latestSourceCreatedAt ?? null,
		languageSets: languageSets.map((entry) => {
			if (!entry || typeof entry !== "object")
				throw new Error("Invalid language-set inventory row");
			const row = entry as { readonly languages?: unknown; readonly count?: unknown };
			return {
				languages: row.languages,
				count: numeric(row.count, "languageSets.count"),
			};
		}),
	});
	await writeJsonAtomic(join(runDirectory(config.runId), "inventory.json"), inventory);
	await appendRunEvent(config.runId, "inventory.captured", {
		publicBooks: inventory.publicBooks,
		exactZhSources: inventory.exactZhSources,
		withJapaneseMetadata: inventory.withJapaneseMetadata,
	});
	return inventory;
}

const OnlineSourceRowSchema = z
	.object({
		id: z.uuid(),
		title: z.string().nullable(),
	})
	.strict();

const OnlineCandidateLinkSchema = z
	.object({
		sourceUnitId: z.uuid(),
		candidateUnitId: z.uuid(),
		position: z.coerce.number().int().positive(),
	})
	.strict();

export type OnlineEvidenceGroup = {
	readonly source: BookEvidence;
	readonly candidates: readonly BookEvidence[];
};

export type OnlineCatalogReader = {
	readonly readEvidencePage: (input: {
		readonly afterCreatedAt: string | null;
		readonly afterUnitId: string | null;
		readonly limit: number;
		readonly maxCandidates: number;
	}) => Promise<readonly OnlineEvidenceGroup[]>;
};

export async function withOnlineCatalog<Result>(
	config: RunConfig,
	operation: (reader: OnlineCatalogReader) => Promise<Result>,
): Promise<Result> {
	const [sourceQuery, candidateQuery, evidenceQuery] = await Promise.all([
		readFile(join(repositoryRoot, "sql", "online-source-page.sql"), "utf8"),
		readFile(join(repositoryRoot, "sql", "online-candidate-links.sql"), "utf8"),
		readFile(join(repositoryRoot, "sql", "book-evidence.sql"), "utf8"),
	]);

	return withReadOnlyDatabase(async (queryReadOnly) => {
		const readEvidencePage: OnlineCatalogReader["readEvidencePage"] = async (input) => {
			if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
				throw new Error("Online source page limit must be between 1 and 100");
			if (
				!Number.isSafeInteger(input.maxCandidates) ||
				input.maxCandidates < 2 ||
				input.maxCandidates > 50
			)
				throw new Error("Online candidate limit must be between 2 and 50");
			if ((input.afterCreatedAt === null) !== (input.afterUnitId === null))
				throw new Error("Online source cursor fields must be supplied together");

			const { groups } = await queryReadOnly(async (sql) => {
				const rawSources = await sql.unsafe<Record<string, unknown>[]>(sourceQuery, [
					config.cutoff,
					input.afterCreatedAt,
					input.afterUnitId,
					input.limit,
				]);
				const sources = rawSources.map((source) => OnlineSourceRowSchema.parse(source));
				if (sources.length === 0) return { groups: [] as OnlineEvidenceGroup[] };

				const rawLinks = await sql.unsafe<Record<string, unknown>[]>(candidateQuery, [
					sql.json(sources.map(({ id, title }) => ({ sourceUnitId: id, title }))),
					input.maxCandidates,
					config.cutoff,
				]);
				const links = rawLinks.map((link) => OnlineCandidateLinkSchema.parse(link));
				const requestedIds = new Set(sources.map(({ id }) => id));
				for (const link of links) requestedIds.add(link.candidateUnitId);
				const evidenceRows = await sql.unsafe<{ readonly record: unknown }[]>(evidenceQuery, [
					sql.json([...requestedIds]),
					config.cutoff,
				]);
				const evidenceById = new Map(
					evidenceRows.map(({ record }) => {
						const evidence = toEvidence(record);
						return [evidence.id, evidence] as const;
					}),
				);
				const linksBySource = Map.groupBy(links, ({ sourceUnitId }) => sourceUnitId);
				const groups = sources.map(({ id }) => {
					const source = evidenceById.get(id);
					if (!source?.sourceEligible)
						throw new Error(`Online source lost exact-zh eligibility during capture: ${id}`);
					const candidateIds =
						linksBySource.get(id)?.map(({ candidateUnitId }) => candidateUnitId) ?? [];
					const candidates = candidateIds
						.map((candidateId) => evidenceById.get(candidateId))
						.filter((candidate): candidate is BookEvidence => candidate !== undefined);
					return { source, candidates };
				});
				return { groups };
			});
			return groups;
		};

		return operation({ readEvidencePage });
	});
}
