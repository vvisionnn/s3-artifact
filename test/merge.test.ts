import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runDownload } from "../src/download/run.ts";
import { runMerge } from "../src/merge/run.ts";
import { runUpload } from "../src/upload/run.ts";
import { actionEnv } from "./action-env.ts";
import { inputs, withEnv } from "./helpers.ts";

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

async function upload(
	name: string,
	files: Record<string, string>,
	extra: Record<string, string> = {},
) {
	for (const [file, content] of Object.entries(files)) {
		await env.dir.write(join("sources", name, file), content);
	}
	await withInputs({ name, path: join(env.dir.root, "sources", name), ...extra }, runUpload);
	await env.outputs();
}

const names = () =>
	env.s3
		.keys()
		.filter((k) => k.endsWith("manifest.json"))
		.map((k) => k.split("/").at(-2));

async function downloaded(name: string): Promise<string[]> {
	const target = join(env.dir.root, "check", name);
	await withInputs({ name, path: target }, runDownload);
	const glob = new Bun.Glob("**/*");
	return (await Array.fromAsync(glob.scan({ cwd: target, dot: true })))
		.map((p) => p.split("\\").join("/"))
		.sort();
}

describe("merge", () => {
	test("merges matching artifacts into one with default name", async () => {
		await upload("part-1", { "a.txt": "a" });
		await upload("part-2", { "b.txt": "b" });
		await upload("other", { "c.txt": "c" });
		await withInputs({ pattern: "part-*" }, runMerge);
		const outputs = await env.outputs();
		expect(outputs["artifact-id"]).toMatch(/^\d+$/);
		expect(outputs["artifact-digest"]).toMatch(/^[0-9a-f]{64}$/);
		expect(await downloaded("merged-artifacts")).toEqual(["a.txt", "b.txt"]);
		expect(names()).toEqual(["merged-artifacts", "other", "part-1", "part-2"]);
	});

	test("separate-directories keeps each artifact in its own folder", async () => {
		await upload("x", { "same.txt": "x" });
		await upload("y", { "same.txt": "y" });
		await withInputs({ name: "combined", pattern: "*", "separate-directories": "true" }, runMerge);
		expect(await downloaded("combined")).toEqual(["x/same.txt", "y/same.txt"]);
	});

	test("delete-merged removes the source artifacts", async () => {
		await upload("p1", { "1.txt": "1" });
		await upload("p2", { "2.txt": "2" });
		await withInputs({ name: "all", pattern: "p*", "delete-merged": "true" }, runMerge);
		expect(names()).toEqual(["all"]);
	});

	test("includes unarchived artifacts as plain files", async () => {
		await env.dir.write("sources/raw.bin", "raw");
		await withInputs({ path: join(env.dir.root, "sources/raw.bin"), archive: "false" }, runUpload);
		await upload("zipped", { "z.txt": "z" });
		await withInputs({ name: "mixed", pattern: "*" }, runMerge);
		expect(await downloaded("mixed")).toEqual(["raw.bin", "z.txt"]);
	});

	test("include-hidden-files carries hidden files through the merge", async () => {
		await upload("h", { ".env": "secret", "v.txt": "v" }, { "include-hidden-files": "true" });
		await withInputs({ name: "no-hidden", pattern: "h" }, runMerge);
		await withInputs(
			{ name: "with-hidden", pattern: "h", "include-hidden-files": "true" },
			runMerge,
		);
		expect(await downloaded("no-hidden")).toEqual(["v.txt"]);
		expect(await downloaded("with-hidden")).toEqual([".env", "v.txt"]);
	});

	test("fails when nothing matches", async () => {
		await expect(withInputs({ pattern: "nothing-*" }, runMerge)).rejects.toThrow(
			"No artifacts found matching pattern 'nothing-*'",
		);
	});

	test("fails when a source artifact is corrupted", async () => {
		await upload("bad", { "b.txt": "b" });
		const object = env.s3.objects.get("octo/repo/42/bad/bad.zip");
		if (object) object.body = new Uint8Array([...object.body, 1]);
		await expect(withInputs({ pattern: "bad" }, runMerge)).rejects.toThrow(
			"Digest validation failed",
		);
	});
});
