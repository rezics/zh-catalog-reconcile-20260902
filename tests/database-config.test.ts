import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertReadOnlyPrivilegeProof, resolveDatabaseAccess } from "../src/database-config.ts";
import { repositoryRoot } from "../src/io.ts";

describe("database credential resolution", () => {
	test("builds an SSH stdio access plan without copying the secret to .env", async () => {
		const scratchRoot = join(repositoryRoot, ".temp");
		await mkdir(scratchRoot, { recursive: true });
		const directory = await mkdtemp(join(scratchRoot, "database-config-"));
		try {
			const identityDirectory = join(directory, "server", "b");
			await mkdir(identityDirectory, { recursive: true });
			await writeFile(join(identityDirectory, "operator-ed25519"), "fixture-key");
			const secretPath = join(directory, "secret.json");
			await writeFile(
				secretPath,
				JSON.stringify({
					main_db_server_info: {
						host: "ssh.example.test",
						username: "operator",
						ssh: { operatorKey: "ssh.hostOperators.B" },
					},
					postgresql: {
						rezicsProduction: {
							current: {
								runtime: {
									url: "postgresql://writer:old@db.internal.example:5432/rezics?sslmode=disable",
								},
							},
							monitoring: {
								username: "catalog_monitor",
								password: "p@ss:/?#[]",
								status: "active",
								role: "read-only monitoring",
							},
						},
					},
					ssh: {
						hostOperators: {
							B: { status: "active", fingerprint: "SHA256:fixture" },
						},
					},
				}),
			);

			const access = await resolveDatabaseAccess({
				REZICS_DATABASE_SECRET_FILE: secretPath,
			});
			expect(access.kind).toBe("ssh-stdio");
			if (access.kind !== "ssh-stdio") throw new Error("Expected SSH stdio access");
			expect(access.credentialPolicy).toBe("least-privilege");
			const resolved = new URL(access.databaseUrl);
			expect(resolved.username).toBe("catalog_monitor");
			expect(resolved.password).toBe("p%40ss%3A%2F%3F%23%5B%5D");
			expect(access.bridge).toMatchObject({
				sshHost: "ssh.example.test",
				sshUser: "operator",
				targetHost: "db.internal.example",
				targetPort: 5432,
			});
			expect(access.bridge.identityFile).toBe(join(identityDirectory, "operator-ed25519"));

			const runtimeAccess = await resolveDatabaseAccess({
				REZICS_DATABASE_SECRET_FILE: secretPath,
				REZICS_DATABASE_SECRET_PROFILE: "runtime",
			});
			expect(runtimeAccess.kind).toBe("ssh-stdio");
			if (runtimeAccess.kind !== "ssh-stdio") throw new Error("Expected SSH stdio access");
			expect(runtimeAccess.credentialPolicy).toBe("runtime-forced-read-only");
			const runtimeUrl = new URL(runtimeAccess.databaseUrl);
			expect(runtimeUrl.username).toBe("writer");
			expect(runtimeUrl.searchParams.get("options")).toContain("default_transaction_read_only=on");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects ambiguous credential sources", async () => {
		await expect(
			resolveDatabaseAccess({
				REZICS_DATABASE_READONLY_URL: "postgresql://reader:secret@localhost/rezics",
				REZICS_DATABASE_SECRET_FILE: join(repositoryRoot, ".temp", "secret.json"),
			}),
		).rejects.toThrow("exactly one");
	});

	test("treats an explicit direct URL as least privilege", async () => {
		const access = await resolveDatabaseAccess({
			REZICS_DATABASE_READONLY_URL: "postgresql://reader:secret@localhost/rezics",
		});
		expect(access.credentialPolicy).toBe("least-privilege");
	});
});

describe("database privilege proof", () => {
	test("accepts a restricted read-only role", () => {
		expect(
			assertReadOnlyPrivilegeProof({
				defaultTransactionReadOnly: false,
				transactionReadOnly: true,
				restrictedRole: true,
				canSelectAllRequiredRelations: true,
				canExecuteCandidateSearch: true,
				canWriteAnyRequiredRelation: false,
				canWriteAnyRequiredColumn: false,
			}),
		).toMatchObject({ transactionReadOnly: true });
	});

	test("rejects a role with any write privilege", () => {
		expect(() =>
			assertReadOnlyPrivilegeProof({
				defaultTransactionReadOnly: false,
				transactionReadOnly: true,
				restrictedRole: true,
				canSelectAllRequiredRelations: true,
				canExecuteCandidateSearch: true,
				canWriteAnyRequiredRelation: true,
				canWriteAnyRequiredColumn: false,
			}),
		).toThrow("write privileges");
	});

	test("rejects a role that cannot execute bounded candidate search", () => {
		expect(() =>
			assertReadOnlyPrivilegeProof({
				defaultTransactionReadOnly: false,
				transactionReadOnly: true,
				restrictedRole: true,
				canSelectAllRequiredRelations: true,
				canExecuteCandidateSearch: false,
				canWriteAnyRequiredRelation: false,
				canWriteAnyRequiredColumn: false,
			}),
		).toThrow("bounded REZICS candidate search");
	});

	test("allows runtime privileges only behind both session and transaction read-only guards", () => {
		expect(
			assertReadOnlyPrivilegeProof(
				{
					defaultTransactionReadOnly: true,
					transactionReadOnly: true,
					restrictedRole: true,
					canSelectAllRequiredRelations: true,
					canExecuteCandidateSearch: true,
					canWriteAnyRequiredRelation: true,
					canWriteAnyRequiredColumn: true,
				},
				"runtime-forced-read-only",
			),
		).toMatchObject({ defaultTransactionReadOnly: true });

		expect(() =>
			assertReadOnlyPrivilegeProof(
				{
					defaultTransactionReadOnly: false,
					transactionReadOnly: true,
					restrictedRole: true,
					canSelectAllRequiredRelations: true,
					canExecuteCandidateSearch: true,
					canWriteAnyRequiredRelation: true,
					canWriteAnyRequiredColumn: true,
				},
				"runtime-forced-read-only",
			),
		).toThrow("session does not default");
	});
});
