import { describe, expect, test } from "bun:test";
import { resolveS3Config } from "../src/shared/config.ts";

const inputs =
	(values: Record<string, string> = {}) =>
	(name: string) =>
		values[name] ?? "";

const creds = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET" };

describe("resolveS3Config", () => {
	test("inputs take precedence over environment variables", () => {
		const config = resolveS3Config(
			inputs({
				"s3-bucket": "from-input",
				"s3-endpoint": "https://input.example.com/",
				"s3-region": "eu-west-1",
				"s3-access-key-id": "IN_KEY",
				"s3-secret-access-key": "IN_SECRET",
				"s3-session-token": "IN_TOKEN",
				"s3-prefix": "/ci/artifacts/",
				"s3-force-path-style": "false",
				"s3-url-expires-in": "3600",
			}),
			{ ...creds, ARTIFACT_S3_BUCKET: "from-env", ARTIFACT_S3_ENDPOINT: "https://env.example.com" },
		);
		expect(config).toEqual({
			bucket: "from-input",
			endpoint: "https://input.example.com",
			region: "eu-west-1",
			accessKeyId: "IN_KEY",
			secretAccessKey: "IN_SECRET",
			sessionToken: "IN_TOKEN",
			prefix: "ci/artifacts/",
			forcePathStyle: false,
			urlExpiresIn: 3600,
		});
	});

	test("ARTIFACT_S3_* variables override the generic AWS_* ones", () => {
		const config = resolveS3Config(inputs(), {
			...creds,
			ARTIFACT_S3_BUCKET: "bucket",
			ARTIFACT_S3_ENDPOINT: "https://artifact.example.com",
			AWS_ENDPOINT_URL: "https://generic.example.com",
			ARTIFACT_S3_ACCESS_KEY_ID: "A_KEY",
			ARTIFACT_S3_SECRET_ACCESS_KEY: "A_SECRET",
			ARTIFACT_S3_REGION: "auto",
			AWS_REGION: "us-west-2",
			ARTIFACT_S3_PREFIX: "p",
		});
		expect(config.endpoint).toBe("https://artifact.example.com");
		expect(config.accessKeyId).toBe("A_KEY");
		expect(config.secretAccessKey).toBe("A_SECRET");
		expect(config.region).toBe("auto");
		expect(config.prefix).toBe("p/");
		expect(config.forcePathStyle).toBe(true);
		expect(config.urlExpiresIn).toBe(604800);
		expect(config.sessionToken).toBeUndefined();
	});

	test("falls back to AWS_ENDPOINT_URL_S3 before AWS_ENDPOINT_URL", () => {
		const config = resolveS3Config(inputs({ "s3-bucket": "b" }), {
			...creds,
			AWS_ENDPOINT_URL_S3: "https://s3-specific.example.com",
			AWS_ENDPOINT_URL: "https://generic.example.com",
			AWS_SESSION_TOKEN: "TOKEN",
		});
		expect(config.endpoint).toBe("https://s3-specific.example.com");
		expect(config.sessionToken).toBe("TOKEN");
	});

	test("defaults to AWS S3 with virtual-hosted addressing", () => {
		const config = resolveS3Config(inputs({ "s3-bucket": "b" }), {
			...creds,
			AWS_DEFAULT_REGION: "ap-south-1",
		});
		expect(config.endpoint).toBe("https://s3.ap-south-1.amazonaws.com");
		expect(config.region).toBe("ap-south-1");
		expect(config.forcePathStyle).toBe(false);
		expect(config.prefix).toBe("");
	});

	test("uses us-east-1 when no region is configured", () => {
		expect(resolveS3Config(inputs({ "s3-bucket": "b" }), creds).region).toBe("us-east-1");
	});

	test("requires a bucket", () => {
		expect(() => resolveS3Config(inputs(), creds)).toThrow("s3-bucket");
	});

	test("requires both credentials", () => {
		expect(() =>
			resolveS3Config(inputs({ "s3-bucket": "b" }), { AWS_ACCESS_KEY_ID: "only-key" }),
		).toThrow("s3-secret-access-key");
		expect(() =>
			resolveS3Config(inputs({ "s3-bucket": "b" }), { AWS_SECRET_ACCESS_KEY: "only-secret" }),
		).toThrow("s3-access-key-id");
	});

	test("rejects malformed endpoints", () => {
		expect(() =>
			resolveS3Config(inputs({ "s3-bucket": "b", "s3-endpoint": "not a url" }), creds),
		).toThrow("Invalid S3 endpoint");
		expect(() =>
			resolveS3Config(inputs({ "s3-bucket": "b", "s3-endpoint": "ftp://x.example.com" }), creds),
		).toThrow("Invalid S3 endpoint");
	});

	test("rejects invalid booleans", () => {
		expect(() =>
			resolveS3Config(inputs({ "s3-bucket": "b", "s3-force-path-style": "yes" }), creds),
		).toThrow("s3-force-path-style");
	});

	test.each(["0", "604801", "1.5", "abc"])("rejects url expiry %p", (value) => {
		expect(() =>
			resolveS3Config(inputs({ "s3-bucket": "b", "s3-url-expires-in": value }), creds),
		).toThrow("s3-url-expires-in");
	});
});
