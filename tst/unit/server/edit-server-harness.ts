// a real edit-mode EngineServer with the editor loaded, on a temp project dir.
// `dispatch` hands an editor RPC to the server the way the wire would.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as pack from 'packcat';
import { openNodeFs } from '../../../cli/node-fs';
import { registry } from '../../../src/core/registry';
import type { CommandHandle } from '../../../src/core/rpc';
import * as Rpc from '../../../src/core/rpc';
import { createNode, serializeNode } from '../../../src/core/scene/scene-tree';
import { drainWrites } from '../../../src/editor/persist/scenes';
import '../../../src/editor/server';
import { env } from '../../../src/env';
import { nodeZstd } from '../../../src/node/zstd';
import type * as Rooms from '../../../src/server/rooms';
import * as EngineServer from '../../../src/server/server';
import { createInMemoryStorageDriver } from '../../../src/server/storage-in-memory';

export type EditServerHarness = {
    server: EngineServer.EngineServer;
    tmpDir: string;
    /** every frame the engine handed to the host's `send`, in order. */
    sent: { client: number; channel: number; bytes: Uint8Array }[];
    writeScene(sceneId: string): void;
    sceneOnDisk(sceneId: string): string;
    sceneExistsOnDisk(sceneId: string): boolean;
    dispatch<S extends pack.Schema>(
        room: Rooms.Room,
        handle: CommandHandle<S, 'client_to_server'>,
        args: pack.SchemaType<S>,
        client: number,
    ): void;
    dispose(): Promise<void>;
};

export async function bootEditServer(scenes: string[]): Promise<EditServerHarness> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bongle-edit-'));
    fs.mkdirSync(path.join(tmpDir, 'content', 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resources', 'server'), { recursive: true });
    env.server = true;
    env.client = false;
    env.editor = true;

    const scenePath = (sceneId: string) => path.join(tmpDir, 'content', 'scenes', `${sceneId}.scene.json`);
    const writeScene = (sceneId: string) => {
        const root = createNode({ name: 'Root' });
        fs.writeFileSync(scenePath(sceneId), JSON.stringify({ version: 1, nodes: { root: serializeNode(root) } }, null, 2));
    };
    for (const sceneId of scenes) writeScene(sceneId);

    const sent: EditServerHarness['sent'] = [];
    const server = EngineServer.init({
        mode: 'edit',
        fs: openNodeFs(tmpDir),
        zstd: nodeZstd,
        driver: { storage: createInMemoryStorageDriver(), avatars: { sample: async () => [] } },
        send: (client, channel, bytes) => sent.push({ client, channel, bytes }),
    });
    await EngineServer.load(server);

    return {
        server,
        tmpDir,
        sent,
        writeScene,
        sceneOnDisk: (sceneId) => fs.readFileSync(scenePath(sceneId), 'utf8'),
        sceneExistsOnDisk: (sceneId) => fs.existsSync(scenePath(sceneId)),
        dispatch: (room, handle, args, client) => {
            const commandIndex = registry.protocol.commands.idToIndex.get(handle.id);
            if (commandIndex === undefined) throw new Error(`${handle.id} is not in the protocol`);
            const payload = handle.def.serdes.pack(args);
            Rpc.dispatchNetMessage(
                server.rpc,
                registry.protocol.commands,
                { type: 'net_message', direction: 'to_server', roomId: room.id, commandIndex, payload },
                client,
            );
        },
        dispose: async () => {
            EngineServer.dispose(server);
            await drainWrites();
        },
    };
}
