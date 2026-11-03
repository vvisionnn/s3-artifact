import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Creates an isolated temp directory and returns helpers bound to it. */
export async function tempDir(): Promise<{
	root: string;
	write: (relative: string, content?: string | Uint8Array) => Promise<string>;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "s3-artifact-test-"));
	return {
		root,
		async write(relative, content = relative) {
			const path = join(root, relative);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
			return path;
		},
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

/** Sets environment variables for one test and restores the previous environment afterwards. */
export function withEnv(vars: Record<string, string | undefined>): () => void {
	const previous = { ...process.env };
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const key of Object.keys(process.env)) {
			if (!(key in previous)) delete process.env[key];
		}
		Object.assign(process.env, previous);
	};
}

/** Converts `{ "if-no-files-found": "error" }` into the `INPUT_*` variables Actions would set. */
export function inputs(values: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).map(([name, value]) => [
			`INPUT_${name.replace(/ /g, "_").toUpperCase()}`,
			value,
		]),
	);
}

/** Parses a `GITHUB_OUTPUT` file written by `@actions/core`. */
export function parseOutputs(text: string): Record<string, string> {
	const outputs: Record<string, string> = {};
	const pattern = /^(.+?)<<(ghadelimiter_[^\r\n]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm;
	for (const [, name, , value] of text.matchAll(pattern)) {
		outputs[name ?? ""] = value ?? "";
	}
	return outputs;
}

/** Captures workflow commands (warnings, errors) printed to stdout while `fn` runs. */
export async function captureStdout<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; output: string }> {
	const original = process.stdout.write.bind(process.stdout);
	let output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		return { result: await fn(), output };
	} finally {
		process.stdout.write = original;
	}
}
