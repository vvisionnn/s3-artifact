/**
 * Minimal in-memory S3 server covering the API surface the actions use. It speaks real HTTP so the
 * production client is exercised end to end, and supports fault injection for retry tests.
 */

export interface StoredObject {
	body: Uint8Array;
	headers: Record<string, string>;
}

interface Upload {
	key: string;
	headers: Record<string, string>;
	parts: Map<number, Uint8Array>;
}

export interface FakeS3Options {
	accessKeyId?: string;
	bucket?: string;
	/** Page size for ListObjectsV2, small values exercise pagination. */
	maxKeys?: number;
	port?: number;
	hostname?: string;
}

export interface RecordedRequest {
	method: string;
	path: string;
	query: string;
}

const STORED_HEADERS = ["content-type", "content-disposition", "cache-control"];

export class FakeS3 {
	readonly accessKeyId: string;
	readonly bucket: string;
	readonly objects = new Map<string, StoredObject>();
	readonly requests: RecordedRequest[] = [];
	private readonly uploads = new Map<string, Upload>();
	private readonly server: ReturnType<typeof Bun.serve>;
	private readonly maxKeys: number;
	private faults: Array<{ status: number; match?: (r: RecordedRequest) => boolean }> = [];
	private uploadCounter = 0;
	/** When set, the next CompleteMultipartUpload answers 200 with an error body, as S3 may. */
	completeFailsInBody = false;

	constructor(options: FakeS3Options = {}) {
		this.accessKeyId = options.accessKeyId ?? "test-access-key";
		this.bucket = options.bucket ?? "artifacts";
		this.maxKeys = options.maxKeys ?? 1000;
		this.server = Bun.serve({
			port: options.port ?? 0,
			hostname: options.hostname ?? "127.0.0.1",
			fetch: (request) => this.handle(request),
		});
	}

	get endpoint(): string {
		return `http://${this.server.hostname}:${this.server.port}`;
	}

	/** Fails the next matching request with `status`. Faults are consumed in order. */
	failNext(status: number, match?: (r: RecordedRequest) => boolean): void {
		this.faults.push(match ? { status, match } : { status });
	}

	keys(): string[] {
		return [...this.objects.keys()].sort();
	}

	stop(): Promise<void> {
		return this.server.stop(true);
	}

	private async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const [, bucket = "", ...keyParts] = url.pathname.split("/");
		const key = keyParts.map(decodeURIComponent).join("/");
		const record = { method: request.method, path: url.pathname, query: url.search };
		this.requests.push(record);

		const faultIndex = this.faults.findIndex((f) => !f.match || f.match(record));
		if (faultIndex !== -1) {
			const [fault] = this.faults.splice(faultIndex, 1);
			return xmlError(fault?.status ?? 500, "InternalError", "Injected fault");
		}
		if (!this.authorized(request, url)) {
			return xmlError(
				403,
				"InvalidAccessKeyId",
				"The AWS Access Key Id you provided does not exist.",
			);
		}
		if (bucket !== this.bucket) {
			return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");
		}

		const q = url.searchParams;
		if (!key) {
			if (request.method === "GET" && q.get("list-type") === "2") return this.list(q);
			return xmlError(400, "InvalidRequest", "Unsupported bucket operation");
		}
		switch (request.method) {
			case "PUT":
				if (q.has("uploadId")) return this.uploadPart(request, q);
				return this.put(request, key);
			case "POST":
				if (q.has("uploads")) return this.createUpload(request, key);
				if (q.has("uploadId")) return this.completeUpload(request, key, q);
				break;
			case "GET":
			case "HEAD":
				return this.get(key, request.method === "HEAD");
			case "DELETE":
				if (q.has("uploadId")) {
					this.uploads.delete(q.get("uploadId") ?? "");
					return new Response(null, { status: 204 });
				}
				this.objects.delete(key);
				return new Response(null, { status: 204 });
		}
		return xmlError(400, "InvalidRequest", "Unsupported object operation");
	}

	private authorized(request: Request, url: URL): boolean {
		const credential =
			url.searchParams.get("X-Amz-Credential") ??
			/Credential=([^,]+)/.exec(request.headers.get("authorization") ?? "")?.[1];
		return credential?.split("/")[0] === this.accessKeyId;
	}

	private async put(request: Request, key: string): Promise<Response> {
		const body = new Uint8Array(await request.arrayBuffer());
		this.objects.set(key, { body, headers: pickHeaders(request.headers) });
		return new Response(null, { status: 200, headers: { etag: `"${etagOf(body)}"` } });
	}

	private get(key: string, headOnly: boolean): Response {
		const object = this.objects.get(key);
		if (!object) {
			return headOnly
				? new Response(null, { status: 404 })
				: xmlError(404, "NoSuchKey", "The specified key does not exist.");
		}
		const headers = {
			...object.headers,
			"content-length": String(object.body.byteLength),
			etag: `"${etagOf(object.body)}"`,
		};
		return new Response(headOnly ? null : object.body, { status: 200, headers });
	}

	private list(q: URLSearchParams): Response {
		const prefix = q.get("prefix") ?? "";
		const maxKeys = Math.min(Number(q.get("max-keys") ?? this.maxKeys), this.maxKeys);
		const all = this.keys().filter((k) => k.startsWith(prefix));
		const start = Number(q.get("continuation-token") ?? 0);
		const page = all.slice(start, start + maxKeys);
		const next = start + maxKeys;
		const truncated = next < all.length;
		const contents = page
			.map(
				(k) =>
					`<Contents><Key>${escapeXml(k)}</Key><Size>${this.objects.get(k)?.body.byteLength}</Size></Contents>`,
			)
			.join("");
		return xml(
			`<ListBucketResult><Name>${this.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
		);
	}

	private createUpload(request: Request, key: string): Response {
		const uploadId = `upload-${++this.uploadCounter}`;
		this.uploads.set(uploadId, { key, headers: pickHeaders(request.headers), parts: new Map() });
		return xml(
			`<InitiateMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
		);
	}

	private async uploadPart(request: Request, q: URLSearchParams): Promise<Response> {
		const upload = this.uploads.get(q.get("uploadId") ?? "");
		if (!upload) return xmlError(404, "NoSuchUpload", "The specified upload does not exist.");
		const body = new Uint8Array(await request.arrayBuffer());
		upload.parts.set(Number(q.get("partNumber")), body);
		return new Response(null, { status: 200, headers: { etag: `"${etagOf(body)}"` } });
	}

	private async completeUpload(
		request: Request,
		key: string,
		q: URLSearchParams,
	): Promise<Response> {
		if (this.completeFailsInBody) {
			this.completeFailsInBody = false;
			return xml(
				"<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>",
			);
		}
		const uploadId = q.get("uploadId") ?? "";
		const upload = this.uploads.get(uploadId);
		if (!upload) return xmlError(404, "NoSuchUpload", "The specified upload does not exist.");
		const requested = [
			...(await request.text()).matchAll(
				/<PartNumber>(\d+)<\/PartNumber>\s*<ETag>"?([^<"]+)"?<\/ETag>/g,
			),
		];
		const chunks: Uint8Array[] = [];
		for (const [, number, etag] of requested) {
			const part = upload.parts.get(Number(number));
			if (!part || etagOf(part) !== etag) {
				return xmlError(
					400,
					"InvalidPart",
					"One or more of the specified parts could not be found.",
				);
			}
			chunks.push(part);
		}
		const body = new Uint8Array(Buffer.concat(chunks));
		this.objects.set(key, { body, headers: upload.headers });
		this.uploads.delete(uploadId);
		return xml(
			`<CompleteMultipartUploadResult><Key>${escapeXml(key)}</Key><ETag>"${etagOf(body)}"</ETag></CompleteMultipartUploadResult>`,
		);
	}

	get pendingUploads(): number {
		return this.uploads.size;
	}
}

function pickHeaders(headers: Headers): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const [name, value] of headers) {
		if (STORED_HEADERS.includes(name) || name.startsWith("x-amz-meta-")) picked[name] = value;
	}
	return picked;
}

function etagOf(body: Uint8Array): string {
	return new Bun.CryptoHasher("md5").update(body).digest("hex");
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xml(body: string, status = 200): Response {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
		status,
		headers: { "content-type": "application/xml" },
	});
}

function xmlError(status: number, code: string, message: string): Response {
	return xml(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`, status);
}
