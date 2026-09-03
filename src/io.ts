import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

import {
	EventSchema,
	type JsonValue,
	type RunConfig,
	RunConfigSchema,
	RunIdSchema,
	SchemaVersion,
} from "./contracts.ts";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runsRoot = join(repositoryRoot, "runs");

export function nowIso(): string {
	return new Date().toISOString();
}

export function runDirectory(runIdInput: string): string {
	const runId = RunIdSchema.parse(runIdInput);
	return join(runsRoot, runId);
}

export function assertPathInsideRepository(pathInput: string): string {
	const absolute = resolve(isAbsolute(pathInput) ? pathInput : join(repositoryRoot, pathInput));
	const pathFromRoot = relative(repositoryRoot, absolute);
	if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot))
		throw new Error(`Path must remain inside the repository: ${pathInput}`);
	return absolute;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	await rename(temporary, path);
}

export async function readJson<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
	const source = await readFile(path, "utf8");
	try {
		return schema.parse(JSON.parse(source));
	} catch (error) {
		throw new Error(`Invalid JSON contract in ${path}`, { cause: error });
	}
}

export async function loadRunConfig(runId: string): Promise<RunConfig> {
	return readJson(join(runDirectory(runId), "run.json"), RunConfigSchema);
}

export async function appendJsonLines(path: string, values: readonly unknown[]): Promise<void> {
	if (values.length === 0) return;
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

export async function writeJsonLinesAtomic(
	path: string,
	values: readonly unknown[],
): Promise<void> {
	if (values.length === 0) throw new Error("Cannot create an empty JSONL batch");
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	await rename(temporary, path);
}

export async function* readJsonLines<T extends z.ZodType>(
	path: string,
	schema: T,
): AsyncGenerator<z.infer<T>> {
	const input = createInterface({
		input: createReadStream(path, "utf8"),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	let lineNumber = 0;
	for await (const line of input) {
		lineNumber += 1;
		if (!line.trim()) continue;
		try {
			yield schema.parse(JSON.parse(line));
		} catch (error) {
			throw new Error(`Invalid JSONL contract at ${path}:${lineNumber}`, { cause: error });
		}
	}
}

export async function listPartFiles(directory: string): Promise<string[]> {
	if (!(await pathExists(directory))) return [];
	return (await readdir(directory))
		.filter((name) => /^part-\d{5,12}\.jsonl$/u.test(name))
		.sort()
		.map((name) => join(directory, name));
}

export function partFileName(part: number): string {
	return `part-${part.toString().padStart(5, "0")}.jsonl`;
}

export async function appendRunEvent(
	runId: string,
	event: string,
	data: Record<string, JsonValue> = {},
	level: "info" | "warning" | "error" = "info",
): Promise<void> {
	const value = EventSchema.parse({
		schemaVersion: SchemaVersion,
		timestamp: nowIso(),
		runId,
		level,
		event,
		data,
	});
	await appendJsonLines(join(runDirectory(runId), "events.jsonl"), [value]);
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	let handle: FileHandle;
	try {
		handle = await open(lockPath, "wx");
		await handle.writeFile(`${process.pid} ${nowIso()}\n`);
	} catch (error) {
		throw new Error(`Could not acquire lock ${lockPath}`, { cause: error });
	}
	try {
		return await operation();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}
