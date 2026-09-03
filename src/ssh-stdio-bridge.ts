import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

export type SshStdioBridgeConfig = {
	readonly sshHost: string;
	readonly sshUser: string;
	readonly identityFile: string;
	readonly bindAddress?: string;
	readonly targetHost: string;
	readonly targetPort: number;
};

export type BridgeProcessFactory = (
	arguments_: readonly string[],
) => ChildProcessWithoutNullStreams;

const defaultProcessFactory: BridgeProcessFactory = (arguments_) =>
	spawn("ssh", arguments_, {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

export function buildSshArguments(config: SshStdioBridgeConfig): string[] {
	return [
		"-T",
		...(config.bindAddress ? ["-b", config.bindAddress] : []),
		"-i",
		config.identityFile,
		"-o",
		"BatchMode=yes",
		"-o",
		"IdentitiesOnly=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ConnectTimeout=10",
		"-o",
		"ConnectionAttempts=1",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"RequestTTY=no",
		"-o",
		"LogLevel=ERROR",
		`${config.sshUser}@${config.sshHost}`,
		"nc",
		config.targetHost,
		String(config.targetPort),
	];
}

function boundedError(value: Buffer): string {
	return value
		.toString("utf8")
		.replace(/postgres(?:ql)?:\/\/\S+/giu, "<database-url-redacted>")
		.trim()
		.slice(-500);
}

export class SshStdioBridge {
	readonly #config: SshStdioBridgeConfig;
	readonly #processFactory: BridgeProcessFactory;
	readonly #children = new Set<ChildProcessWithoutNullStreams>();
	readonly #sockets = new Set<Socket>();
	#server: Server | undefined;
	#lastFailure: string | undefined;

	constructor(config: SshStdioBridgeConfig, processFactory = defaultProcessFactory) {
		this.#config = config;
		this.#processFactory = processFactory;
	}

	get lastFailure(): string | undefined {
		return this.#lastFailure;
	}

	async start(): Promise<{ readonly host: "127.0.0.1"; readonly port: number }> {
		if (this.#server) throw new Error("SSH stdio bridge is already started");
		const server = createServer((socket) => this.#handleConnection(socket));
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			const fail = (error: Error): void => reject(error);
			server.once("error", fail);
			server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
				server.off("error", fail);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			await this.close();
			throw new Error("SSH stdio bridge did not bind a TCP endpoint");
		}
		return { host: "127.0.0.1", port: address.port };
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const socket of this.#sockets) socket.destroy();
		for (const child of this.#children) child.kill();
		if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all(
			[...this.#children].map(async (child) => {
				if (child.exitCode === null && child.signalCode === null)
					await Promise.race([
						once(child, "exit"),
						new Promise((resolve) => setTimeout(resolve, 1_000)),
					]);
			}),
		);
		this.#children.clear();
		this.#sockets.clear();
	}

	#handleConnection(socket: Socket): void {
		this.#sockets.add(socket);
		socket.on("error", () => undefined);
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.#processFactory(buildSshArguments(this.#config));
		} catch {
			this.#lastFailure = "Unable to start the SSH client";
			socket.destroy();
			return;
		}
		this.#children.add(child);
		let stderr = Buffer.alloc(0);
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = Buffer.concat([stderr, chunk]).subarray(-2_048);
		});
		child.stdin.on("error", () => undefined);
		child.stdout.on("error", () => undefined);
		child.on("error", () => {
			this.#lastFailure = "The SSH client process failed";
			socket.destroy();
		});
		child.on("exit", (code, signal) => {
			this.#children.delete(child);
			if (code !== 0) {
				const detail = boundedError(stderr);
				this.#lastFailure = detail
					? `SSH database bridge exited with code ${code ?? "none"}: ${detail}`
					: `SSH database bridge exited with code ${code ?? "none"} and signal ${signal ?? "none"}`;
				socket.destroy();
			} else {
				socket.end();
			}
		});
		socket.on("close", () => {
			this.#sockets.delete(socket);
			if (child.exitCode === null && child.signalCode === null) child.kill();
		});
		socket.pipe(child.stdin);
		child.stdout.pipe(socket);
	}
}
