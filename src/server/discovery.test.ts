import type { Client } from 'bongle/interface';
import { block } from 'bongle';
import { describe, expect, it } from 'vitest';
import { createTestServer } from '../../tst/integration/server-integration-test';
import { unpackPackedSceneGraph, unpackServerMessage } from '../core/protocol';
import * as Debug from '../core/debug';
import { addChild, addTrait, createNode, destroyNode, getNodeById, reparent, setRealm } from '../core/scene/nodes';
import { setPosition, TransformTrait } from '../builtins/transform';
import * as Resources from '../core/resources';
import { setBlock } from '../core/voxels/voxels';
import * as Discovery from './discovery';
import * as Net from './net';
import * as Rooms from './rooms';

/* ── helpers ── */

const FAKE_CLIENT: Client = 1;

// register a solid block once for the fairness suite (global registry singleton).
const FAIRNESS_BLOCK = 'fairness-stone';
block(FAIRNESS_BLOCK, { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });

/** per-player voxel knowledge for assertions (queue sizes, etc.). */
function voxelKnowledge(discovery: Discovery.Discovery, client: Client, playerId: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (discovery as any).clients.get(client)?.voxelKnowledge.get(playerId);
}

/** count voxel_chunk_full messages in a flush result. */
function countFull(out: Array<[Client, { type: string }]>): number {
    return out.filter(([, m]) => m.type === 'voxel_chunk_full').length;
}

/** collect the chunk coords shipped as voxel_chunk_full in a flush. */
function fullCoords(out: Array<[Client, { type: string }]>): Array<{ cx: number; cy: number; cz: number }> {
    const coords: Array<{ cx: number; cy: number; cz: number }> = [];
    for (const [, m] of out) {
        if (m.type !== 'voxel_chunk_full') continue;
        const f = m as { cx: number; cy: number; cz: number };
        coords.push({ cx: f.cx, cy: f.cy, cz: f.cz });
    }
    return coords;
}

/** simulate a client decoding + acking every full chunk in a flush. */
function ackFulls(discovery: Discovery.Discovery, playerId: number, out: Array<[Client, { type: string }]>): void {
    const full = fullCoords(out);
    if (full.length === 0) return;
    Discovery.handleVoxelAck(discovery, FAKE_CLIENT, { type: 'voxel_ack', playerId, full });
}

/** ack every full chunk in a flush, grouped by (client, playerId) — for the
 *  multi-client case where one flush carries messages for several clients. */
function ackAllFulls(discovery: Discovery.Discovery, out: Array<[Client, { type: string }]>): void {
    const groups = new Map<string, { client: Client; playerId: number; full: Array<{ cx: number; cy: number; cz: number }> }>();
    for (const [client, m] of out) {
        if (m.type !== 'voxel_chunk_full') continue;
        const f = m as { playerId: number; cx: number; cy: number; cz: number };
        const gk = `${client}:${f.playerId}`;
        let g = groups.get(gk);
        if (!g) {
            g = { client, playerId: f.playerId, full: [] };
            groups.set(gk, g);
        }
        g.full.push({ cx: f.cx, cy: f.cy, cz: f.cz });
    }
    for (const g of groups.values()) {
        Discovery.handleVoxelAck(discovery, g.client, { type: 'voxel_ack', playerId: g.playerId, full: g.full });
    }
}

function setupRoom(mode: 'edit' | 'play') {
    const server = createTestServer({ mode });
    const discovery = Discovery.init();
    const resources = Resources.init({ loadBytes: async () => new Uint8Array() }, 'server');
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
    return Discovery.flush(discovery, rooms, resources, Debug.createMetrics(false));
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
        setRealm(node, 'server');

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

    it('create ordering: reparent-fresh-under-fresh emits parent before child', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);

        // create c under root, create p under root, then reparent c under p — all
        // one tick. c was dirtied before p, but p is now c's parent, so the
        // fan-out must emit p's node_created before c's (depth order).
        const c = createNode({ name: 'child' });
        addChild(server.nodes.root, c);
        const p = createNode({ name: 'parent' });
        addChild(server.nodes.root, p);
        reparent(c, p);

        const messages = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = messages.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();
        const updates = (sync![1] as { updates: Array<{ type: string; id: number }> }).updates;
        const pCreate = updates.findIndex((u) => u.type === 'node_created' && u.id === p.id);
        const cCreate = updates.findIndex((u) => u.type === 'node_created' && u.id === c.id);
        expect(pCreate).toBeGreaterThanOrEqual(0);
        expect(cCreate).toBeGreaterThanOrEqual(0);
        expect(pCreate).toBeLessThan(cCreate);

        server.dispose();
    });

    it('idle: a tick with no changes emits no scene_sync', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        const n = createNode({ name: 'static' });
        addChild(server.nodes.root, n);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources); // drains the create
        const idle = flushUntilQuiet(discovery, server.rooms, resources);
        expect(idle.find(([, m]) => m.type === 'scene_sync')).toBeUndefined();
        server.dispose();
    });

    it('field change on a known node emits node_trait_fields incrementally', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        const n = createNode({ name: 'mover' });
        addChild(server.nodes.root, n);
        const t = addTrait(n, TransformTrait);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources); // drains the create

        setPosition(t, [10, 0, 0]); // well past the position threshold
        const out = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = out.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();
        const updates = (sync![1] as { updates: Array<{ type: string; id: number }> }).updates;
        expect(updates.some((u) => u.type === 'node_trait_fields' && u.id === n.id)).toBe(true);
        server.dispose();
    });

    it('play mode: non-shared→shared transition emits node_created (reveal)', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        const n = createNode({ name: 'reveal-me', realm: 'server' });
        addChild(server.nodes.root, n);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        // not shared yet → never sent to the play client
        const before = flushUntilQuiet(discovery, server.rooms, resources);
        expect(before.find(([, m]) => m.type === 'scene_sync')).toBeUndefined();

        setRealm(n, 'shared');
        const after = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = after.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();
        const created = (sync![1] as { updates: Array<{ type: string; id: number }> }).updates.find(
            (u) => u.type === 'node_created' && u.id === n.id,
        );
        expect(created).toBeDefined();
        server.dispose();
    });

    it('add → remove → add of the same node ends as a create, no destroy', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);

        const node = createNode({ name: 'flicker' });
        addChild(server.nodes.root, node);
        destroyNode(server.nodes, node);
        // re-add the same node object — it becomes live again this tick.
        addChild(server.nodes.root, node);

        const messages = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = messages.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();
        const updates = (sync![1] as { updates: Array<{ type: string; id: number }> }).updates;
        expect(updates.some((u) => u.type === 'node_created' && u.id === node.id)).toBe(true);
        expect(updates.some((u) => u.type === 'node_destroyed' && u.id === node.id)).toBe(false);
        // node is live in the graph at end of tick
        expect(getNodeById(server.nodes, node.id)).toBeDefined();

        server.dispose();
    });
});

describe('discovery — chunk_full fairness (dispatchFull)', () => {
    const FULL_CAP = 6; // FULL_CHUNKS_PER_CLIENT_PER_TICK
    const BACKLOG_CAP = 64; // DISCOVERY_BACKLOG_CAP
    const MAX_IN_FLIGHT = 24; // MAX_IN_FLIGHT_FULL

    it('caps voxel_chunk_full per tick and eventually delivers every occupied chunk', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // establish the streaming anchor (first flush sets lastAnchor).
        flushUntilQuiet(discovery, server.rooms, resources);
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        const [ax, ay, az] = k.lastAnchor as [number, number, number];

        // 3x3x3 = 27 occupied chunks hugging the anchor — all well within the
        // play-mode view radius (8), and > FULL_CAP so delivery spans ticks.
        const expected = new Set<string>();
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let l = 0; l < 3; l++) {
                    const cx = ax + i, cy = ay + j, cz = az + l;
                    setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
                    expected.add(`${cx},${cy},${cz}`);
                }

        const seen = new Set<string>();
        let maxPerTick = 0;
        for (let tick = 0; tick < 12; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            const fulls = out.filter(([, m]) => m.type === 'voxel_chunk_full');
            maxPerTick = Math.max(maxPerTick, fulls.length);
            for (const [, m] of fulls) {
                const f = m as { cx: number; cy: number; cz: number };
                seen.add(`${f.cx},${f.cy},${f.cz}`);
            }
            // ack each tick so the in-flight window keeps freeing (fast client).
            ackFulls(discovery, player.id, out);
        }

        expect(maxPerTick).toBeLessThanOrEqual(FULL_CAP);
        // every occupied chunk eventually shipped exactly once.
        for (const key of expected) expect(seen.has(key)).toBe(true);
        expect(seen.size).toBe(expected.size);

        server.dispose();
    });

    it('in-flight window stalls delivery at MAX_IN_FLIGHT_FULL without acks, resumes after ack', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        const [ax, ay, az] = k.lastAnchor as [number, number, number];

        // 48 occupied chunks (4x4x3) hugging the anchor — more than the 24-slot
        // in-flight window, all within the edit view radius.
        for (let i = 0; i < 4; i++)
            for (let j = 0; j < 4; j++)
                for (let l = 0; l < 3; l++) {
                    setBlock(server.room.voxels, (ax + i) * 16, (ay + j) * 16, (az + l) * 16, FAIRNESS_BLOCK);
                }

        // flush repeatedly WITHOUT acking — delivery must stall at the window.
        const shipped: Array<{ cx: number; cy: number; cz: number }> = [];
        for (let tick = 0; tick < 20; tick++) {
            shipped.push(...fullCoords(flushUntilQuiet(discovery, server.rooms, resources)));
        }
        expect(shipped.length).toBe(MAX_IN_FLIGHT);
        expect(k.inFlightFull.size).toBe(MAX_IN_FLIGHT);

        // ack everything in flight → frees the window → delivery resumes.
        Discovery.handleVoxelAck(discovery, FAKE_CLIENT, { type: 'voxel_ack', playerId: player.id, full: shipped });
        expect(k.inFlightFull.size).toBe(0);
        const after = countFull(flushUntilQuiet(discovery, server.rooms, resources));
        expect(after).toBeGreaterThan(0);

        server.dispose();
    });

    it('a chunk shipped as full does not also get a separate light message that tick', () => {
        // regression for the lightSentInFull -> knownChunks-guard flip: placing
        // a block dirties the chunk's light, but the chunk ships as a fresh
        // voxel_chunk_full (light in-payload), so it must NOT also appear in a
        // voxel_chunk_light / _delta the same tick.
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        const [ax, ay, az] = k.lastAnchor as [number, number, number];

        setBlock(server.room.voxels, ax * 16, ay * 16, az * 16, FAIRNESS_BLOCK);

        // walk ticks until the chunk ships as full, checking disjointness each tick.
        const fullKey = `${ax},${ay},${az}`;
        let shippedAsFull = false;
        for (let tick = 0; tick < 12 && !shippedAsFull; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            const fullThisTick = new Set<string>();
            const lightThisTick = new Set<string>();
            for (const [, m] of out) {
                if (m.type === 'voxel_chunk_full') {
                    const f = m as { cx: number; cy: number; cz: number };
                    fullThisTick.add(`${f.cx},${f.cy},${f.cz}`);
                } else if (m.type === 'voxel_chunk_light' || m.type === 'voxel_chunk_light_delta') {
                    const lm = m as { cx: number; cy: number; cz: number };
                    lightThisTick.add(`${lm.cx},${lm.cy},${lm.cz}`);
                }
            }
            // no chunk appears in both channels in the same tick.
            for (const key of fullThisTick) expect(lightThisTick.has(key)).toBe(false);
            if (fullThisTick.has(fullKey)) shippedAsFull = true;
        }

        expect(shippedAsFull).toBe(true);
        server.dispose();
    });

    it('discovery backlog stays bounded by DISCOVERY_BACKLOG_CAP in one tick', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // 75 occupied chunks in a 5x5x3 block near the anchor — well inside the
        // edit view radius, and more than BACKLOG_CAP (64).
        let placed = 0;
        for (let cx = 0; cx < 5; cx++)
            for (let cy = 0; cy < 5; cy++)
                for (let cz = 0; cz < 3; cz++) {
                    setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
                    placed++;
                }
        expect(placed).toBe(75);

        flushUntilQuiet(discovery, server.rooms, resources);

        // after one flush: dispatchFull shipped some, the rest sit in pendingFull,
        // and discovery stopped filling at the cap (minus what dispatch drained).
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        expect(k).toBeDefined();
        expect(k.pendingFull.size).toBeLessThanOrEqual(BACKLOG_CAP);

        server.dispose();
    });

    it('global cap bounds total egress across players (no linear scaling, no starvation)', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        // add two more clients + players in the same room (harness is
        // single-client by default). all three share the [0,0,0] anchor since
        // the test never builds player scene nodes — maximal contention.
        const CLIENT_2: Client = 2;
        const CLIENT_3: Client = 3;
        Discovery.addClient(discovery, CLIENT_2);
        Discovery.addClient(discovery, CLIENT_3);
        const player2 = Rooms.joinRoom(server.rooms, CLIENT_2, server.room.id, server.room.mode);
        const player3 = Rooms.joinRoom(server.rooms, CLIENT_3, server.room.id, server.room.mode);
        const roster = [
            { client: FAKE_CLIENT, id: player.id },
            { client: CLIENT_2, id: player2.id },
            { client: CLIENT_3, id: player3.id },
        ];
        for (const r of roster) {
            Discovery.invalidatePlayer(discovery, net, server.rooms, resources, Rooms.getPlayer(server.rooms, r.id)!);
        }
        flushUntilQuiet(discovery, server.rooms, resources); // establish anchors

        // 27 occupied chunks (3x3x3) at the shared origin anchor.
        const expected = new Set<string>();
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let l = 0; l < 3; l++) {
                    setBlock(server.room.voxels, i * 16, j * 16, l * 16, FAIRNESS_BLOCK);
                    expected.add(`${i},${j},${l}`);
                }

        const N_PLAYERS = 3;
        const globalCap = Math.floor((N_PLAYERS + 8) * FULL_CAP / 4) + 1; // ROOM_MAX_USERS = 8 → 17
        const seenByClient = new Map<Client, Set<string>>(roster.map((r) => [r.client, new Set<string>()]));
        let checkedContention = false;

        for (let tick = 0; tick < 15; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);

            const perClient = new Map<Client, number>();
            // (client, chunk) shipped as full vs light this tick — must be
            // disjoint per client (a full carries light in-payload).
            const fullPerClient = new Map<Client, Set<string>>();
            const lightPerClient = new Map<Client, Set<string>>();
            for (const [client, m] of out) {
                if (m.type === 'voxel_chunk_full') {
                    const f = m as { cx: number; cy: number; cz: number };
                    perClient.set(client, (perClient.get(client) ?? 0) + 1);
                    seenByClient.get(client)!.add(`${f.cx},${f.cy},${f.cz}`);
                    (fullPerClient.get(client) ?? fullPerClient.set(client, new Set()).get(client)!).add(`${f.cx},${f.cy},${f.cz}`);
                } else if (m.type === 'voxel_chunk_light' || m.type === 'voxel_chunk_light_delta') {
                    const l = m as { cx: number; cy: number; cz: number };
                    (lightPerClient.get(client) ?? lightPerClient.set(client, new Set()).get(client)!).add(`${l.cx},${l.cy},${l.cz}`);
                }
            }
            const total = [...perClient.values()].reduce((a, b) => a + b, 0);

            // invariants every tick: per-client burst cap + global cap.
            for (const c of perClient.values()) expect(c).toBeLessThanOrEqual(FULL_CAP);
            expect(total).toBeLessThanOrEqual(globalCap);

            // multi-player dedup: no client gets a chunk as both full + light.
            for (const [client, fulls] of fullPerClient) {
                const lights = lightPerClient.get(client);
                if (!lights) continue;
                for (const key of fulls) expect(lights.has(key)).toBe(false);
            }

            // first fully-contended tick: no client starved, and the global cap
            // actually held egress below the naive per-client sum (3 × 6 = 18).
            if (!checkedContention && total > 0) {
                checkedContention = true;
                expect(perClient.get(FAKE_CLIENT) ?? 0).toBeGreaterThan(0);
                expect(perClient.get(CLIENT_2) ?? 0).toBeGreaterThan(0);
                expect(perClient.get(CLIENT_3) ?? 0).toBeGreaterThan(0);
                expect(total).toBeLessThan(N_PLAYERS * FULL_CAP);
            }

            ackAllFulls(discovery, out); // fast clients ack each tick
        }

        // with acks, every client eventually receives every chunk.
        for (const r of roster) {
            const seen = seenByClient.get(r.client)!;
            for (const key of expected) expect(seen.has(key)).toBe(true);
            expect(seen.size).toBe(expected.size);
        }

        server.dispose();
    });

    it('eviction clears inFlightFull for chunks that drift out of range', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // give the player a movable node so getPlayerChunkCoord tracks position
        // (the default harness has no node → anchor pinned at origin).
        const node = createNode({ name: 'p' });
        addChild(server.nodes.root, node);
        const t = addTrait(node, TransformTrait);
        setPosition(t, [0, 0, 0]);
        server.room.playerNodes.set(player.id, node);

        // occupied chunks at the origin anchor; flush WITHOUT acking so they
        // sit in inFlightFull.
        for (let i = 0; i < 3; i++) setBlock(server.room.voxels, i * 16, 0, 0, FAIRNESS_BLOCK);
        flushUntilQuiet(discovery, server.rooms, resources);
        flushUntilQuiet(discovery, server.rooms, resources);

        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        expect(k.inFlightFull.size).toBeGreaterThan(0);
        const inFlightBefore = new Set<string>(k.inFlightFull);

        // teleport far away → anchor cross → eviction sweep.
        setPosition(t, [1000, 0, 0]);
        flushUntilQuiet(discovery, server.rooms, resources);

        // every previously in-flight chunk is now out of range and dropped.
        for (const key of inFlightBefore) expect(k.inFlightFull.has(key)).toBe(false);
        expect(k.inFlightFull.size).toBe(0);

        server.dispose();
    });

    it('promotion while in-flight re-queues the chunk and drops the in-flight slot', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        const [ax, ay, az] = k.lastAnchor as [number, number, number];
        const key = `${ax},${ay},${az}`;

        // one block → chunk ships as full; do NOT ack, so it sits in-flight.
        setBlock(server.room.voxels, ax * 16, ay * 16, az * 16, FAIRNESS_BLOCK);
        flushUntilQuiet(discovery, server.rooms, resources);
        expect(k.inFlightFull.has(key)).toBe(true);
        expect(k.knownChunks.has(key)).toBe(true);

        // > PROMOTION_THRESHOLD (CHUNK_VOLUME/2 = 2048) edits in that chunk this
        // tick → promotion. fill 9 of 16 y-layers (16*9*16 = 2304 voxels).
        for (let y = 0; y < 9; y++)
            for (let z = 0; z < 16; z++)
                for (let x = 0; x < 16; x++) {
                    setBlock(server.room.voxels, ax * 16 + x, ay * 16 + y, az * 16 + z, FAIRNESS_BLOCK);
                }
        const out = flushUntilQuiet(discovery, server.rooms, resources);

        // promoted: dropped from in-flight + known, re-queued, and re-shipped as
        // a fresh full this tick (so it's back in-flight from the re-send).
        expect(fullCoords(out).some((c) => c.cx === ax && c.cy === ay && c.cz === az)).toBe(true);
        expect(k.knownChunks.has(key)).toBe(true); // re-added by the re-ship
        expect(k.inFlightFull.has(key)).toBe(true); // re-ship put it back in flight

        server.dispose();
    });

    it('all 75 occupied chunks drain over successive ticks without duplicates', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        const expected = new Set<string>();
        for (let cx = 0; cx < 5; cx++)
            for (let cy = 0; cy < 5; cy++)
                for (let cz = 0; cz < 3; cz++) {
                    setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
                    expected.add(`${cx},${cy},${cz}`);
                }

        const seen = new Set<string>();
        let duplicates = 0;
        for (let tick = 0; tick < 40; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            for (const [, m] of out) {
                if (m.type !== 'voxel_chunk_full') continue;
                const f = m as { cx: number; cy: number; cz: number };
                const key = `${f.cx},${f.cy},${f.cz}`;
                if (seen.has(key)) duplicates++;
                seen.add(key);
            }
            // ack each tick so the in-flight window drains (fast client).
            ackFulls(discovery, player.id, out);
        }

        expect(duplicates).toBe(0);
        for (const key of expected) expect(seen.has(key)).toBe(true);

        server.dispose();
    });
});
