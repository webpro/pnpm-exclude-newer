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
  const registry = http.createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const packageVersions = {};
    const time = {};
    for (const { version, publishedAt } of versions) {
      packageVersions[version] = {
        name: packageName,
        version,
        dist: { tarball: `${origin}/${packageName}/-/${packageName}-${version}.tgz` },
      };
      time[version] = publishedAt;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      name: packageName,
      'dist-tags': {
        latest: options.latest ?? versions.at(-1).version,
        ...options.tags,
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
} else if (args[0] === 'list') {
  console.log(JSON.stringify([{ path: process.cwd() }]));
} else if (args[0] === 'install' && args.includes('--lockfile-only')) {
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
      FAKE_FINAL_CODE: String(options.finalCode ?? 0),
      FAKE_GENERATED_LOCKFILE: 'lockfileVersion: "9.0"\ngenerated: true\n',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  return {
    ...result,
    dependency: manifest.dependencies[packageName],
    lockfile: await readFile(join(fixture, 'pnpm-lock.yaml'), 'utf8'),
    originalLockfile,
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
