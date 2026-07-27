import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

const run = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });

async function runFixture(t, options = {}) {
  const packageName = options.packageName ?? 'example-package';
  const versions = options.versions ?? [
    { version: '1.0.0', publishedAt: '2020-01-01T00:00:00.000Z' },
    { version: '2.0.0', publishedAt: '2020-01-02T00:00:00.000Z' },
  ];
  const blockers = options.blockers ?? [];
  const registry = http.createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const requestName = decodeURIComponent(request.url.slice(1));
    const blocker = blockers.find(({ name }) => name === requestName);
    const registryPackage = blocker ? {
      name: blocker.name,
      versions: blocker.available === false ? [] : [{
        version: blocker.version,
        publishedAt: blocker.publishedAt,
      }],
      latest: blocker.version,
    } : requestName === packageName ? {
      name: packageName,
      versions,
      latest: options.latest ?? versions.at(-1).version,
      tags: options.tags,
    } : undefined;
    if (!registryPackage) {
      response.writeHead(404);
      response.end();
      return;
    }
    const packageVersions = {};
    const time = {};
    for (const { version, publishedAt } of registryPackage.versions) {
      packageVersions[version] = {
        name: registryPackage.name,
        version,
        dist: { tarball: `${origin}/${registryPackage.name}/-/${registryPackage.name}-${version}.tgz` },
      };
      time[version] = publishedAt;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      name: registryPackage.name,
      'dist-tags': {
        latest: registryPackage.latest,
        ...registryPackage.tags,
      },
      versions: packageVersions,
      time,
    }));
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => registry.close());

  const fixture = await mkdtemp(join(tmpdir(), 'pnpm-exclude-newer-correctness-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = join(fixture, 'bin');
  const fakePnpm = join(bin, 'pnpm');
  await mkdir(bin);
  await writeFile(
    fakePnpm,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = JSON.parse(process.env.FAKE_CONFIG);
if (args[0] === 'config' && args[1] === 'get') {
  const value = config[args[2]];
  if (value === '__FAIL__') {
    process.exitCode = 1;
  } else if (value !== undefined) {
    process.stdout.write(args[2] === 'registry' && !args.includes('--json') ? value : JSON.stringify(value));
  }
} else if (args[0] === 'config' && args[1] === 'set') {
  const exclusions = JSON.parse(args.at(-1));
  writeFileSync('pnpm-workspace.yaml', 'packages: []\\nminimumReleaseAgeExclude:\\n' + exclusions.map((entry) => '  - ' + entry).join('\\n') + '\\n');
} else if (args[0] === 'list') {
  console.log(JSON.stringify([{ path: process.cwd() }]));
} else if (args[0] === '--reporter=ndjson' && args[1] === 'install' && args.includes('--lockfile-only')) {
  if (process.env.FAKE_SILENT_RESOLUTION_FAILURE === '1') process.exit(1);
  const registry = args[args.indexOf('--registry') + 1];
  for (const blocker of JSON.parse(process.env.FAKE_BLOCKERS)) {
    const metadata = await fetch(registry + '/' + blocker.name);
    const packument = await metadata.json();
    if (!packument.versions[blocker.version]) {
      const message = 'No matching version found for ' + blocker.name + '@' + blocker.version + ' while fetching it from ' + registry;
      console.log(JSON.stringify({
        level: 'error',
        name: 'pnpm',
        code: 'ERR_PNPM_NO_MATCHING_VERSION',
        package: { name: blocker.name, bareSpecifier: blocker.version, version: blocker.version },
        pkgsStack: blocker.parents,
        err: { name: 'pnpm', code: 'ERR_PNPM_NO_MATCHING_VERSION', message },
      }));
      process.exit(1);
    }
  }
  writeFileSync('pnpm-lock.yaml', process.env.FAKE_GENERATED_LOCKFILE);
} else if (args[0] === 'install' && args.includes('--frozen-lockfile')) {
  process.exitCode = Number(process.env.FAKE_FINAL_CODE);
} else {
  process.exitCode = 1;
}
`,
  );
  await chmod(fakePnpm, 0o755);
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ dependencies: { [packageName]: options.initialSpec ?? '^1.0.0' } }, null, 2) + '\n',
  );
  await writeFile(join(fixture, 'pnpm-workspace.yaml'), options.workspace ?? 'packages: []\n');
  const originalLockfile = 'lockfileVersion: "9.0"\noriginal: true\n';
  await writeFile(join(fixture, 'pnpm-lock.yaml'), originalLockfile);

  const address = registry.address();
  const config = {
    registry: `http://127.0.0.1:${address.port}`,
    minimumReleaseAgeExclude: [],
    ...options.config,
  };
  const args = [...(options.args ?? ['--exclude-newer', '2026-07-25'])];
  if (options.verify !== true) args.push('--no-install');
  const result = await run(process.execPath, [cli, ...args], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CONFIG: JSON.stringify(config),
      FAKE_BLOCKERS: JSON.stringify(blockers.map((blocker) => ({
        ...blocker,
        parents: blocker.parents ?? [{ name: packageName, version: options.latest ?? versions.at(-1).version }],
      }))),
      FAKE_FINAL_CODE: String(options.finalCode ?? 0),
      FAKE_GENERATED_LOCKFILE: 'lockfileVersion: "9.0"\ngenerated: true\n',
      FAKE_SILENT_RESOLUTION_FAILURE: options.silentResolutionFailure ? '1' : '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  return {
    ...result,
    dependency: manifest.dependencies[packageName],
    lockfile: await readFile(join(fixture, 'pnpm-lock.yaml'), 'utf8'),
    originalLockfile,
    workspace: await readFile(join(fixture, 'pnpm-workspace.yaml'), 'utf8'),
  };
}

test('fails closed when minimumReleaseAgeExclude cannot be read', async (t) => {
  const result = await runFixture(t, {
    config: { minimumReleaseAgeExclude: '__FAIL__' },
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not read pnpm config minimumReleaseAgeExclude/);
  assert.equal(result.dependency, '^1.0.0');
});

test('uses the effective minimumReleaseAge from pnpm config', async (t) => {
  const result = await runFixture(t, {
    initialSpec: '^2.0.0',
    args: [],
    config: { minimumReleaseAge: 4320 },
    versions: [
      { version: '1.0.0', publishedAt: '2020-01-01T00:00:00.000Z' },
      { version: '2.0.0', publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.dependency, '^1.0.0');
});

test('does not promote a higher version from a non-latest dist-tag', async (t) => {
  const result = await runFixture(t, {
    latest: '1.0.0',
    tags: { next: '2.0.0' },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.dependency, '^1.0.0');
});

test('does not lower a mature direct floor above the latest dist-tag', async (t) => {
  const result = await runFixture(t, {
    initialSpec: '^2.0.0',
    latest: '1.0.0',
    tags: { next: '2.0.0' },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.dependency, '^2.0.0');
});

test('combines separate exact-version exclusions for one package', async (t) => {
  const result = await runFixture(t, {
    initialSpec: '^2.0.0',
    config: {
      minimumReleaseAgeExclude: ['example-package@1.0.0', 'example-package@2.0.0'],
    },
    versions: [
      { version: '1.0.0', publishedAt: '2026-07-20T00:00:00.000Z' },
      { version: '2.0.0', publishedAt: '2026-07-27T00:00:00.000Z' },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.dependency, '^2.0.0');
});

test('rejects scoped registries that would bypass the mirror', async (t) => {
  const result = await runFixture(t, {
    config: { registries: { '@private': 'https://registry.example.com/' } },
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /scoped registries are not supported/);
  assert.equal(result.dependency, '^1.0.0');
});

test('restores manifests and lockfile when final verification fails', async (t) => {
  const result = await runFixture(t, {
    verify: true,
    finalCode: 42,
  });

  assert.equal(result.code, 42);
  assert.equal(result.dependency, '^1.0.0');
  assert.equal(result.lockfile, result.originalLockfile);
});

test('restores manifests when resolution fails without structured error output', async (t) => {
  const result = await runFixture(t, {
    silentResolutionFailure: true,
  });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /TypeError/);
  assert.match(result.stderr, /resolution failed/);
  assert.equal(result.dependency, '^1.0.0');
  assert.equal(result.lockfile, result.originalLockfile);
});

test('collects immature exact blockers and fails closed without confirmation', async (t) => {
  const result = await runFixture(t, {
    initialSpec: '^2.0.0',
    blockers: [{
      name: 'fresh-transitive',
      version: '3.0.0',
      publishedAt: '2026-07-27T00:00:00.000Z',
    }],
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /fresh-transitive@3\.0\.0/);
  assert.match(result.stderr, /example-package@2\.0\.0 → fresh-transitive@3\.0\.0/);
  assert.match(result.stderr, /non-interactive/);
  assert.doesNotMatch(result.workspace, /fresh-transitive/);
  assert.equal(result.dependency, '^2.0.0');
  assert.equal(result.lockfile, result.originalLockfile);
});

test('persists all confirmed exact blockers and completes resolution', async (t) => {
  const result = await runFixture(t, {
    initialSpec: '^2.0.0',
    args: ['--exclude-newer', '2026-07-25', '--yes'],
    config: { minimumReleaseAgeExclude: ['already-excluded'] },
    blockers: [
      {
        name: 'first-transitive',
        version: '3.0.0',
        publishedAt: '2026-07-26T00:00:00.000Z',
      },
      {
        name: 'second-transitive',
        version: '4.0.0',
        publishedAt: '2026-07-27T00:00:00.000Z',
        parents: [
          { name: 'nested-parent', version: '5.0.0' },
          { name: 'example-package', version: '2.0.0' },
        ],
      },
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.workspace, /already-excluded/);
  assert.match(result.workspace, /first-transitive@3\.0\.0/);
  assert.match(result.workspace, /second-transitive@4\.0\.0/);
  assert.match(result.stderr, /example-package@2\.0\.0 → nested-parent@5\.0\.0 → second-transitive@4\.0\.0/);
  assert.equal(result.lockfile, 'lockfileVersion: "9.0"\ngenerated: true\n');
});

test('does not offer a missing version that was not hidden by the age policy', async (t) => {
  const result = await runFixture(t, {
    blockers: [{
      name: 'missing-transitive',
      version: '9.0.0',
      publishedAt: '2026-07-27T00:00:00.000Z',
      available: false,
    }],
  });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /Add exact exclusions/);
  assert.doesNotMatch(result.workspace, /missing-transitive/);
});

test('restores approved exclusions when final verification fails', async (t) => {
  const result = await runFixture(t, {
    args: ['--exclude-newer', '2026-07-25', '--yes'],
    blockers: [{
      name: 'fresh-transitive',
      version: '3.0.0',
      publishedAt: '2026-07-27T00:00:00.000Z',
    }],
    verify: true,
    finalCode: 42,
  });

  assert.equal(result.code, 42);
  assert.doesNotMatch(result.workspace, /fresh-transitive/);
  assert.equal(result.lockfile, result.originalLockfile);
});
