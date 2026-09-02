import type { Client } from 'bongle/interface';
import { describe, expect, it } from 'vitest';
import { getWorldPosition, setPosition, TransformTrait } from '../../../src/builtins/transform';
import * as Debug from '../../../src/core/debug';
import { unpackPackedSceneTree, unpackServerMessage } from '../../../src/core/protocol';
import * as Resources from '../../../src/core/resources';
import {
    addChild,
    addTrait,
    createNode,
    destroyNode,
    getNodeById,
    getTrait,
    reparent,
    setRealm,
} from '../../../src/core/scene/scene-tree';
import { block } from '../../../src/core/voxels/blocks';
import { chunkToRegionCoord, REGION_CHUNKS_PER_AXIS, setBlock, toChunkCoord } from '../../../src/core/voxels/voxels';
import { nodeZstd } from '../../../src/node/zstd';
import * as Discovery from '../../../src/server/discovery';
import * as Net from '../../../src/server/net';
import * as Rooms from '../../../src/server/rooms';
import { createTestServer, type TestServer } from '../../integration/server-integration-test';

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

/** the player's streaming anchor in CHUNK coords (mirrors discovery.ts's private
 *  getPlayerChunkCoord) — used to place occupied chunks at/around the anchor,
 *  independent of ClientVoxelKnowledge's internal (region-grained) bookkeeping. */
function playerChunkCoord(server: TestServer, playerId: number): [number, number, number] {
    const node = server.room.playerNodes.get(playerId);
    const t = node && getTrait(node, TransformTrait);
    if (!t) return [0, 0, 0]; // the default harness has no player node → anchor pinned at origin
    const pos = getWorldPosition(t);
    return [toChunkCoord(Math.floor(pos[0])), toChunkCoord(Math.floor(pos[1])), toChunkCoord(Math.floor(pos[2]))];
}

/** N small region-offsets (in region units) from (0,0,0), ordered by distance,
 *  all within a radius-2-region sphere (the default MIN_STREAM_RADIUS(8 chunks)
 *  → regionRadius(2) these tests run at, no explicit viewRadius bump needed).
 *  used to place occupied chunks in several DISTINCT, simultaneously in-range
 *  regions without relying on any one axis reaching past the sphere. */
const REGION_OFFSETS: Array<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
];

/** one chunk coord inside the region at `[ax,ay,az] chunks + offset regions`
 *  (the region's local (0,0,0) corner chunk — enough to make that region
 *  discoverable/occupied, these tests don't need more than one per region). */
function chunkInRegion(ax: number, ay: number, az: number, offset: [number, number, number]): [number, number, number] {
    return [
        ax + offset[0] * REGION_CHUNKS_PER_AXIS,
        ay + offset[1] * REGION_CHUNKS_PER_AXIS,
        az + offset[2] * REGION_CHUNKS_PER_AXIS,
    ];
}

function regionKeyOf(cx: number, cy: number, cz: number): string {
    return `${chunkToRegionCoord(cx)},${chunkToRegionCoord(cy)},${chunkToRegionCoord(cz)}`;
}

/** count voxel_chunk_full messages (PROMOTION channel) in a flush result. */
function countFull(out: Array<[Client, { type: string }]>): number {
    return out.filter(([, m]) => m.type === 'voxel_chunk_full').length;
}

/** collect the chunk coords shipped as voxel_chunk_full (promotion) in a flush. */
function fullCoords(out: Array<[Client, { type: string }]>): Array<{ cx: number; cy: number; cz: number }> {
    const coords: Array<{ cx: number; cy: number; cz: number }> = [];
    for (const [, m] of out) {
        if (m.type !== 'voxel_chunk_full') continue;
        const f = m as unknown as { cx: number; cy: number; cz: number };
        coords.push({ cx: f.cx, cy: f.cy, cz: f.cz });
    }
    return coords;
}

/** collect the voxel_region_full messages (DISCOVERY channel) in a flush. */
function regionFullMessages(
    out: Array<[Client, { type: string }]>,
): Array<{ client: Client; rx: number; ry: number; rz: number; occupied: boolean[] }> {
    const regions: Array<{ client: Client; rx: number; ry: number; rz: number; occupied: boolean[] }> = [];
    for (const [client, m] of out) {
        if (m.type !== 'voxel_region_full') continue;
        const r = m as unknown as { rx: number; ry: number; rz: number; occupied: boolean[] };
        regions.push({ client, rx: r.rx, ry: r.ry, rz: r.rz, occupied: r.occupied });
    }
    return regions;
}

// a fast, steady client for these fairness tests — reports the seeded default
// rate, so acking never itself changes the per-tick budget these tests assert on.
const DEFAULT_DESIRED_REGIONS_PER_TICK = 1; // matches DEFAULT_REGIONS_PER_TICK

/** simulate a client decoding + acking every region in a flush (voxel_region_full,
 *  the DISCOVERY channel), reporting `desiredRegionsPerTick`. */
function ackRegions(
    discovery: Discovery.Discovery,
    playerId: number,
    out: Array<[Client, { type: string }]>,
    desiredRegionsPerTick = DEFAULT_DESIRED_REGIONS_PER_TICK,
): void {
    const regions = regionFullMessages(out).map((r) => ({ rx: r.rx, ry: r.ry, rz: r.rz }));
    if (regions.length === 0) return;
    Discovery.handleVoxelAck(discovery, FAKE_CLIENT, { type: 'voxel_ack', playerId, full: [], regions, desiredRegionsPerTick });
}

function setupRoom(mode: 'edit' | 'play') {
    const server = createTestServer({ mode });
    const discovery = Discovery.init(nodeZstd);
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

function flushUntilQuiet(discovery: Discovery.Discovery, rooms: Rooms.Rooms, resources: Resources.Resources) {
    return Discovery.flush(discovery, rooms, resources, Debug.createMetrics(false));
}

/* ── tests ── */

describe('discovery — realm filtering', () => {
    it('play mode: join_room packed scene excludes non-shared subtree', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        // shared node, should appear
        const sharedA = createNode({ name: 'shared-A' });
        addChild(server.room.scene.root, sharedA);
        // server-only node with a shared descendant, entire subtree pruned
        const serverOnly = createNode({ name: 'server-B', realm: 'server' });
        addChild(server.room.scene.root, serverOnly);
        const sharedC = createNode({ name: 'shared-C', realm: 'shared' });
        addChild(serverOnly, sharedC);

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const join = takeJoinRoom(net, FAKE_CLIENT);
        const names = unpackPackedSceneTree(join.packedNodes).nodes.map((n: any) => n.name);

        expect(names).toContain('shared-A');
        expect(names).not.toContain('server-B');
        expect(names).not.toContain('shared-C');

        server.dispose();
    });

    it('edit mode: join_room packed scene includes everything regardless of realm', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');

        const sharedA = createNode({ name: 'shared-A' });
        addChild(server.room.scene.root, sharedA);
        const serverOnly = createNode({ name: 'server-B', realm: 'server' });
        addChild(server.room.scene.root, serverOnly);
        const sharedC = createNode({ name: 'shared-C', realm: 'shared' });
        addChild(serverOnly, sharedC);

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const join = takeJoinRoom(net, FAKE_CLIENT);
        const names = unpackPackedSceneTree(join.packedNodes).nodes.map((n: any) => n.name);

        expect(names).toContain('shared-A');
        expect(names).toContain('server-B');
        expect(names).toContain('shared-C');

        server.dispose();
    });

    it('play mode: shared→non-shared transition emits node_destroyed on next flush', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        const node = createNode({ name: 'morphs' });
        addChild(server.room.scene.root, node);

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

        // emit empty join_room (only sceneTree.root exists), then quiesce
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources);

        // add mixed-realm nodes after join, incremental sync path
        const sharedX = createNode({ name: 'shared-X' });
        addChild(server.room.scene.root, sharedX);
        const svr = createNode({ name: 'server-Y', realm: 'server' });
        addChild(server.room.scene.root, svr);
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

        // create c under root, create p under root, then reparent c under p, all
        // one tick. c was dirtied before p, but p is now c's parent, so the
        // fan-out must emit p's node_created before c's (depth order).
        const c = createNode({ name: 'child' });
        addChild(server.room.scene.root, c);
        const p = createNode({ name: 'parent' });
        addChild(server.room.scene.root, p);
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
        addChild(server.room.scene.root, n);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flushUntilQuiet(discovery, server.rooms, resources); // drains the create
        const idle = flushUntilQuiet(discovery, server.rooms, resources);
        expect(idle.find(([, m]) => m.type === 'scene_sync')).toBeUndefined();
        server.dispose();
    });

    it('field change on a known node emits node_trait_fields incrementally', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        const n = createNode({ name: 'mover' });
        addChild(server.room.scene.root, n);
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
        addChild(server.room.scene.root, n);
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
        addChild(server.room.scene.root, node);
        destroyNode(server.room.scene, node);
        // re-add the same node object, it becomes live again this tick.
        addChild(server.room.scene.root, node);

        const messages = flushUntilQuiet(discovery, server.rooms, resources);
        const sync = messages.find(([, m]) => m.type === 'scene_sync');
        expect(sync).toBeDefined();
        const updates = (sync![1] as { updates: Array<{ type: string; id: number }> }).updates;
        expect(updates.some((u) => u.type === 'node_created' && u.id === node.id)).toBe(true);
        expect(updates.some((u) => u.type === 'node_destroyed' && u.id === node.id)).toBe(false);
        // node is live in the graph at end of tick
        expect(getNodeById(server.room.scene, node.id)).toBeDefined();

        server.dispose();
    });
});

describe('discovery — region_full fairness (dispatchRegionFull)', () => {
    const DEFAULT_CAP = 1; // DEFAULT_REGIONS_PER_TICK
    const MAX_IN_FLIGHT_REGIONS = 4; // MAX_IN_FLIGHT_REGIONS

    it('caps voxel_region_full per tick and eventually delivers every occupied region', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const [ax, ay, az] = playerChunkCoord(server, player.id);

        // one occupied chunk in each of 5 distinct, simultaneously in-range
        // regions — more than DEFAULT_CAP(1) so delivery spans ticks. placed
        // BEFORE the first flush: discovery must see them already occupied,
        // rather than a first flush shipping these regions as empty and a
        // later setBlock re-routing through the individual promotion channel.
        const expected = new Set<string>();
        for (const offset of REGION_OFFSETS.slice(0, 5)) {
            const [cx, cy, cz] = chunkInRegion(ax, ay, az, offset);
            setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
            expected.add(regionKeyOf(cx, cy, cz));
        }

        // the anchor's full radius-2 region sphere (~33 cells) is all pending
        // from the first flush, most of it air; dispatch ships nearest-first
        // regardless of occupancy, so the 5 target regions may not be first —
        // give it enough ticks to drain the whole sphere at 1/tick.
        const seen = new Set<string>();
        let maxPerTick = 0;
        for (let tick = 0; tick < 40; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            const regions = regionFullMessages(out);
            maxPerTick = Math.max(maxPerTick, regions.length);
            for (const r of regions) seen.add(`${r.rx},${r.ry},${r.rz}`);
            // ack each tick so the in-flight window keeps freeing (fast client).
            ackRegions(discovery, player.id, out);
        }

        expect(maxPerTick).toBeLessThanOrEqual(DEFAULT_CAP);
        // every occupied region eventually shipped exactly once.
        for (const key of expected) expect(seen.has(key)).toBe(true);

        server.dispose();
    });

    it('a fresh join stalls at maxInFlightRegions=1 until the first ack, then ramps to MAX_IN_FLIGHT_REGIONS', () => {
        // mirrors Minecraft's PlayerChunkSender: maxUnacknowledgedBatches starts
        // at 1 for a brand-new connection and only becomes 10 after that
        // player's first batch ack — so a fresh join (which may need to freshly
        // recompress a lot of chunks whose cache went stale from other players'
        // edits) can't get more than one region's worth of fresh compression
        // per tick until it's proven it can keep up.
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        const [ax, ay, az] = playerChunkCoord(server, player.id);

        // one occupied chunk in each of ALL 8 REGION_OFFSETS regions — more than
        // either in-flight ceiling. placed BEFORE the first flush (see the
        // "caps..." test above for why).
        for (const offset of REGION_OFFSETS) {
            const [cx, cy, cz] = chunkInRegion(ax, ay, az, offset);
            setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
        }

        // stage 1: before ANY ack, capped at the join-time seed (1), not the
        // full ceiling (4).
        const shipped: Array<{ rx: number; ry: number; rz: number }> = [];
        for (let tick = 0; tick < 20; tick++) {
            shipped.push(...regionFullMessages(flushUntilQuiet(discovery, server.rooms, resources)));
        }
        expect(k.maxInFlightRegions).toBe(1);
        expect(shipped.length).toBe(1);
        expect(k.inFlightRegions.size).toBe(1);

        // stage 2: the first ack (confirming a region) lifts the ceiling.
        Discovery.handleVoxelAck(discovery, FAKE_CLIENT, {
            type: 'voxel_ack',
            playerId: player.id,
            full: [],
            regions: shipped,
            desiredRegionsPerTick: DEFAULT_DESIRED_REGIONS_PER_TICK,
        });
        expect(k.maxInFlightRegions).toBe(MAX_IN_FLIGHT_REGIONS);
        expect(k.inFlightRegions.size).toBe(0);

        // stage 3: without acking again, delivery now stalls at the FULL ceiling.
        const shipped2: Array<{ rx: number; ry: number; rz: number }> = [];
        for (let tick = 0; tick < 20; tick++) {
            shipped2.push(...regionFullMessages(flushUntilQuiet(discovery, server.rooms, resources)));
        }
        expect(shipped2.length).toBe(MAX_IN_FLIGHT_REGIONS);
        expect(k.inFlightRegions.size).toBe(MAX_IN_FLIGHT_REGIONS);

        server.dispose();
    });

    it('a region shipped as full does not also get a separate light message that tick', () => {
        // regression for the fullShippedChunks -> knownChunks-guard flip: placing
        // a block dirties the chunk's light, but the chunk ships inside a fresh
        // voxel_region_full (light in-payload), so it must NOT also appear in a
        // voxel_chunk_light / _delta the same tick.
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const [ax, ay, az] = playerChunkCoord(server, player.id);

        // placed BEFORE the first flush (see the "caps..." test above for why).
        setBlock(server.room.voxels, ax * 16, ay * 16, az * 16, FAIRNESS_BLOCK);

        // walk ticks until the region ships as full, checking disjointness each
        // tick (up to the full ~33-region sphere at 1/tick, see "caps...").
        const targetRegion = regionKeyOf(ax, ay, az);
        let shippedAsFull = false;
        for (let tick = 0; tick < 40 && !shippedAsFull; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            const regionsThisTick = new Set(regionFullMessages(out).map((r) => `${r.rx},${r.ry},${r.rz}`));
            const lightThisTick = new Set<string>();
            for (const [, m] of out) {
                if (m.type === 'voxel_chunk_light' || m.type === 'voxel_chunk_light_delta') {
                    const lm = m as { cx: number; cy: number; cz: number };
                    lightThisTick.add(`${lm.cx},${lm.cy},${lm.cz}`);
                }
            }
            // the target chunk never appears in the light channel the same
            // tick its containing region shipped as full.
            if (regionsThisTick.has(targetRegion)) {
                expect(lightThisTick.has(`${ax},${ay},${az}`)).toBe(false);
                shippedAsFull = true;
            }
        }

        expect(shippedAsFull).toBe(true);
        server.dispose();
    });

    it('global cap bounds total egress across players (no linear scaling, no starvation)', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');

        // add two more clients + players in the same room (harness is
        // single-client by default). all three share the [0,0,0] anchor since
        // the test never builds player scene nodes, maximal contention.
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
        // one occupied chunk in each of 5 distinct regions at the shared origin
        // anchor, placed BEFORE invalidatePlayer/the first flush (see the
        // "caps..." test above for why).
        const expected = new Set<string>();
        for (const offset of REGION_OFFSETS.slice(0, 5)) {
            const [cx, cy, cz] = chunkInRegion(0, 0, 0, offset);
            setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
            expected.add(regionKeyOf(cx, cy, cz));
        }

        for (const r of roster) {
            Discovery.invalidatePlayer(discovery, net, server.rooms, resources, Rooms.getPlayer(server.rooms, r.id)!);
        }

        const N_PLAYERS = 3;
        const globalCap = Math.floor(((N_PLAYERS + 8) * DEFAULT_CAP) / 4) + 1; // ROOM_MAX_USERS = 8 → 3
        const seenByClient = new Map<Client, Set<string>>(roster.map((r) => [r.client, new Set<string>()]));
        let checkedContention = false;

        // each player's own radius-2 region sphere (~33 cells) competes for
        // dispatch order the same way as "caps..." above, so give it room.
        for (let tick = 0; tick < 40; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);

            const perClient = new Map<Client, number>();
            for (const r of regionFullMessages(out)) {
                perClient.set(r.client, (perClient.get(r.client) ?? 0) + 1);
                seenByClient.get(r.client)!.add(`${r.rx},${r.ry},${r.rz}`);
            }
            const total = [...perClient.values()].reduce((a, b) => a + b, 0);

            // invariants every tick: per-client burst cap + global cap.
            for (const c of perClient.values()) expect(c).toBeLessThanOrEqual(DEFAULT_CAP);
            expect(total).toBeLessThanOrEqual(globalCap);

            // first fully-contended tick: no client starved.
            if (!checkedContention && total >= 3) {
                checkedContention = true;
                expect(perClient.get(FAKE_CLIENT) ?? 0).toBeGreaterThan(0);
                expect(perClient.get(CLIENT_2) ?? 0).toBeGreaterThan(0);
                expect(perClient.get(CLIENT_3) ?? 0).toBeGreaterThan(0);
            }

            ackAllRegions(discovery, out); // fast clients ack each tick
        }

        // with acks, every client eventually receives every targeted region
        // (each also receives its whole ~33-region sphere, not just these 5).
        for (const r of roster) {
            const seen = seenByClient.get(r.client)!;
            for (const key of expected) expect(seen.has(key)).toBe(true);
        }

        server.dispose();

        function ackAllRegions(d: Discovery.Discovery, o: Array<[Client, { type: string }]>): void {
            const groups = new Map<Client, Array<{ rx: number; ry: number; rz: number }>>();
            for (const r of regionFullMessages(o)) {
                let g = groups.get(r.client);
                if (!g) {
                    g = [];
                    groups.set(r.client, g);
                }
                g.push({ rx: r.rx, ry: r.ry, rz: r.rz });
            }
            for (const [client, regions] of groups) {
                const owner = roster.find((r) => r.client === client)!;
                Discovery.handleVoxelAck(d, client, {
                    type: 'voxel_ack',
                    playerId: owner.id,
                    full: [],
                    regions,
                    desiredRegionsPerTick: DEFAULT_DESIRED_REGIONS_PER_TICK,
                });
            }
        }
    });

    it('eviction clears inFlightRegions for regions that drift out of range', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // give the player a movable node so getPlayerChunkCoord tracks position
        // (the default harness has no node → anchor pinned at origin).
        const node = createNode({ name: 'p' });
        addChild(server.room.scene.root, node);
        const t = addTrait(node, TransformTrait);
        setPosition(t, [0, 0, 0]);
        server.room.playerNodes.set(player.id, node);

        // an occupied chunk at the origin anchor; flush WITHOUT acking so its
        // region sits in inFlightRegions.
        setBlock(server.room.voxels, 0, 0, 0, FAIRNESS_BLOCK);
        flushUntilQuiet(discovery, server.rooms, resources);
        flushUntilQuiet(discovery, server.rooms, resources);

        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        expect(k.inFlightRegions.size).toBeGreaterThan(0);
        const inFlightBefore = new Set<string>(k.inFlightRegions);

        // teleport far away → anchor cross → eviction sweep. rediscovery at the
        // new anchor is immediate (same tick, unbudgeted), so a NEW nearby
        // region may take a slot in inFlightRegions right away — assert the
        // OLD keys are gone, not that the set is empty.
        setPosition(t, [10000, 0, 0]);
        flushUntilQuiet(discovery, server.rooms, resources);

        for (const key of inFlightBefore) expect(k.inFlightRegions.has(key)).toBe(false);

        server.dispose();
    });

    it('all occupied regions drain over successive ticks without duplicates', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const [ax, ay, az] = playerChunkCoord(server, player.id);

        const expected = new Set<string>();
        for (const offset of REGION_OFFSETS) {
            const [cx, cy, cz] = chunkInRegion(ax, ay, az, offset);
            setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
            expected.add(regionKeyOf(cx, cy, cz));
        }

        const seen = new Set<string>();
        let duplicates = 0;
        for (let tick = 0; tick < 40; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            for (const r of regionFullMessages(out)) {
                const key = `${r.rx},${r.ry},${r.rz}`;
                if (seen.has(key)) duplicates++;
                seen.add(key);
            }
            // ack each tick so the in-flight window drains (fast client).
            ackRegions(discovery, player.id, out);
        }

        expect(duplicates).toBe(0);
        for (const key of expected) expect(seen.has(key)).toBe(true);

        server.dispose();
    });
});

describe('discovery — chunk_full fairness (dispatchFull, promotion only)', () => {
    const FULL_CAP = 6; // FULL_CHUNKS_PER_CLIENT_PER_TICK
    const MAX_IN_FLIGHT = 24; // MAX_IN_FLIGHT_FULL

    it('promotion while in-flight re-queues the chunk and drops the in-flight slot', () => {
        const { server, discovery, net, player, resources } = setupRoom('play');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const [ax, ay, az] = playerChunkCoord(server, player.id);
        const key = `${ax},${ay},${az}`;

        // discover + fully settle the chunk via the region channel first (it
        // must be KNOWN before promotion, which only re-sends an
        // already-known chunk).
        setBlock(server.room.voxels, ax * 16, ay * 16, az * 16, FAIRNESS_BLOCK);
        for (let tick = 0; tick < 5; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            ackRegions(discovery, player.id, out);
        }
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        expect(k.knownChunks.has(key)).toBe(true);

        // > PROMOTION_THRESHOLD (CHUNK_VOLUME/2 = 2048) edits in that chunk this
        // tick → promotion. fill 9 of 16 y-layers (16*9*16 = 2304 voxels).
        for (let y = 0; y < 9; y++)
            for (let z = 0; z < 16; z++)
                for (let x = 0; x < 16; x++) {
                    setBlock(server.room.voxels, ax * 16 + x, ay * 16 + y, az * 16 + z, FAIRNESS_BLOCK);
                }
        const out = flushUntilQuiet(discovery, server.rooms, resources);

        // promoted: dropped from known, re-queued, and re-shipped as a fresh
        // individual voxel_chunk_full this tick (so it's back in-flight).
        expect(fullCoords(out).some((c) => c.cx === ax && c.cy === ay && c.cz === az)).toBe(true);
        expect(k.knownChunks.has(key)).toBe(true); // re-added by the re-ship
        expect(k.inFlightFull.has(key)).toBe(true); // re-ship put it back in flight

        server.dispose();
    });

    it('caps voxel_chunk_full promotions per tick at FULL_CHUNKS_PER_CLIENT_PER_TICK', () => {
        const { server, discovery, net, player, resources } = setupRoom('edit');
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        const [ax, ay, az] = playerChunkCoord(server, player.id);

        // discover + settle 9 chunks (a 3x3 patch, one region) via the region
        // channel first, so all 9 are KNOWN before any promotion.
        const chunks: Array<[number, number, number]> = [];
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++) {
                const cx = ax + i;
                const cy = ay;
                const cz = az + j;
                setBlock(server.room.voxels, cx * 16, cy * 16, cz * 16, FAIRNESS_BLOCK);
                chunks.push([cx, cy, cz]);
            }
        for (let tick = 0; tick < 5; tick++) {
            const out = flushUntilQuiet(discovery, server.rooms, resources);
            ackRegions(discovery, player.id, out);
        }
        const k = voxelKnowledge(discovery, FAKE_CLIENT, player.id);
        for (const [cx, cy, cz] of chunks) expect(k.knownChunks.has(`${cx},${cy},${cz}`)).toBe(true);

        // promote all 9 in the same tick (> PROMOTION_THRESHOLD edits each).
        for (const [cx, cy, cz] of chunks) {
            for (let y = 0; y < 9; y++)
                for (let z = 0; z < 16; z++)
                    for (let x = 0; x < 16; x++) {
                        setBlock(server.room.voxels, cx * 16 + x, cy * 16 + y, cz * 16 + z, FAIRNESS_BLOCK);
                    }
        }
        const out = flushUntilQuiet(discovery, server.rooms, resources);

        expect(countFull(out)).toBeLessThanOrEqual(FULL_CAP);
        expect(countFull(out)).toBeGreaterThan(0);
        expect(k.inFlightFull.size).toBeLessThanOrEqual(MAX_IN_FLIGHT);

        server.dispose();
    });
});
