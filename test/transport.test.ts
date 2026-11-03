import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeTransport } from "../src/shared/transport.ts";

let server: Server | undefined;
afterEach(
	() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("nodeTransport", () => {
	test("sends method, headers and body over HTTP/1.1 and streams the response", async () => {
		const url = await serve((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				res.setHeader("etag", '"abc"');
				res.setHeader(
					"x-seen",
					`${req.method} ${req.httpVersion} ${req.headers["x-test"]} ${req.headers["content-length"]} ${body}`,
				);
				res.end("response-body");
			});
		});
		const send = nodeTransport();
		const response = await send(
			new Request(`${url}/k`, { method: "PUT", headers: { "x-test": "1" }, body: "hello" }),
		);
		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
		expect(response.headers.get("etag")).toBe('"abc"');
		expect(response.headers.get("x-seen")).toBe("PUT 1.1 1 5 hello");
		expect(await response.text()).toBe("response-body");
	});

	test("returns empty bodies for HEAD and 204 responses", async () => {
		const url = await serve((req, res) => {
			res.statusCode = req.method === "HEAD" ? 404 : 204;
			res.end();
		});
		const send = nodeTransport();
		expect((await send(new Request(url, { method: "HEAD" }))).status).toBe(404);
		const deleted = await send(new Request(url, { method: "DELETE" }));
		expect(deleted.status).toBe(204);
		expect(await deleted.text()).toBe("");
	});

	test("fails stalled connections after the inactivity timeout", async () => {
		const url = await serve(() => {
			/* never responds */
		});
		await expect(nodeTransport({ timeoutMs: 50 })(new Request(url))).rejects.toThrow("timed out");
	});

	test("rejects connection errors", async () => {
		const url = await serve(() => {});
		const closed = url;
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
		await expect(nodeTransport()(new Request(closed))).rejects.toThrow();
	});
});
