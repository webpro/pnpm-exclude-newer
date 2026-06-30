# pnpm-exclude-newer

**NOTE**: This script is 100% generated. Use at your own risk.

Bring a pnpm project up to the latest versions that are old enough to trust: every dependency —
direct **and transitive** — capped to what was published before a cutoff. Think [uv's
`--exclude-newer`][1], or a **transitive** `minimumReleaseAge`, for pnpm.

By default it rewrites each direct dep range in `package.json` to the latest **mature** version
(keeping its `^`/`~` operator) and resolves a fully age-capped lockfile. Pass `--no-bump` to leave
`package.json` alone and only resolve the lockfile within the existing ranges.

```sh
pnpm dlx @webpro/pnpm-exclude-newer            # cutoff from pnpm-workspace.yaml's minimumReleaseAge (else 1 day)
pnpm dlx @webpro/pnpm-exclude-newer --age 4320 # 3 days
pnpm dlx @webpro/pnpm-exclude-newer --exclude-newer 2026-05-30
pnpm dlx @webpro/pnpm-exclude-newer --no-bump  # lockfile only, don't touch package.json
```

## Why this exists

pnpm's [`minimumReleaseAge`][2] is **verify-only**: the
resolver picks the latest in-range version and then _rejects_ it if it's too fresh
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `ERR_PNPM_NO_MATURE_MATCHING_VERSION`) — it does **not**
fall back to the latest _mature_ version. `resolutionMode: time-based` is meant to do age-aware
resolution but is broken when combined with `minimumReleaseAge`. So out of the box you can't get a
lockfile that's mature _all the way down_, and the escape hatches are all exclusion-based.

Related pnpm issues:
[#10257][3] (time-based ignored),
[#11068][4] (transitive deps error out),
[#11203][5] (no intermediate fallback),
[#10488][6] (excludes don't cascade).

## How it compares

Cooldown / min-release-age features that work at the **manifest or PR layer** only gate **direct**
dependencies — your package manager still resolves the transitive tree to the freshest versions at
install time:

| Tool                                               | Operates on             |        Direct        | Transitive  |
| -------------------------------------------------- | ----------------------- | :------------------: | :---------: |
| [`npm-check-updates --cooldown`][7]                | rewrites `package.json` |          ✅          |     ❌      |
| Renovate `minimumReleaseAge` / Dependabot cooldown | opens PRs               |          ✅          |     ❌      |
| pnpm [`minimumReleaseAge`][2]                      | resolve + verify        | ⚠️ `latest`-tag only | ❌ (errors) |
| **`pnpm-exclude-newer`**                           | **registry resolution** |          ✅          |     ✅      |

Verified: `ncu --cooldown 3` on a project with a single direct dependency correctly cools that
dependency, yet its lockfile still contained a transitive dependency published 2 days earlier.
`pnpm-exclude-newer` on the same project left zero entries younger than the cutoff. Only
resolution-level filtering reaches transitive dependencies.

## How it works

1. Stands up a throwaway local registry **mirror** that hides every version published on/after the
   cutoff (and repoints `dist-tags.latest` to the newest mature version).
2. Unless `--no-bump`, rewrites each direct dep range in your `package.json`(s) to that latest
   mature version — preserving the `^`/`~` operator. This both **updates** stale ranges and
   **lowers** any whose floor is too fresh to have a mature match (e.g. `^1.69.0` → `^1.68.0`),
   which would otherwise error. Non-registry specs (`workspace:`, `catalog:`, `file:`, git, URL,
   `npm:` aliases, `*`, complex ranges) are left untouched.
3. Copies the workspace-member manifests (asked from pnpm, so the `packages` globs and their
   negations are honored — test fixtures and other nested `package.json`s are skipped) into a
   clean temp tree (your `node_modules` would otherwise leak fresh peer versions), copies a sanitized
   project `.npmrc`, and runs `pnpm install --lockfile-only` against the mirror — so pnpm's _normal_
   resolver produces a transitively age-capped tree.
4. Normalizes registry tarball URLs out of the generated lockfile, copies it back, and runs
   `pnpm install --frozen-lockfile`, letting pnpm's own gate verify it without mutating the result.

Real integrity hashes come straight from the upstream registry, so the lockfile stays portable and
keeps pnpm's usual shape. If resolution fails, any `package.json` bumps from this run are reverted.

## Options

| flag                     | meaning                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `--exclude-newer <date>` | hide versions published on/after `<date>` (e.g. `2026-05-30`)                                 |
| `--age <minutes>`        | cutoff = now − minutes (default: `minimumReleaseAge` from `pnpm-workspace.yaml`, else `1440`) |
| `--no-bump`              | don't rewrite `package.json`; only resolve the lockfile within the existing ranges            |
| `--no-install`           | stop after writing the lockfile (skip the verifying install)                                  |
| `-h`, `--help`           | usage                                                                                         |

If a resolution fails, it means an already-mature package depends on a still-too-fresh version —
wait for it to age, or raise the cutoff for that run.

## Requirements & limitations

- Node ≥ 18 (global `fetch`) and `pnpm` on `PATH`.
- **pnpm version**: resolves with whatever `pnpm` is on `PATH` (under corepack, the repo's
  `packageManager` pin — recommended for fidelity). A mismatch can change resolution; e.g. pnpm 11
  ignores the `pnpm` field in `package.json`, so on an older repo that keeps
  `overrides`/`patchedDependencies` there, run it under the matching pnpm.
- **Registries**: only the default registry is mirrored (read with `pnpm config get registry`, with
  its `_authToken` from `.npmrc`). Per-scope registries (`@scope:registry=`) are stripped from the
  isolated install so the mirror remains in control; private scopes that need a different registry may
  fail.
- **Config fidelity**: the isolated install copies `package.json`(s), `pnpm-workspace.yaml`,
  `.pnpmfile.cjs`/`pnpmfile.cjs`, `patches/`, and non-registry project `.npmrc` settings. Registry,
  auth, minimum-release-age, and `resolution-mode=time-based` entries are stripped in the temp tree.
- `shared-workspace-lockfile=false` (per-package lockfiles) isn't supported.
- **Non-registry deps** (git, tarball URL, `file:`, `link:`, `workspace:`) have no published-version
  concept and aren't age-filtered — they resolve as usual.
- If an `overrides` / catalog / `patchedDependencies` entry pins an _exact_ version newer than the
  cutoff, resolution fails (the mirror hides it) — age the pin or raise the cutoff.
- `minimumReleaseAgeExclude` is not honored: everything is aged, no exceptions.
- Versions the registry has no publish `time` for are treated as too-new (excluded).

## License

MIT

[1]: https://docs.astral.sh/uv/reference/settings/#exclude-newer
[2]: https://pnpm.io/settings#minimumreleaseage
[3]: https://github.com/pnpm/pnpm/issues/10257
[4]: https://github.com/pnpm/pnpm/issues/11068
[5]: https://github.com/pnpm/pnpm/issues/11203
[6]: https://github.com/pnpm/pnpm/issues/10488
[7]: https://github.com/raineorshine/npm-check-updates#cooldown
