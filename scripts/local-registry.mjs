#!/usr/bin/env node
// A registry for one release: serves packuments and tarballs for every
// dist-release/*.tgz and proxies everything else to registry.npmjs.org, so an
// `npm install` through it exercises the real optional-dependency and
// os/cpu path against packages that are not published yet.
//
//   node scripts/local-registry.mjs [--release-dir <dir>] [--port <n>]
//   → prints the base URL; pass it as --@orcaops:registry=<url> to npm.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UPSTREAM = 'https://registry.npmjs.org';

function readManifestFromTarball(tarball) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  );
}

/** Index every tarball in the release dir by package name. */
export function indexRelease(releaseDir) {
  const packages = new Map();
  for (const file of readdirSync(releaseDir)) {
    if (!file.endsWith('.tgz')) continue;
    const tarball = path.join(releaseDir, file);
    const manifest = readManifestFromTarball(tarball);
    const bytes = readFileSync(tarball);
    const entry = packages.get(manifest.name) ?? { versions: new Map() };
    entry.versions.set(manifest.version, {
      manifest,
      file,
      tarball,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      size: statSync(tarball).size,
    });
    packages.set(manifest.name, entry);
  }
  return packages;
}

function packument(baseUrl, name, entry) {
  const versions = {};
  let latest = null;
  for (const [version, v] of entry.versions) {
    versions[version] = {
      ...v.manifest,
      dist: {
        tarball: `${baseUrl}/${name}/-/${v.file}`,
        shasum: v.shasum,
        integrity: v.integrity,
        unpackedSize: v.size,
      },
    };
    latest = version;
  }
  return { name, 'dist-tags': { latest }, versions };
}

async function proxy(req, res) {
  const url = `${UPSTREAM}${req.url}`;
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) {
    // Never relay a client's credentials or session to the upstream.
    if (
      key === 'host' ||
      key === 'connection' ||
      key === 'authorization' ||
      key === 'cookie' ||
      key.startsWith('npm-')
    ) {
      delete headers[key];
    }
  }
  const upstream = await fetch(url, { method: req.method, headers });
  const out = {};
  for (const [key, value] of upstream.headers) {
    if (['content-encoding', 'transfer-encoding', 'content-length'].includes(key)) continue;
    out[key] = value;
  }
  // Buffer before the headers go out: a body that fails midway must still be
  // reportable as a 502, and headers cannot be rewritten once sent.
  const buffer = upstream.body === null ? null : Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, out);
  res.end(buffer ?? undefined);
}

/** Start the registry; resolves to `{ url, close }`. Port 0 picks a free one. */
export function startLocalRegistry({ releaseDir, port = 0 } = {}) {
  const packages = indexRelease(releaseDir);
  const server = createServer(async (req, res) => {
    try {
      // Reads only. Nothing legitimate writes through this registry, and a
      // stray `npm publish` pointed at it must never reach the upstream.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      // /<name>/-/<file>.tgz  or  /<name>  (scoped names carry a slash)
      const tarballMatch = pathname.match(/^\/(.+?)\/-\/([^/]+\.tgz)$/);
      if (tarballMatch !== null) {
        const [, name, file] = tarballMatch;
        const entry = packages.get(name);
        const version = entry && [...entry.versions.values()].find((v) => v.file === file);
        if (version !== undefined) {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': version.size,
          });
          createReadStream(version.tarball).pipe(res);
          return;
        }
      }
      const name = pathname.slice(1);
      const entry = packages.get(name);
      if (entry !== undefined && req.method === 'GET') {
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(packument(baseUrl, name, entry)));
        return;
      }
      await proxy(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`local-registry: ${error?.message ?? error}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        packages: [...packages.keys()],
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--release-dir');
  const portIdx = args.indexOf('--port');
  const releaseDir = path.resolve(
    dirIdx === -1
      ? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-release')
      : args[dirIdx + 1]
  );
  const { url, packages } = await startLocalRegistry({
    releaseDir,
    port: portIdx === -1 ? 0 : Number(args[portIdx + 1]),
  });
  process.stdout.write(`${url}\n`);
  process.stderr.write(
    `serving ${packages.length} package(s) from ${releaseDir}; proxying the rest to ${UPSTREAM}\n`
  );
}
