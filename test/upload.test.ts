import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runUpload } from "../src/upload/run.ts";
import { actionEnv } from "./action-env.ts";
import { captureStdout, inputs, withEnv } from "./helpers.ts";

let env: Awaited<ReturnType<typeof actionEnv>>;
let restoreInputs: () => void = () => {};

beforeEach(async () => {
	env = await actionEnv();
});
afterEach(async () => {
	restoreInputs();
	await env.cleanup();
});

const setInputs = (values: Record<string, string>) => {
	restoreInputs = withEnv(inputs(values));
};

const manifest = (name: string) =>
	JSON.parse(
		new TextDecoder().decode(env.s3.objects.get(`octo/repo/42/${name}/manifest.json`)?.body),
	);

describe("upload", () => {
	test("zips a directory and sets the official outputs", async () => {
		await env.dir.write("workspace/dist/app.js", "console.log(1)");
		await env.dir.write("workspace/dist/lib/util.js", "export {}");
		setInputs({ name: "web", path: join(env.workspace, "dist") });
		await runUpload();

		const outputs = await env.outputs();
		const stored = manifest("web");
		expect(outputs["artifact-id"]).toBe(String(stored.id));
		expect(`sha256:${outputs["artifact-digest"]}`).toBe(stored.digest);
		expect(outputs["artifact-url"]).toContain("X-Amz-Signature=");
		expect(stored).toMatchObject({
			name: "web",
			fileName: "web.zip",
			archive: true,
			runAttempt: 1,
		});
		const zip = await (await fetch(outputs["artifact-url"] ?? "")).arrayBuffer();
		expect(new TextDecoder().decode(zip)).toContain("lib/util.js");
	});

	test("uses the default name 'artifact'", async () => {
		await env.dir.write("workspace/file.txt");
		setInputs({ path: join(env.workspace, "file.txt") });
		await runUpload();
		expect(manifest("artifact").fileName).toBe("artifact.zip");
	});

	test("resolves relative paths against the working directory", async () => {
		await env.dir.write("workspace/rel/out.txt", "x");
		setInputs({ name: "rel", path: "rel/out.txt" });
		const cwd = process.cwd();
		process.chdir(env.workspace);
		try {
			await runUpload();
		} finally {
			process.chdir(cwd);
		}
		expect(manifest("rel").size).toBeGreaterThan(0);
	});

	test("archive: false uploads the single file as-is under its own name", async () => {
		await env.dir.write("workspace/report.html", "<h1>hi</h1>");
		setInputs({ name: "ignored", path: join(env.workspace, "report.html"), archive: "false" });
		await runUpload();
		expect(manifest("report.html")).toMatchObject({
			archive: false,
			fileName: "report.html",
			size: 11,
		});
		expect(
			env.s3.objects.get("octo/repo/42/report.html/report.html")?.headers["content-type"],
		).toBe("application/octet-stream");
	});

	test("archive: false rejects multiple files", async () => {
		await env.dir.write("workspace/m/a.txt");
		await env.dir.write("workspace/m/b.txt");
		setInputs({ path: join(env.workspace, "m"), archive: "false" });
		await expect(runUpload()).rejects.toThrow("only a single file can be uploaded. Found 2 files");
	});

	test.each([
		["warn", "::warning::No files were found"],
		["ignore", "No files were found"],
	])("if-no-files-found: %s does not fail", async (mode, message) => {
		setInputs({ path: join(env.workspace, "nothing/**"), "if-no-files-found": mode });
		const { output } = await captureStdout(() => runUpload());
		expect(output).toContain(message);
		expect(env.s3.keys()).toEqual([]);
		expect(await env.outputs()).toEqual({});
	});

	test("if-no-files-found: error fails", async () => {
		setInputs({ path: join(env.workspace, "nothing"), "if-no-files-found": "error" });
		await expect(runUpload()).rejects.toThrow("No files were found with the provided path");
	});

	test("rejects an unknown if-no-files-found value", async () => {
		setInputs({ path: "x", "if-no-files-found": "explode" });
		await expect(runUpload()).rejects.toThrow(
			"Unrecognized if-no-files-found input. Provided: explode",
		);
	});

	test.each([
		["retention-days", "abc", "Invalid retention-days"],
		["retention-days", "-1", "Invalid retention-days"],
		["compression-level", "x", "Invalid compression-level"],
		["compression-level", "10", "Invalid compression-level. Valid values are 0-9"],
		["overwrite", "maybe", "overwrite"],
	])("rejects invalid %s=%p", async (input, value, message) => {
		setInputs({ path: "x", [input]: value });
		await expect(runUpload()).rejects.toThrow(message);
	});

	test("rejects invalid artifact names", async () => {
		await env.dir.write("workspace/f.txt");
		setInputs({ name: "bad/name", path: join(env.workspace, "f.txt") });
		await expect(runUpload()).rejects.toThrow("The artifact name is not valid");
	});

	test("rejects files with characters that are invalid on other platforms", async () => {
		await env.dir.write("workspace/odd/what?.txt");
		setInputs({ path: join(env.workspace, "odd") });
		await expect(runUpload()).rejects.toThrow(
			"The path for one of the files in artifact is not valid",
		);
	});

	test("hidden files are excluded by default and included on request", async () => {
		await env.dir.write("workspace/h/.env", "secret");
		await env.dir.write("workspace/h/visible.txt", "v");
		setInputs({ name: "h1", path: join(env.workspace, "h") });
		await runUpload();
		restoreInputs();
		setInputs({ name: "h2", path: join(env.workspace, "h"), "include-hidden-files": "true" });
		await runUpload();
		expect(manifest("h2").size).toBeGreaterThan(manifest("h1").size);
	});

	test("conflicts on duplicate names unless overwrite is set", async () => {
		await env.dir.write("workspace/f.txt");
		setInputs({ name: "dup", path: join(env.workspace, "f.txt") });
		await runUpload();
		await expect(runUpload()).rejects.toThrow("already exists");
		restoreInputs();
		setInputs({ name: "dup", path: join(env.workspace, "f.txt"), overwrite: "true" });
		await runUpload();
	});

	test("applies retention, capped by GITHUB_RETENTION_DAYS", async () => {
		await env.dir.write("workspace/f.txt");
		const restore = withEnv({ GITHUB_RETENTION_DAYS: "5" });
		try {
			setInputs({ name: "capped", path: join(env.workspace, "f.txt"), "retention-days": "30" });
			const { output } = await captureStdout(() => runUpload());
			expect(output).toContain(
				"::warning::Retention days cannot be greater than the maximum allowed retention",
			);
			restoreInputs();
			setInputs({ name: "default", path: join(env.workspace, "f.txt") });
			await runUpload();
		} finally {
			restore();
		}
		const days = (m: { createdAt: string; expiresAt: string }) =>
			Math.round((Date.parse(m.expiresAt) - Date.parse(m.createdAt)) / 86_400_000);
		expect(days(manifest("capped"))).toBe(5);
		expect(days(manifest("default"))).toBe(5);
	});

	test("defaults retention to 90 days", async () => {
		await env.dir.write("workspace/f.txt");
		setInputs({ name: "ninety", path: join(env.workspace, "f.txt"), "retention-days": "0" });
		await runUpload();
		const m = manifest("ninety");
		expect(Math.round((Date.parse(m.expiresAt) - Date.parse(m.createdAt)) / 86_400_000)).toBe(90);
	});

	test("honours the configured key prefix and compression level", async () => {
		await env.dir.write("workspace/big.txt", "a".repeat(100_000));
		setInputs({
			name: "stored",
			path: join(env.workspace, "big.txt"),
			"compression-level": "0",
			"s3-prefix": "cache/",
		});
		await runUpload();
		expect(
			env.s3.objects.get("cache/octo/repo/42/stored/stored.zip")?.body.byteLength,
		).toBeGreaterThan(100_000);
	});

	test("requires a workflow run context", async () => {
		await env.dir.write("workspace/f.txt");
		const restore = withEnv({ GITHUB_RUN_ID: undefined });
		try {
			setInputs({ path: join(env.workspace, "f.txt") });
			await expect(runUpload()).rejects.toThrow("GITHUB_RUN_ID");
		} finally {
			restore();
		}
	});
});
