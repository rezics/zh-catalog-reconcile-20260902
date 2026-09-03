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
import { StringDecoder } from "node:string_decoder";
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
	const input = createReadStream(path);
	const decoder = new StringDecoder("utf8");
	let buffered = "";
	let lineNumber = 0;
	const parseLine = (line: string): z.infer<T> | undefined => {
		lineNumber += 1;
		if (!line.trim()) return undefined;
		try {
			return schema.parse(JSON.parse(line));
		} catch (error) {
			throw new Error(`Invalid JSONL contract at ${path}:${lineNumber}`, { cause: error });
		}
	};
	for await (const chunk of input) {
		buffered += decoder.write(chunk as Buffer);
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const value = parseLine(buffered.slice(0, newline));
			buffered = buffered.slice(newline + 1);
			if (value !== undefined) yield value;
		}
	}
	buffered += decoder.end();
	if (buffered.length > 0) {
		const value = parseLine(buffered);
		if (value !== undefined) yield value;
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
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") throw new Error(`Could not acquire lock ${lockPath}`, { cause: error });
		const contents = await readFile(lockPath, "utf8").catch(() => "");
		const pid = Number.parseInt(contents.split(/\s/u, 1)[0] ?? "", 10);
		let ownerIsAlive = !Number.isSafeInteger(pid) || pid <= 0;
		if (!ownerIsAlive) {
			try {
				process.kill(pid, 0);
				ownerIsAlive = true;
			} catch (ownerError) {
				ownerIsAlive = (ownerError as NodeJS.ErrnoException).code === "EPERM";
			}
		}
		if (ownerIsAlive) throw new Error(`Could not acquire lock ${lockPath}`, { cause: error });
		await rm(lockPath, { force: true });
		try {
			handle = await open(lockPath, "wx");
		} catch (retryError) {
			throw new Error(`Could not acquire lock ${lockPath}`, { cause: retryError });
		}
	}
	await handle.writeFile(`${process.pid} ${nowIso()}\n`);
	try {
		return await operation();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}
