// scripts/gather-lib-runtime.mjs — assemble the RUNTIME copies of the
// first-party github libs the prebundle externalizes (mathcat/gpucat/crashcat/
// packcat), so the editor can seed them into the vfs as real node_modules
// packages. The runtime counterpart of gather-lib-types.mjs: that copies their
// .d.ts for Monaco; this copies their built dist + package.json for eval.
//
// bongle's prebundle imports these by bare specifier (external); the dev-server
// resolves `mathcat` → node_modules/mathcat via package.json `main`/`exports`
// and the runner evaluates the shared, deduped package (not a copy baked into
// each bongle chunk).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');

// closed set (same as gather-lib-types): mathcat/packcat/dashcat have no deps,
// gpucat→mathcat, crashcat→mathcat. All ship built dist ESM.
const LIBS = ['mathcat', 'gpucat', 'crashcat', 'packcat', 'dashcat'];

/** package root dir for a bare name — walk up from its resolved main entry to
 *  the package.json that names it (exports maps often omit ./package.json). */
function resolvePkgDir(name) {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
        const pj = join(dir, 'package.json');
        if (existsSync(pj)) {
            try {
                if (JSON.parse(readFileSync(pj, 'utf8')).name === name) return dir;
            } catch {}
        }
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`package root for ${name} not found`);
        dir = parent;
    }
}

/** newest mtime under a dir (0 if missing) — catches a rebuilt cat lib whose
 *  version didn't bump. */
function newestMtime(dir) {
    let m = 0;
    if (!existsSync(dir)) return m;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        const t = e.isDirectory() ? newestMtime(abs) : statSync(abs).mtimeMs;
        if (t > m) m = t;
    }
    return m;
}

const pkgDirs = LIBS.map(resolvePkgDir);
// Fingerprint each lib's version + newest dist mtime, so a lib/src edit reuses
// the existing vendor copies but a rebuilt/bumped cat lib refreshes them. Pass
// --force to copy regardless.
const FP = join(VENDOR, '.fingerprint');
const fingerprint = createHash('sha1')
    .update(LIBS.map((lib, i) => `${lib}@${JSON.parse(readFileSync(join(pkgDirs[i], 'package.json'), 'utf8')).version}:${newestMtime(join(pkgDirs[i], 'dist'))}`).join('\n'))
    .digest('hex');
if (!process.argv.includes('--force') && existsSync(FP) && readFileSync(FP, 'utf8') === fingerprint) {
    console.log('runtime libs up to date — skipping');
    process.exit(0);
}

rmSync(VENDOR, { recursive: true, force: true });
for (let i = 0; i < LIBS.length; i++) {
    const lib = LIBS[i];
    const pkgDir = pkgDirs[i];
    const dest = join(VENDOR, lib);
    mkdirSync(dest, { recursive: true });
    cpSync(join(pkgDir, 'package.json'), join(dest, 'package.json'));
    cpSync(join(pkgDir, 'dist'), join(dest, 'dist'), { recursive: true });
    const readme = join(pkgDir, 'README.md');
    if (existsSync(readme)) cpSync(readme, join(dest, 'README.md'));
    console.log(`gathered runtime: ${lib}`);
}
writeFileSync(FP, fingerprint);
