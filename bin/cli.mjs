#!/usr/bin/env node
// pnpm-exclude-newer — resolve a pnpm lockfile whose ENTIRE tree (direct + transitive)
// excludes versions published after a cutoff. Works around pnpm's `minimumReleaseAge`
// being verify-only and `resolutionMode: time-based` being broken (pnpm #10257/#11068/#11203):
// it stands up a throwaway registry mirror that hides too-new versions, so a normal
// `pnpm install` resolves a transitively age-capped tree.

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import semver from 'semver';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const win = process.platform === 'win32';
const PNPM = win ? 'pnpm.cmd' : 'pnpm';
const NPM = win ? 'npm.cmd' : 'npm';

if (has('-h') || has('--help')) {
  console.log(`pnpm-exclude-newer — resolve a transitively age-capped pnpm lockfile

Usage (run from a pnpm project/workspace root):
  pnpm-exclude-newer [--age <minutes>] [--exclude-newer <date>] [--no-bump] [--no-install]

  --exclude-newer <date>  hide versions published on/after <date> (e.g. 2026-05-30)
  --age <minutes>         cutoff = now - <minutes>  (default: minimumReleaseAge from
                          pnpm-workspace.yaml, else 1440 = 1 day)
  --no-bump               don't touch package.json; only resolve the lockfile within
                          the existing ranges
  --no-install            stop after writing the lockfile (skip the verifying install)
  -h, --help              this message

By default each direct dep range is bumped to the latest *mature* version, keeping its
^/~ operator; a floor too fresh to have a mature match (^1.69.0 when 1.68.0 is newest) is
lowered. --no-bump skips the bump and only resolves the lockfile.

Why: pnpm's minimumReleaseAge only *verifies* (resolves latest-in-range, then rejects),
and resolutionMode:time-based is broken, so neither yields a transitively-mature tree.
This mirrors the registry minus too-new versions, resolves in an isolated copy of your
manifests (your node_modules would otherwise leak fresh peers), writes the lockfile back,
then runs a frozen install so pnpm's own gate verifies it.`);
  process.exit(0);
}

// ---- cutoff ----
const wsPath = join(ROOT, 'pnpm-workspace.yaml');
const ws = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : '';
let cutoff;
if (val('--exclude-newer') !== undefined) {
  cutoff = Date.parse(val('--exclude-newer'));
  if (Number.isNaN(cutoff)) { console.error(`pnpm-exclude-newer: invalid --exclude-newer date: ${val('--exclude-newer')}`); process.exit(1); }
} else {
  const age = Number(val('--age') ?? ws.match(/^\s*minimumReleaseAge:\s*(\d+)/m)?.[1] ?? 1440);
  cutoff = Date.now() - age * 60000;
}

if (!existsSync(join(ROOT, 'package.json')) && !ws) {
  console.error('pnpm-exclude-newer: run from a pnpm project root (no package.json or pnpm-workspace.yaml found).');
  process.exit(1);
}

// ---- upstream registry + auth (respect npm config / .npmrc) ----
let upstream = 'https://registry.npmjs.org';
try {
  const r = execFileSync(PNPM, ['config', 'get', 'registry'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (/^https?:\/\//.test(r)) upstream = r.replace(/\/$/, '');
} catch {
  try {
    const r = execFileSync(NPM, ['config', 'get', 'registry'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^https?:\/\//.test(r)) upstream = r.replace(/\/$/, '');
  } catch {}
}
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
const highest = (versions) => {
  const validVersions = versions.filter(valid);
  const pool = validVersions.filter(stable).length ? validVersions.filter(stable) : validVersions;
  return pool.sort(semver.compare).at(-1);
};

// ---- time-machine registry mirror ----
const cache = new Map();
let registry;
async function filtered(urlPath) {
  if (cache.has(urlPath)) return cache.get(urlPath);
  const res = await fetch(upstream + urlPath, { headers: { accept: 'application/json', ...upstreamAuth } });
  if (!res.ok) return { status: res.status };
  const p = await res.json();
  const time = p.time ?? {};
  const versions = {};
  for (const [v, meta] of Object.entries(p.versions ?? {})) {
    const t = time[v];
    if (valid(v) && t && Date.parse(t) < cutoff) {
      const next = { ...meta, dist: meta.dist ? { ...meta.dist } : meta.dist };
      if (next.dist?.tarball) {
        try { next.dist.tarball = registry + new URL(next.dist.tarball).pathname; } catch {}
      }
      versions[v] = next;
    }
  }
  const ntime = {};
  for (const [k, v2] of Object.entries(time)) if (k === 'created' || k === 'modified' || versions[k]) ntime[k] = v2;
  p.versions = versions;
  p.time = ntime;
  const keys = Object.keys(versions);
  const latest = highest(keys);
  const tags = {};
  if (latest) tags.latest = latest;
  for (const [tag, v] of Object.entries(p['dist-tags'] ?? {})) if (tag !== 'latest' && versions[v]) tags[tag] = v;
  p['dist-tags'] = tags;
  const out = { status: 200, body: JSON.stringify(p) };
  cache.set(urlPath, out);
  return out;
}

// ---- bump direct deps to the latest mature version (preserving the ^/~ operator) ----
// @types/node follows Node majors; even majors are LTS — track the newest LTS line, not current.
const BUMP_CONSTRAINTS = { '@types/node': (v) => Number(v.split('.')[0]) % 2 === 0 };
async function latestMature(name) {
  const r = await filtered('/' + name.replace('/', '%2f')); // scoped: /@scope%2fname
  if (r.status !== 200) return undefined;
  let p; try { p = JSON.parse(r.body); } catch { return undefined; }
  const ok = BUMP_CONSTRAINTS[name];
  if (ok) {
    const keys = Object.keys(p.versions ?? {}).filter(ok);
    const pick = highest(keys);
    if (pick) return pick;
  }
  return p['dist-tags']?.latest;
}
const BUMP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SPEC = /^(\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/; // skip workspace:/catalog:/file:/git/url/alias/* and complex ranges
async function bumpManifests(paths) {
  const bumps = [], snapshots = [];
  for (const file of paths) {
    const text = readFileSync(file, 'utf8');
    let pkg; try { pkg = JSON.parse(text); } catch { continue; }
    let changed = false;
    for (const sec of BUMP_SECTIONS) {
      for (const [name, cur] of Object.entries(pkg[sec] ?? {})) {
        if (typeof cur !== 'string' || !SPEC.test(cur)) continue;
        const latest = await latestMature(name);
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
      const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
      writeFileSync(file, JSON.stringify(pkg, null, indent) + (text.endsWith('\n') ? '\n' : ''));
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

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
registry = `http://127.0.0.1:${port}`;
console.error(`pnpm-exclude-newer: cutoff=${new Date(cutoff).toISOString()} upstream=${upstream} mirror=${registry}`);

const manifestPaths = manifests();
let snapshots = [];
if (!has('--no-bump')) {
  const r = await bumpManifests(manifestPaths);
  snapshots = r.snapshots;
  if (r.bumps.length) console.error(`pnpm-exclude-newer: bumped ${r.bumps.length} direct dep(s) to latest mature:\n  ${r.bumps.join('\n  ')}`);
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

// async spawn — spawnSync would block this process's event loop and starve the in-process mirror
const run = (args, cwd, env = {}) => new Promise((resolve) => {
  const c = spawn(PNPM, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: false });
  c.on('close', (code) => resolve(code ?? 0));
  c.on('error', () => resolve(1));
});
const genCode = await run(['install', '--lockfile-only', '--registry', registry, '--config.lockfile-include-tarball-url=false'], tmp, { NPM_CONFIG_USERCONFIG: tmpNpmrc });
server.close();
const generated = join(tmp, 'pnpm-lock.yaml');
if (genCode !== 0 || !existsSync(generated)) {
  for (const s of snapshots) writeFileSync(s.file, s.text);
  rmSync(tmp, { recursive: true, force: true });
  console.error(`\npnpm-exclude-newer: resolution failed${snapshots.length ? ' — reverted package.json bumps' : ''} (an aged package likely needs a too-fresh dependency; see error above).`);
  process.exit(1);
}

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
writeFileSync(join(ROOT, 'pnpm-lock.yaml'), normalizeLockfile(readFileSync(generated, 'utf8'), [upstream, registry]));
rmSync(tmp, { recursive: true, force: true });
console.error('pnpm-exclude-newer: lockfile written.');

if (!has('--no-install')) {
  console.error('pnpm-exclude-newer: verifying with a frozen install…');
  process.exit(await run(['install', '--frozen-lockfile'], ROOT));
}
