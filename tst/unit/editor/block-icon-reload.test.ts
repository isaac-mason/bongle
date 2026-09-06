// @vitest-environment happy-dom
//
// ── block-icon atlas reload coalescing ──────────────────────────────────
//
// The icon bake writes `voxels-icons.png` and `voxels-icons.json` as two
// separate writes, and the editor fs emits one change event per write — so the
// edit client calls `reloadBlockIconAtlas` TWICE per bake, the second while the
// first is still reading. The first read can catch the new png against the
// previous pass's coords, which leaves a newly-declared block in the palette
// with no icon; the second notification is the only thing that corrects it.
// Dropping it (the in-flight guard used to) made that state permanent until the
// pipeline was restarted by hand.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from '../../../src/editor/editor-store';
import { registerClient, reloadBlockIconAtlas } from '../../../src/editor/index';

type Icons = { coords: Record<string, [number, number]>; cols: number; rows: number; iconPx: number };

const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** an editor client whose loader hands back whatever `disk` currently holds, one
 *  macrotask later — the async window the two fs notifications land inside. */
function fakeClient(disk: { icons: Icons }, reads: string[]) {
    return {
        resources: {
            loader: {
                loadBytes: async (name: string) => {
                    reads.push(name);
                    // snapshot at read START, not at resolution: a read opened before the
                    // bake's second write lands sees the sidecar as it was, which is the
                    // whole reason the second notification has to be honoured.
                    const seen = disk.icons;
                    await new Promise((r) => setTimeout(r, 0));
                    return name.endsWith('.json') ? encode(seen) : new Uint8Array([1, 2, 3]);
                },
            },
        },
        rooms: { rooms: new Map() },
        net: {},
    };
}

describe('reloadBlockIconAtlas', () => {
    beforeEach(() => {
        vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:icons', revokeObjectURL: () => {} });
    });

    it('replays a reload requested while one is in flight', async () => {
        const oneBlock: Icons = { coords: { 'game/stone': [0, 0] }, cols: 1, rows: 1, iconPx: 128 };
        const twoBlocks: Icons = { coords: { 'game/stone': [0, 0], 'game/copper': [1, 0] }, cols: 2, rows: 1, iconPx: 128 };
        const disk = { icons: oneBlock };
        const reads: string[] = [];
        registerClient(fakeClient(disk, reads) as never);
        await vi.waitFor(() => expect(useEditor.getState().blockIconCoords).toHaveProperty('game/stone'));

        // the png notification: the load starts against the OLD sidecar, exactly as
        // it does when the bake is mid-way between its two writes.
        reloadBlockIconAtlas();
        // the json notification, arriving while that read is still open. This is the
        // one carrying the new block's tile.
        disk.icons = twoBlocks;
        reloadBlockIconAtlas();

        await vi.waitFor(() => expect(useEditor.getState().blockIconCoords).toHaveProperty('game/copper'));
        expect(useEditor.getState().blockIconCols).toBe(2);
    });
});
