import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { runDownload } from "../src/download/run.ts";
import { runUpload } from "../src/upload/run.ts";
import { actionEnv } from "./action-env.ts";
import { captureStdout, inputs, withEnv } from "./helpers.ts";

let env: Awaited<ReturnType<typeof actionEnv>>;

beforeEach(async () => {
	env = await actionEnv();
});
afterEach(() => env.cleanup());

async function withInputs<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const restore = withEnv(inputs(values));
	try {
		return await fn();
	} finally {
		restore();
	}
}

async function uploadArtifact(
	name: string,
	files: Record<string, string>,
	extra: Record<string, string> = {},
) {
	for (const [file, content] of Object.entries(files)) {
		await env.dir.write(join("sources", name, file), content);
	}
	await withInputs({ name, path: join(env.dir.root, "sources", name), ...extra }, runUpload);
	return (await env.outputs())["artifact-id"] ?? "";
}

async function tree(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const full = join(entry.parentPath, entry.name);
		result[relative(root, full).split(sep).join("/")] = await readFile(full, "utf8");
	}
	return result;
}

describe("download", () => {
	test("downloads a named artifact into the workspace by default", async () => {
		await uploadArtifact("web", { "index.html": "<html>", "js/app.js": "app" });
		await withInputs({ name: "web" }, runDownload);
		expect(await tree(env.workspace)).toEqual({ "index.html": "<html>", "js/app.js": "app" });
		expect((await env.outputs())["download-path"]).toBe(env.workspace);
	});

	test("downloads into a custom path with tilde expansion", async () => {
		await uploadArtifact("t", { "a.txt": "a" });
		const restore = withEnv({ HOME: env.dir.root, USERPROFILE: env.dir.root });
		try {
			const target = `~${sep}from-home`;
			await withInputs({ name: "t", path: target }, runDownload);
			expect(await tree(join(homedir(), "from-home"))).toEqual({ "a.txt": "a" });
		} finally {
			restore();
		}
	});

	test("fails for unknown artifact names", async () => {
		await expect(withInputs({ name: "nope" }, runDownload)).rejects.toThrow(
			"Artifact 'nope' not found",
		);
	});

	test("downloads every artifact into named directories", async () => {
		await uploadArtifact("one", { "1.txt": "1" });
		await uploadArtifact("two", { "2.txt": "2" });
		await withInputs({ path: join(env.dir.root, "all") }, runDownload);
		expect(await tree(join(env.dir.root, "all"))).toEqual({ "one/1.txt": "1", "two/2.txt": "2" });
	});

	test("merge-multiple puts every artifact in the same directory", async () => {
		await uploadArtifact("one", { "1.txt": "1" });
		await uploadArtifact("two", { "2.txt": "2" });
		await withInputs({ path: join(env.dir.root, "merged"), "merge-multiple": "true" }, runDownload);
		expect(await tree(join(env.dir.root, "merged"))).toEqual({ "1.txt": "1", "2.txt": "2" });
	});

	test("pattern filters artifacts, and a single match is extracted directly", async () => {
		await uploadArtifact("build-linux", { "l.txt": "l" });
		await uploadArtifact("build-mac", { "m.txt": "m" });
		await uploadArtifact("logs", { "x.log": "x" });
		await withInputs({ path: join(env.dir.root, "p"), pattern: "build-*" }, runDownload);
		expect(await tree(join(env.dir.root, "p"))).toEqual({
			"build-linux/l.txt": "l",
			"build-mac/m.txt": "m",
		});
		await withInputs({ path: join(env.dir.root, "single"), pattern: "logs" }, runDownload);
		expect(await tree(join(env.dir.root, "single"))).toEqual({ "x.log": "x" });
	});

	test("downloads by artifact IDs and warns about missing ones", async () => {
		const first = await uploadArtifact("first", { "f.txt": "f" });
		await uploadArtifact("second", { "s.txt": "s" });
		const { output } = await captureStdout(() =>
			withInputs({ path: join(env.dir.root, "ids"), "artifact-ids": `${first}, 123` }, runDownload),
		);
		expect(output).toContain("::warning::Could not find the following artifact IDs: 123");
		expect(await tree(join(env.dir.root, "ids"))).toEqual({ "f.txt": "f" });
	});

	test.each([
		[{ name: "a", "artifact-ids": "1" }, "cannot be used together"],
		[{ "artifact-ids": " , " }, "No valid artifact IDs"],
		[{ "artifact-ids": "12x" }, "Invalid artifact ID: '12x'"],
		[{ "artifact-ids": "999" }, "None of the provided artifact IDs were found"],
		[{ "digest-mismatch": "explode" }, "Invalid value for 'digest-mismatch'"],
		[{ "merge-multiple": "nah" }, "merge-multiple"],
	])("rejects invalid inputs %p", async (values, message) => {
		await expect(withInputs(values, runDownload)).rejects.toThrow(message);
	});

	test("succeeds with no artifacts in the run", async () => {
		const { output } = await captureStdout(() => withInputs({}, runDownload));
		expect(output).toContain("Total of 0 artifact(s) downloaded");
	});

	test("skip-decompress keeps the zip file", async () => {
		await uploadArtifact("raw", { "r.txt": "r" });
		await withInputs(
			{ name: "raw", path: join(env.dir.root, "zip"), "skip-decompress": "true" },
			runDownload,
		);
		const files = await readdir(join(env.dir.root, "zip"));
		expect(files).toEqual(["raw.zip"]);
	});

	test("unarchived artifacts are saved as plain files", async () => {
		await env.dir.write("sources/report.txt", "plain");
		await withInputs(
			{ path: join(env.dir.root, "sources/report.txt"), archive: "false" },
			runUpload,
		);
		await withInputs({ name: "report.txt", path: join(env.dir.root, "out") }, runDownload);
		expect(await tree(join(env.dir.root, "out"))).toEqual({ "report.txt": "plain" });
	});

	test("downloads artifacts from another repository and run", async () => {
		await uploadArtifact("shared", { "s.txt": "from run 42" });
		const restore = withEnv({ GITHUB_REPOSITORY: "other/consumer", GITHUB_RUN_ID: "7" });
		try {
			const { output } = await captureStdout(() =>
				withInputs(
					{
						name: "shared",
						repository: "octo/repo",
						"run-id": "42",
						"github-token": "unused",
						path: join(env.dir.root, "x"),
					},
					runDownload,
				),
			);
			expect(output).toContain("github-token is not needed");
		} finally {
			restore();
		}
		expect(await tree(join(env.dir.root, "x"))).toEqual({ "s.txt": "from run 42" });
	});

	test.each(["no-slash", "a/b/c", "../x", "owner/.."])(
		"rejects malformed repository %p",
		async (repository) => {
			await expect(withInputs({ repository }, runDownload)).rejects.toThrow("Invalid repository");
		},
	);

	test.each(["abc", "1/2", "-1"])("rejects malformed run-id %p", async (runId) => {
		await expect(withInputs({ "run-id": runId }, runDownload)).rejects.toThrow("Invalid run-id");
	});

	test("refuses artifact names that would escape the download directory", async () => {
		await uploadArtifact("ok", { "a.txt": "a" });
		const good = JSON.parse(
			new TextDecoder().decode(env.s3.objects.get("octo/repo/42/ok/manifest.json")?.body),
		);
		env.s3.objects.set("octo/repo/42/evil/manifest.json", {
			body: new TextEncoder().encode(JSON.stringify({ ...good, name: ".." })),
			headers: {},
		});
		await expect(
			withInputs({ path: join(env.dir.root, "all", "inner") }, runDownload),
		).rejects.toThrow("The artifact name is not valid");
		expect(await Bun.file(join(env.dir.root, "all", "a.txt")).exists()).toBe(false);
	});

	describe("digest verification", () => {
		const corrupt = () => {
			const object = env.s3.objects.get("octo/repo/42/bad/bad.zip");
			if (!object) throw new Error("missing fixture");
			object.body = new Uint8Array([...object.body, 0]);
		};

		test("fails by default and does not extract corrupted data", async () => {
			await uploadArtifact("bad", { "b.txt": "b" });
			corrupt();
			await expect(
				withInputs({ name: "bad", path: join(env.dir.root, "bad") }, runDownload),
			).rejects.toThrow("Digest validation failed for artifact(s): bad");
			expect(await readdir(join(env.dir.root, "bad")).catch(() => [])).toEqual([]);
		});

		test.each([
			["warn", "::warning::Artifact 'bad' digest validation failed"],
			["info", "Artifact 'bad' digest validation failed"],
			["ignore", ""],
		])("digest-mismatch: %s continues", async (mode, message) => {
			await uploadArtifact("bad", { "b.txt": "b" });
			corrupt();
			const { output } = await captureStdout(() =>
				withInputs(
					{
						name: "bad",
						path: join(env.dir.root, "bad"),
						"digest-mismatch": mode,
						"skip-decompress": "true",
					},
					runDownload,
				),
			);
			expect(output).toContain(message);
			expect(await readdir(join(env.dir.root, "bad"))).toEqual(["bad.zip"]);
		});
	});
});
