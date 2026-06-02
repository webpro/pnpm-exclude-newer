# pnpm-exclude-newer

Resolve a pnpm lockfile whose **entire** dependency tree — direct **and transitive** — excludes
versions published after a cutoff. Think [uv's `--exclude-newer`](https://docs.astral.sh/uv/reference/settings/#exclude-newer),
or a **transitive** `minimumReleaseAge`, for pnpm.

```sh
pnpm dlx pnpm-exclude-newer            # cutoff from pnpm-workspace.yaml's minimumReleaseAge (else 1 day)
pnpm dlx pnpm-exclude-newer --age 4320 # 3 days
pnpm dlx pnpm-exclude-newer --exclude-newer 2026-05-30
```

## Why this exists

pnpm's [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) is **verify-only**: the
resolver picks the latest in-range version and then *rejects* it if it's too fresh
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `ERR_PNPM_NO_MATURE_MATCHING_VERSION`) — it does **not**
fall back to the latest *mature* version. `resolutionMode: time-based` is meant to do age-aware
resolution but is broken when combined with `minimumReleaseAge`. So out of the box you can't get a
lockfile that's mature *all the way down*, and the escape hatches are all exclusion-based.

Related pnpm issues:
[#10257](https://github.com/pnpm/pnpm/issues/10257) (time-based ignored),
[#11068](https://github.com/pnpm/pnpm/issues/11068) (transitive deps error out),
[#11203](https://github.com/pnpm/pnpm/issues/11203) (no intermediate fallback),
[#10488](https://github.com/pnpm/pnpm/issues/10488) (excludes don't cascade).

## How it compares

Cooldown / min-release-age features that work at the **manifest or PR layer** only gate **direct**
dependencies — your package manager still resolves the transitive tree to the freshest versions at
install time:

| Tool | Operates on | Direct | Transitive |
| --- | --- | :---: | :---: |
| [`npm-check-updates --cooldown`](https://github.com/raineorshine/npm-check-updates#cooldown) | rewrites `package.json` | ✅ | ❌ |
| Renovate `minimumReleaseAge` / Dependabot cooldown | opens PRs | ✅ | ❌ |
| pnpm [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) | resolve + verify | ⚠️ `latest`-tag only | ❌ (errors) |
| **`pnpm-exclude-newer`** | **registry resolution** | ✅ | ✅ |

Verified: `ncu --cooldown 3` on a project with a single direct dependency correctly cools that
dependency, yet its lockfile still contained a transitive dependency published 2 days earlier.
`pnpm-exclude-newer` on the same project left zero entries younger than the cutoff. Only
resolution-level filtering reaches transitive dependencies.

## How it works

1. Stands up a throwaway local registry **mirror** that hides every version published on/after the
   cutoff (and repoints `dist-tags.latest` to the newest mature version).
2. Copies your manifests into a clean temp tree (your `node_modules` would otherwise leak
   fresh peer versions) and runs `pnpm install --lockfile-only` against the mirror — so pnpm's
   *normal* resolver produces a transitively age-capped tree.
3. Copies the lockfile back and runs a real `pnpm install`, letting pnpm's own gate verify it.

Real integrity hashes and tarballs come straight from the upstream registry, so the lockfile is
portable and unmodified beyond version selection.

## Options

| flag | meaning |
| --- | --- |
| `--exclude-newer <date>` | hide versions published on/after `<date>` (e.g. `2026-05-30`) |
| `--age <minutes>` | cutoff = now − minutes (default: `minimumReleaseAge` from `pnpm-workspace.yaml`, else `1440`) |
| `--no-install` | stop after writing the lockfile (skip the verifying install) |
| `-h`, `--help` | usage |

If a resolution fails, it means an already-mature package depends on a still-too-fresh version —
wait for it to age, or raise the cutoff for that run.

## Requirements & limitations

- Node ≥ 18 (global `fetch`) and `pnpm` on `PATH`.
- Reads the default registry and its `_authToken` from `npm config` / `.npmrc` (single registry).
  Per-scope custom registries (`@scope:registry=`) aren't mirrored yet — those scopes fall back to
  the default upstream.
- It resolves with whatever `pnpm` is on `PATH`, not necessarily the repo's `packageManager` pin.

## License

MIT
