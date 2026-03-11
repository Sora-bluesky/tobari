# Changelog

## [3.0.0](https://github.com/Sora-bluesky/tobari/compare/v2.0.0...v3.0.0) (2026-03-11)


### ⚠ BREAKING CHANGES

* v2.0.0 — consolidate tobari-ops into tobari
* v2.0.0 — consolidate tobari-ops into tobari
* Python hooks replaced by JavaScript hooks (Phase 2)

### Features

* add complete hook/skill/rule infrastructure for working product ([78f3acf](https://github.com/Sora-bluesky/tobari/commit/78f3acfabec9077861aca1ce7cfc27d514e26035))
* add npm packaging — tobari init CLI and templates ([690d747](https://github.com/Sora-bluesky/tobari/commit/690d747b5527ce61f5c31a29cecdf6f8abc35596))
* add npm packaging — tobari init CLI and templates ([bdc1ad9](https://github.com/Sora-bluesky/tobari/commit/bdc1ad94c6744cb9e76c5c74a00bd625beb7797f))
* complete product setup with hooks, skills, and governance ([19e11a7](https://github.com/Sora-bluesky/tobari/commit/19e11a7baaa6ef4093c67b9a92f91ae7deb5f018))
* initial commit — tobari public repository ([6699eb6](https://github.com/Sora-bluesky/tobari/commit/6699eb62e9edadb32acdefddd76507e559ab7eaa))
* migrate JS hooks from tobari-ops with S1-S11 sanitization ([1376a19](https://github.com/Sora-bluesky/tobari/commit/1376a19ae148281a7c34906dff1560ea616ba20d))
* migrate settings, rules, skills, agents, and commands from tobari-ops ([3c4484f](https://github.com/Sora-bluesky/tobari/commit/3c4484f05eb97b2a64510ba80828ba5343d038a5))
* migrate tests and design docs from tobari-ops ([aef8a95](https://github.com/Sora-bluesky/tobari/commit/aef8a95671954a7c8fa17cab09a1542242cbbc6a))
* remove Python hooks and update CLI for v2.0.0 consolidation ([f1f7fbc](https://github.com/Sora-bluesky/tobari/commit/f1f7fbccea17c9a1878510886ac042b580a7aa5c))
* replace hero images with designed JPGs ([d474837](https://github.com/Sora-bluesky/tobari/commit/d474837600f6a8f4cbfeec8d478808afa043910c))
* switch README to English-first for international expansion ([#24](https://github.com/Sora-bluesky/tobari/issues/24)) ([3082d9c](https://github.com/Sora-bluesky/tobari/commit/3082d9c89f93ee3491ee0ee5320fb1428b25a9b2))
* sync tobari-ops v0.8.0 ([2419b74](https://github.com/Sora-bluesky/tobari/commit/2419b74a4ef7b54afef3fea4b5f38643f4e40ba6))
* sync tobari-ops v0.8.0 changes ([f1311f0](https://github.com/Sora-bluesky/tobari/commit/f1311f0958ba8368883dcd8dc4fdbde68f2da9fa))
* sync v0.4.0 - template sync + M2 security fixes ([d82b906](https://github.com/Sora-bluesky/tobari/commit/d82b9063897c5e20348eb2dd22a2f47ff79f599c))
* sync v0.4.0 - template sync automation + M2 security fixes ([91ab27b](https://github.com/Sora-bluesky/tobari/commit/91ab27baffcf24410a55ea4553adcbdbc2afe1ed))
* sync v1.1.0 Node.js Hook templates from tobari-ops ([#21](https://github.com/Sora-bluesky/tobari/issues/21)) ([207a5c0](https://github.com/Sora-bluesky/tobari/commit/207a5c0db36fc496ddc68356b85f5eceaadce17d))
* v2.0.0 — consolidate tobari-ops into tobari ([f6f3701](https://github.com/Sora-bluesky/tobari/commit/f6f37012521404989531a170e3767d2820124758))
* v2.0.0 — consolidate tobari-ops into tobari ([f6f3701](https://github.com/Sora-bluesky/tobari/commit/f6f37012521404989531a170e3767d2820124758))


### Bug Fixes

* add language toggle links and remove /orose from Skills table ([49732e3](https://github.com/Sora-bluesky/tobari/commit/49732e3bc8da369340b2de012b4fadbe1c4284b2))
* change npm-publish trigger from release to tag push ([a30b5f0](https://github.com/Sora-bluesky/tobari/commit/a30b5f0ab29f0d58e3c5f49a7db4440960dcbc19))
* change npm-publish trigger from release to tag push ([773517d](https://github.com/Sora-bluesky/tobari/commit/773517dfab1ebc3c2295f164c87e82c32dfe3163))
* **ci:** move --test-concurrency flag before file glob in test CI ([e408e18](https://github.com/Sora-bluesky/tobari/commit/e408e18778ebde14c2d826a10be1f73efef6212f))
* handle absolute paths with unresolved symlinks in canonicalPathKey ([23782ef](https://github.com/Sora-bluesky/tobari/commit/23782efdf136c105c3a2b167e9fe7f1e7db9f807))
* improve diagram readability — convert LR to TD layout ([6ea7b12](https://github.com/Sora-bluesky/tobari/commit/6ea7b129fb1dd10e52c93dfbba3f361969e67e52))
* resolve macOS symlink mismatch in canonicalPathKey + relax detached HEAD test ([2b9c2fc](https://github.com/Sora-bluesky/tobari/commit/2b9c2fca216f33d403d7804a60913d7605085962))
* **tests:** handle missing tobari-session.json in test beforeEach ([d4cb379](https://github.com/Sora-bluesky/tobari/commit/d4cb379d51ea22b5f15abb6f69ad881cfd44c4ee))


### Maintenance

* bump version to 1.0.0 ([40af1c6](https://github.com/Sora-bluesky/tobari/commit/40af1c6901ede73a29f362a86f05cb000751620d))
* bump version to 1.0.0 for stable release ([dfe7a45](https://github.com/Sora-bluesky/tobari/commit/dfe7a4595aae476fbbcba0fff224625ad1721ddc))
* remove templates/.claude/ directory (v2.0.0 direct distribution) ([a584ff6](https://github.com/Sora-bluesky/tobari/commit/a584ff6f659a90f4b5a54f845e869446aa3180c2))
* sync from tobari-ops v0.4.1 ([a423a19](https://github.com/Sora-bluesky/tobari/commit/a423a19a8c34a9378527bcce3914525ea16e4af2))
* sync from tobari-ops v0.4.1 ([8ffe400](https://github.com/Sora-bluesky/tobari/commit/8ffe400c021e02618639e68789f7bdfd29939358))
* sync from tobari-ops v0.5.0 ([824f05f](https://github.com/Sora-bluesky/tobari/commit/824f05f39d4099c06c920679f045e47e265aea3d))
* sync from tobari-ops v0.5.0 ([6d2a1f9](https://github.com/Sora-bluesky/tobari/commit/6d2a1f93b1836b1ff4c8c3f822ca52c5f071fc58))
* sync from tobari-ops v0.5.1 ([#10](https://github.com/Sora-bluesky/tobari/issues/10)) ([8837632](https://github.com/Sora-bluesky/tobari/commit/8837632983c6d02bff6cc4f0e7df9e6b7e51d89a))
* sync from tobari-ops v0.6.0 ([#11](https://github.com/Sora-bluesky/tobari/issues/11)) ([0d49bd3](https://github.com/Sora-bluesky/tobari/commit/0d49bd33a6f764157c25b53e4d932e8fa0d08f1b))
* sync from tobari-ops v0.7.0 ([#12](https://github.com/Sora-bluesky/tobari/issues/12)) ([6b863a8](https://github.com/Sora-bluesky/tobari/commit/6b863a8d9e25986bfc5e8b3236f78e41480a19fe))
* sync from tobari-ops v0.8.0 ([#13](https://github.com/Sora-bluesky/tobari/issues/13)) ([2e590e5](https://github.com/Sora-bluesky/tobari/commit/2e590e59aa277cfe99cc77125a87eee5cd96bf49))
* sync from tobari-ops v0.9.0 ([#15](https://github.com/Sora-bluesky/tobari/issues/15)) ([e77019d](https://github.com/Sora-bluesky/tobari/commit/e77019da6c5c063f9cbdb0ffa17145201d586ba8))
* sync from tobari-ops v0.9.1 ([#18](https://github.com/Sora-bluesky/tobari/issues/18)) ([e4d4157](https://github.com/Sora-bluesky/tobari/commit/e4d41572a57ea8e61c9e9ceafeed78b243cd488b))
* sync from tobari-ops v1.1.0 ([#20](https://github.com/Sora-bluesky/tobari/issues/20)) ([5841403](https://github.com/Sora-bluesky/tobari/commit/5841403af99693fe6526f63bf8c9776475312758))
* sync from tobari-ops v1.2.0 ([#22](https://github.com/Sora-bluesky/tobari/issues/22)) ([b597ee1](https://github.com/Sora-bluesky/tobari/commit/b597ee1e33d668e3de46d940900b4a45b0aa5ca9))
* sync from tobari-ops v1.3.0 ([#23](https://github.com/Sora-bluesky/tobari/issues/23)) ([664b590](https://github.com/Sora-bluesky/tobari/commit/664b59056a6553c0870af1ad6c863f0315252b71))
* sync from tobari-ops v1.4.0 ([#25](https://github.com/Sora-bluesky/tobari/issues/25)) ([3a996fe](https://github.com/Sora-bluesky/tobari/commit/3a996fe87a703802d2b7f3152db6c1859410c312))
* sync from tobari-ops v1.5.0 ([#26](https://github.com/Sora-bluesky/tobari/issues/26)) ([d1f09d0](https://github.com/Sora-bluesky/tobari/commit/d1f09d0d117facb12f8f02ebf5fdb2ccb7adcd59))
* sync v0.9.0 from tobari-ops ([#16](https://github.com/Sora-bluesky/tobari/issues/16)) ([b52365e](https://github.com/Sora-bluesky/tobari/commit/b52365e5102f0784654ffc1bcaf8e88547c574fd))


### Documentation

* add npm Quick Start and sync settings.json from tobari-ops ([23e82c7](https://github.com/Sora-bluesky/tobari/commit/23e82c7d839799562438af8c1cf1e9660e18921d))
* add npm Quick Start to README ([2f2f1ac](https://github.com/Sora-bluesky/tobari/commit/2f2f1ac9fb6885c12731f4e45c8dcf4beefc9c6d))
* add Prerequisites section and --force/--update usage ([9f58c2c](https://github.com/Sora-bluesky/tobari/commit/9f58c2caaf67d191f4827aee02701f754abe6d0c))
* add Prerequisites section and --force/--update usage to README ([84ec13e](https://github.com/Sora-bluesky/tobari/commit/84ec13ee7a3cdb121ec4091b1ec07e7dc03e5fd8))
* remove Python references from CONTRIBUTING.md ([129b96e](https://github.com/Sora-bluesky/tobari/commit/129b96ea07add5156a8263d8e86a26741a5c7e85))


### CI/CD

* add automated release workflow ([c2cff79](https://github.com/Sora-bluesky/tobari/commit/c2cff79401232859e36555a850e39278db260e24))
* add automated release workflow ([450461a](https://github.com/Sora-bluesky/tobari/commit/450461ace2530dfc265aa9576dc7a3f01f9c5a5e))
* add cross-platform test workflow (macOS + Ubuntu) ([4ae70d6](https://github.com/Sora-bluesky/tobari/commit/4ae70d6ba4e6a9d0ca4510d152fdb5a5166517ae))
* add cross-platform test workflow (macOS + Ubuntu) ([0b77533](https://github.com/Sora-bluesky/tobari/commit/0b77533da0f528e0f949f393616f10ca9f9a87e2))
* add release-please, update test CI, create v2.0.0 migration ([502beab](https://github.com/Sora-bluesky/tobari/commit/502beab5af4261d5e6770477af31967d8de4b8fb))
