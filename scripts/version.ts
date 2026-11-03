/** Semantic version bumping used by the release script. */
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

export function nextVersion(current: string, bump: string): string {
	if (SEMVER.test(bump)) return bump;
	const match = SEMVER.exec(current);
	if (!match) throw new Error(`package.json version ${current} is not valid semver`);
	const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
	// A prerelease of the target version graduates to it instead of skipping ahead.
	const pre = match[4] !== undefined;
	switch (bump) {
		case "major":
			return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
		case "minor":
			return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
		case "patch":
			return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
		default:
			throw new Error(
				`Unknown release type "${bump}". Use major, minor, patch or an explicit x.y.z.`,
			);
	}
}
