import type { Client } from '@bongle/interface';
import { describe, expect, it } from 'vitest';
import { createTestServer } from '../../tst/integration/server-integration-test';
import { unpackPackedSceneGraph, unpackServerMessage } from '../core/protocol';
import { addChild, createNode } from '../core/scene/nodes';
import * as Resources from '../core/resources';
import * as Discovery from './discovery';
import * as Net from './net';
import * as Rooms from './rooms';

/* ── helpers ── */

const FAKE_CLIENT: Client = 1;

function setupRoom(mode: 'edit' | 'play') {
    const server = createTestServer({ mode });
    const discovery = Discovery.init();
    const resources = Resources.init(async () => new Uint8Array(), 'server');
    Discovery.addClient(discovery, FAKE_CLIENT);
    const net = Net.init();
    const player = Rooms.joinRoom(server.rooms, FAKE_CLIENT, server.room.id, server.room.mode);
    return { server, discovery, net, player, resources };
}

/** drain the synchronously-emitted join_room from the per-client outbox. */
function takeJoinRoom(net: Net.ServerNet, client: Client) {
    const messages = net.outboxMessages.get(client) ?? [];
    const entry = messages.find((m) => m.type === 'join_room');
    if (!entry) throw new Error('no join_room message on net outbox');
    const message = unpackServerMessage(entry.bytes);
    if (!message || message.type !== 'join_room') throw new Error('failed to unpack join_room from outbox');
    return message;
}

function flushUntilQuiet(
    discovery: Discovery.Discovery,
    rooms: Rooms.Rooms,
    resources: Resources.Resources,
) {
    return Discovery.flush(discovery, rooms, resources);
}

/* ── tests ── */

describe('discovery — realm filtering', () => {
    it('play mode: join_room packed scene excludes non-shared subtree', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        // shared node — should appear
        const sharedA = createNode({ name: 'shared-A' });
        addChild(server.nodes.root, sharedA);
        // server-only node with a shared descendant — entire subtree pruned
        const serverOnly = createNode({ name: 'server-B', realm: 'server' });
        addChild(server.nodes.root, serverOnly);
        const sharedC = createNode({ name: 'shared-C', realm: 'shared' });
        addChild(serverOnly, sharedC);

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const join = takeJoinRoom(net, FAKE_CLIENT);
        const names = unpackPackedSceneGraph(join.packedNodes).nodes.map((n) => n.name);

        expect(names).toContain('shared-A');
        expect(names).not.toContain('server-B');
        expect(names).not.toContain('shared-C');

        server.dispose();
    });

    it('edit mode: join_room packed scene includes everything regardless of realm', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');

        const sharedA = createNode({ name: 'shared-A' });
        addChild(server.nodes.root, sharedA);
        const serverOnly = createNode({ name: 'server-B', realm: 'server' });
        addChild(server.nodes.root, serverOnly);
        const sharedC = createNode({ name: 'shared-C', realm: 'shared' });
        addChild(serverOnly, sharedC);

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const join = takeJoinRoom(net, FAKE_CLIENT);
        const names = unpackPackedSceneGraph(join.packedNodes).nodes.map((n) => n.name);

        expect(names).toContain('shared-A');
        expect(names).toContain('server-B');
        expect(names).toContain('shared-C');

        server.dispose();
    });

    it('play mode: shared→non-shared transition emits node_destroyed on next flush', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        const node = createNode({ name: 'morphs' });
        addChild(server.nodes.root, node);

        // emit join_room synchronously with the populated scene
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // first flush: steady-state, expect no scene_sync updates
        const quiet = flushUntilQuiet(discovery, server.rooms, resources);
        expect(quiet.find(([, m]) => m.type === 'scene_sync')).toBeUndefined();

        // flip realm so the node should disappear from the client's view
        node.realm = 'server';

        const after = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = after.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();
        const update = (sync![1] as { updates: Array<{ type: string; id: number }> }).updates.find(
            (u) => u.type === 'node_destroyed' && u.id === node.id,
        );
        expect(update).toBeDefined();

        server.dispose();
    });

    it('play mode: scene_sync skips non-shared subtree on incremental sync', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        // emit empty join_room (only sg.root exists), then quiesce
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);

        // add mixed-realm nodes after join — incremental sync path
        const sharedX = createNode({ name: 'shared-X' });
        addChild(server.nodes.root, sharedX);
        const svr = createNode({ name: 'server-Y', realm: 'server' });
        addChild(server.nodes.root, svr);
        const sharedZ = createNode({ name: 'shared-Z', realm: 'shared' });
        addChild(svr, sharedZ);

        const messages = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = messages.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();

        const created = (sync![1] as { updates: Array<{ type: string; name?: string }> }).updates.filter(
            (u) => u.type === 'node_created',
        );
        const createdNames = created.map((u) => u.name);
        expect(createdNames).toContain('shared-X');
        expect(createdNames).not.toContain('server-Y');
        expect(createdNames).not.toContain('shared-Z');

        server.dispose();
    });
});
