import { describe, expect, it } from 'vitest';
import type { TraitSyncState } from '../../../../../src/core/scene/traits';
import { diffSync } from '../../../../../src/core/scene/sync/sync-diff';

// minimal stubs, diffSync only touches codec.{pack,packInto} + the per-instance sync
// state, so we avoid pulling real packcat codecs (and their runtime env needs) into
// the test. packInto mirrors pack: write the slice's bytes into the scratch, return
// the length.
const node = {} as never;
const codec = {
    pack: (inst: { bytes: Uint8Array }) => inst.bytes,
    packInto: (inst: { bytes: Uint8Array }, _node: never, u8: Uint8Array, offset: number) => {
        u8.set(inst.bytes, offset);
        return inst.bytes.length;
    },
} as never;
const syncState = (): TraitSyncState => ({
    dirty: new Uint32Array(1),
    bytes: [],
    versions: new Float64Array(1),
    traitVersion: 0,
});

describe('diffSync — byte-diff', () => {
    it('server seeds a first-seen slice silently; client emits it', () => {
        const inst = { bytes: new Uint8Array([1]) };
        const s = syncState();
        expect(diffSync(codec, inst as never, node, 0, s, false)).toBe(false);
        expect(s.bytes[0]).toBeDefined(); // seeded for next compare

        const c = syncState();
        expect(diffSync(codec, inst as never, node, 0, c, true)).toBe(true);
    });

    it('emits on byte change, stays silent when unchanged', () => {
        const inst = { bytes: new Uint8Array([1]) };
        const s = syncState();
        diffSync(codec, inst as never, node, 0, s, false); // seed
        expect(diffSync(codec, inst as never, node, 0, s, false)).toBe(false);
        inst.bytes = new Uint8Array([2]);
        expect(diffSync(codec, inst as never, node, 0, s, false)).toBe(true);
    });
});
