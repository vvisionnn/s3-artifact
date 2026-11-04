import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

interface ActionYaml {
	inputs: Record<string, { default?: string; required?: boolean }>;
	outputs: Record<string, unknown>;
	runs: { using: string; main: string };
}

const load = async (file: string) => Bun.YAML.parse(await Bun.file(file).text()) as ActionYaml;

const S3_INPUTS = [
	"s3-bucket",
	"s3-endpoint",
	"s3-region",
	"s3-access-key-id",
	"s3-secret-access-key",
	"s3-session-token",
	"s3-prefix",
	"s3-force-path-style",
];

/** Inputs, defaults and outputs of actions/upload-artifact@v7, merge, and download-artifact@v8. */
const OFFICIAL = {
	"upload/action.yml": {
		inputs: {
			name: "artifact",
			path: undefined,
			"if-no-files-found": "warn",
			"retention-days": undefined,
			"compression-level": "6",
			overwrite: "false",
			"include-hidden-files": "false",
			archive: "true",
		},
		outputs: ["artifact-id", "artifact-url", "artifact-digest"],
		main: "dist/upload/index.js",
	},
	"upload/merge/action.yml": {
		inputs: {
			name: "merged-artifacts",
			pattern: "*",
			"separate-directories": "false",
			"retention-days": undefined,
			"compression-level": "6",
			"delete-merged": "false",
			"include-hidden-files": "false",
		},
		outputs: ["artifact-id", "artifact-url", "artifact-digest"],
		main: "dist/merge/index.js",
	},
	"download/action.yml": {
		inputs: {
			name: undefined,
			"artifact-ids": undefined,
			path: undefined,
			pattern: undefined,
			"merge-multiple": "false",
			"github-token": undefined,
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression, not a template
			repository: "${{ github.repository }}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression, not a template
			"run-id": "${{ github.run_id }}",
			"skip-decompress": "false",
			"digest-mismatch": "error",
		},
		outputs: ["download-path"],
		main: "dist/download/index.js",
	},
} as const;

describe.each(Object.entries(OFFICIAL))("%s", (file, spec) => {
	test("keeps every official input with the official default", async () => {
		const action = await load(file);
		for (const [name, value] of Object.entries(spec.inputs)) {
			expect(action.inputs).toHaveProperty(name);
			expect(action.inputs[name]?.default).toBe(value);
		}
	});

	test("adds the S3 inputs and nothing unexpected", async () => {
		const action = await load(file);
		const extra = Object.keys(action.inputs).filter((name) => !(name in spec.inputs));
		const expected = file.startsWith("download") ? S3_INPUTS : [...S3_INPUTS, "s3-url-expires-in"];
		expect(extra.sort()).toEqual(expected.sort());
	});

	test("exposes the official outputs", async () => {
		expect(Object.keys((await load(file)).outputs)).toEqual([...spec.outputs]);
	});

	test("runs the bundled entry point on node24", async () => {
		const action = await load(file);
		expect(action.runs.using).toBe("node24");
		expect(join(dirname(file), action.runs.main)).toBe(join(spec.main));
		expect(existsSync(join(dirname(file), action.runs.main))).toBe(true);
	});
});

test("every s3-* input is read by the configuration resolver", async () => {
	const source = await Bun.file("src/shared/config.ts").text();
	for (const name of [...S3_INPUTS, "s3-url-expires-in"]) {
		expect(source).toContain(`"${name}"`);
	}
});

describe("root action.yml (Marketplace listing)", () => {
	test("is the upload action under a unique name", async () => {
		const root = (await Bun.YAML.parse(await Bun.file("action.yml").text())) as ActionYaml & {
			name: string;
			description: string;
			branding: { icon: string; color: string };
		};
		const upload = await load("upload/action.yml");
		expect(root.name).toBe("S3 Artifact");
		expect(root.inputs).toEqual(upload.inputs);
		expect(root.outputs).toEqual(upload.outputs);
		expect(root.runs).toEqual({ using: "node24", main: "dist/upload/index.js" });
		expect(root.branding.icon).toBeTruthy();
		expect(root.branding.color).toBeTruthy();
		// Marketplace rejects descriptions longer than 125 characters.
		expect(root.description.length).toBeLessThanOrEqual(125);
	});
});
