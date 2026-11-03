/**
 * Cuts a release: `bun run release <major|minor|patch|x.y.z[-pre]>`.
 *
 * Verifies the tree, bumps package.json, regenerates CHANGELOG.md with git-cliff, commits, tags and
 * pushes. Pushing the tag triggers .github/workflows/release.yml, which publishes the GitHub
 * release and moves the floating major tag (for example `v1`).
 */
import { $ } from "bun";
import { nextVersion } from "./version.ts";

async function main(bump: string | undefined): Promise<void> {
	if (!bump) throw new Error("Usage: bun run release <major|minor|patch|x.y.z>");

	const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
	if (branch !== "main") throw new Error(`Releases are cut from main, not ${branch}.`);
	if ((await $`git status --porcelain`.text()).trim())
		throw new Error("Working tree is not clean.");
	await $`git fetch --tags origin main`;
	const behind = (await $`git rev-list --count HEAD..origin/main`.text()).trim();
	if (behind !== "0") throw new Error("main is behind origin/main; pull first.");

	const pkg = await Bun.file("package.json").json();
	const version = nextVersion(pkg.version, bump);
	const tag = `v${version}`;
	if ((await $`git tag --list ${tag}`.text()).trim()) throw new Error(`Tag ${tag} already exists.`);

	console.log(`Releasing ${tag}: running checks`);
	await $`bun run check`;
	if ((await $`git status --porcelain dist`.text()).trim()) {
		throw new Error("dist/ is out of date; commit the rebuilt bundles first.");
	}

	pkg.version = version;
	await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
	await $`bunx git-cliff --tag ${tag} --output CHANGELOG.md`;
	await $`bunx biome format --write package.json`.quiet();
	await $`git add package.json CHANGELOG.md`;
	await $`git commit -m ${`chore(release): ${tag}`}`;
	await $`git tag -a ${tag} -m ${tag}`;
	await $`git push --atomic origin main ${tag}`;
	console.log(`Pushed ${tag}. The release workflow publishes it.`);
}

await main(process.argv[2]);
