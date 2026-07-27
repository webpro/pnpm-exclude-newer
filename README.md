# pnpm-exclude-newer

Generate a pnpm lockfile in which every registry dependency, including transitive dependencies, predates a cutoff unless explicitly excluded. It is similar to [uv's `--exclude-newer`][1], but for pnpm.

By default, the command also updates simple direct dependency ranges to the latest allowed version while keeping their `^` or `~` prefix. Use `--no-bump` to leave `package.json` unchanged.

## Usage

```sh
pnpm dlx @webpro/pnpm-exclude-newer
pnpm dlx @webpro/pnpm-exclude-newer --age 4320
pnpm dlx @webpro/pnpm-exclude-newer --exclude-newer 2026-05-30
pnpm dlx @webpro/pnpm-exclude-newer --no-bump
```

Without an explicit cutoff, the command uses the effective pnpm `minimumReleaseAge`, or 1440 minutes if none is configured.

## Why

pnpm's [`minimumReleaseAge`][2] checks the selected version but does not reliably fall back to the newest mature version. This can leave a valid mature version unused or fail on a fresh transitive dependency. `resolutionMode: time-based` also has unresolved interactions with the age policy.

Since pnpm 11.1.3, strict mode [collects immature direct and transitive versions and asks once before excluding them][3]. That fixes the discovery loop, but accepts the fresh versions instead of finding a fully mature dependency tree. The resolver gaps remain open: [time-based resolution is ignored][4], [fresh transitive dependencies block resolution][5], and [mature intermediate versions are skipped][6].

This command filters registry metadata before pnpm resolves the dependency graph. pnpm therefore sees only versions allowed by the cutoff.

## How it works

1. Start a local registry mirror that hides versions published on or after the cutoff. Configured `minimumReleaseAgeExclude` package names, patterns, and exact versions remain visible.
2. Update simple direct ranges unless `--no-bump` is set. An allowed current floor is never lowered just because it is above the upstream `latest` tag. A floor hidden by the cutoff is lowered to the newest allowed version.
3. Resolve the workspace in a clean temporary directory. The copy includes workspace manifests, pnpm hooks, patches, and non-registry `.npmrc` settings.
4. If selected versions require hidden exact dependencies, collect them and ask before adding them to the project `minimumReleaseAgeExclude`. Approving keeps the selected direct versions.
5. If the exclusions are not approved, try older versions of the introducing direct dependencies. Direct ranges are updated automatically when an older version produces a mature graph.
6. Remove mirror tarball URLs from the generated lockfile, copy it back, and run `pnpm install --frozen-lockfile`.

Package integrity hashes still come from the upstream registry. If resolution or final verification fails, the command restores the manifests, project configuration, and previous lockfile.

## Confirming fresh dependencies

Exclusions do not cascade. For example, excluding `release-it` allows its newest version, but not a fresh exact version of `undici` that it requires.

The command collects every hidden exact blocker and prints the evidence:

```text
undici@7.29.0
  path: release-it@21.0.0 → undici@7.29.0
  published: 2026-07-24T12:52:58.701Z; matures in 6h 30m
```

An interactive run asks once before adding the exact versions. Approving keeps the selected direct versions. Rejecting the prompt tries older mature versions of the introducing direct dependencies; this fallback does not require confirmation. If no mature graph resolves, the project is restored.

Non-interactive runs behave like a rejected prompt and try the mature fallback. Pass `--yes` only after reviewing the reported versions and dependency paths. With `--no-bump`, rejecting or not answering the prompt stops without changes.

Exact exclusions are not removed automatically after they mature. Remove entries that are no longer intentional; pnpm is [tracking a cleanup command][7].

## Options

| Flag                     | Meaning                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `--exclude-newer <date>` | Hide versions published on or after the given date.                                |
| `--age <minutes>`        | Set the minimum age in minutes.                                                     |
| `--no-bump`              | Keep `package.json` ranges unchanged.                                               |
| `--no-install`           | Write the lockfile without running the final frozen install.                       |
| `--yes`                  | Approve collected exact-version exclusions without prompting.                      |
| `-h`, `--help`           | Show help.                                                                         |

## Requirements and limitations

- Requires Node.js 18 or newer and pnpm on `PATH`.
- Uses the pnpm version on `PATH`. Prefer the version pinned by the repository because pnpm versions can interpret resolution settings differently.
- Currently supports macOS and Linux. Windows still needs explicit handling for `pnpm.cmd` and its temporary directory.
- Mirrors only the default registry. Scoped and named registries are rejected because they would bypass the mirror.
- Supports a shared workspace lockfile only. `shared-workspace-lockfile=false` is not supported.
- Does not age-filter git, URL, `file:`, `link:`, or `workspace:` dependencies.
- Treats registry versions without a publish time as unavailable.
- Leaves `workspace:`, `catalog:`, `file:`, git, URL, `npm:` aliases, wildcards, and complex direct ranges unchanged.

## License

MIT

[1]: https://docs.astral.sh/uv/reference/settings/#exclude-newer
[2]: https://pnpm.io/settings#minimumreleaseage
[3]: https://github.com/pnpm/pnpm/pull/11705
[4]: https://github.com/pnpm/pnpm/issues/10257
[5]: https://github.com/pnpm/pnpm/issues/11068
[6]: https://github.com/pnpm/pnpm/issues/11203
[7]: https://github.com/pnpm/pnpm/issues/11668
