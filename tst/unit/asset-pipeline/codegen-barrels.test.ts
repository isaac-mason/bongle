// ── codegen barrel emitters ─────────────────────────────────────────
//
// The model and sound barrels are the one place the engine WRITES TypeScript that
// then has to compile inside a user's project. Nothing else typechecks them: lib
// can't self-resolve `bongle`, so the emitted `import … from 'bongle'` is never
// compiled here, and a project only finds out at its next pipeline pass.
//
// These pin the structural properties that broke when `XHandle` was split into
// `XDef` + `XHandle`: the def literal must not carry handle-only fields, the
// HandleMap must name the handle type rather than the def const, and the import
// must not list a specifier twice.

import { describe, expect, it } from 'vitest';
import { type CodegenEntry, renderBarrel as renderSoundBarrel } from '../../../src/asset-pipeline/bake/audio';
import { type BuildEntry, renderBarrel as renderModelBarrel } from '../../../src/asset-pipeline/bake/models';

const SOUND: CodegenEntry = { id: 'arrow-reload', src: 'assets/arrow-reload.ogg', long: false, duration: 0.236 };

const MODEL: BuildEntry = {
    id: 'bow',
    srcRel: 'assets/bow.glb',
    srcHash: 'abc',
    hash8: 'abcdef01',
    clientBinPath: 'resources/client/models/bow.abcdef01.client.bin',
    serverBinPath: 'resources/server/models/bow.abcdef01.server.bin',
    clientBinUrl: 'models/bow.abcdef01.client.bin',
    serverBinUrl: 'models/bow.abcdef01.server.bin',
    fresh: true,
    payload: {
        sceneNodes: [
            { name: 'root', parent: -1, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], meshName: null },
            { name: 'arrow', parent: 0, position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], meshName: 'ArrowMesh' },
        ],
        nodeNames: ['root', 'arrow'],
        meshes: [{ name: 'ArrowMesh', aabb: [0, 0, 0, 1, 1, 1] }],
        clipNames: ['draw'],
        animatedNodeNames: ['arrow'],
        aabb: [0, 0, 0, 1, 1, 1],
    },
};

/** every `import { … }` specifier list in the emitted source, split out. */
function importSpecifiers(source: string): string[][] {
    return [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)].map((m) =>
        m[1]!
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
    );
}

describe.each([
    ['models', () => renderModelBarrel([MODEL])],
    ['sounds', () => renderSoundBarrel([SOUND])],
])('%s barrel', (_kind, render) => {
    it('never lists an import specifier twice', () => {
        for (const specifiers of importSpecifiers(render())) {
            // a specifier list with a repeat is a hard TS error in the project that
            // imports it, and the engine's own typecheck never sees this file.
            expect(new Set(specifiers).size, `duplicate in: ${specifiers.join(', ')}`).toBe(specifiers.length);
        }
    });

    it('does not put handle-only fields on the def literal', () => {
        // `dependency` moved to the handle when Def/Handle split; leaving it here
        // makes every generated project fail to compile.
        expect(render()).not.toContain('dependency:');
    });

    it('imports every type it references', () => {
        const source = render();
        const imported = new Set(
            importSpecifiers(source)
                .flat()
                .map((s) => s.replace(/^type\s+/, '')),
        );
        for (const referenced of source.matchAll(/\b(ModelDef|ModelHandle|SoundDef|SoundHandle|ClipDef)\b/g)) {
            const name = referenced[1]!;
            if (name.endsWith('Map')) continue;
            expect(imported, `${name} is referenced but not imported`).toContain(name);
        }
    });
});

describe('HandleMap declaration merging', () => {
    it('maps each id to the HANDLE type, not the def const', () => {
        // `model('bow')` returns a ModelHandle; if the map names `typeof bow` (the
        // def const) the declared return type is the def and every `.nodes` read
        // downstream resolves against the wrong type.
        const models = renderModelBarrel([MODEL]);
        expect(models).toContain('interface ModelHandleMap');
        expect(models).toMatch(/"bow":\s*ModelHandle</);

        const sounds = renderSoundBarrel([SOUND]);
        expect(sounds).toContain('interface SoundHandleMap');
        expect(sounds).toMatch(/"arrow-reload":\s*SoundHandle\b/);
    });
});
