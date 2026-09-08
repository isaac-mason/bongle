// ── an edit room persists its unsaved edits before it is destroyed ─────────
//
// Persistence is the editor's: its room system (editor/server.ts) flushes when an
// editor leaves, which is what `stop_room` and the last editor leaving do to every
// player before the room is destroyed. The runtime only guarantees the leave hooks
// fire on those paths and that root systems are disposed with the room.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { system } from '../../../src/api/scripts';
import { onDispose, onLeave } from '../../../src/core/scene/scripts';
import { CreateNodeCommand } from '../../../src/editor/commands';
import { env } from '../../../src/env';
import * as ContentManager from '../../../src/server/content-manager';
import * as Rooms from '../../../src/server/rooms';
import * as EngineServer from '../../../src/server/server';
import { bootEditServer, type EditServerHarness } from './edit-server-harness';

const CLIENT = 7;
const probeLog: string[] = [];
system(
    'teardown-probe',
    (ctx) => {
        if (!env.server) return;
        onLeave(ctx, ({ client }) => probeLog.push(`leave:${client}`));
        onDispose(ctx, () => probeLog.push('dispose'));
    },
    { editor: true },
);

let h: EditServerHarness;

function createNodeViaEditor(room: Rooms.Room, name: string): void {
    h.dispatch(
        room,
        CreateNodeCommand,
        {
            id: 424242,
            parentId: room.scene.root.id,
            index: 0,
            name,
            persist: undefined,
            traits: '[]',
            children: undefined,
            prefab: undefined,
        },
        CLIENT,
    );
}

function sideMtime(): number {
    return fs.statSync(path.join(h.tmpDir, 'content', 'scenes', 'side.scene.json')).mtimeMs;
}

describe('edit room teardown', () => {
    beforeEach(async () => {
        probeLog.length = 0;
        h = await bootEditServer(['main', 'side']);
    });
    afterEach(() => h.dispose());

    it('stop_room saves an edited room before destroying it', async () => {
        const room = Rooms.createRoomInNamespace(h.server, 'side', 'edit', 'editor');
        Rooms.addClientToRoom(h.server, CLIENT, room, 'edit');
        createNodeViaEditor(room, 'unsaved-in-side');
        expect(h.sceneOnDisk('side')).not.toContain('unsaved-in-side');

        Rooms.stopRoom(h.server, room.id);

        expect(h.server.rooms.rooms.has(room.id)).toBe(false);
        expect(JSON.stringify(ContentManager.loadScene(h.server.contentManager, 'side'))).toContain('unsaved-in-side');
        await EngineServer.drainPersist(h.server);
        expect(h.sceneOnDisk('side')).toContain('unsaved-in-side');
    });

    it('the last editor leaving saves the room it empties', async () => {
        const room = Rooms.createRoomInNamespace(h.server, 'side', 'edit', 'editor');
        const player = Rooms.addClientToRoom(h.server, CLIENT, room, 'edit');
        createNodeViaEditor(room, 'unsaved-in-side');

        Rooms.leaveClientFromRoom(h.server, player.id);

        expect(h.server.rooms.rooms.has(room.id)).toBe(false);
        await EngineServer.drainPersist(h.server);
        expect(h.sceneOnDisk('side')).toContain('unsaved-in-side');
    });

    it('a clean room costs no write on teardown', async () => {
        const room = Rooms.createRoomInNamespace(h.server, 'side', 'edit', 'editor');
        const before = h.sceneOnDisk('side');
        const mtimeBefore = sideMtime();

        Rooms.stopRoom(h.server, room.id);
        await EngineServer.drainPersist(h.server);

        expect(h.sceneOnDisk('side')).toBe(before);
        expect(sideMtime()).toBe(mtimeBefore);
    });

    it('a system sees every player leave and is disposed with the room', () => {
        const room = Rooms.createRoomInNamespace(h.server, 'side', 'edit', 'editor');
        Rooms.addClientToRoom(h.server, CLIENT, room, 'edit');
        probeLog.length = 0;

        Rooms.stopRoom(h.server, room.id);

        expect(probeLog).toEqual([`leave:${CLIENT}`, 'dispose']);
    });

    it('leave_room fires the leave hook for the leaving player', () => {
        const room = Rooms.createRoomInNamespace(h.server, 'side', 'edit', 'editor');
        const player = Rooms.addClientToRoom(h.server, CLIENT, room, 'edit');
        probeLog.length = 0;

        Rooms.leaveClientFromRoom(h.server, player.id);

        expect(probeLog[0]).toBe(`leave:${CLIENT}`);
    });
});
