// ── discovery load scenario ──────────────────────────────────────────
//
// builds a room that exercises the whole discovery path the way a real play
// session does, and drives it a tick at a time. shared by the vitest fan-out
// bench (throughput) and discovery-egress.ts (bytes).
//
// what it gets right that a bare scene of sync-only nodes does not:
//
//   - props carry a real TransformTrait, so they are transform roots, get filed
//     in the chunk index, and are AOI-gated. a node with no transform root is
//     exempt from chunk gating entirely (discovery.ts, buildSceneSyncUpdates)
//     and would be visible to every client at any distance.
//   - bots get real player nodes via addPlayerTraits — Transform + Player +
//     character rig + humanoid controls — each at its own spawn, so every client
//     has a distinct AOI anchor and the regions genuinely diverge.
//   - occupied chunks, so the voxel phase encodes and compresses real payloads
//     instead of shipping empty stubs.
//   - chunk acks, so the in-flight window (MAX_IN_FLIGHT_FULL) keeps draining
//     and streaming doesn't stall after 24 chunks.
//   - messages go through Net.send, which packs them and bills per-type bytes,
//     so egress is measurable.
//
// bots ack in the same tick they receive, i.e. zero RTT. that's the optimistic
// end of the backpressure range; a real client acks a few ticks later and holds
// the window open less of the time.

import { addPlayerTraits } from '../src/builtins/player-node';
import { setPosition, TransformTrait } from '../src/builtins/transform';
import * as Debug from '../src/core/debug';
import * as Resources from '../src/core/resources';
import { addChild, addTrait, bumpNodeVersion, createNode, getTrait, setOwner } from '../src/core/scene/scene-tree';
import type { TraitType } from '../src/core/scene/traits';
import { SetBlockFlags } from '../src/core/voxels/block-flags';
import { block } from '../src/core/voxels/blocks';
import { propagateAllLight } from '../src/core/voxels/light';
import { CHUNK_SIZE, setBlock, type Voxels } from '../src/core/voxels/voxels';
import * as kit from '../src/kit/blocks';
import { nodeZstd } from '../src/node/zstd';
import * as Discovery from '../src/server/discovery';
import * as Net from '../src/server/net';
import * as Rooms from '../src/server/rooms';
import { createTestServer, type TestServer } from '../tst/integration/server-integration-test';

/** the ground block. registered at module scope so it's in the registry before
 *  createTestServer reindexes and createRoom reads blockRegistry. */
const GROUND = 'bench-ground';
block(GROUND, { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });

type Transform = TraitType<typeof TransformTrait>;

export type Terrain = 'empty' | 'floor' | 'generated';

export type WorldOptions = {
    /** replicable, AOI-gated prop nodes scattered through the world. */
    props: number;
    /** bot clients, each with a real player node at its own spawn. */
    clients: number;
    /** what fills the world:
     *    'empty'     no blocks — every in-range chunk ships as an empty stub.
     *    'floor'     a stone slab at y=0. one chunk layer deep, one palette entry.
     *    'generated' rolling hills, water and trees from the kit block set — the
     *                realistic case: several chunk layers deep, multi-entry
     *                palettes, and light that actually varies. */
    terrain: Terrain;
    /** half-extent in blocks that props and bot spawns are scattered over. */
    spread: number;
};

/** how fast bots travel. walk/sprint are CharacterControllerTrait's own config
 *  defaults; sled is the default terminalVelocity, i.e. the fastest a falling or
 *  downhill body goes without a game raising it; fly is deliberately past anything
 *  the stock config produces. speed is what drives AOI churn — a walker crosses a
 *  16-block chunk boundary every ~3s, a sledder ~2.5x a second. */
export type Locomotion = 'idle' | 'walk' | 'sprint' | 'sled' | 'fly';

export const LOCOMOTION_SPEED: Record<Locomotion, number> = {
    idle: 0,
    walk: 5, // character-controller.ts config.walkSpeed
    sprint: 6.5, // config.sprintSpeed
    sled: 40, // config.terminalVelocity
    fly: 80,
};

/** chunk boundaries a bot crosses per second at this speed. the honest predictor of
 *  region churn, and the reason a sledding game costs more than a walking one. */
export function chunkCrossingsPerSecond(locomotion: Locomotion): number {
    return LOCOMOTION_SPEED[locomotion] / CHUNK_SIZE;
}

export type Bot = {
    client: number;
    playerId: number;
    transform: Transform;
};

export type World = {
    server: TestServer;
    /** half-extent in blocks the world was generated over. */
    spread: number;
    discovery: Discovery.Discovery;
    resources: Resources.Resources;
    net: Net.ServerNet;
    metrics: Debug.Metrics;
    bots: Bot[];
    props: Transform[];
    /** one server-side discovery tick: flush, pack to the wire, ack chunks. */
    tick(): void;
    /** tick until the voxel phase goes quiet; returns the ticks it took. */
    settle(maxTicks?: number): number;
    /** bytes sent since the last drain, split by message type. */
    egress(): Net.NetStats;
};

/** the play-mode stream radius (discovery.ts DEFAULT_VIEW_RADIUS), in blocks. */
const STREAM_RADIUS_BLOCKS = 8 * CHUNK_SIZE;

const DEFAULTS: WorldOptions = { props: 1000, clients: 8, terrain: 'floor', spread: 96 };

export function createWorld(options: Partial<WorldOptions> = {}): World {
    const opts = { ...DEFAULTS, ...options };

    const server = createTestServer({ mode: 'play' });
    const discovery = Discovery.init(nodeZstd);
    const resources = Resources.init({ loadBytes: async () => new Uint8Array() }, 'server');
    const net = Net.init();
    const metrics = Debug.createMetrics(false);
    const room = server.room;

    if (opts.terrain === 'floor') layFloor(room.voxels, opts.spread);
    else if (opts.terrain === 'generated') generateTerrain(room.voxels, opts.spread);
    // bulk writes defer relight to a tick-end flush that nothing here runs, so bake
    // it once now. without this every chunk ships all-zero light, which compresses
    // to nothing and makes chunk_full payloads unrepresentatively small.
    if (opts.terrain !== 'empty') propagateAllLight(room.voxels);

    // props: transform roots, so the chunk index files them and AOI gates them.
    // scattered on a lattice across the spread so they land in many distinct chunks
    // rather than piling into one bucket.
    const props: Transform[] = [];
    const perAxis = Math.max(1, Math.ceil(Math.sqrt(opts.props)));
    const step = (opts.spread * 2) / perAxis;
    for (let i = 0; i < opts.props; i++) {
        const node = createNode({ name: `prop:${i}` });
        addChild(room.scene.root, node);
        const transform = addTrait(node, TransformTrait);
        const gx = i % perAxis;
        const gz = Math.floor(i / perAxis);
        setPosition(transform, [-opts.spread + gx * step, 1, -opts.spread + gz * step]);
        props.push(transform);
    }

    // bots: real player nodes, each spawned on its own patch of the world so the
    // per-client AOI regions actually differ.
    const bots: Bot[] = [];
    for (let c = 1; c <= opts.clients; c++) {
        Discovery.addClient(discovery, c);
        const player = Rooms.joinRoom(server.rooms, c, room.id, room.mode);

        const node = createNode({ name: `player:${player.id}`, persist: false });
        addChild(room.scene.root, node);
        setOwner(room.scene, node, player.id);
        const angle = (2 * Math.PI * (c - 1)) / opts.clients;
        addPlayerTraits(node, {
            playerId: player.id,
            clientId: c,
            mode: 'play',
            viewRadius: 8,
            spawn: [Math.cos(angle) * opts.spread * 0.5, 2, Math.sin(angle) * opts.spread * 0.5],
        });
        bumpNodeVersion(room.scene, node);
        room.playerNodes.set(player.id, node);

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        bots.push({ client: c, playerId: player.id, transform: getTransform(node) });
    }

    const world: World = {
        server,
        spread: opts.spread,
        discovery,
        resources,
        net,
        metrics,
        bots,
        props,

        tick() {
            const out = Discovery.flush(discovery, server.rooms, resources, metrics);

            // pack every message onto the wire (this is what bills per-type bytes),
            // and ack each promoted chunk + discovered region so both in-flight
            // windows keep draining.
            const acks = new Map<
                string,
                { client: Client; playerId: number; full: Array<{ cx: number; cy: number; cz: number }>; regions: Array<{ rx: number; ry: number; rz: number }> }
            >();
            const ackEntry = (client: Client, playerId: number) => {
                const gk = `${client}:${playerId}`;
                let g = acks.get(gk);
                if (!g) {
                    g = { client, playerId, full: [], regions: [] };
                    acks.set(gk, g);
                }
                return g;
            };
            for (const [client, message] of out) {
                Net.send(net, client, message);
                if (message.type === 'voxel_chunk_full') {
                    ackEntry(client, message.playerId).full.push({ cx: message.cx, cy: message.cy, cz: message.cz });
                } else if (message.type === 'voxel_region_full') {
                    ackEntry(client, message.playerId).regions.push({ rx: message.rx, ry: message.ry, rz: message.rz });
                }
            }
            for (const { client, playerId, full, regions } of acks.values()) {
                // bots report a fixed fast-client rate — these load tests
                // measure discovery/eviction cost, not adaptive pacing.
                Discovery.handleVoxelAck(discovery, client, { type: 'voxel_ack', playerId, full, regions, desiredRegionsPerTick: 64 });
            }

            // frame and discard — nothing consumes the outbox here, and leaving it to
            // grow would be the only unbounded allocation in a long run.
            Net.flush(net);
            net.outbox.clear();
        },

        settle(maxTicks = 2000) {
            const QUIET = 3;
            let quiet = 0;
            let ticks = 0;
            while (ticks < maxTicks && quiet < QUIET) {
                const before = voxelBytes(net);
                world.tick();
                quiet = voxelBytes(net) === before ? quiet + 1 : 0;
                ticks++;
            }
            return ticks - QUIET;
        },

        egress() {
            return Net.drainNetStats(net);
        },
    };

    return world;
}

/**
 * move every bot at `locomotion` speed along a shared circular track, each on its
 * own phase. the track is bounded (a bench callback runs this thousands of times)
 * but wide enough that a lap is far longer than the retention band, so a fast bot
 * genuinely streams fresh terrain rather than re-entering chunks it still holds.
 *
 * the track radius sits inside the generated area by the stream radius, so a bot's
 * whole AOI sphere stays over real terrain instead of hanging off the edge into air.
 */
export function moveBots(world: World, tick: number, locomotion: Locomotion = 'walk', tickRate = 60): void {
    const speed = LOCOMOTION_SPEED[locomotion];
    if (speed === 0) return;

    const radius = Math.max(CHUNK_SIZE, world.spread - STREAM_RADIUS_BLOCKS);
    const step = speed / tickRate / radius; // radians/tick for the requested ground speed
    for (let i = 0; i < world.bots.length; i++) {
        const angle = (2 * Math.PI * i) / world.bots.length + tick * step;
        setPosition(world.bots[i].transform, [Math.cos(angle) * radius, 2, Math.sin(angle) * radius]);
    }
}

/** jiggle a fraction of the props so they emit without changing chunk. */
export function moveProps(world: World, tick: number, fraction = 0.2): void {
    const stride = Math.max(1, Math.round(1 / fraction));
    const d = tick * 0.1;
    for (let i = 0; i < world.props.length; i += stride) {
        const p = world.props[i].position;
        setPosition(world.props[i], [p[0], 1 + (d % 1), p[2]]);
    }
}

function layFloor(voxels: Voxels, spread: number): void {
    for (let x = -spread; x < spread; x++) {
        for (let z = -spread; z < spread; z++) {
            setBlock(voxels, x, 0, z, GROUND);
        }
    }
}

/* ── generated terrain ───────────────────────────────────────────────
 * the same deterministic recipe as examples/performance-terrain: hash noise for
 * roughness, stacked sines for the hills, a water level, and sparse trees. no
 * RNG, so a given spread always produces the same world and runs are comparable.
 */

const WATER_LEVEL = 14;
const BASE_HEIGHT = 18;
const BULK = SetBlockFlags.BULK;

/** deterministic 2D hash in [0, 1). */
function hash2(x: number, z: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function terrainHeight(x: number, z: number): number {
    let h = BASE_HEIGHT;
    h += Math.sin(x * 0.03) * Math.cos(z * 0.035) * 12; // broad hills
    h += Math.sin(x * 0.09 + 1.3) * Math.sin(z * 0.08 + 2.1) * 5; // medium
    h += Math.sin(x * 0.21 + 4.2) * Math.cos(z * 0.19 + 0.7) * 2.5; // bumps
    h += (hash2(x, z) - 0.5) * 2; // fine roughness
    return Math.max(2, Math.min(60, Math.floor(h)));
}

function generateTerrain(voxels: Voxels, spread: number): void {
    const stone = kit.stone.defaultKey();
    const dirt = kit.dirt.defaultKey();
    const grass = kit.grass.defaultKey();
    const gravel = kit.gravel.defaultKey();
    const water = kit.water.defaultKey();
    const log = kit.oakLog.defaultKey();
    const leaves = kit.oakLeaves.defaultKey();

    for (let x = -spread; x < spread; x++) {
        for (let z = -spread; z < spread; z++) {
            const height = terrainHeight(x, z);
            const underwater = height < WATER_LEVEL;
            for (let y = 0; y <= height; y++) {
                const depth = height - y;
                const state = depth === 0 ? (underwater ? gravel : grass) : depth < 4 ? dirt : stone;
                setBlock(voxels, x, y, z, state, BULK);
            }
            for (let y = height + 1; y <= WATER_LEVEL; y++) setBlock(voxels, x, y, z, water, BULK);
            // ~1% of dry grass columns sprout a tree.
            if (!underwater && hash2(x * 7, z * 13) < 0.01) placeTree(voxels, x, z, height, log, leaves, -spread, spread - 1);
        }
    }
}

function placeTree(
    voxels: Voxels,
    x: number,
    z: number,
    groundY: number,
    log: string,
    leaves: string,
    lo: number,
    hi: number,
): void {
    const trunk = 4 + Math.floor(hash2(x * 7, z * 13) * 3);
    const topY = groundY + trunk;
    for (let y = groundY + 1; y <= topY; y++) setBlock(voxels, x, y, z, log, BULK);
    for (let dy = -2; dy <= 1; dy++) {
        const r = dy >= 0 ? 1 : 2;
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (dx === 0 && dz === 0 && dy < 1) continue;
                const cx = x + dx;
                const cz = z + dz;
                if (cx < lo || cx > hi || cz < lo || cz > hi) continue;
                setBlock(voxels, cx, topY + dy, cz, leaves, BULK);
            }
        }
    }
    setBlock(voxels, x, topY + 1, z, leaves, BULK);
}

/** running total of bytes billed to voxel_* message types. the counters only
 *  reset on drainNetStats, so an unchanged total across a tick means the voxel
 *  phase emitted nothing. */
function voxelBytes(net: Net.ServerNet): number {
    let total = 0;
    for (const [type, bytes] of net.bytesOutByType) {
        if (type.startsWith('voxel_')) total += bytes;
    }
    return total;
}

function getTransform(node: ReturnType<typeof createNode>): Transform {
    const t = getTrait(node, TransformTrait);
    if (!t) throw new Error('player node has no TransformTrait');
    return t;
}

export { CHUNK_SIZE };
