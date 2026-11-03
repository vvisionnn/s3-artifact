import { describe, expect, test } from "bun:test";
import { nextVersion } from "../scripts/version.ts";

describe("nextVersion", () => {
	test.each([
		["1.2.3", "patch", "1.2.4"],
		["1.2.3", "minor", "1.3.0"],
		["1.2.3", "major", "2.0.0"],
		["0.0.0", "1.0.0", "1.0.0"],
		["1.0.0", "2.0.0-rc.1", "2.0.0-rc.1"],
		["1.0.0-rc.1", "patch", "1.0.0"],
		["1.1.0-rc.1", "minor", "1.1.0"],
		["2.0.0-rc.1", "major", "2.0.0"],
		["1.0.1-rc.1", "minor", "1.1.0"],
	])("%s + %s = %s", (current, bump, expected) => {
		expect(nextVersion(current, bump)).toBe(expected);
	});

	test("rejects unknown bumps and invalid versions", () => {
		expect(() => nextVersion("1.0.0", "huge")).toThrow("Unknown release type");
		expect(() => nextVersion("nope", "patch")).toThrow("not valid semver");
	});
});
