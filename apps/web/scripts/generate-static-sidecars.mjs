import { constants as zlibConstants, brotliCompress, gzip } from "node:zlib";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const MINIMUM_SOURCE_BYTES = 256;
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".xml",
]);
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function shouldCompress(path) {
  const relativePath = relative(DIST_DIR, path).split(sep).join("/");
  return (
    relativePath !== "index.html" &&
    relativePath !== "_headers" &&
    !relativePath.startsWith(".vite/") &&
    !relativePath.endsWith(".br") &&
    !relativePath.endsWith(".gz") &&
    COMPRESSIBLE_EXTENSIONS.has(extname(relativePath).toLowerCase())
  );
}

async function writeSmallerSidecar(path, extension, compressed, sourceLength) {
  if (compressed.length < sourceLength) {
    await writeFile(`${path}${extension}`, compressed);
  }
}

for (const path of await listFiles(DIST_DIR)) {
  if (!shouldCompress(path)) {
    continue;
  }
  const source = await readFile(path);
  if (source.length < MINIMUM_SOURCE_BYTES) {
    continue;
  }
  const [brotli, gzipped] = await Promise.all([
    compressBrotli(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
    compressGzip(source, { level: 9 }),
  ]);
  await Promise.all([
    writeSmallerSidecar(path, ".br", brotli, source.length),
    writeSmallerSidecar(path, ".gz", gzipped, source.length),
  ]);
}
