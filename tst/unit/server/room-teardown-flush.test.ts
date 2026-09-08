// ── an edit room persists its unsaved edits before it is destroyed ─────────
//
// The interval auto-flush runs every 3s. Before this, `stop_room` and the last
// editor leaving destroyed the room straight away, so up to 3s of edits went
// with it. Both paths now flush a dirty edit room first (`Save.flushRoom`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeFs } from '../../../cli/node-fs';
import { addChild, createNode, serializeNode } from '../../../src/core/scene/scene-tree';
import { env } from '../../../src/env';
import { nodeZstd } from '../../../src/node/zstd';
import * as ContentManager from '../../../src/server/content-manager';
import * as Rooms from '../../../src/server/rooms';
import * as EngineServer from '../../../src/server/server';
import { createInMemoryStorageDriver } from '../../../src/server/storage-in-memory';

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

/** open an edit room on `sceneId` and add a node the scene file does not have. */
function openDirtyEditRoom(sceneId: string): Rooms.Room {
    const room = Rooms.createRoomInNamespace(server, sceneId, 'edit', 'editor');
    addChild(room.scene.root, createNode({ name: `unsaved-in-${sceneId}` }));
    Rooms.setRoomDirty(room, true);
    return room;
}

describe('edit room teardown flushes unsaved edits', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bongle-teardown-'));
        fs.mkdirSync(path.join(tmpDir, 'content', 'scenes'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'resources', 'server'), { recursive: true });
        env.server = true;
        env.client = false;
        env.editor = true;
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

    it('stop_room saves a dirty edit room before destroying it', async () => {
        const room = openDirtyEditRoom('side');
        expect(sceneOnDisk('side')).not.toContain('unsaved-in-side');

        Rooms.stopRoom(server, room.id);

        expect(server.rooms.rooms.has(room.id)).toBe(false);
        expect(JSON.stringify(ContentManager.loadScene(server.contentManager, 'side'))).toContain('unsaved-in-side');
        await EngineServer.drainPersist(server);
        expect(sceneOnDisk('side')).toContain('unsaved-in-side');
    });

    it('the last editor leaving saves the room it empties', async () => {
        const room = openDirtyEditRoom('side');
        const player = Rooms.addClientToRoom(server, 7, room, 'edit');

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
});
