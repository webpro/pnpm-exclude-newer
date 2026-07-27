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

async function runFixture(t, excludes) {
  const registry = http.createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const metadata = {
      name: 'release-it',
      'dist-tags': { latest: '21.0.0' },
      versions: {
        '20.2.1': {
          name: 'release-it',
          version: '20.2.1',
          dist: { tarball: `${origin}/release-it/-/release-it-20.2.1.tgz` },
        },
        '21.0.0': {
          name: 'release-it',
          version: '21.0.0',
          dist: { tarball: `${origin}/release-it/-/release-it-21.0.0.tgz` },
        },
      },
      time: {
        '20.2.1': '2026-07-20T00:00:00.000Z',
        '21.0.0': '2026-07-27T00:00:00.000Z',
      },
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(metadata));
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => registry.close());

  const fixture = await mkdtemp(join(tmpdir(), 'pnpm-exclude-newer-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = join(fixture, 'bin');
  const fakePnpm = join(bin, 'pnpm');
  await mkdir(bin);
  await writeFile(
    fakePnpm,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'config' && args[1] === 'get') {
  if (args[2] === 'registry') console.log(JSON.stringify(process.env.FAKE_REGISTRY));
  else if (args[2] === 'minimumReleaseAgeExclude') console.log(process.env.FAKE_EXCLUDES);
} else if (args[0] === 'list') {
  console.log(JSON.stringify([{ path: process.cwd() }]));
} else if (args[0] === 'install' && args.includes('--lockfile-only')) {
  writeFileSync('pnpm-lock.yaml', 'lockfileVersion: "9.0"\\n');
} else {
  process.exitCode = 1;
}
`,
  );
  await chmod(fakePnpm, 0o755);
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({ devDependencies: { 'release-it': '^21.0.0' } }, null, 2) + '\n',
  );
  await writeFile(
    join(fixture, 'pnpm-workspace.yaml'),
    `minimumReleaseAge: 4320
minimumReleaseAgeExclude:${excludes.length ? `\n${excludes.map((entry) => `  - '${entry}'`).join('\n')}` : ' []'}
`,
  );

  const address = registry.address();
  const result = await run(
    process.execPath,
    [cli, '--exclude-newer', '2026-07-25', '--no-install'],
    {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_REGISTRY: `http://127.0.0.1:${address.port}`,
        FAKE_EXCLUDES: JSON.stringify(excludes),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  return manifest.devDependencies['release-it'];
}

for (const { name, excludes, expected } of [
  {
    name: 'package name bypasses the mirror cutoff',
    excludes: ['release-it'],
    expected: '^21.0.0',
  },
  {
    name: 'package pattern bypasses the mirror cutoff',
    excludes: ['release-*'],
    expected: '^21.0.0',
  },
  {
    name: 'exact package version bypasses the mirror cutoff',
    excludes: ['release-it@21.0.0'],
    expected: '^21.0.0',
  },
  {
    name: 'package without an exclusion remains age-capped',
    excludes: [],
    expected: '^20.2.1',
  },
]) {
  test(`minimumReleaseAgeExclude ${name}`, async (t) => {
    assert.equal(await runFixture(t, excludes), expected);
  });
}
