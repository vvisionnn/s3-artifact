import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { S3Config } from "../src/shared/config.ts";
import { S3Client, S3Error } from "../src/shared/s3.ts";
import { FakeS3 } from "./fake-s3.ts";

let s3: FakeS3;
let sleeps: number[];

const configFor = (fake: FakeS3, overrides: Partial<S3Config> = {}): S3Config => ({
	bucket: fake.bucket,
	endpoint: fake.endpoint,
	region: "us-east-1",
	accessKeyId: fake.accessKeyId,
	secretAccessKey: "secret",
	prefix: "",
	forcePathStyle: true,
	urlExpiresIn: 3600,
	...overrides,
});

const clientFor = (fake: FakeS3, overrides: Partial<S3Config> = {}) =>
	new S3Client(configFor(fake, overrides), {
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});

beforeEach(() => {
	s3 = new FakeS3({ maxKeys: 2 });
	sleeps = [];
});
afterEach(() => s3.stop());

describe("S3Client objects", () => {
	test("puts, reads and deletes objects with metadata", async () => {
		const client = clientFor(s3);
		await client.putObject("dir/file.txt", new TextEncoder().encode("hello"), {
			"content-type": "text/plain",
			"content-disposition": "attachment",
		});
		expect(s3.objects.get("dir/file.txt")?.headers["content-type"]).toBe("text/plain");

		const response = await client.getObject("dir/file.txt");
		expect(await response.text()).toBe("hello");
		expect(await client.getText("dir/file.txt")).toBe("hello");

		await client.deleteObject("dir/file.txt");
		expect(s3.objects.size).toBe(0);
	});

	test("encodes keys with special characters", async () => {
		const client = clientFor(s3);
		const key = "runs/1/c++ build (x86)/ü&=?#.zip";
		await client.putObject(key, "data");
		expect(s3.keys()).toEqual([key]);
		expect(await client.getText(key)).toBe("data");
	});

	test("getText returns undefined for missing objects", async () => {
		expect(await clientFor(s3).getText("missing")).toBeUndefined();
	});

	test("getObject surfaces S3 errors", async () => {
		const error = await clientFor(s3)
			.getObject("missing")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(S3Error);
		expect(error).toMatchObject({ status: 404, code: "NoSuchKey" });
	});

	test("rejects requests with the wrong credentials", async () => {
		const error = await clientFor(s3, { accessKeyId: "wrong" })
			.putObject("k", "v")
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 403, code: "InvalidAccessKeyId" });
		expect(String(error)).toContain("PUT");
	});

	test("lists every key under a prefix across pages", async () => {
		const client = clientFor(s3);
		for (const key of ["p/a", "p/b", "p/c", "p/&d", "other/x"]) {
			await client.putObject(key, key);
		}
		expect(await client.listKeys("p/")).toEqual(["p/&d", "p/a", "p/b", "p/c"]);
		expect(await client.listKeys("none/")).toEqual([]);
	});

	test("uploads multipart objects", async () => {
		const client = clientFor(s3);
		const uploadId = await client.createMultipartUpload("big.bin", {
			"content-type": "application/zip",
		});
		const etag2 = await client.uploadPart("big.bin", uploadId, 2, new Uint8Array([3, 4]));
		const etag1 = await client.uploadPart("big.bin", uploadId, 1, new Uint8Array([1, 2]));
		await client.completeMultipartUpload("big.bin", uploadId, [
			{ partNumber: 2, etag: etag2 },
			{ partNumber: 1, etag: etag1 },
		]);
		expect([...(s3.objects.get("big.bin")?.body ?? [])]).toEqual([1, 2, 3, 4]);
		expect(s3.objects.get("big.bin")?.headers["content-type"]).toBe("application/zip");
	});

	test("treats an error body in a 200 completion response as a failure", async () => {
		const client = clientFor(s3);
		const uploadId = await client.createMultipartUpload("big.bin");
		const etag = await client.uploadPart("big.bin", uploadId, 1, new Uint8Array([1]));
		s3.completeFailsInBody = true;
		await expect(
			client.completeMultipartUpload("big.bin", uploadId, [{ partNumber: 1, etag }]),
		).rejects.toMatchObject({
			code: "InternalError",
			message: "We encountered an internal error.",
		});
	});

	test("getText propagates errors other than 404", async () => {
		const client = clientFor(s3);
		s3.failNext(403);
		await expect(client.getText("k")).rejects.toMatchObject({ status: 403 });
	});

	test("aborts multipart uploads", async () => {
		const client = clientFor(s3);
		const uploadId = await client.createMultipartUpload("big.bin");
		await client.abortMultipartUpload("big.bin", uploadId);
		expect(s3.pendingUploads).toBe(0);
	});

	test("creates presigned GET URLs usable without credentials", async () => {
		const client = clientFor(s3);
		await client.putObject("shared/file.txt", "public");
		const url = await client.presignGet("shared/file.txt");
		expect(url).toContain("X-Amz-Expires=3600");
		expect(await (await fetch(url)).text()).toBe("public");
	});
});

describe("S3Client retries", () => {
	test("retries transient failures with exponential backoff", async () => {
		const client = clientFor(s3);
		s3.failNext(500);
		s3.failNext(503);
		s3.failNext(429);
		await client.putObject("k", "v");
		expect(await client.getText("k")).toBe("v");
		expect(sleeps).toEqual([250, 500, 1000]);
	});

	test("gives up after the retry budget", async () => {
		const client = clientFor(s3);
		for (let i = 0; i < 10; i++) s3.failNext(500);
		const error = await client.putObject("k", "v").catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 500, code: "InternalError" });
		expect(sleeps).toHaveLength(5);
	});

	test("does not retry client errors", async () => {
		const client = clientFor(s3);
		s3.failNext(400);
		await expect(client.putObject("k", "v")).rejects.toMatchObject({ status: 400 });
		expect(sleeps).toEqual([]);
	});

	test("retries network errors", async () => {
		let calls = 0;
		const client = new S3Client(configFor(s3), {
			sleep: async () => {},
			transport: async (input: Request) => {
				calls++;
				if (calls === 1) throw new TypeError("fetch failed");
				return fetch(input);
			},
		});
		await client.putObject("k", "v");
		expect(calls).toBe(2);
	});

	test("caps backoff delay", async () => {
		const client = new S3Client(configFor(s3), {
			retries: 8,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		for (let i = 0; i < 8; i++) s3.failNext(500);
		await client.putObject("k", "v");
		expect(sleeps.at(-1)).toBe(10_000);
	});
});

describe("S3Client addressing", () => {
	test("uses virtual-hosted URLs unless path style is forced", () => {
		const config = configFor(s3, {
			endpoint: "https://s3.eu-west-1.amazonaws.com",
			forcePathStyle: false,
		});
		expect(new S3Client(config).objectUrl("a b/c")).toBe(
			`https://${s3.bucket}.s3.eu-west-1.amazonaws.com/a%20b/c`,
		);
	});

	test("keeps endpoint base paths in path-style URLs", () => {
		const config = configFor(s3, { endpoint: "https://proxy.example.com/storage" });
		expect(new S3Client(config).objectUrl("k")).toBe(
			`https://proxy.example.com/storage/${s3.bucket}/k`,
		);
	});
});
