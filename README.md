<div align="center">

# s3-artifact

**`actions/upload-artifact` and `actions/download-artifact`, backed by your own S3 bucket.**

Same inputs. Same outputs. No artifact storage quota.

[![CI](https://github.com/vvisionnn/s3-artifact/actions/workflows/ci.yml/badge.svg)](https://github.com/vvisionnn/s3-artifact/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vvisionnn/s3-artifact?sort=semver&color=blue)](https://github.com/vvisionnn/s3-artifact/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Runtime](https://img.shields.io/badge/runtime-node24-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)

[Quick start](#-quick-start) ·
[Configuration](#-configuration) ·
[Providers](#-provider-recipes) ·
[Compatibility](#-compatibility) ·
[How it works](#-how-it-works)

</div>

---

## ✨ Why

GitHub's artifact storage is metered and shared across your account, and it runs out fast on busy repositories. `s3-artifact` keeps the exact interface of the official actions but writes to any S3-compatible bucket you control: SeaweedFS, MinIO, Garage, Cloudflare R2, Backblaze B2, AWS S3 and more.

|                 |                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- |
| 🔁 **Drop-in**  | Every input and output of `upload-artifact@v7`, `upload-artifact/merge` and `download-artifact@v8`. |
| 🪣 **Any S3**   | Path-style or virtual-hosted, custom endpoints, session tokens, key prefixes.                       |
| 🚀 **Fast**     | Streaming zip + parallel multipart uploads, ZIP64 for artifacts beyond 4 GiB.                       |
| 🔒 **Verified** | SHA-256 digests checked on every download; corrupted data is never extracted.                       |
| 🧳 **Portable** | Linux, macOS and Windows runners. Executable bits survive the round trip.                           |
| 🪶 **Lean**     | Single-file bundles, ~200 KiB each, no runtime downloads.                                           |

## ⚡ Quick start

**1. Point the job at your bucket** — once per workflow (or as organization variables and secrets):

```yaml
env:
  ARTIFACT_S3_ENDPOINT: https://s3.example.com
  ARTIFACT_S3_BUCKET: gha-artifacts
  ARTIFACT_S3_ACCESS_KEY_ID: ${{ secrets.ARTIFACT_S3_ACCESS_KEY_ID }}
  ARTIFACT_S3_SECRET_ACCESS_KEY: ${{ secrets.ARTIFACT_S3_SECRET_ACCESS_KEY }}
```

**2. Swap the `uses:` lines** — nothing else changes:

```diff
- - uses: actions/upload-artifact@v7
+ - uses: vvisionnn/s3-artifact/upload@v1
    with:
      name: dist
      path: dist/

- - uses: actions/download-artifact@v8
+ - uses: vvisionnn/s3-artifact/download@v1
    with:
      name: dist

- - uses: actions/upload-artifact/merge@v7
+ - uses: vvisionnn/s3-artifact/upload/merge@v1
```

`vvisionnn/s3-artifact@v1` (the repository root, as listed on the Marketplace) is the same as `vvisionnn/s3-artifact/upload@v1`.

<details>
<summary><b>Complete workflow example</b></summary>

```yaml
name: build

on: [push]

env:
  ARTIFACT_S3_ENDPOINT: ${{ vars.ARTIFACT_S3_ENDPOINT }}
  ARTIFACT_S3_BUCKET: ${{ vars.ARTIFACT_S3_BUCKET }}
  ARTIFACT_S3_ACCESS_KEY_ID: ${{ secrets.ARTIFACT_S3_ACCESS_KEY_ID }}
  ARTIFACT_S3_SECRET_ACCESS_KEY: ${{ secrets.ARTIFACT_S3_SECRET_ACCESS_KEY }}

jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - run: make build
      - uses: vvisionnn/s3-artifact/upload@v1
        with:
          name: build-${{ matrix.os }}
          path: out/
          retention-days: 7

  package:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: vvisionnn/s3-artifact/download@v1
        with:
          pattern: build-*
          path: builds/
      - run: ls -R builds/
```

</details>

## 🧩 Configuration

All official inputs work unchanged. Storage is configured with the `s3-*` inputs below; each one falls back to environment variables, so most workflows set them once and never repeat them.

| Input                  | Environment fallback (in order)                                   | Default                                     |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `s3-bucket`            | `ARTIFACT_S3_BUCKET`                                              | **required**                                |
| `s3-endpoint`          | `ARTIFACT_S3_ENDPOINT`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` | AWS S3 for the region                       |
| `s3-region`            | `ARTIFACT_S3_REGION`, `AWS_REGION`, `AWS_DEFAULT_REGION`          | `us-east-1`                                 |
| `s3-access-key-id`     | `ARTIFACT_S3_ACCESS_KEY_ID`, `AWS_ACCESS_KEY_ID`                  | **required**                                |
| `s3-secret-access-key` | `ARTIFACT_S3_SECRET_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`          | **required**                                |
| `s3-session-token`     | `ARTIFACT_S3_SESSION_TOKEN`, `AWS_SESSION_TOKEN`                  | –                                           |
| `s3-prefix`            | `ARTIFACT_S3_PREFIX`                                              | –                                           |
| `s3-force-path-style`  | `ARTIFACT_S3_FORCE_PATH_STYLE`                                    | `true` with a custom endpoint, else `false` |
| `s3-url-expires-in`    | `ARTIFACT_S3_URL_EXPIRES_IN`                                      | `604800` (7 days, the SigV4 maximum)        |

> [!TIP]
> Prefer the `ARTIFACT_S3_*` names in workflow-level `env`: they never collide with credentials other steps use for AWS.

## 🪣 Provider recipes

<details>
<summary><b>SeaweedFS · MinIO · Garage · any self-hosted S3</b></summary>

```yaml
env:
  ARTIFACT_S3_ENDPOINT: https://s3.example.com # path-style is used automatically
  ARTIFACT_S3_BUCKET: gha-artifacts
  ARTIFACT_S3_ACCESS_KEY_ID: ${{ secrets.ARTIFACT_S3_ACCESS_KEY_ID }}
  ARTIFACT_S3_SECRET_ACCESS_KEY: ${{ secrets.ARTIFACT_S3_SECRET_ACCESS_KEY }}
```

Requests use HTTP/1.1 with one connection per parallel part, which keeps reverse proxies that throttle large HTTP/2 uploads out of the way.

</details>

<details>
<summary><b>Cloudflare R2</b></summary>

```yaml
env:
  ARTIFACT_S3_ENDPOINT: https://<account-id>.r2.cloudflarestorage.com
  ARTIFACT_S3_REGION: auto
  ARTIFACT_S3_BUCKET: gha-artifacts
  ARTIFACT_S3_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  ARTIFACT_S3_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

</details>

<details>
<summary><b>AWS S3 with OIDC (no long-lived keys)</b></summary>

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v6
    with:
      role-to-assume: arn:aws:iam::123456789012:role/gha-artifacts
      aws-region: eu-west-1
  - uses: vvisionnn/s3-artifact/upload@v1
    with:
      name: dist
      path: dist/
      s3-bucket: my-gha-artifacts
```

The `AWS_*` variables exported by `configure-aws-credentials`, including the session token, are picked up automatically.

</details>

<details>
<summary><b>Backblaze B2</b></summary>

```yaml
env:
  ARTIFACT_S3_ENDPOINT: https://s3.us-west-004.backblazeb2.com
  ARTIFACT_S3_REGION: us-west-004
  ARTIFACT_S3_BUCKET: gha-artifacts
  ARTIFACT_S3_ACCESS_KEY_ID: ${{ secrets.B2_KEY_ID }}
  ARTIFACT_S3_SECRET_ACCESS_KEY: ${{ secrets.B2_APPLICATION_KEY }}
```

</details>

**Minimum permissions** for the key: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` and the multipart actions (`s3:AbortMultipartUpload`) on the bucket, ideally limited to the configured prefix.

## 🔁 Compatibility

|                                                        | Official actions                                                  | s3-artifact                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Inputs and defaults                                    | ✓                                                                 | ✓ identical, plus `s3-*`                                                                          |
| Outputs                                                | `artifact-id`, `artifact-url`, `artifact-digest`, `download-path` | ✓ same names and formats                                                                          |
| Glob paths, `!` exclusions, hidden files, LCA root     | ✓                                                                 | ✓ same rules and error messages                                                                   |
| `archive: false`, `skip-decompress`, `digest-mismatch` | ✓                                                                 | ✓                                                                                                 |
| Download from another run or repository                | needs `github-token`                                              | `repository` + `run-id` only; token accepted and ignored                                          |
| `artifact-url`                                         | GitHub UI link (requires login)                                   | presigned S3 link, valid for `s3-url-expires-in`                                                  |
| Same name uploaded again in a re-run attempt           | –                                                                 | replaces the earlier attempt's artifact; within one attempt it conflicts unless `overwrite: true` |
| Digest mismatch with `digest-mismatch: error`          | fails after extracting                                            | fails **without** extracting                                                                      |
| File permissions                                       | lost                                                              | executable bits preserved                                                                         |
| Artifacts in the GitHub UI / REST API                  | ✓                                                                 | ✗ they live in your bucket                                                                        |

> [!IMPORTANT]
> `artifact-url` is a bearer link: anyone who has it can download the artifact until it expires. It is exposed only as a step output and never printed to the log. Avoid echoing it in public repositories.

## 🔍 How it works

```text
s3://<bucket>/<prefix><owner>/<repo>/<run-id>/<artifact-name>/
├── <artifact-name>.zip     # or the raw file when archive: false
└── manifest.json           # id, size, sha256 digest, expiry; written last
```

- **Upload** globs files exactly like the official action, streams a zip (or the raw file) through SHA-256, and switches to parallel multipart uploads above 16 MiB. The manifest is written last, so readers only ever see complete artifacts.
- **Download** lists manifests for the requested run, downloads with retries, verifies the digest, then extracts with path-traversal protection.
- **Retention** follows `retention-days` (capped by `GITHUB_RETENTION_DAYS`, default 90). Expired artifacts disappear from listings immediately. To reclaim the space, add a bucket lifecycle rule that expires objects after your longest retention period, for example 90 days on the artifact prefix.
- **Transient failures** (network errors, 429, 5xx) are retried with exponential backoff; failed multipart uploads are aborted so no orphaned parts remain.

## 🛠️ Development

Requires [Bun](https://bun.sh). The bundles in `dist/` are committed because GitHub runs actions straight from the repository.

```sh
bun install
bun run check        # lint + typecheck + tests with coverage gate + bundle
bun test             # 180+ tests against an in-process S3 server, ~1s
bun run build        # rebuild dist/ after changing src/
```

Every push runs the unit suite on Linux, macOS and Windows, end-to-end workflows on all three against a fake S3, and a full scenario against a real SeaweedFS server.

**Releasing** is one command. It bumps the version, writes [CHANGELOG.md](CHANGELOG.md) with git-cliff and pushes a tag; the tag publishes the GitHub release and moves the major tag (`v1`):

```sh
bun run release patch   # or minor, major, 1.4.0, 2.0.0-rc.1
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org) so the changelog writes itself.

## 📄 License

[MIT](LICENSE)
