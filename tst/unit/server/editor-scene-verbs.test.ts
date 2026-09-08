// ── the editor's scene verbs: open, rename, delete ─────────────────────────
//
// Editor RPCs handled by the editor system, not core protocol messages: the
// runtime only provides the room helpers that keep live rooms consistent with a
// content change.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateNodeCommand, DeleteSceneCommand, OpenSceneCommand, RenameSceneCommand } from '../../../src/editor/commands';
import { drainWrites } from '../../../src/editor/persist/scenes';
import * as ContentManager from '../../../src/server/content-manager';
import * as Rooms from '../../../src/server/rooms';
import { bootEditServer, type EditServerHarness } from './edit-server-harness';

const CLIENT = 7;
let h: EditServerHarness;

/** the default edit room, where the client's editor lives and its RPCs land. */
function homeRoom(): Rooms.Room {
    return Rooms.getRoom(h.server.rooms, h.server.defaultRoomId!)!;
}

describe('editor scene verbs', () => {
    beforeEach(async () => {
        h = await bootEditServer(['main', 'side']);
        Rooms.addClientToRoom(h.server, CLIENT, homeRoom(), 'edit');
    });
    afterEach(() => h.dispose());

    it('open_scene finds or creates the edit room for the scene and joins the sender', () => {
        expect([...h.server.rooms.rooms.values()].some((r) => r.sceneId === 'side')).toBe(false);

        h.dispatch(homeRoom(), OpenSceneCommand, { sceneId: 'side' }, CLIENT);

        const opened = [...h.server.rooms.rooms.values()].filter((r) => r.sceneId === 'side');
        expect(opened).toHaveLength(1);
        expect(opened[0]!.mode).toBe('edit');
        expect(Rooms.findPlayer(h.server.rooms, CLIENT, opened[0]!.id, 'edit')).toBeDefined();

        // a second open reuses the room instead of minting another.
        h.dispatch(homeRoom(), OpenSceneCommand, { sceneId: 'side' }, CLIENT);
        expect([...h.server.rooms.rooms.values()].filter((r) => r.sceneId === 'side')).toHaveLength(1);
    });

    it('rename_scene renames the stored scene and follows it on open rooms', async () => {
        h.dispatch(homeRoom(), OpenSceneCommand, { sceneId: 'side' }, CLIENT);
        const room = [...h.server.rooms.rooms.values()].find((r) => r.sceneId === 'side')!;

        h.dispatch(homeRoom(), RenameSceneCommand, { oldSceneId: 'side', newSceneId: 'renamed' }, CLIENT);

        expect(room.sceneId).toBe('renamed');
        expect(ContentManager.loadScene(h.server.contentManager, 'renamed')).not.toBeNull();
        expect(ContentManager.loadScene(h.server.contentManager, 'side')).toBeNull();
        await drainWrites();
        expect(h.sceneExistsOnDisk('renamed')).toBe(true);
        expect(h.sceneExistsOnDisk('side')).toBe(false);
    });

    it('delete_scene stops every room on the scene and removes the file', async () => {
        h.dispatch(homeRoom(), OpenSceneCommand, { sceneId: 'side' }, CLIENT);
        const room = [...h.server.rooms.rooms.values()].find((r) => r.sceneId === 'side')!;

        h.dispatch(homeRoom(), DeleteSceneCommand, { sceneId: 'side' }, CLIENT);

        expect(h.server.rooms.rooms.has(room.id)).toBe(false);
        expect(ContentManager.loadScene(h.server.contentManager, 'side')).toBeNull();
        await drainWrites();
        expect(h.sceneExistsOnDisk('side')).toBe(false);
    });

    it('delete_scene after an unsaved edit leaves no file: the leave flush lands before the remove', async () => {
        h.dispatch(homeRoom(), OpenSceneCommand, { sceneId: 'side' }, CLIENT);
        const room = [...h.server.rooms.rooms.values()].find((r) => r.sceneId === 'side')!;
        h.dispatch(
            room,
            CreateNodeCommand,
            {
                id: 424242,
                parentId: room.scene.root.id,
                index: 0,
                name: 'doomed',
                persist: undefined,
                traits: '[]',
                children: undefined,
                prefab: undefined,
            },
            CLIENT,
        );

        h.dispatch(homeRoom(), DeleteSceneCommand, { sceneId: 'side' }, CLIENT);
        await drainWrites();

        expect(h.sceneExistsOnDisk('side')).toBe(false);
    });
});
