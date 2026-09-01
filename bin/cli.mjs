#!/usr/bin/env node
// pnpm-exclude-newer — resolve a pnpm lockfile whose entire non-excluded tree (direct +
// transitive) excludes versions published after a cutoff. Works around pnpm's `minimumReleaseAge`
// being verify-only and `resolutionMode: time-based` being broken (pnpm #10257/#11068/#11203):
// it stands up a throwaway registry mirror that hides too-new versions, so a normal
// `pnpm install` resolves a transitively age-capped tree.

import http from 'node:http';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import semver from 'semver';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const win = process.platform === 'win32';
const PNPM = win ? 'pnpm.cmd' : 'pnpm';

if (has('-h') || has('--help')) {
  console.log(`pnpm-exclude-newer — resolve a transitively age-capped pnpm lockfile

Usage (run from a pnpm project/workspace root):
  pnpm-exclude-newer [--age <minutes>] [--exclude-newer <date>] [--no-bump] [--no-install] [--yes]

  --exclude-newer <date>  hide versions published on/after <date> (e.g. 2026-05-30)
  --age <minutes>         cutoff = now - <minutes>  (default: effective pnpm
                          minimumReleaseAge config, else 1440 = 1 day)
  --no-bump               don't touch package.json; only resolve the lockfile within
                          the existing ranges
  --no-install            stop after writing the lockfile (skip the verifying install)
  --yes                   approve collected exact-version exclusions without prompting
  -h, --help              this message

By default each direct dep range is bumped to the latest allowed version, keeping its
^/~ operator; a floor too fresh to have a mature match (^1.69.0 when 1.68.0 is newest) is
lowered. minimumReleaseAgeExclude entries from pnpm config bypass the cutoff, including
package patterns and exact-version selectors. --no-bump skips the bump and only resolves
the lockfile.

Why: pnpm's minimumReleaseAge does not reliably select the newest fully mature graph,
and resolutionMode:time-based has unresolved interactions with the age policy. This
mirrors the registry minus too-new versions, resolves in an isolated copy of your manifests
(your node_modules would otherwise leak fresh peers), writes the lockfile back, then runs
a frozen install so pnpm's own gate verifies it.`);
  process.exit(0);
}

const wsPath = join(ROOT, 'pnpm-workspace.yaml');
const ws = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : '';

if (!existsSync(join(ROOT, 'package.json')) && !ws) {
  console.error('pnpm-exclude-newer: run from a pnpm project root (no package.json or pnpm-workspace.yaml found).');
  process.exit(1);
}

function readPnpmConfig(key, options = []) {
  let output;
  try {
    output = execFileSync(PNPM, ['config', 'get', key, ...options, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(`could not read pnpm config ${key}`);
  }
  if (!output.trim()) return undefined;
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`pnpm config ${key} returned invalid JSON`);
  }
}

let configuredAge;
let minimumReleaseAgeExclude;
let configuredRegistry;
let registries;
let namedRegistries;
try {
  configuredAge = readPnpmConfig('minimumReleaseAge');
  minimumReleaseAgeExclude = readPnpmConfig('minimumReleaseAgeExclude') ?? [];
  configuredRegistry = readPnpmConfig('registry');
  registries = readPnpmConfig('registries');
  namedRegistries = readPnpmConfig('namedRegistries');
} catch (error) {
  console.error(`pnpm-exclude-newer: ${error.message}`);
  process.exit(1);
}
if (!Array.isArray(minimumReleaseAgeExclude) || minimumReleaseAgeExclude.some((entry) => typeof entry !== 'string')) {
  console.error('pnpm-exclude-newer: pnpm config minimumReleaseAgeExclude must be an array of strings');
  process.exit(1);
}
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
if (registries !== undefined && !isRecord(registries)) {
  console.error('pnpm-exclude-newer: pnpm config registries must be an object');
  process.exit(1);
}
if (namedRegistries !== undefined && !isRecord(namedRegistries)) {
  console.error('pnpm-exclude-newer: pnpm config namedRegistries must be an object');
  process.exit(1);
}
// pnpm >=11.23 reports `registries` keyed by registry URL ({ scopes, prefix }) and always ships
// built-ins for jsr, GitHub Packages and npmjs; older config shapes use { default: url, '@scope': url }.
// The '@' scope is the catch-all, i.e. the default registry, which `--registry` redirects to the mirror.
function normalizeRegistries(value) {
  const scopes = new Map();
  const prefixes = new Map();
  let defaultUrl;
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (typeof entry === 'string') {
      if (key === 'default') defaultUrl = entry;
      else scopes.set(key, entry);
      continue;
    }
    if (!isRecord(entry)) continue;
    for (const scope of entry.scopes ?? []) {
      if (scope === '@') defaultUrl ??= key;
      else scopes.set(scope, key);
    }
    if (typeof entry.prefix === 'string') prefixes.set(entry.prefix, key);
  }
  for (const [prefix, url] of Object.entries(namedRegistries ?? {})) {
    if (!prefixes.has(prefix) && typeof url === 'string') prefixes.set(prefix, url);
  }
  return { defaultUrl, scopes, prefixes };
}
const { defaultUrl: defaultRegistry, scopes: scopeRegistries, prefixes: prefixRegistries } = normalizeRegistries(registries);

// ---- cutoff ----
if (has('--age') && has('--exclude-newer')) {
  console.error('pnpm-exclude-newer: use either --age or --exclude-newer, not both');
  process.exit(1);
}
let cutoff;
let ageMinutes;
if (has('--exclude-newer')) {
  cutoff = Date.parse(val('--exclude-newer'));
  if (Number.isNaN(cutoff)) {
    console.error(`pnpm-exclude-newer: invalid --exclude-newer date: ${val('--exclude-newer') ?? '(missing)'}`);
    process.exit(1);
  }
} else {
  const age = Number(has('--age') ? val('--age') : configuredAge ?? 1440);
  if (!Number.isFinite(age) || age < 0) {
    console.error(`pnpm-exclude-newer: invalid --age value: ${has('--age') ? val('--age') ?? '(missing)' : configuredAge}`);
    process.exit(1);
  }
  ageMinutes = age;
  cutoff = Date.now() - age * 60000;
}

function nameMatcher(pattern) {
  const ignore = pattern.startsWith('!');
  const value = ignore ? pattern.slice(1) : pattern;
  let match;
  if (value === '*') {
    match = () => true;
  } else if (!value.includes('*')) {
    match = (name) => name === value;
  } else {
    const source = value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replaceAll('\\*', '.*');
    const regexp = new RegExp(`^${source}$`);
    match = (name) => regexp.test(name);
  }
  return ignore ? (name) => !match(name) : match;
}
function createMinimumReleaseAgeExclude(patterns) {
  const rules = [];
  for (const pattern of patterns) {
    const atIndex = pattern.startsWith('@') ? pattern.indexOf('@', 1) : pattern.indexOf('@');
    const packageName = atIndex === -1 ? pattern : pattern.slice(0, atIndex);
    const exactVersions = atIndex === -1 ? [] : pattern.slice(atIndex + 1).split('||').map((version) => semver.valid(version));
    if (exactVersions.includes(null)) {
      throw new Error(`invalid versions union "${pattern}"; use exact versions only`);
    }
    if (exactVersions.length && packageName.includes('*')) {
      throw new Error(`name patterns are not allowed with version unions: "${pattern}"`);
    }
    rules.push({ match: nameMatcher(packageName), exactVersions });
  }
  return (name, version) => {
    let matchedVersions;
    for (const rule of rules) {
      if (!rule.match(name)) continue;
      if (rule.exactVersions.length === 0) return matchedVersions?.has(version) ?? true;
      matchedVersions ??= new Set();
      for (const exactVersion of rule.exactVersions) matchedVersions.add(exactVersion);
    }
    return matchedVersions?.has(version) ?? false;
  };
}
let isMinimumReleaseAgeExcluded;
try {
  isMinimumReleaseAgeExcluded = createMinimumReleaseAgeExclude(minimumReleaseAgeExclude);
} catch (error) {
  console.error(`pnpm-exclude-newer: invalid minimumReleaseAgeExclude: ${error.message}`);
  process.exit(1);
}

// ---- upstream registry + auth (respect npm config / .npmrc) ----
const registryConfig = defaultRegistry ?? configuredRegistry ?? 'https://registry.npmjs.org';
if (typeof registryConfig !== 'string' || !/^https?:\/\//.test(registryConfig)) {
  console.error(`pnpm-exclude-newer: invalid registry URL: ${registryConfig}`);
  process.exit(1);
}
const upstream = registryConfig.replace(/\/$/, '');
function authHeader(regUrl) {
  const host = new URL(regUrl).host;
  const files = [join(ROOT, '.npmrc'), process.env.NPM_CONFIG_USERCONFIG, join(homedir(), '.npmrc')].filter((f) => f && existsSync(f));
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\/\/([^/]+)\/.*?:_authToken=(.+?)\s*$/);
      if (m && m[1] === host) {
        const tok = m[2].replace(/^["']|["']$/g, '').replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] ?? '').trim();
        if (tok) return { authorization: `Bearer ${tok}` };
      }
    }
  }
  return {};
}
const upstreamAuth = authHeader(upstream);

const valid = (v) => semver.valid(v) !== null;
const stable = (v) => semver.prerelease(v) === null;
const maximum = (versions) => versions.filter(valid).sort(semver.compare).at(-1);
const highest = (versions) => {
  const validVersions = versions.filter(valid);
  const pool = validVersions.filter(stable).length ? validVersions.filter(stable) : validVersions;
  return maximum(pool);
};

// ---- time-machine registry mirror ----
const cache = new Map();
const hiddenVersions = new Map();
const rejectedVersions = new Set();
const temporaryExclusions = new Set();
const mirrorRegistries = [];
let registry;
const exactSelector = (name, version) => `${name}@${version}`;
const packagePath = (name) => '/' + name.replace('/', '%2f');
async function filtered(urlPath) {
  if (cache.has(urlPath)) return cache.get(urlPath);
  const res = await fetch(upstream + urlPath, { headers: { accept: 'application/json', ...upstreamAuth } });
  if (!res.ok) return { status: res.status };
  const p = await res.json();
  const originalTags = p['dist-tags'] ?? {};
  const time = p.time ?? {};
  const versions = {};
  for (const [v, meta] of Object.entries(p.versions ?? {})) {
    const t = time[v];
    const selector = exactSelector(p.name, v);
    const rejected = rejectedVersions.has(selector);
    const excluded = isMinimumReleaseAgeExcluded(p.name, v) || temporaryExclusions.has(selector);
    if (!rejected && valid(v) && ((t && Date.parse(t) < cutoff) || excluded)) {
      const next = { ...meta, dist: meta.dist ? { ...meta.dist } : meta.dist };
      if (next.dist?.tarball) {
        try { next.dist.tarball = registry + new URL(next.dist.tarball).pathname; } catch {}
      }
      versions[v] = next;
    } else if (!rejected && valid(v) && t && Date.parse(t) >= cutoff) {
      hiddenVersions.set(selector, { name: p.name, version: v, publishedAt: t });
    }
  }
  const ntime = {};
  for (const [k, v2] of Object.entries(time)) if (k === 'created' || k === 'modified' || versions[k]) ntime[k] = v2;
  p.versions = versions;
  p.time = ntime;
  const keys = Object.keys(versions);
  const originalLatest = originalTags.latest;
  const bounded = valid(originalLatest) ? keys.filter((version) => semver.lte(version, originalLatest)) : keys;
  const fallback = valid(originalLatest) && stable(originalLatest) ? bounded.filter(stable) : bounded;
  const latest = versions[originalLatest] ? originalLatest : maximum(fallback) ?? maximum(bounded) ?? highest(keys);
  const tags = {};
  if (latest) tags.latest = latest;
  for (const [tag, v] of Object.entries(originalTags)) if (tag !== 'latest' && versions[v]) tags[tag] = v;
  p['dist-tags'] = tags;
  const out = { status: 200, body: JSON.stringify(p) };
  cache.set(urlPath, out);
  return out;
}

// ---- bump direct deps to the latest allowed version (preserving the ^/~ operator) ----
// @types/node follows Node majors; even majors are LTS — track the newest LTS line, not current.
const BUMP_CONSTRAINTS = { '@types/node': (v) => Number(v.split('.')[0]) % 2 === 0 };
async function latestAllowed(name, current) {
  const r = await filtered(packagePath(name)); // scoped: /@scope%2fname
  if (r.status !== 200) return undefined;
  let p; try { p = JSON.parse(r.body); } catch { return undefined; }
  const ok = BUMP_CONSTRAINTS[name];
  const currentAllowed = p.versions?.[current] && (!ok || ok(current));
  const latest = ok ? highest(Object.keys(p.versions ?? {}).filter(ok)) : p['dist-tags']?.latest;
  return currentAllowed && (!latest || semver.gte(current, latest)) ? current : latest;
}
async function previousAllowed(name, current) {
  const r = await filtered(packagePath(name));
  if (r.status !== 200) return undefined;
  let p; try { p = JSON.parse(r.body); } catch { return undefined; }
  const ok = BUMP_CONSTRAINTS[name];
  return highest(Object.keys(p.versions ?? {}).filter((version) => valid(version) && semver.lt(version, current) && (!ok || ok(version))));
}
const BUMP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SPEC = /^(\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/; // skip workspace:/catalog:/file:/git/url/alias/* and complex ranges
const parseManifest = (text) => {
  try { return JSON.parse(text); } catch { return undefined; }
};
const writeManifest = (file, text, manifest) => {
  const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
  writeFileSync(file, JSON.stringify(manifest, null, indent) + (text.endsWith('\n') ? '\n' : ''));
};
async function bumpManifests(paths) {
  const bumps = [], snapshots = [];
  for (const file of paths) {
    const text = readFileSync(file, 'utf8');
    const pkg = parseManifest(text);
    if (!pkg) continue;
    let changed = false;
    for (const sec of BUMP_SECTIONS) {
      for (const [name, cur] of Object.entries(pkg[sec] ?? {})) {
        if (typeof cur !== 'string') continue;
        const match = SPEC.exec(cur);
        if (!match) continue;
        const latest = await latestAllowed(name, match[2]);
        if (!latest) continue;
        const next = cur.replace(SPEC, (_, op) => (op ?? '') + latest);
        if (next === cur) continue;
        pkg[sec][name] = next;
        bumps.push(`${name}  ${cur} → ${next}`);
        changed = true;
      }
    }
    if (changed) {
      snapshots.push({ file, text });
      writeManifest(file, text, pkg);
    }
  }
  return { bumps, snapshots };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.includes('/-/')) { res.writeHead(302, { location: upstream + req.url }); return res.end(); } // tarball/attestation -> real registry
    const r = await filtered(req.url);
    if (r.status !== 200) { res.writeHead(r.status); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.method === 'HEAD' ? undefined : r.body);
  } catch (e) { res.writeHead(502); res.end(String(e?.message ?? e)); }
});
const listenMirror = () => new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    server.off('error', onError);
    registry = `http://127.0.0.1:${server.address().port}`;
    mirrorRegistries.push(registry);
    resolve();
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(0, '127.0.0.1');
});
const restartMirror = async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  cache.clear();
  await listenMirror();
};

// ---- workspace member manifests ----
// Ask pnpm which dirs are real workspace members so we honor the packages globs (and their
// negations) instead of walking every subdir — a naive recursion bumps test fixtures too.
// No workspace file => single package, so the only manifest is the root.
function manifests() {
  if (!ws) return existsSync(join(ROOT, 'package.json')) ? [join(ROOT, 'package.json')] : [];
  let members;
  try {
    members = JSON.parse(execFileSync(PNPM, ['list', '-r', '--depth', '-1', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    console.error('pnpm-exclude-newer: could not enumerate workspace packages (`pnpm list -r --depth -1 --json` failed).');
    process.exit(1);
  }
  return members.map((m) => join(m.path, 'package.json')).filter(existsSync);
}

await listenMirror();
const port = server.address().port;
console.error(`pnpm-exclude-newer: cutoff=${new Date(cutoff).toISOString()} upstream=${upstream} mirror=${registry}`);

const manifestPaths = manifests();
const lockfilePath = join(ROOT, 'pnpm-lock.yaml');
const lockfileSnapshot = existsSync(lockfilePath) ? readFileSync(lockfilePath, 'utf8') : undefined;
const workspaceSnapshot = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : undefined;
let snapshots = [];
const restoreRoot = () => {
  for (const snapshot of snapshots) writeFileSync(snapshot.file, snapshot.text);
  if (lockfileSnapshot === undefined) rmSync(lockfilePath, { force: true });
  else writeFileSync(lockfilePath, lockfileSnapshot);
  if (workspaceSnapshot === undefined) rmSync(wsPath, { force: true });
  else writeFileSync(wsPath, workspaceSnapshot);
};
if (!has('--no-bump')) {
  const r = await bumpManifests(manifestPaths);
  snapshots = r.snapshots;
  if (r.bumps.length) console.error(`pnpm-exclude-newer: bumped ${r.bumps.length} direct dep(s) to latest allowed:\n  ${r.bumps.join('\n  ')}`);
}
const tmp = join(process.env.TMPDIR ?? '/tmp', `pnpm-exclude-newer-${port}`);
rmSync(tmp, { recursive: true, force: true });
for (const f of manifestPaths) {
  const dest = join(tmp, relative(ROOT, f));
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(f, dest);
}
// also copy resolution-affecting files the manifest walk skips: pnpmfile hooks + patch files
for (const f of ['.pnpmfile.cjs', 'pnpmfile.cjs']) {
  if (existsSync(join(ROOT, f))) copyFileSync(join(ROOT, f), join(tmp, f));
}
if (existsSync(join(ROOT, 'patches'))) cpSync(join(ROOT, 'patches'), join(tmp, 'patches'), { recursive: true });
for (const m of ws.matchAll(/([^\s'"]+\.patch)\b/g)) {
  if (existsSync(join(ROOT, m[1])) && !existsSync(join(tmp, m[1]))) {
    mkdirSync(join(tmp, m[1], '..'), { recursive: true });
    copyFileSync(join(ROOT, m[1]), join(tmp, m[1]));
  }
}
function sanitizeNpmrc(text) {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return true;
    const [rawKey, ...rawValue] = trimmed.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join('=').trim().toLowerCase();
    const authKeys = ['_auth', '_authtoken', '_password', 'username', 'email'];
    if (key === 'registry' || key.endsWith(':registry')) return false;
    if (authKeys.includes(key) || authKeys.some((authKey) => key.endsWith(`:${authKey}`))) return false;
    if (key === 'minimum-release-age' || key === 'minimumreleaseage') return false;
    if (key === 'minimum-release-age-strict' || key === 'minimumreleaseagestrict') return false;
    if ((key === 'resolution-mode' || key === 'resolutionmode') && value === 'time-based') return false;
    return true;
  }).join('\n').replace(/\n*$/, '\n');
}
const tmpNpmrc = join(tmp, '.npmrc');
if (existsSync(join(ROOT, '.npmrc'))) {
  const npmrc = sanitizeNpmrc(readFileSync(join(ROOT, '.npmrc'), 'utf8'));
  writeFileSync(tmpNpmrc, npmrc.trim() ? npmrc : '');
} else {
  writeFileSync(tmpNpmrc, '');
}
// neutralize only the policy keys that would block/bias generation (the mirror already enforces age);
// keep other resolutionMode values and don't touch list-valued keys like minimumReleaseAgeExclude
if (ws) writeFileSync(join(tmp, 'pnpm-workspace.yaml'), ws
  .replace(/^\s*minimumReleaseAge:\s.*$/gm, '')
  .replace(/^\s*minimumReleaseAgeStrict:\s.*$/gm, '')
  .replace(/^\s*resolutionMode:\s*time-based\b.*$/gm, ''));

const hasDirectVersion = (name, version) => {
  for (const file of manifestPaths) {
    const manifest = parseManifest(readFileSync(file, 'utf8'));
    if (!manifest) continue;
    for (const section of BUMP_SECTIONS) {
      const specifier = manifest[section]?.[name];
      if (typeof specifier === 'string' && SPEC.test(specifier) && semver.satisfies(version, specifier, { includePrerelease: true })) {
        return true;
      }
    }
  }
  return false;
};
const findIntroducingDirect = (parents) => {
  for (const parent of [...parents].reverse()) {
    if (hasDirectVersion(parent.name, parent.version)) return parent;
  }
};
const updateDirectVersion = (name, currentVersion, nextVersion) => {
  const changes = [];
  for (const file of manifestPaths) {
    const text = readFileSync(file, 'utf8');
    const manifest = parseManifest(text);
    if (!manifest) continue;
    let changed = false;
    for (const section of BUMP_SECTIONS) {
      const current = manifest[section]?.[name];
      if (typeof current !== 'string') continue;
      const match = SPEC.exec(current);
      if (!match || !semver.satisfies(currentVersion, current, { includePrerelease: true })) continue;
      const next = (match[1] ?? '') + nextVersion;
      if (next === current) continue;
      manifest[section][name] = next;
      changes.push(`${name}  ${current} → ${next}`);
      changed = true;
    }
    if (!changed) continue;
    if (!snapshots.some((snapshot) => snapshot.file === file)) snapshots.push({ file, text });
    writeManifest(file, text, manifest);
    copyFileSync(file, join(tmp, relative(ROOT, file)));
  }
  return [...new Set(changes)];
};
const run = (args, cwd, env = {}) => new Promise((resolve) => {
  const c = spawn(PNPM, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: false });
  c.on('close', (code) => resolve(code ?? 1));
  c.on('error', () => resolve(1));
});
const generated = join(tmp, 'pnpm-lock.yaml');
const resolutionLog = join(tmp, 'pnpm-resolution.ndjson');
const readResolutionError = () => {
  if (!existsSync(resolutionLog)) return undefined;
  const parseError = (line) => {
    if (!line.length) return undefined;
    try {
      const log = JSON.parse(line.toString('utf8'));
      if (log.level === 'error') {
        return {
          code: log.code ?? log.err?.code,
          message: log.err?.message,
          package: log.package,
          pkgsStack: log.pkgsStack,
        };
      }
    } catch {}
  };
  const fd = openSync(resolutionLog, 'r');
  try {
    let position = statSync(resolutionLog).size;
    let remainder = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      readSync(fd, chunk, 0, length, position);
      const combined = Buffer.concat([chunk, remainder]);
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 10) continue;
        const error = parseError(combined.subarray(index + 1, lineEnd));
        if (error) return error;
        lineEnd = index;
      }
      remainder = combined.subarray(0, lineEnd);
    }
    return parseError(remainder);
  } finally {
    closeSync(fd);
  }
};
const runResolution = () => new Promise((resolve) => {
  rmSync(resolutionLog, { force: true });
  const logFd = openSync(resolutionLog, 'w');
  const child = spawn(PNPM, [
    '--reporter=ndjson',
    'install',
    '--lockfile-only',
    '--registry',
    registry,
    '--config.lockfile-include-tarball-url=false',
  ], {
    cwd: tmp,
    env: { ...process.env, NPM_CONFIG_USERCONFIG: tmpNpmrc },
    stdio: ['ignore', logFd, 'pipe'],
    shell: false,
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    closeSync(logFd);
    resolve({ code: code ?? 1, error: code === 0 ? undefined : readResolutionError() });
  };
  child.on('close', finish);
  child.on('error', () => finish(1));
});
const runCleanResolution = async () => {
  rmSync(generated, { force: true });
  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true });
  return runResolution();
};
const getImmatureExactBlocker = (resolution) => {
  const requested = resolution.error?.package;
  const version = valid(requested?.bareSpecifier) ? semver.valid(requested.bareSpecifier) : undefined;
  const selector = version && typeof requested?.name === 'string' ? exactSelector(requested.name, version) : undefined;
  const hidden = selector ? hiddenVersions.get(selector) : undefined;
  if (!hidden || resolution.error?.code !== 'ERR_PNPM_NO_MATCHING_VERSION') return undefined;
  const parents = Array.isArray(resolution.error?.pkgsStack)
    ? resolution.error.pkgsStack.filter((parent) => typeof parent?.name === 'string' && typeof parent?.version === 'string')
    : [];
  return { ...hidden, selector, parents, introducingDirect: findIntroducingDirect(parents) };
};
const resolutionSucceeded = (resolution) => resolution.code === 0 && existsSync(generated);
const failResolution = (resolution) => {
  server.close();
  restoreRoot();
  rmSync(tmp, { recursive: true, force: true });
  const detail = resolution.error?.message ? `: ${resolution.error.message}` : '';
  console.error(`\npnpm-exclude-newer: resolution failed${detail}${snapshots.length ? ' — reverted package.json bumps' : ''}.`);
  process.exit(1);
};
const resolveWithMatureDirectFallbacks = async () => {
  while (true) {
    const resolution = await runCleanResolution();
    if (resolutionSucceeded(resolution)) return resolution;
    const blocker = getImmatureExactBlocker(resolution);
    const introducingDirect = blocker?.introducingDirect;
    if (!introducingDirect) return resolution;
    const previous = await previousAllowed(introducingDirect.name, introducingDirect.version);
    if (!previous) return resolution;
    const changes = updateDirectVersion(introducingDirect.name, introducingDirect.version, previous);
    if (!changes.length) return resolution;
    const rejectedSelector = exactSelector(introducingDirect.name, introducingDirect.version);
    rejectedVersions.add(rejectedSelector);
    hiddenVersions.delete(rejectedSelector);
    cache.delete(packagePath(introducingDirect.name));
    console.error(`pnpm-exclude-newer: downgraded ${changes.join(', ')}; ${rejectedSelector} introduces immature ${blocker.selector}.`);
  }
};

const blockers = [];
const blockerSelectors = new Set();
let resolution;
while (true) {
  resolution = await runCleanResolution();
  if (resolutionSucceeded(resolution)) break;
  const blocker = getImmatureExactBlocker(resolution);
  if (!blocker || blockerSelectors.has(blocker.selector)) break;
  blockers.push(blocker);
  blockerSelectors.add(blocker.selector);
  temporaryExclusions.add(blocker.selector);
  cache.delete(packagePath(blocker.name));
}
if (!resolutionSucceeded(resolution)) failResolution(resolution);

const formatDuration = (milliseconds) => {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, remainder && `${remainder}m`].filter(Boolean).join(' ') || 'less than a minute';
};
const currentCutoff = () => ageMinutes === undefined ? cutoff : Date.now() - ageMinutes * 60000;
const pendingBlockers = blockers.filter((blocker) => Date.parse(blocker.publishedAt) >= currentCutoff());
if (pendingBlockers.length) {
  console.error(`pnpm-exclude-newer: resolution requires ${pendingBlockers.length} immature exact-version exclusion(s):`);
  for (const blocker of pendingBlockers) {
    const path = [...blocker.parents].reverse().map((parent) => exactSelector(parent.name, parent.version));
    path.push(blocker.selector);
    const remaining = ageMinutes === undefined ? '' : `; matures in ${formatDuration(Date.parse(blocker.publishedAt) - currentCutoff())}`;
    console.error(`  ${blocker.selector}\n    path: ${path.join(' → ')}\n    published: ${blocker.publishedAt}${remaining}`);
  }
}
if (pendingBlockers.length) {
  let confirmed = has('--yes');
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (!confirmed && interactive) {
    console.error(has('--no-bump')
      ? 'Choosing No will stop without changes because --no-bump disables direct fallbacks.'
      : 'Choosing No will try older mature versions of the introducing direct dependencies.');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await prompt.question('Add these exact exclusions to minimumReleaseAgeExclude and keep the current direct versions? [y/N] ');
      confirmed = /^(?:y|yes)$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  }
  if (!confirmed && has('--no-bump')) {
    server.close();
    restoreRoot();
    rmSync(tmp, { recursive: true, force: true });
    const reason = interactive
      ? 'exact-version exclusions were not approved'
      : 'non-interactive run cannot approve exact-version exclusions and --no-bump disables direct fallbacks';
    console.error(`pnpm-exclude-newer: ${reason}.`);
    process.exit(1);
  }
  if (confirmed) {
    try {
      const projectExclusions = readPnpmConfig('minimumReleaseAgeExclude', ['--location=project']) ?? [];
      if (!Array.isArray(projectExclusions) || projectExclusions.some((entry) => typeof entry !== 'string')) {
        throw new Error('project minimumReleaseAgeExclude must be an array of strings');
      }
      const additions = pendingBlockers.map((blocker) => blocker.selector);
      const nextExclusions = [...new Set([...projectExclusions, ...additions])];
      execFileSync(PNPM, [
        'config',
        'set',
        '--location=project',
        '--json',
        'minimumReleaseAgeExclude',
        JSON.stringify(nextExclusions),
      ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      console.error(`pnpm-exclude-newer: added exact exclusion(s): ${additions.join(', ')}`);
    } catch (error) {
      server.close();
      restoreRoot();
      rmSync(tmp, { recursive: true, force: true });
      console.error(`pnpm-exclude-newer: could not update minimumReleaseAgeExclude: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.error('pnpm-exclude-newer: exact-version exclusions were not approved; trying mature direct dependency fallbacks.');
    for (const blocker of pendingBlockers) {
      temporaryExclusions.delete(blocker.selector);
    }
    try {
      await restartMirror();
    } catch (error) {
      restoreRoot();
      rmSync(tmp, { recursive: true, force: true });
      console.error(`pnpm-exclude-newer: could not restart the registry mirror: ${error.message}`);
      process.exit(1);
    }
    resolution = await resolveWithMatureDirectFallbacks();
    if (!resolutionSucceeded(resolution)) failResolution(resolution);
  }
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const failRegistryGate = (message) => {
  server.close();
  restoreRoot();
  rmSync(tmp, { recursive: true, force: true });
  console.error(`pnpm-exclude-newer: ${message}`);
  process.exit(1);
};
const resolvedPackageKeys = (() => {
  try {
    const keys = [];
    let inPackages = false;
    for (const line of readFileSync(generated, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (!line.startsWith(' ')) {
        inPackages = line === 'packages:';
        continue;
      }
      if (!inPackages || !line.startsWith('  ') || line.startsWith('   ') || !line.endsWith(':')) continue;
      let key = line.slice(2, -1);
      if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) key = key.slice(1, -1);
      keys.push(key);
    }
    return keys;
  } catch (error) {
    failRegistryGate(`could not inspect the generated lockfile: ${error.message}`);
  }
})();
const blockedScopes = [...scopeRegistries.keys()].filter((scope) =>
  resolvedPackageKeys.some((key) => key.startsWith(`${scope}/`) || key.startsWith(`/${scope}/`)));
if (blockedScopes.length) {
  failRegistryGate(`scoped registries are not supported because they bypass the mirror: ${blockedScopes.join(', ')}`);
}
const blockedPrefixes = [...prefixRegistries.keys()].filter((prefix) => {
  const marker = new RegExp(`@${escapeRegExp(prefix)}:`);
  return resolvedPackageKeys.some((key) => marker.test(key));
});
if (blockedPrefixes.length) {
  failRegistryGate(`prefixed registries are not supported because they bypass the mirror: ${blockedPrefixes.join(', ')}`);
}
server.close();

function isRegistryTarball(value, registryOrigins) {
  try { return registryOrigins.has(new URL(value).origin); } catch { return false; }
}
function normalizeLockfile(text, registryUrls) {
  const registryOrigins = new Set(registryUrls.map((url) => new URL(url).origin));
  return text.replace(/\bresolution:\s*\{([^}\n]*)\}/g, (match, body) => {
    const fields = body.split(/,\s*/);
    const kept = fields.filter((field) => {
      const [key, ...value] = field.split(':');
      if (key.trim() !== 'tarball') return true;
      const tarball = value.join(':').trim().replace(/^['"]|['"]$/g, '');
      return !isRegistryTarball(tarball, registryOrigins);
    });
    return `resolution: {${kept.join(', ')}}`;
  });
}
try {
  writeFileSync(lockfilePath, normalizeLockfile(readFileSync(generated, 'utf8'), [upstream, ...mirrorRegistries]));
} catch (error) {
  restoreRoot();
  rmSync(tmp, { recursive: true, force: true });
  console.error(`pnpm-exclude-newer: could not write lockfile: ${error.message}`);
  process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
console.error('pnpm-exclude-newer: lockfile written.');

if (!has('--no-install')) {
  console.error('pnpm-exclude-newer: verifying with a frozen install…');
  const verificationCode = await run(['install', '--frozen-lockfile'], ROOT);
  if (verificationCode !== 0) {
    restoreRoot();
    console.error('pnpm-exclude-newer: verification failed — reverted package.json bumps and lockfile.');
  }
  process.exit(verificationCode);
}
