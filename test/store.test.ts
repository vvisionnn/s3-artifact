import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "../src/shared/s3.ts";
import { ArtifactConflictError, ArtifactStore, type RunRef } from "../src/shared/store.ts";
import { FakeS3 } from "./fake-s3.ts";
import { tempDir } from "./helpers.ts";

let s3: FakeS3;
let dir: Awaited<ReturnType<typeof tempDir>>;
let clock: Date;
let nextId: number;

const run: RunRef = { repository: "octo/repo", runId: "100", runAttempt: 1 };

function storeFor(options: { partSize?: number; prefix?: string; attempt?: number } = {}) {
	const client = new S3Client(
		{
			bucket: s3.bucket,
			endpoint: s3.endpoint,
			region: "us-east-1",
			accessKeyId: s3.accessKeyId,
			secretAccessKey: "secret",
			prefix: "",
			forcePathStyle: true,
			urlExpiresIn: 600,
		},
		{ sleep: async () => {} },
	);
	return new ArtifactStore(client, options.prefix ?? "ci/", {
		partSize: options.partSize ?? 8,
		concurrency: 2,
		now: () => clock,
		generateId: () => nextId++,
		sleep: async () => {},
	});
}

const body = (text: string) => Readable.from([Buffer.from(text)]);
const chunks = (...parts: string[]) => Readable.from(parts.map((p) => Buffer.from(p)));
const sha256 = (text: string) =>
	`sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

const upload = (
	store: ArtifactStore,
	name: string,
	content: string,
	extra: Partial<Parameters<ArtifactStore["upload"]>[1]> = {},
) =>
	store.upload(run, {
		name,
		fileName: `${name}.zip`,
		archive: true,
		body: body(content),
		retentionDays: 90,
		overwrite: false,
		...extra,
	});

beforeEach(async () => {
	s3 = new FakeS3({ maxKeys: 3 });
	dir = await tempDir();
	clock = new Date("2026-01-01T00:00:00Z");
	nextId = 1000;
});
afterEach(async () => {
	await s3.stop();
	await dir.cleanup();
});

describe("ArtifactStore.upload", () => {
	test("stores small artifacts with a single PUT and writes a manifest", async () => {
		const manifest = await upload(storeFor(), "build", "tiny");
		expect(manifest).toEqual({
			version: 1,
			id: 1000,
			name: "build",
			fileName: "build.zip",
			archive: true,
			size: 4,
			digest: sha256("tiny"),
			contentType: "application/zip",
			createdAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2026-04-01T00:00:00.000Z",
			repository: "octo/repo",
			runId: "100",
			runAttempt: 1,
		});
		expect(s3.keys()).toEqual([
			"ci/octo/repo/100/build/build.zip",
			"ci/octo/repo/100/build/manifest.json",
		]);
		expect(s3.requests.some((r) => r.query.includes("uploads"))).toBe(false);
		const stored = s3.objects.get("ci/octo/repo/100/build/build.zip");
		expect(stored?.headers["content-type"]).toBe("application/zip");
		expect(stored?.headers["content-disposition"]).toBe(
			`attachment; filename="build.zip"; filename*=UTF-8''build.zip`,
		);
	});

	test("streams large artifacts as multipart uploads", async () => {
		const content = "0123456789".repeat(5);
		const manifest = await storeFor().upload(run, {
			name: "big",
			fileName: "big.bin",
			archive: false,
			body: chunks(content.slice(0, 3), content.slice(3, 21), content.slice(21)),
			retentionDays: 1,
			overwrite: false,
		});
		expect(manifest.size).toBe(50);
		expect(manifest.digest).toBe(sha256(content));
		expect(manifest.contentType).toBe("application/octet-stream");
		expect(new TextDecoder().decode(s3.objects.get("ci/octo/repo/100/big/big.bin")?.body)).toBe(
			content,
		);
		expect(s3.requests.filter((r) => r.query.includes("partNumber")).length).toBe(7);
	});

	test("aborts the multipart upload when a part fails", async () => {
		s3.failNext(400, (r) => r.query.includes("partNumber=2"));
		await expect(upload(storeFor(), "broken", "x".repeat(40))).rejects.toThrow("400");
		expect(s3.pendingUploads).toBe(0);
		expect(s3.keys()).toEqual([]);
	});

	test("aborts the multipart upload when the source stream fails", async () => {
		const failing = new Readable({
			read() {
				this.push(Buffer.from("x".repeat(20)));
				this.destroy(new Error("disk on fire"));
			},
		});
		await expect(
			storeFor().upload(run, {
				name: "s",
				fileName: "s.zip",
				archive: true,
				body: failing,
				retentionDays: 1,
				overwrite: false,
			}),
		).rejects.toThrow("disk on fire");
		expect(s3.pendingUploads).toBe(0);
	});

	test("rejects a second upload with the same name in the same attempt", async () => {
		const store = storeFor();
		await upload(store, "dup", "one");
		const error = await upload(store, "dup", "two").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ArtifactConflictError);
		expect(String(error)).toContain("overwrite: true");
	});

	test("overwrite replaces the artifact and removes stale files", async () => {
		const store = storeFor();
		await upload(store, "dup", "one");
		const second = await upload(store, "dup", "two", {
			fileName: "raw.txt",
			archive: false,
			overwrite: true,
		});
		expect(second.id).toBe(1001);
		expect(s3.keys()).toEqual([
			"ci/octo/repo/100/dup/manifest.json",
			"ci/octo/repo/100/dup/raw.txt",
		]);
	});

	test("a re-run attempt replaces artifacts from earlier attempts", async () => {
		await upload(storeFor(), "rerun", "first");
		const second = await storeFor().upload(
			{ ...run, runAttempt: 2 },
			{
				name: "rerun",
				fileName: "rerun.zip",
				archive: true,
				body: body("second"),
				retentionDays: 1,
				overwrite: false,
			},
		);
		expect(second.runAttempt).toBe(2);
		expect((await storeFor().get(run, "rerun"))?.digest).toBe(sha256("second"));
	});

	test("expired artifacts do not block new uploads", async () => {
		const store = storeFor();
		await upload(store, "old", "v1", { retentionDays: 1 });
		clock = new Date("2026-01-03T00:00:00Z");
		await expect(upload(store, "old", "v2")).resolves.toMatchObject({ id: 1001 });
	});

	test("defaults to no expiry when retention is zero", async () => {
		expect((await upload(storeFor(), "keep", "x", { retentionDays: 0 })).expiresAt).toBeNull();
	});
});

describe("ArtifactStore queries", () => {
	test("lists live artifacts of a run sorted by name", async () => {
		const store = storeFor();
		await upload(store, "b", "b");
		await upload(store, "a", "a");
		await upload(store, "short", "s", { retentionDays: 1 });
		await storeFor().upload(
			{ ...run, runId: "999" },
			{
				name: "other-run",
				fileName: "o.zip",
				archive: true,
				body: body("o"),
				retentionDays: 1,
				overwrite: false,
			},
		);
		clock = new Date("2026-01-05T00:00:00Z");
		expect((await store.list(run)).map((m) => m.name)).toEqual(["a", "b"]);
		expect(await store.get(run, "short")).toBeUndefined();
		expect(await store.get(run, "missing")).toBeUndefined();
	});

	test("ignores corrupt or unfinished manifests", async () => {
		const store = storeFor();
		await upload(store, "good", "g");
		s3.objects.set("ci/octo/repo/100/bad/manifest.json", {
			body: new TextEncoder().encode("{oops"),
			headers: {},
		});
		s3.objects.set("ci/octo/repo/100/wrong/manifest.json", {
			body: new TextEncoder().encode('{"version":99}'),
			headers: {},
		});
		s3.objects.set("ci/octo/repo/100/partial/partial.zip", {
			body: new Uint8Array(1),
			headers: {},
		});
		expect((await store.list(run)).map((m) => m.name)).toEqual(["good"]);
	});

	test("downloads to a file and reports the digest", async () => {
		const store = storeFor();
		const manifest = await upload(store, "dl", "payload");
		const target = join(dir.root, "nested/out.zip");
		expect(await store.download(manifest, target)).toBe(sha256("payload"));
		expect(await readFile(target, "utf8")).toBe("payload");
	});

	test("retries downloads interrupted by server errors", async () => {
		const store = storeFor();
		const manifest = await upload(store, "dl", "payload");
		for (let i = 0; i < 6; i++) s3.failNext(500, (r) => r.path.endsWith("dl.zip"));
		const target = join(dir.root, "out.zip");
		expect(await store.download(manifest, target)).toBe(sha256("payload"));
	});

	test("gives up downloading after repeated failures", async () => {
		const store = storeFor();
		const manifest = await upload(store, "dl", "payload");
		for (let i = 0; i < 30; i++) s3.failNext(500, (r) => r.path.endsWith("dl.zip"));
		await expect(store.download(manifest, join(dir.root, "out.zip"))).rejects.toThrow("500");
	});

	test("deletes every object of an artifact", async () => {
		const store = storeFor();
		const manifest = await upload(store, "gone", "x");
		await upload(store, "kept", "y");
		await store.delete(manifest);
		expect(s3.keys()).toEqual([
			"ci/octo/repo/100/kept/kept.zip",
			"ci/octo/repo/100/kept/manifest.json",
		]);
	});

	test("creates presigned download URLs", async () => {
		const store = storeFor();
		const manifest = await upload(store, "share", "shared");
		const url = await store.presign(manifest);
		expect(await (await fetch(url)).text()).toBe("shared");
	});

	test("encodes non-ASCII file names in Content-Disposition", async () => {
		await upload(storeFor(), "日本", "x", { fileName: '日本 "q".zip' });
		const stored = s3.objects.get('ci/octo/repo/100/日本/日本 "q".zip');
		expect(stored?.headers["content-disposition"]).toBe(
			`attachment; filename="__ 'q'.zip"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%20%22q%22.zip`,
		);
	});
});
