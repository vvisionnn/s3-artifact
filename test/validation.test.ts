import { describe, expect, test } from "bun:test";
import { validateArtifactName, validateFilePath } from "../src/shared/validation.ts";

describe("validateArtifactName", () => {
	test("accepts names the official action accepts", () => {
		for (const name of ["artifact", "my-artifact_1.2", "with space", "ünïcode"]) {
			expect(() => validateArtifactName(name)).not.toThrow();
		}
	});

	test("rejects empty names", () => {
		expect(() => validateArtifactName("")).toThrow("empty");
	});

	test.each([".", ".."])("rejects the relative directory name %p", (name) => {
		expect(() => validateArtifactName(name)).toThrow("The artifact name is not valid");
	});

	test.each(['"', ":", "<", ">", "|", "*", "?", "\r", "\n", "\\", "/"])(
		"rejects names containing %p",
		(char) => {
			expect(() => validateArtifactName(`bad${char}name`)).toThrow(
				"The artifact name is not valid",
			);
		},
	);
});

describe("validateFilePath", () => {
	test("allows directory separators", () => {
		expect(() => validateFilePath("dir/sub\\file.txt")).not.toThrow();
	});

	test("rejects empty paths", () => {
		expect(() => validateFilePath("")).toThrow("empty");
	});

	test.each(['"', ":", "<", ">", "|", "*", "?", "\r", "\n"])(
		"rejects paths containing %p",
		(char) => {
			expect(() => validateFilePath(`dir/bad${char}.txt`)).toThrow(
				"The path for one of the files in artifact is not valid",
			);
		},
	);
});
