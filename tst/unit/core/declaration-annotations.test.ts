// Every declaration API carries `/*#__NO_SIDE_EFFECTS__*/`.
//
// `block()`, `tile()`, `texture()`, `sound()` et al register into the engine registries when their
// declaration is EVALUATED, and the asset pipeline bakes whatever registered. Registration is
// meant to be demand-driven — you get an entry because something referenced the handle, or
// because `use()` asked for it — so a declaration nothing references should not survive into a
// game's bundle. That is what the annotation asserts, and without it `bongle/kit` alone puts all
// ~200 of its blocks, textures and sounds into every game's atlas.
//
// Purity is a property of the WHOLE initializer expression, so this covers more than the
// registering factories: the `blockPreset.*` wrappers (the outermost call in a kit declaration)
// and the helpers that appear in the arguments (`asset`) need it too. One unannotated
// call anywhere inside `cube('kit:stone', { tiles: tiles.stone })` keeps the whole
// statement.
//
// Text, not behaviour, and deliberately so: a missed annotation is silent — the build succeeds,
// the game runs, the atlas is just quietly full again. The end-to-end count needs a built dist,
// so it belongs after `pnpm run build`, not here. This is the cheap guard that catches the
// realistic regression: someone adds a preset and doesn't know about the contract.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ANNOTATION = '/*#__NO_SIDE_EFFECTS__*/';
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../src/${rel}`, import.meta.url)), 'utf8');

/** the annotation must sit in the lines directly above the declaration (comments may intervene). */
function isAnnotated(source: string, name: string): boolean {
    const lines = source.split('\n');
    const at = lines.findIndex((l) => new RegExp(`^export function ${name}\\b`).test(l));
    if (at === -1) throw new Error(`no \`export function ${name}\` found`);
    for (let i = at - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line === ANNOTATION) return true;
        // walk up through the declaration's own comment block; stop at anything else.
        if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        return false;
    }
    return false;
}

// The registering factories, plus the argument-position helpers that share their statement.
const NAMED: [file: string, names: string[]][] = [
    ['api/asset.ts', ['asset']],
    // every declaration API lives beside the store it writes to, so `kind()` and
    // `declare()` never leave that file. `texture()` is a REGISTERING factory now —
    // its predecessor `draw()` was an argument-position value constructor with no
    // store, which is exactly what the split removed.
    ['core/registry.ts', ['block', 'tile', 'texture', 'sound', 'sprite', 'particle', 'model']],
];

describe('declaration APIs are annotated side-effect-free', () => {
    for (const [file, names] of NAMED) {
        for (const name of names) {
            it(`${name} (${file})`, () => {
                expect(isAnnotated(src(file), name)).toBe(true);
            });
        }
    }

    // Derived, not listed: a NEW preset must be annotated too, and a hand-kept list would not
    // notice one being added. A preset is a function that DECLARES a block — `block(` in its body
    // — which excludes the runtime state helpers alongside them (`setDoorOpen` mutates a live
    // world and is genuinely effectful).
    it('every blockPreset that declares a block', () => {
        const source = src('core/voxels/block-presets.ts');
        const bodies = source.split(/^(?=export function )/m).slice(1);
        const presets = bodies
            .filter((body) => /[^.\w]block\(/.test(body))
            .map((body) => body.match(/^export function (\w+)\b/)![1]);
        expect(presets.length).toBeGreaterThan(10); // the split still finds them
        expect(presets.filter((name) => !isAnnotated(source, name))).toEqual([]);
    });
});
