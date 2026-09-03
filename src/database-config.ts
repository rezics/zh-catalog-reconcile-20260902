import { access, readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { SshStdioBridge, type SshStdioBridgeConfig } from "./ssh-stdio-bridge.ts";

const HostOperatorSchema = z.object({
	status: z.string().min(1),
	fingerprint: z.string().min(1),
});

const ProductionMonitoringSecretSchema = z.object({
	main_db_server_info: z.object({
		host: z.string().min(1),
		username: z.string().regex(/^[a-z_][a-z0-9_-]*$/iu),
		ssh: z.object({
			operatorKey: z.string().min(1),
		}),
	}),
	postgresql: z.object({
		rezicsProduction: z.object({
			current: z.object({
				runtime: z.object({
					url: z.string().min(1),
				}),
			}),
			monitoring: z.object({
				username: z.string().min(1),
				password: z.string().min(1),
				status: z.string().min(1),
				role: z.string().min(1),
			}),
		}),
	}),
	ssh: z.object({
		hostOperators: z.record(z.string(), HostOperatorSchema),
	}),
});

export type DatabaseEnvironment = Readonly<
	Partial<
		Record<
			| "REZICS_DATABASE_READONLY_URL"
			| "REZICS_DATABASE_SECRET_FILE"
			| "REZICS_DATABASE_SECRET_PROFILE"
			| "REZICS_SSH_BIND_INTERFACE",
			string | undefined
		>
	>
>;

export type CredentialPolicy = "least-privilege" | "runtime-forced-read-only";

export type ResolvedDatabaseAccess =
	| {
			readonly kind: "direct";
			readonly databaseUrl: string;
			readonly credentialPolicy: "least-privilege";
	  }
	| {
			readonly kind: "ssh-stdio";
			readonly databaseUrl: string;
			readonly credentialPolicy: CredentialPolicy;
			readonly bridge: SshStdioBridgeConfig;
	  };

export type ActiveDatabaseEndpoint = {
	readonly transport: ResolvedDatabaseAccess["kind"];
	readonly databaseUrl: string;
	readonly credentialPolicy: CredentialPolicy;
};

function parsePostgresUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("The configured database endpoint is not a valid URL");
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
		throw new Error("The configured database endpoint is not PostgreSQL");
	if (!url.hostname) throw new Error("The configured database endpoint has no host");
	return url;
}

function bindAddressForInterface(interfaceName: string): string {
	const candidates = networkInterfaces()[interfaceName] ?? [];
	const selected = candidates.find(
		(candidate) => candidate.family === "IPv4" && !candidate.internal,
	);
	if (!selected)
		throw new Error(`REZICS_SSH_BIND_INTERFACE has no active IPv4 address: ${interfaceName}`);
	return selected.address;
}

export async function resolveDatabaseAccess(
	environment?: DatabaseEnvironment,
): Promise<ResolvedDatabaseAccess> {
	const source: DatabaseEnvironment = environment ?? {
		REZICS_DATABASE_READONLY_URL: process.env.REZICS_DATABASE_READONLY_URL,
		REZICS_DATABASE_SECRET_FILE: process.env.REZICS_DATABASE_SECRET_FILE,
		REZICS_DATABASE_SECRET_PROFILE: process.env.REZICS_DATABASE_SECRET_PROFILE,
		REZICS_SSH_BIND_INTERFACE: process.env.REZICS_SSH_BIND_INTERFACE,
	};
	const directUrl = source.REZICS_DATABASE_READONLY_URL?.trim();
	const secretFile = source.REZICS_DATABASE_SECRET_FILE?.trim();
	if (directUrl && secretFile)
		throw new Error(
			"Configure exactly one of REZICS_DATABASE_READONLY_URL or REZICS_DATABASE_SECRET_FILE",
		);
	if (directUrl)
		return {
			kind: "direct",
			databaseUrl: parsePostgresUrl(directUrl).toString(),
			credentialPolicy: "least-privilege",
		};
	if (!secretFile)
		throw new Error(
			"REZICS_DATABASE_SECRET_FILE or REZICS_DATABASE_READONLY_URL is required; generic DATABASE_URL variables are ignored",
		);
	if (!isAbsolute(secretFile))
		throw new Error("REZICS_DATABASE_SECRET_FILE must be an absolute path");

	let untrusted: unknown;
	try {
		untrusted = JSON.parse(await readFile(secretFile, "utf8"));
	} catch {
		throw new Error("Unable to read or parse REZICS_DATABASE_SECRET_FILE");
	}
	const parsed = ProductionMonitoringSecretSchema.safeParse(untrusted);
	if (!parsed.success)
		throw new Error("The secret file is missing the production SSH or monitoring profile");
	const { main_db_server_info: server, postgresql, ssh } = parsed.data;
	const { current, monitoring } = postgresql.rezicsProduction;
	const profile = source.REZICS_DATABASE_SECRET_PROFILE?.trim() || "monitoring";
	if (profile !== "monitoring" && profile !== "runtime")
		throw new Error("REZICS_DATABASE_SECRET_PROFILE must be monitoring or runtime");
	if (profile === "monitoring") {
		if (!/(?:active|current|ready|verified)/iu.test(monitoring.status))
			throw new Error("The production monitoring database profile is not active");
		if (!/(?:monitor|read|select)/iu.test(monitoring.role))
			throw new Error("The production monitoring database profile is not marked read-only");
	}
	const operatorMatch = /^ssh\.hostOperators\.([a-z0-9_-]+)$/iu.exec(server.ssh.operatorKey);
	const operatorName = operatorMatch?.[1];
	if (!operatorName) throw new Error("The production SSH operator-key selector is invalid");
	const operator = ssh.hostOperators[operatorName];
	if (!operator || !/(?:active|current|ready|verified)/iu.test(operator.status))
		throw new Error("The selected production SSH operator key is not active");
	const identityFile = join(
		dirname(secretFile),
		"server",
		operatorName.toLowerCase(),
		"operator-ed25519",
	);
	try {
		await access(identityFile);
	} catch {
		throw new Error("The selected production SSH operator private key is unavailable locally");
	}

	const databaseUrl = parsePostgresUrl(current.runtime.url);
	const credentialPolicy: CredentialPolicy =
		profile === "monitoring" ? "least-privilege" : "runtime-forced-read-only";
	if (profile === "monitoring") {
		databaseUrl.username = monitoring.username;
		databaseUrl.password = monitoring.password;
	} else {
		const existingOptions = databaseUrl.searchParams.get("options")?.trim();
		const readOnlyOption = "-c default_transaction_read_only=on";
		if (!existingOptions?.includes("default_transaction_read_only"))
			databaseUrl.searchParams.set(
				"options",
				existingOptions ? `${existingOptions} ${readOnlyOption}` : readOnlyOption,
			);
	}
	const databasePort = Number(databaseUrl.port || "5432");
	if (!Number.isSafeInteger(databasePort) || databasePort < 1 || databasePort > 65_535)
		throw new Error("The production database port is invalid");

	return {
		kind: "ssh-stdio",
		databaseUrl: databaseUrl.toString(),
		credentialPolicy,
		bridge: {
			sshHost: server.host,
			sshUser: server.username,
			identityFile,
			...(source.REZICS_SSH_BIND_INTERFACE?.trim()
				? {
						bindAddress: bindAddressForInterface(source.REZICS_SSH_BIND_INTERFACE.trim()),
					}
				: {}),
			targetHost: databaseUrl.hostname,
			targetPort: databasePort,
		},
	};
}

export async function withDatabaseTransport<Result>(
	operation: (endpoint: ActiveDatabaseEndpoint) => Promise<Result>,
	environment?: DatabaseEnvironment,
): Promise<Result> {
	const access = await resolveDatabaseAccess(environment);
	if (access.kind === "direct")
		return operation({
			transport: access.kind,
			databaseUrl: access.databaseUrl,
			credentialPolicy: access.credentialPolicy,
		});

	const bridge = new SshStdioBridge(access.bridge);
	const local = await bridge.start();
	const localUrl = new URL(access.databaseUrl);
	localUrl.hostname = local.host;
	localUrl.port = String(local.port);
	try {
		return await operation({
			transport: access.kind,
			databaseUrl: localUrl.toString(),
			credentialPolicy: access.credentialPolicy,
		});
	} catch (error) {
		if (bridge.lastFailure) throw new Error(bridge.lastFailure, { cause: error });
		throw error;
	} finally {
		await bridge.close();
	}
}

const ReadOnlyPrivilegeProofSchema = z
	.object({
		defaultTransactionReadOnly: z.boolean(),
		transactionReadOnly: z.boolean(),
		restrictedRole: z.boolean(),
		canSelectAllRequiredRelations: z.boolean(),
		canExecuteCandidateSearch: z.boolean(),
		canWriteAnyRequiredRelation: z.boolean(),
		canWriteAnyRequiredColumn: z.boolean(),
	})
	.strict();

export type ReadOnlyPrivilegeProof = z.infer<typeof ReadOnlyPrivilegeProofSchema>;

export function assertReadOnlyPrivilegeProof(
	value: unknown,
	credentialPolicy: CredentialPolicy = "least-privilege",
): ReadOnlyPrivilegeProof {
	const proof = ReadOnlyPrivilegeProofSchema.parse(value);
	if (!proof.transactionReadOnly) throw new Error("Database transaction is not read-only");
	if (credentialPolicy === "runtime-forced-read-only" && !proof.defaultTransactionReadOnly)
		throw new Error("Database session does not default every transaction to read-only");
	if (!proof.restrictedRole)
		throw new Error("Database role has cluster-level privilege escalation capabilities");
	if (!proof.canSelectAllRequiredRelations)
		throw new Error(
			"Database role cannot SELECT every relation required by online evidence capture",
		);
	if (!proof.canExecuteCandidateSearch)
		throw new Error("Database role cannot execute the bounded REZICS candidate search");
	if (
		credentialPolicy === "least-privilege" &&
		(proof.canWriteAnyRequiredRelation || proof.canWriteAnyRequiredColumn)
	)
		throw new Error("Database role has write privileges on a reconciliation relation");
	return proof;
}
