// scripts/bongle-asset-rewrite.ts — build-time rewrite of `asset()` refs so they
// survive bundling into dist.
//
// `asset('<rel>', import.meta.url)` = `new URL(rel, base).href` — a runtime ref
// the bundler emits NOTHING for (unlike `new URL('<literal>', import.meta.url)`).
// The asset pipeline resolves the href at bake time and reads the file as a bake
// INPUT (baked into an atlas/bin, never shipped raw). But bundling collapses
// `import.meta.url` to the chunk location (`dist/chunks/<chunk>.js`), so a
// source-relative `rel` no longer points at the file:
//   - starter's `./assets/x`            → dist/chunks/assets/x   (co-located, ok-ish)
//   - base-avatar's `../../../avatars/x` → escapes bongle entirely (depth was
//     calibrated to src/core/player/, not the chunk's depth)
//
// This plugin rewrites every ref to `./assets/<pkgrel>` and copies the source
// file to `dist/assets/<pkgrel>`. Since the lib build emits BOTH entries and
// chunks at the dist/ root (same depth — see chunkFileNames), `./assets/` resolves
// to `dist/assets/` from every output file, regardless of the source module's
// depth or whether its code lands in an entry or a chunk. The files ride the dist
// seed as bake inputs. Only refs whose file EXISTS are rewritten, so JSDoc
// examples like `asset('./clip.ogg', import.meta.url)` in api docs are untouched.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import type { Plugin } from 'vite';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url)); // lib/ (the bongle package root)

// asset(<string literal>, import.meta.url) — static literal + the import.meta.url base.
const ASSET_RE = /\basset\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;

// map a source path to its clean dist target: strip everything up to & including
// the last `/assets/` (source asset dirs) so `src/starter/assets/textures/x.png`
// → `assets/textures/x.png`; sources with no `assets/` segment (avatars/) keep
// their package-relative path → `assets/avatars/base/player.glb`.
function distTargetFor(absSource: string): string {
    const pkgrel = relative(PKG_ROOT, absSource).split('\\').join('/');
    const i = pkgrel.lastIndexOf('/assets/');
    return `assets/${i >= 0 ? pkgrel.slice(i + '/assets/'.length) : pkgrel}`;
}

export function bongleAssetRewrite(): Plugin {
    // absolute source path → dist-relative target (deduped across modules).
    const toCopy = new Map<string, string>();
    // dist target → source, so two distinct sources mapping to one target fail loud.
    const claimed = new Map<string, string>();
    return {
        name: 'bongle:asset-rewrite',
        transform(code, id) {
            if (!id.includes('/lib/src/') && !id.includes('/lib/interface/')) return null;
            if (!code.includes('asset(')) return null;
            const dir = dirname(id);
            let s: MagicString | null = null;
            for (const m of code.matchAll(ASSET_RE)) {
                const absSource = resolve(dir, m[2]);
                if (!existsSync(absSource)) continue; // JSDoc example / not a real file
                const target = distTargetFor(absSource);
                const prior = claimed.get(target);
                if (prior && prior !== absSource) {
                    throw new Error(`[asset-rewrite] two assets collide on ${target}:\n  ${prior}\n  ${absSource}`);
                }
                claimed.set(target, absSource);
                toCopy.set(absSource, target);
                s ??= new MagicString(code);
                s.overwrite(m.index, m.index + m[0].length, `asset('./${target}', import.meta.url)`);
            }
            return s ? { code: s.toString(), map: s.generateMap({ hires: true }) } : null;
        },
        writeBundle(options) {
            const outDir = options.dir ?? fileURLToPath(new URL('../dist', import.meta.url));
            for (const [absSource, target] of toCopy) {
                const dest = join(outDir, target);
                mkdirSync(dirname(dest), { recursive: true });
                copyFileSync(absSource, dest);
            }
        },
    };
}
