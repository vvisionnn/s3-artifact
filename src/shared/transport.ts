import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

export type Transport = (request: Request) => Promise<Response>;

const agents = {
	"http:": new http.Agent({ keepAlive: true }),
	"https:": new https.Agent({ keepAlive: true }),
};

/**
 * Sends requests with Node's HTTP/1.1 client instead of `fetch`. `fetch` may negotiate HTTP/2,
 * and reverse proxies commonly reset concurrent large HTTP/2 uploads (NGHTTP2_ENHANCE_YOUR_CALM);
 * one connection per in-flight request is what S3 SDKs do as well.
 */
export function nodeTransport(options: { timeoutMs?: number } = {}): Transport {
	const timeoutMs = options.timeoutMs ?? 120_000;
	return async (request) => {
		const url = new URL(request.url);
		const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
		const headers: Record<string, string> = Object.fromEntries(request.headers);
		if (body) headers["content-length"] = String(body.byteLength);
		const client = url.protocol === "https:" ? https : http;

		return new Promise<Response>((resolve, reject) => {
			const req = client.request(
				url,
				{ method: request.method, headers, agent: agents[url.protocol as keyof typeof agents] },
				(res) => {
					const responseHeaders = new Headers();
					for (const [name, value] of Object.entries(res.headers)) {
						if (value !== undefined)
							responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
					}
					const status = res.statusCode ?? 0;
					const empty = request.method === "HEAD" || status === 204 || status === 304;
					if (empty) res.resume();
					resolve(
						new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
							status,
							statusText: res.statusMessage ?? "",
							headers: responseHeaders,
						}),
					);
				},
			);
			req.setTimeout(timeoutMs, () =>
				req.destroy(new Error(`Request to ${url.host} timed out after ${timeoutMs}ms`)),
			);
			req.on("error", reject);
			req.end(body);
		});
	};
}
