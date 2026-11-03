import { parseBoolean } from "./core.ts";

export interface S3Config {
	bucket: string;
	endpoint: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/** Key prefix inside the bucket, either empty or ending with `/`. */
	prefix: string;
	forcePathStyle: boolean;
	/** Lifetime in seconds of the presigned `artifact-url` output. */
	urlExpiresIn: number;
}

export type InputReader = (name: string) => string;
type Env = Record<string, string | undefined>;

/** SigV4 presigned URLs cannot outlive seven days. */
export const MAX_URL_EXPIRES_IN = 604800;

/**
 * Resolves the storage configuration. Every setting can come from an action input, an
 * `ARTIFACT_S3_*` variable or the standard AWS variable, in that order, so workflows can configure
 * the bucket once at the job or workflow level and keep each step identical to the official action.
 */
export function resolveS3Config(input: InputReader, env: Env): S3Config {
	const pick = (inputName: string, ...envNames: string[]): string | undefined => {
		const fromInput = input(inputName).trim();
		if (fromInput) return fromInput;
		for (const envName of envNames) {
			const value = env[envName]?.trim();
			if (value) return value;
		}
		return undefined;
	};
	const required = (inputName: string, ...envNames: string[]): string => {
		const value = pick(inputName, ...envNames);
		if (!value) {
			throw new Error(
				`Missing S3 setting: set the \`${inputName}\` input or the ${envNames.join(" / ")} environment variable.`,
			);
		}
		return value;
	};

	const bucket = required("s3-bucket", "ARTIFACT_S3_BUCKET");
	const accessKeyId = required(
		"s3-access-key-id",
		"ARTIFACT_S3_ACCESS_KEY_ID",
		"AWS_ACCESS_KEY_ID",
	);
	const secretAccessKey = required(
		"s3-secret-access-key",
		"ARTIFACT_S3_SECRET_ACCESS_KEY",
		"AWS_SECRET_ACCESS_KEY",
	);
	const sessionToken = pick("s3-session-token", "ARTIFACT_S3_SESSION_TOKEN", "AWS_SESSION_TOKEN");
	const region =
		pick("s3-region", "ARTIFACT_S3_REGION", "AWS_REGION", "AWS_DEFAULT_REGION") ?? "us-east-1";

	const customEndpoint = pick(
		"s3-endpoint",
		"ARTIFACT_S3_ENDPOINT",
		"AWS_ENDPOINT_URL_S3",
		"AWS_ENDPOINT_URL",
	);
	const endpoint = normalizeEndpoint(customEndpoint ?? `https://s3.${region}.amazonaws.com`);

	const pathStyle = pick("s3-force-path-style", "ARTIFACT_S3_FORCE_PATH_STYLE");
	const forcePathStyle =
		pathStyle === undefined
			? customEndpoint !== undefined
			: parseBoolean("s3-force-path-style", pathStyle);

	const rawPrefix = (pick("s3-prefix", "ARTIFACT_S3_PREFIX") ?? "").replace(/^\/+|\/+$/g, "");
	const prefix = rawPrefix ? `${rawPrefix}/` : "";

	const expires = pick("s3-url-expires-in", "ARTIFACT_S3_URL_EXPIRES_IN");
	const urlExpiresIn = expires === undefined ? MAX_URL_EXPIRES_IN : Number(expires);
	if (!Number.isInteger(urlExpiresIn) || urlExpiresIn < 1 || urlExpiresIn > MAX_URL_EXPIRES_IN) {
		throw new Error(
			`Invalid s3-url-expires-in: ${expires}. Use a whole number of seconds between 1 and ${MAX_URL_EXPIRES_IN}.`,
		);
	}

	return {
		bucket,
		endpoint,
		region,
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
		prefix,
		forcePathStyle,
		urlExpiresIn,
	};
}

function normalizeEndpoint(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid S3 endpoint: ${raw}. Expected an http(s) URL.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Invalid S3 endpoint: ${raw}. Expected an http(s) URL.`);
	}
	return url.toString().replace(/\/+$/, "");
}
