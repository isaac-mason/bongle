// ── an edit room persists its unsaved edits before it is destroyed ─────────
//
// Persistence is the editor's: its room system (editor/server.ts) flushes when an
// editor leaves, which is what `stop_room` and the last editor leaving do to every
// player before the room is destroyed. The runtime only guarantees the leave hooks
// fire on those paths and that root systems are disposed with the room.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeFs } from '../../../cli/node-fs';
import { system } from '../../../src/api/scripts';
import { registry } from '../../../src/core/registry';
import * as Rpc from '../../../src/core/rpc';
import { createNode, serializeNode } from '../../../src/core/scene/scene-tree';
import { onDispose, onLeave } from '../../../src/core/scene/scripts';
import { CreateNodeCommand } from '../../../src/editor/commands';
import '../../../src/editor/server';
import { env } from '../../../src/env';
import { nodeZstd } from '../../../src/node/zstd';
import * as ContentManager from '../../../src/server/content-manager';
import * as Rooms from '../../../src/server/rooms';
import * as EngineServer from '../../../src/server/server';
import { createInMemoryStorageDriver } from '../../../src/server/storage-in-memory';

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

let tmpDir: string;
let server: EngineServer.EngineServer;

function writeScene(sceneId: string): void {
    const root = createNode({ name: 'Root' });
    fs.writeFileSync(
        path.join(tmpDir, 'content', 'scenes', `${sceneId}.scene.json`),
        JSON.stringify({ version: 1, nodes: { root: serializeNode(root) } }, null, 2),
    );
}

function sceneOnDisk(sceneId: string): string {
    return fs.readFileSync(path.join(tmpDir, 'content', 'scenes', `${sceneId}.scene.json`), 'utf8');
}

/** drive the editor's create-node RPC into `room` the way the wire would. */
function createNodeViaEditor(room: Rooms.Room, name: string): void {
    const commandIndex = registry.protocol.commands.idToIndex.get(CreateNodeCommand.id);
    if (commandIndex === undefined) throw new Error('editor commands not in the protocol');
    const payload = CreateNodeCommand.def.serdes.pack({
        id: 424242,
        parentId: room.scene.root.id,
        index: 0,
        name,
        persist: undefined,
        traits: '[]',
        children: undefined,
        prefab: undefined,
    });
    Rpc.dispatchNetMessage(
        server.rpc,
        registry.protocol.commands,
        { type: 'net_message', direction: 'to_server', roomId: room.id, commandIndex, payload },
        CLIENT,
    );
}

describe('edit room teardown', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bongle-teardown-'));
        fs.mkdirSync(path.join(tmpDir, 'content', 'scenes'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'resources', 'server'), { recursive: true });
        env.server = true;
        env.client = false;
        env.editor = true;
        probeLog.length = 0;
        writeScene('main');
        writeScene('side');
        server = EngineServer.init({
            mode: 'edit',
            fs: openNodeFs(tmpDir),
            zstd: nodeZstd,
            driver: { storage: createInMemoryStorageDriver(), avatars: { sample: async () => [] } },
        });
        await EngineServer.load(server);
    });

    afterEach(async () => {
        EngineServer.dispose(server);
        await EngineServer.drainPersist(server);
    });

    it('stop_room saves an edited room before destroying it', async () => {
        const room = Rooms.createRoomInNamespace(server, 'side', 'edit', 'editor');
        Rooms.addClientToRoom(server, CLIENT, room, 'edit');
        createNodeViaEditor(room, 'unsaved-in-side');
        expect(sceneOnDisk('side')).not.toContain('unsaved-in-side');

        Rooms.stopRoom(server, room.id);

        expect(server.rooms.rooms.has(room.id)).toBe(false);
        expect(JSON.stringify(ContentManager.loadScene(server.contentManager, 'side'))).toContain('unsaved-in-side');
        await EngineServer.drainPersist(server);
        expect(sceneOnDisk('side')).toContain('unsaved-in-side');
    });

    it('the last editor leaving saves the room it empties', async () => {
        const room = Rooms.createRoomInNamespace(server, 'side', 'edit', 'editor');
        const player = Rooms.addClientToRoom(server, CLIENT, room, 'edit');
        createNodeViaEditor(room, 'unsaved-in-side');

        Rooms.leaveClientFromRoom(server, player.id);

        expect(server.rooms.rooms.has(room.id)).toBe(false);
        await EngineServer.drainPersist(server);
        expect(sceneOnDisk('side')).toContain('unsaved-in-side');
    });

    it('a clean room costs no write on teardown', async () => {
        const room = Rooms.createRoomInNamespace(server, 'side', 'edit', 'editor');
        const before = sceneOnDisk('side');
        const mtimeBefore = fs.statSync(path.join(tmpDir, 'content', 'scenes', 'side.scene.json')).mtimeMs;

        Rooms.stopRoom(server, room.id);
        await EngineServer.drainPersist(server);

        expect(sceneOnDisk('side')).toBe(before);
        expect(fs.statSync(path.join(tmpDir, 'content', 'scenes', 'side.scene.json')).mtimeMs).toBe(mtimeBefore);
    });

    it('a system sees every player leave and is disposed with the room', () => {
        const room = Rooms.createRoomInNamespace(server, 'side', 'edit', 'editor');
        Rooms.addClientToRoom(server, CLIENT, room, 'edit');
        probeLog.length = 0;

        Rooms.stopRoom(server, room.id);

        expect(probeLog).toEqual([`leave:${CLIENT}`, 'dispose']);
    });

    it('leave_room fires the leave hook for the leaving player', () => {
        const room = Rooms.createRoomInNamespace(server, 'side', 'edit', 'editor');
        const player = Rooms.addClientToRoom(server, CLIENT, room, 'edit');
        probeLog.length = 0;

        Rooms.leaveClientFromRoom(server, player.id);

        expect(probeLog[0]).toBe(`leave:${CLIENT}`);
    });
});
