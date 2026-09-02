import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';

const EXTERNAL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

async function htmlFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(path);
  }
  return files;
}

function sitePath(pathname, sourceRelative, base) {
  if (pathname === '') return sourceRelative;

  const baseRoot = base.endsWith('/') ? base.slice(0, -1) : base;
  let route = pathname;
  if (route === baseRoot || route === `${baseRoot}/`) route = '/';
  else if (route.startsWith(`${baseRoot}/`)) route = route.slice(baseRoot.length);
  else if (route.startsWith('/')) return null;

  let target = route.startsWith('/')
    ? posix.normalize(route.slice(1))
    : posix.normalize(posix.join(posix.dirname(sourceRelative), route));

  if (target === '' || target.endsWith('/')) target = posix.join(target, 'index.html');
  else if (extname(target) === '') target = `${target}.html`;
  return target;
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export async function validateBuiltLinks(siteConfig) {
  const outDir = resolve(siteConfig.outDir);
  const base = siteConfig.site.base || '/';
  const files = await htmlFiles(outDir);
  const documents = new Map();

  for (const file of files) {
    const html = await readFile(file, 'utf8');
    const ids = new Set([...html.matchAll(/\sid=(['"])(.*?)\1/g)].map((match) => match[2]));
    documents.set(resolve(file), { html, ids });
  }

  const failures = [];
  for (const [file, document] of documents) {
    const sourceRelative = relative(outDir, file).split(sep).join('/');
    for (const match of document.html.matchAll(/\shref=(['"])(.*?)\1/g)) {
      const href = match[2];
      if (EXTERNAL_SCHEME.test(href) || href.startsWith('//')) continue;

      const hashAt = href.indexOf('#');
      if (hashAt < 0 || hashAt === href.length - 1) continue;

      const pathname = href.slice(0, hashAt).split('?', 1)[0];
      const targetRelative = sitePath(pathname, sourceRelative, base);
      if (targetRelative === null || targetRelative.startsWith('../')) continue;

      const targetFile = resolve(outDir, targetRelative);
      const target = documents.get(targetFile);
      const fragment = decodeFragment(href.slice(hashAt + 1));
      if (!target) failures.push(`${sourceRelative}: ${href} targets a page that was not built`);
      else if (!target.ids.has(fragment)) {
        failures.push(`${sourceRelative}: ${href} targets missing fragment #${fragment}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Built documentation contains broken fragment links:\n${failures.join('\n')}`);
  }
}
