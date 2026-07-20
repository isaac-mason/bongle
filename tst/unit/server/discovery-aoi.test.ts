import type { Client } from 'bongle/interface';
import { describe, expect, it } from 'vitest';
import { setPosition, TransformTrait, type TransformTrait as TransformTraitType } from '../../../src/builtins/transform';
import * as Debug from '../../../src/core/debug';
import { unpackPackedSceneTree, unpackServerMessage } from '../../../src/core/protocol';
import * as Resources from '../../../src/core/resources';
import { addChild, addTrait, createNode, getTrait, type Node } from '../../../src/core/scene/scene-tree';
import { block } from '../../../src/core/voxels/blocks';
import { CHUNK_SIZE, setBlock } from '../../../src/core/voxels/voxels';
import { nodeZstd } from '../../../src/node/zstd';
import * as Discovery from '../../../src/server/discovery';
import * as Net from '../../../src/server/net';
import * as Rooms from '../../../src/server/rooms';
import { createTestServer } from '../../integration/server-integration-test';

/* ── chunk-tied node AOI ──────────────────────────────────────────────────
 * transform-root subtrees stream to a client in lockstep with the chunk they
 * sit in (knownChunks ∪ knownEmptyChunks). with no blocks placed, chunks around
 * the player's anchor are announced empty, so a transform root within viewRadius
 * streams in and one outside does not. the unit harness doesn't spawn a player
 * body, so setup() registers an explicit anchor node (also the AOI own-anchor). */

const FAKE_CLIENT: Client = 1;

// solid block for the occupied-chunk cases. imported from src (not 'bongle') so it
// registers into the same registry instance createTestServer reads.
const AOI_BLOCK = 'aoi-stone';
block(AOI_BLOCK, { model: () => ({ type: 'cube', textures: { all: { texture: 'stone' } } }) });

function setup() {
    const server = createTestServer({ mode: 'play' });
    const discovery = Discovery.init(nodeZstd);
    const resources = Resources.init({ loadBytes: async () => new Uint8Array() }, 'server');
    Discovery.addClient(discovery, FAKE_CLIENT);
    const net = Net.init();
    const player = Rooms.joinRoom(server.rooms, FAKE_CLIENT, server.room.id, server.room.mode);

    // explicit anchor node: getPlayerChunkCoord tracks it, and it's the always-visible
    // AOI own-anchor. registered BEFORE invalidatePlayer so join exempts it from the prune.
    const anchor = createNode({ name: `player:${player.id}` });
    addChild(server.room.nodes.root, anchor);
    const anchorT = addTrait(anchor, TransformTrait);
    setPosition(anchorT, [0, 2, 0]); // chunk (0,0,0)
    server.room.playerNodes.set(player.id, anchor);

    const moveAnchor = (pos: [number, number, number]) => setPosition(anchorT, pos);
    return { server, discovery, net, player, resources, moveAnchor };
}

function flush(discovery: Discovery.Discovery, rooms: Rooms.Rooms, resources: Resources.Resources) {
    return Discovery.flush(discovery, rooms, resources, Debug.createMetrics(false));
}

/** all scene_sync updates for a client across one flush result (default: FAKE_CLIENT). */
function sceneUpdates(
    out: Array<[Client, { type: string }]>,
    client: Client = FAKE_CLIENT,
): Array<{ type: string; id: number; name?: string }> {
    const updates: Array<{ type: string; id: number; name?: string }> = [];
    for (const [c, m] of out) {
        if (c !== client || m.type !== 'scene_sync') continue;
        updates.push(...(m as unknown as { updates: Array<{ type: string; id: number; name?: string }> }).updates);
    }
    return updates;
}

function createdIds(out: Array<[Client, { type: string }]>, client: Client = FAKE_CLIENT): number[] {
    return sceneUpdates(out, client)
        .filter((u) => u.type === 'node_created')
        .map((u) => u.id);
}

/** a shared transform root at a world position, child of the scene root. */
function transformRootAt(root: Node, name: string, pos: [number, number, number]): Node {
    const node = createNode({ name });
    addChild(root, node);
    const t = addTrait(node, TransformTrait) as TransformTraitType;
    setPosition(t, pos);
    return node;
}

describe('discovery — chunk-tied node AOI', () => {
    it('join packet omits transform roots but keeps the own anchor + non-transform nodes', () => {
        const { server, discovery, net, player, resources } = setup();

        transformRootAt(server.room.nodes.root, 'near-root', [1, 2, 3]); // chunk (0,0,0)
        const plain = createNode({ name: 'plain-logic' }); // no transform → not chunk-gated
        addChild(server.room.nodes.root, plain);

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        const joinEntry = (net.outboxMessages.get(FAKE_CLIENT) ?? []).find((m) => m.type === 'join_room')!;
        const join = unpackServerMessage(joinEntry.bytes);
        if (!join || join.type !== 'join_room') throw new Error('no join_room');
        const names: Array<string | undefined> = unpackPackedSceneTree(join.packedNodes).nodes.map(
            (n: { name?: string }) => n.name,
        );

        expect(names).not.toContain('near-root'); // transform root → created later via AOI
        expect(names).toContain('plain-logic'); // not chunk-gated → always visible
        expect(names.some((n) => n?.startsWith('player:'))).toBe(true); // own anchor packed

        server.dispose();
    });

    it('streams in an in-range transform root on the first flush after join', () => {
        const { server, discovery, net, player, resources } = setup();

        const near = transformRootAt(server.room.nodes.root, 'near-root', [1, 2, 3]);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(near.id);

        server.dispose();
    });

    it('does NOT stream a transform root outside the view radius', () => {
        const { server, discovery, net, player, resources } = setup();

        const far = transformRootAt(server.room.nodes.root, 'far-root', [800, 2, 0]); // chunk (50,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        for (let i = 0; i < 5; i++) {
            expect(createdIds(flush(discovery, server.rooms, resources))).not.toContain(far.id);
        }

        server.dispose();
    });

    it('region-driven discovery: a settled far root streams in once the player moves onto its chunk', () => {
        const { server, discovery, net, player, resources, moveAnchor } = setup();

        const far = transformRootAt(server.room.nodes.root, 'far-root', [800, 2, 0]); // chunk (50,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // flush so `far` settles out of dirtyNodes (still filed at chunk 50, unknown to client).
        flush(discovery, server.rooms, resources);

        // move the anchor onto chunk 50; `far` itself did NOT change, so this exercises
        // the entered-delta (region-driven) path, not the dirtyNodes path.
        moveAnchor([800, 2, 0]);

        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(far.id);

        server.dispose();
    });

    it('evicts a known transform root when the player retreats out of range', () => {
        const { server, discovery, net, player, resources, moveAnchor } = setup();

        const near = transformRootAt(server.room.nodes.root, 'near-root', [1, 2, 3]);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(near.id);

        // retreat far; the anchor cross evicts chunk (0,0,0) → left → destroy subtree.
        moveAnchor([2000, 2, 0]); // chunk (125,0,0)
        const destroyed = sceneUpdates(flush(discovery, server.rooms, resources)).some(
            (u) => u.type === 'node_destroyed' && u.id === near.id,
        );
        expect(destroyed).toBe(true);

        server.dispose();
    });

    it('root-moved: a root that moves out of the region is destroyed (player stationary)', () => {
        const { server, discovery, net, player, resources } = setup();

        const mover = transformRootAt(server.room.nodes.root, 'mover', [1, 2, 3]); // chunk (0,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(mover.id);

        // move the ROOT far out of range; the player stays at the origin. this drives
        // presence via reconcileRootChunks → rootChunkChanges, not the region deltas.
        setPosition(getTrait(mover, TransformTrait)!, [800, 2, 0]); // chunk (50,0,0)
        const destroyed = sceneUpdates(flush(discovery, server.rooms, resources)).some(
            (u) => u.type === 'node_destroyed' && u.id === mover.id,
        );
        expect(destroyed).toBe(true);

        server.dispose();
    });

    it('root-moved: a root moving within the region stays present and keeps updating', () => {
        const { server, discovery, net, player, resources } = setup();

        const mover = transformRootAt(server.room.nodes.root, 'mover', [1, 2, 3]); // chunk (0,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(mover.id);

        // cross a chunk boundary but stay within view radius (chunk 0 → chunk 1).
        setPosition(getTrait(mover, TransformTrait)!, [20, 2, 3]); // chunk (1,0,0)
        const updates = sceneUpdates(flush(discovery, server.rooms, resources));
        // no churn: not destroyed, not re-created...
        expect(updates.some((u) => u.type === 'node_destroyed' && u.id === mover.id)).toBe(false);
        expect(updates.some((u) => u.type === 'node_created' && u.id === mover.id)).toBe(false);
        // ...but its transform field update still flows.
        expect(updates.some((u) => u.id === mover.id)).toBe(true);

        server.dispose();
    });

    it('root-moved: a root moving into the region is created (player stationary)', () => {
        const { server, discovery, net, player, resources } = setup();

        const mover = transformRootAt(server.room.nodes.root, 'mover', [800, 2, 0]); // chunk (50,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flush(discovery, server.rooms, resources); // settle out of range, not created
        expect(createdIds(flush(discovery, server.rooms, resources))).not.toContain(mover.id);

        // move the root INTO the region; player stationary → rootChunkChanges → create.
        setPosition(getTrait(mover, TransformTrait)!, [1, 2, 3]); // chunk (0,0,0)
        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(mover.id);

        server.dispose();
    });

    it('hysteresis: a root in the margin band is not evicted when the player jitters the boundary', () => {
        const { server, discovery, net, player, resources, moveAnchor } = setup();

        // root at chunk (8,0,0): exactly viewRadius (8) from the origin anchor. it sits at
        // the frontier, discovered last in the spherical walk, so flush until it streams in.
        const root = transformRootAt(server.room.nodes.root, 'edge-root', [128, 2, 0]);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        let discovered = false;
        for (let i = 0; i < 15 && !discovered; i++) {
            if (createdIds(flush(discovery, server.rooms, resources)).includes(root.id)) discovered = true;
        }
        expect(discovered).toBe(true);

        // move the anchor to chunk (-4,0,0): the root is now 12 chunks away = viewRadius(8) +
        // VIEW_RADIUS_MARGIN(4), the eviction radius. it must be KEPT (hysteresis), not evicted,
        // even though a fresh walk from here would never re-discover it. this is the inherited
        // chunk hysteresis — the sole source of anti-thrash for entities.
        moveAnchor([-64, 2, 0]);
        const afterOut = sceneUpdates(flush(discovery, server.rooms, resources));
        expect(afterOut.some((u) => u.type === 'node_destroyed' && u.id === root.id)).toBe(false);

        // jitter back; still no churn.
        moveAnchor([0, 2, 0]);
        const afterBack = sceneUpdates(flush(discovery, server.rooms, resources));
        expect(afterBack.some((u) => u.type === 'node_destroyed' && u.id === root.id)).toBe(false);
        expect(afterBack.some((u) => u.type === 'node_created' && u.id === root.id)).toBe(false);

        server.dispose();
    });

    it('completeness: an ancestor gaining a transform re-files the index (descendant root-status flips)', () => {
        const { server, discovery, net, player, resources } = setup();
        const st = server.room.nodes;

        // parent has no transform; child does → child is the transform root.
        const parent = createNode({ name: 'parent-logic' });
        addChild(st.root, parent);
        const child = createNode({ name: 'child-root' });
        addChild(parent, child);
        setPosition(addTrait(child, TransformTrait), [1, 2, 3]); // chunk (0,0,0)

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        flush(discovery, server.rooms, resources); // reconcile files `child`
        expect(st.rootToChunk.has(child)).toBe(true);
        expect(st.rootToChunk.has(parent)).toBe(false);

        // give the PARENT a transform → it shadows child. the completeness fix (markNodeDirty
        // in updateChildTransformPointers) must dirty `child` so reconcile re-files: parent
        // becomes the root, child stops being one. without that fix, child stays stale-filed.
        setPosition(addTrait(parent, TransformTrait), [2, 2, 2]); // chunk (0,0,0)
        flush(discovery, server.rooms, resources);
        expect(st.rootToChunk.has(parent)).toBe(true);
        expect(st.rootToChunk.has(child)).toBe(false);

        server.dispose();
    });

    it('streams in a root sitting in an occupied chunk (chunk_full / knownChunks path)', () => {
        const { server, discovery, net, player, resources } = setup();

        setBlock(server.room.voxels, 1, 0, 3, AOI_BLOCK); // occupy chunk (0,0,0)
        const root = transformRootAt(server.room.nodes.root, 'occ-root', [1, 2, 3]); // chunk (0,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        // the occupied anchor chunk ships as chunk_full on the first flush; the root streams
        // in the same flush (via the knownChunks entered-delta, never before its terrain).
        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(root.id);

        server.dispose();
    });

    it('promotion of an occupied chunk under a known root does not flicker it', () => {
        const { server, discovery, net, player, resources } = setup();

        setBlock(server.room.voxels, 1, 0, 3, AOI_BLOCK); // occupy chunk (0,0,0)
        const root = transformRootAt(server.room.nodes.root, 'occ-root', [1, 2, 3]); // chunk (0,0,0)
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        expect(createdIds(flush(discovery, server.rooms, resources))).toContain(root.id); // known now

        // bulk-edit chunk (0,0,0) past the promotion threshold (CHUNK_VOLUME/2) → it's dropped
        // from knownChunks and re-queued as chunk_full. this must NOT read as an eviction:
        // promotion is excluded from the `left` delta, so the root stays present.
        for (let x = 0; x < CHUNK_SIZE; x++)
            for (let y = 0; y < CHUNK_SIZE; y++)
                for (let z = 0; z < CHUNK_SIZE; z++) setBlock(server.room.voxels, x, y, z, AOI_BLOCK);

        const updates = sceneUpdates(flush(discovery, server.rooms, resources));
        expect(updates.some((u) => u.type === 'node_destroyed' && u.id === root.id)).toBe(false);

        server.dispose();
    });

    it('per-player isolation: two players in one room get views scoped to their own regions', () => {
        const { server, discovery, net, player, resources } = setup();

        // player B, anchored far from player A (who is at the origin, from setup()).
        const CLIENT_B: Client = 2;
        Discovery.addClient(discovery, CLIENT_B);
        const playerB = Rooms.joinRoom(server.rooms, CLIENT_B, server.room.id, server.room.mode);
        const anchorB = createNode({ name: `player:${playerB.id}` });
        addChild(server.room.nodes.root, anchorB);
        setPosition(addTrait(anchorB, TransformTrait), [2000, 2, 0]); // chunk (125,0,0)
        server.room.playerNodes.set(playerB.id, anchorB);

        const nearA = transformRootAt(server.room.nodes.root, 'near-A', [1, 2, 3]); // chunk (0,0,0)
        const nearB = transformRootAt(server.room.nodes.root, 'near-B', [2001, 2, 3]); // chunk (125,0,0)

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);
        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, playerB);

        const seenA = new Set<number>();
        const seenB = new Set<number>();
        for (let i = 0; i < 3; i++) {
            const out = flush(discovery, server.rooms, resources);
            for (const id of createdIds(out, FAKE_CLIENT)) seenA.add(id);
            for (const id of createdIds(out, CLIENT_B)) seenB.add(id);
        }

        expect(seenA.has(nearA.id)).toBe(true);
        expect(seenA.has(nearB.id)).toBe(false); // A never sees B's distant entity
        expect(seenB.has(nearB.id)).toBe(true);
        expect(seenB.has(nearA.id)).toBe(false); // B never sees A's distant entity

        server.dispose();
    });

    it('creates a transform-root subtree coherently (root + descendants together)', () => {
        const { server, discovery, net, player, resources } = setup();

        const root = transformRootAt(server.room.nodes.root, 'veh-root', [2, 2, 2]); // chunk (0,0,0)
        const child = createNode({ name: 'veh-child' });
        addChild(root, child); // descendant, no transform of its own

        Discovery.invalidatePlayer(discovery, net, server.rooms, resources, player);

        const created = createdIds(flush(discovery, server.rooms, resources));
        expect(created).toContain(root.id);
        expect(created).toContain(child.id);

        server.dispose();
    });
});
