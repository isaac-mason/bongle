// @vitest-environment happy-dom
//
// ── block-icon atlas loading ────────────────────────────────────────────
//
// The atlas is a png plus a coords sidecar, written one after the other. The
// editor never goes looking for that pair: the asset pipeline announces it once
// both halves are on disk, and the host calls `reloadBlockIconAtlas`. So this
// module must (a) read nothing on its own — the boot poll it used to run raced
// the bake's two writes and published a new png against the previous pass's
// coords — and (b) let the newest read win when two announcements overlap.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditor } from '../../../src/editor/editor-store';
import { loadEditorAssets, reloadBlockIconAtlas } from '../../../src/editor/icons';

type Icons = { coords: Record<string, [number, number]>; cols: number; rows: number; iconPx: number };

const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const ONE_BLOCK: Icons = { coords: { 'game/stone': [0, 0] }, cols: 1, rows: 1, iconPx: 128 };
const TWO_BLOCKS: Icons = { coords: { 'game/stone': [0, 0], 'game/copper': [1, 0] }, cols: 2, rows: 1, iconPx: 128 };

/** an editor client whose loader hands back whatever `disk` holds when the read
 *  OPENS, one macrotask later — the async window two announcements land inside. */
function fakeClient(disk: { icons: Icons }, reads: string[]) {
    return {
        resources: {
            loader: {
                loadBytes: async (name: string) => {
                    reads.push(name);
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

describe('block icon atlas', () => {
    beforeEach(() => {
        vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:icons', revokeObjectURL: () => {} });
        useEditor.setState({ blockIconAtlasUrl: null, blockIconCoords: {}, blockIconCols: 0, blockIconRows: 0 });
    });

    it('reads nothing until the bake announces an atlas', async () => {
        const reads: string[] = [];
        loadEditorAssets(fakeClient({ icons: ONE_BLOCK }, reads) as never);

        await new Promise((r) => setTimeout(r, 10));
        expect(reads).toEqual([]);
        expect(useEditor.getState().blockIconAtlasUrl).toBeNull();
    });

    it('publishes the atlas the announcement points at', async () => {
        const reads: string[] = [];
        loadEditorAssets(fakeClient({ icons: ONE_BLOCK }, reads) as never);

        reloadBlockIconAtlas();

        await vi.waitFor(() => expect(useEditor.getState().blockIconCoords).toHaveProperty('game/stone'));
        expect(useEditor.getState().blockIconCols).toBe(1);
    });

    it('lets the newest read win when two announcements overlap', async () => {
        const disk = { icons: ONE_BLOCK };
        loadEditorAssets(fakeClient(disk, []) as never);

        reloadBlockIconAtlas();
        // a second bake lands while that read is still open: its result is the one
        // that must survive, whichever order the two reads happen to resolve in.
        disk.icons = TWO_BLOCKS;
        reloadBlockIconAtlas();

        await vi.waitFor(() => expect(useEditor.getState().blockIconCoords).toHaveProperty('game/copper'));
        expect(useEditor.getState().blockIconCols).toBe(2);

        // and the stale read never publishes behind it.
        await new Promise((r) => setTimeout(r, 10));
        expect(useEditor.getState().blockIconCols).toBe(2);
    });
});
