// scripts/gather-lib-types.mjs — assemble the editor's virtual node_modules
// types tree, run after `tsgo -p tsconfig.build.json` emits bongle's own d.ts
// into dist/types/node_modules/bongle/.
//
// bongle's d.ts references our github libs by bare specifier (`export * from
// 'mathcat'`, `RigidBody` from 'crashcat', …). Those aren't on npm, so Monaco
// can't fetch them via ATA — we copy their prebuilt dist d.ts in beside bongle.
// The set is closed at these four: mathcat/packcat have no deps, gpucat→mathcat,
// crashcat→mathcat (+ `three`, which IS npm → left to ATA). Real npm packages
// (three/react/zustand/lucide/@webgpu) are ATA's job, not copied here.
//
// Also writes bongle's package.json with a types-only exports map (the real
// one points at .ts source) so `bongle`, `bongle/interface`, `bongle/mathcat`,
// … resolve to the emitted .d.ts.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'dist/types/node_modules');
const BONGLE = join(NM, 'bongle');

// closed set of first-party github libs bongle's d.ts references.
const LIBS = ['mathcat', 'gpucat', 'crashcat', 'packcat'];

/** package root dir for a bare name — walk up from its resolved main entry to
 *  the package.json that names it. `require.resolve(name + '/package.json')`
 *  is blocked when a package's `exports` map doesn't list `./package.json`. */
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

/** copy a package's .d.ts tree + package.json (types-only; no runtime JS). */
function copyTypes(pkgDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    cpSync(join(pkgDir, 'package.json'), join(destDir, 'package.json'));
    const walk = (from, to) => {
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            const src = join(from, entry.name);
            const dst = join(to, entry.name);
            if (entry.isDirectory()) walk(src, dst);
            else if (entry.name.endsWith('.d.ts')) {
                mkdirSync(to, { recursive: true });
                cpSync(src, dst);
            }
        }
    };
    walk(pkgDir, destDir);
}

for (const lib of LIBS) {
    copyTypes(resolvePkgDir(lib), join(NM, lib));
    console.log(`gathered types: ${lib}`);
}

// bongle types-package.json: rewrite the real exports' .ts targets to .d.ts,
// keeping only subpaths whose declaration was emitted.
const real = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const exportsMap = {};
for (const [key, val] of Object.entries(real.exports)) {
    const target = typeof val === 'string' ? val : (val.import ?? val.default);
    if (typeof target !== 'string' || !/\.tsx?$/.test(target)) continue;
    const dts = target.replace(/\.tsx?$/, '.d.ts');
    if (existsSync(join(BONGLE, dts))) exportsMap[key] = { types: dts };
}
writeFileSync(
    join(BONGLE, 'package.json'),
    `${JSON.stringify({ name: 'bongle', version: real.version, types: exportsMap['.']?.types, exports: exportsMap }, null, 2)}\n`,
);
console.log(`wrote bongle/package.json (${Object.keys(exportsMap).length} type entries)`);
