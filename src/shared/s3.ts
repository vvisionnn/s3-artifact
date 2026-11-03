import { AwsClient } from "aws4fetch";
import type { S3Config } from "./config.ts";
import { nodeTransport, type Transport } from "./transport.ts";

export interface S3ClientOptions {
	/** Retries after the first attempt for network errors, 429 and 5xx responses. */
	retries?: number;
	sleep?: (ms: number) => Promise<void>;
	transport?: Transport;
}

export interface CompletedPart {
	partNumber: number;
	etag: string;
}

export class S3Error extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "S3Error";
	}
}

const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 10_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Small S3 client built on SigV4 + Node HTTP/1.1: just the operations artifacts need, with retries. */
export class S3Client {
	private readonly signer: AwsClient;
	private readonly retries: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly send: Transport;

	constructor(
		private readonly config: S3Config,
		options: S3ClientOptions = {},
	) {
		this.signer = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
			service: "s3",
			region: config.region,
			retries: 0,
		});
		this.retries = options.retries ?? 5;
		this.sleep = options.sleep ?? defaultSleep;
		this.send = options.transport ?? nodeTransport();
	}

	objectUrl(key: string): string {
		const encodedKey = key.split("/").map(encodeRfc3986).join("/");
		return `${this.bucketUrl()}/${encodedKey}`;
	}

	async putObject(
		key: string,
		body: Uint8Array | string,
		headers: Record<string, string> = {},
	): Promise<void> {
		await this.request("PUT", this.objectUrl(key), { body, headers });
	}

	/** Returns the streaming response of a GET. Throws `S3Error` for non-2xx responses. */
	getObject(key: string): Promise<Response> {
		return this.request("GET", this.objectUrl(key));
	}

	/** Reads a whole object as text, or `undefined` when it does not exist. */
	async getText(key: string): Promise<string | undefined> {
		try {
			return await (await this.getObject(key)).text();
		} catch (error) {
			if (error instanceof S3Error && error.status === 404) return undefined;
			throw error;
		}
	}

	async deleteObject(key: string): Promise<void> {
		await this.request("DELETE", this.objectUrl(key));
	}

	async listKeys(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let token: string | undefined;
		do {
			const url = new URL(this.bucketUrl());
			url.searchParams.set("list-type", "2");
			url.searchParams.set("prefix", prefix);
			if (token) url.searchParams.set("continuation-token", token);
			const body = await (await this.request("GET", url.toString())).text();
			keys.push(...xmlValues(body, "Key"));
			token =
				xmlValues(body, "IsTruncated")[0] === "true"
					? xmlValues(body, "NextContinuationToken")[0]
					: undefined;
		} while (token);
		return keys;
	}

	async createMultipartUpload(key: string, headers: Record<string, string> = {}): Promise<string> {
		const body = await (
			await this.request("POST", `${this.objectUrl(key)}?uploads=`, { headers })
		).text();
		const [uploadId] = xmlValues(body, "UploadId");
		if (!uploadId)
			throw new S3Error(500, "InvalidResponse", "CreateMultipartUpload returned no UploadId");
		return uploadId;
	}

	async uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: Uint8Array,
	): Promise<string> {
		const url = `${this.objectUrl(key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
		const response = await this.request("PUT", url, { body });
		const etag = response.headers.get("etag");
		if (!etag)
			throw new S3Error(500, "InvalidResponse", `UploadPart ${partNumber} returned no ETag`);
		return etag;
	}

	async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: CompletedPart[],
	): Promise<void> {
		const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
		const xml = `<CompleteMultipartUpload>${sorted
			.map(
				(p) =>
					`<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
			)
			.join("")}</CompleteMultipartUpload>`;
		const response = await this.request(
			"POST",
			`${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`,
			{
				body: xml,
				headers: { "content-type": "application/xml" },
			},
		);
		// S3 may report a failed completion inside a 200 response body.
		const text = await response.text();
		if (text.includes("<Error>")) {
			throw new S3Error(
				500,
				xmlValues(text, "Code")[0] ?? "InternalError",
				xmlValues(text, "Message")[0] ?? text,
			);
		}
	}

	async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		await this.request("DELETE", `${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`);
	}

	async presignGet(key: string): Promise<string> {
		const url = new URL(this.objectUrl(key));
		url.searchParams.set("X-Amz-Expires", String(this.config.urlExpiresIn));
		const signed = await this.signer.sign(url.toString(), {
			method: "GET",
			aws: { signQuery: true },
		});
		return signed.url;
	}

	private bucketUrl(): string {
		const endpoint = new URL(this.config.endpoint);
		const basePath = endpoint.pathname.replace(/\/+$/, "");
		if (this.config.forcePathStyle) {
			return `${endpoint.origin}${basePath}/${encodeRfc3986(this.config.bucket)}`;
		}
		return `${endpoint.protocol}//${this.config.bucket}.${endpoint.host}${basePath}`;
	}

	private async request(
		method: string,
		url: string,
		init: { body?: Uint8Array | string; headers?: Record<string, string> } = {},
	): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			let response: Response | undefined;
			let failure: unknown;
			try {
				const signed = await this.signer.sign(url, {
					method,
					headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", ...init.headers },
					...(init.body === undefined ? {} : { body: init.body }),
				});
				response = await this.send(signed);
				if (response.ok) return response;
				if (!isRetryable(response.status)) throw await toS3Error(method, url, response);
			} catch (error) {
				if (error instanceof S3Error) throw error;
				failure = error;
			}
			if (attempt >= this.retries) {
				if (response) throw await toS3Error(method, url, response);
				throw failure;
			}
			await response?.body?.cancel();
			await this.sleep(Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS));
		}
	}
}

const isRetryable = (status: number) => status === 429 || status >= 500;

async function toS3Error(method: string, url: string, response: Response): Promise<S3Error> {
	const body = method === "HEAD" ? "" : await response.text();
	const code = xmlValues(body, "Code")[0] ?? `HTTP${response.status}`;
	const message = xmlValues(body, "Message")[0] ?? response.statusText;
	const target = new URL(url);
	return new S3Error(
		response.status,
		code,
		`${method} ${target.pathname} failed: ${response.status} ${code} - ${message}`,
	);
}

function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function xmlValues(xml: string, tag: string): string[] {
	return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) =>
		unescapeXml(m[1] ?? ""),
	);
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, "&");
}
