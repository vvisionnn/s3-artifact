import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as core from "../src/shared/core.ts";
import { captureStdout, parseOutputs, tempDir, withEnv } from "./helpers.ts";

let restore: () => void = () => {};
afterEach(() => {
	restore();
	process.exitCode = 0;
});

describe("inputs", () => {
	test("reads INPUT_ variables like the runner sets them", () => {
		restore = withEnv({ INPUT_MY_INPUT: "  value  ", "INPUT_IF-NO-FILES-FOUND": "warn" });
		expect(core.getInput("my input")).toBe("value");
		expect(core.getInput("if-no-files-found")).toBe("warn");
		expect(core.getInput("missing")).toBe("");
	});

	test("enforces required inputs", () => {
		expect(() => core.getInput("path", { required: true })).toThrow(
			"Input required and not supplied: path",
		);
	});

	test("parses YAML 1.2 booleans", () => {
		restore = withEnv({ INPUT_YES: "True", INPUT_NO: "FALSE", INPUT_BAD: "1" });
		expect(core.getBooleanInput("yes")).toBe(true);
		expect(core.getBooleanInput("no")).toBe(false);
		expect(() => core.getBooleanInput("bad")).toThrow('YAML 1.2 "Core Schema"');
	});
});

describe("outputs and logging", () => {
	test("writes outputs to GITHUB_OUTPUT with a unique delimiter", async () => {
		const dir = await tempDir();
		const file = join(dir.root, "out");
		await writeFile(file, "");
		restore = withEnv({ GITHUB_OUTPUT: file });
		core.setOutput("id", 42);
		core.setOutput("multi", "a\nb");
		expect(parseOutputs(await readFile(file, "utf8"))).toEqual({ id: "42", multi: "a\nb" });
		await dir.cleanup();
	});

	test("falls back to a workflow command without GITHUB_OUTPUT", async () => {
		restore = withEnv({ GITHUB_OUTPUT: undefined });
		const { output } = await captureStdout(async () => core.setOutput("k", "v"));
		expect(output).toBe("\n::set-output name=k::v\n");
	});

	test("escapes workflow command data", async () => {
		const { output } = await captureStdout(async () => {
			core.info("plain 100%");
			core.debug("d");
			core.warning("50%\r\nnext");
		});
		expect(output).toBe("plain 100%\n::debug::d\n::warning::50%25%0D%0Anext\n");
	});

	test("setFailed reports an error and marks the process as failed", async () => {
		const { output } = await captureStdout(async () => core.setFailed("boom"));
		expect(output).toBe("::error::boom\n");
		expect(process.exitCode).toBe(1);
	});
});
