# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org).

## [1.0.0](https://github.com/vvisionnn/s3-artifact/releases/tag/v1.0.0) - 2026-11-03

### 🚀 Features

- S3-backed drop-in replacements for upload-artifact, merge and download-artifact ([`81968a6`](https://github.com/vvisionnn/s3-artifact/commit/81968a6253ed81912a7502360a3a404b18da0703))

### 🐛 Bug Fixes

- **release:** Render changelog for unscoped commits and roll back failed releases ([`cbd5258`](https://github.com/vvisionnn/s3-artifact/commit/cbd5258b952d2a5eb1abacfc8a47d4fb1214327d))

### ♻️ Refactoring

- Share delay helper and extract case-conflict detection ([`bc49c15`](https://github.com/vvisionnn/s3-artifact/commit/bc49c15007b3bb3fb5642e4b0ad4db1586499d1c))

### 📚 Documentation

- README ([`adaed91`](https://github.com/vvisionnn/s3-artifact/commit/adaed91affac394d91e691e13fe922be718c7cf7))

### 🧪 Tests

- Unit, integration and bundle tests against an in-process S3 server ([`fe26987`](https://github.com/vvisionnn/s3-artifact/commit/fe26987c6307ec4fc6b25403113eaef8570be414))
- Portable line endings on Windows and per-file coverage above 95% ([`dd2f42d`](https://github.com/vvisionnn/s3-artifact/commit/dd2f42d93775fe5b5c09ed63db82644d0693624b))

### ⚙️ CI & Build

- Cross-platform tests, end-to-end runs on fake S3 and SeaweedFS, tag-driven releases ([`01f5c64`](https://github.com/vvisionnn/s3-artifact/commit/01f5c64fdafea338665c125035d7379ad0467463))
- Release script with git-cliff changelog ([`22b723d`](https://github.com/vvisionnn/s3-artifact/commit/22b723dfcb8de3685eb24d14eca390a701ee254c))
- Keep the generated changelog out of formatting checks ([`d686a9a`](https://github.com/vvisionnn/s3-artifact/commit/d686a9af14da196ef3242aff0579b523a313f1e8))

### 🧹 Chores

- Scaffold project with Bun, TypeScript 7 and Biome ([`66ed36d`](https://github.com/vvisionnn/s3-artifact/commit/66ed36dcc4f3e2d6ac824d858f90f12f33dd4dbd))

