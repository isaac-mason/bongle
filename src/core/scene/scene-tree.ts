import {
    getWorldChunk,
    invalidateTransformAncestry,
    invalidateTransformChildren,
    releaseTransform,
    TransformTrait,
} from '../../builtins/transform';
import { env } from '../../env';
import type { PlayerId } from '../client';
import * as Debug from '../debug';
import { registry } from '../registry';
import type { Bitset } from '../utils/bitset';
import * as bitset from '../utils/bitset';
import { type Listener, type Topic, topic, type Unsubscribe } from '../utils/topic';
import type { Voxels } from '../voxels/voxels';
import { chunkToRegionCoord, regionKey } from '../voxels/voxels';
import {
    type Condition,
    type ConditionArgs,
    type ConditionArgsToConditions,
    type ExtractTraitsFromConditions,
    OPER_TAG,
    Oper,
    SRC_TAG,
    Src,
} from './conditions';
import { getControlCodecs } from './packcat-bridge';
import { formatIssuePath, type Issue, validate } from './prop';
import type { ValidationIssue } from './prop/validate';
import { logScriptError } from './script-errors';
import type { FrameArgs, SceneTreeContext, ScriptInstance, TickArgs, UpdateArgs } from './scripts';
import { createScriptInstance, disposeScriptInstance, fireEnterHooks, fireExitHooks, initScriptInstance } from './scripts';
import type { Resolution } from './traits';
import { buildTraitInstance, cloneTraitValue, type TraitBase, type TraitDef, type TraitHandle } from './traits';

export type { TraitHandle } from './traits';

/**
 * which side(s) a node lives on. see {@link Node.realm}.
 *
 * - `'inherit'`: take the effective realm from the nearest non-inherit ancestor (default)
 * - `'shared'`: server-owned, replicated to all clients
 * - `'client'`: lives only on the client that created it; never replicated
 * - `'server'`: lives only on the server; never replicated
 * - `'each'`: server AND every client get their own independent copy on attach
 *
 * the scene tree root is always `'shared'`, so an `'inherit'` node with no
 * explicit realm anywhere in its chain resolves to `'shared'`.
 */
export type Realm = 'inherit' | 'shared' | 'client' | 'server' | 'each';

export type Node = {
    /** runtime-only numeric ID, assigned by the scene tree's incrementing counter. not persisted. */
    id: number;

    /** optional name, a non-unique label. */
    name: string | undefined;

    /** parent node, or null if this is a root node */
    parent: Node | null;

    /** ordered list of child nodes */
    children: Node[];

    /** @internal position in `parent.children`. A hint, not a guarantee — read it through
     *  `childIndexOf`, which re-derives and repairs when it doesn't match. */
    _childIndex: number;

    /** the scene tree this node belongs to, or null if detached */
    scene: SceneTree | null;
    /** @internal the tree whose `dirtyNodes` list currently holds this node, or null. Holds
     *  the tree rather than a bool so a node that moves between trees is filed in each. */
    _dirtyIn: SceneTree | null;

    /**
     * which Player owns this node. null = server-owned (default).
     * Ownership is keyed per-Player (not per-Client) so parallel
     * memberships, same client with multiple Players in a room, don't
     * collapse onto one body.
     */
    owner: PlayerId | null;

    /**
     * whether this node is saved to scene files. default: true.
     * non-persistent nodes are still included in network replication
     * and hot-reload round-trips.
     */
    persist: boolean;

    /**
     * which side(s) this node lives on / is replicated to:
     * - `'inherit'`: take effective realm from nearest non-inherit ancestor (default)
     * - `'shared'`: server-owned, replicated to all clients
     * - `'client'`: lives only on the client that created it; never replicated
     * - `'server'`: lives only on the server; never replicated to clients
     * - `'each'`: server AND every client get their own independent copy on attach
     *
     * realm boundaries cascade through the tree implicitly: an `'inherit'`
     * descendant of a `'server'` node behaves as `'server'`. consumers that walk
     * the tree (replication, prefab tick) thread the inherited realm through
     * the recursion so each node sees its effective value in O(1).
     */
    realm: Realm;

    /** @internal trait instances indexed by trait slot; holes for slots the node doesn't carry. */
    _traits: Array<TraitBase | undefined>;

    /** @internal node-level replication version (send-path early-out gate). */
    _sync: NodeSyncState;

    /** @internal bitset for fast trait query matching */
    _bitset: Bitset;

    /**
     * @internal traits whose definitions weren't in the registry at load time.
     * keyed by trait string id. preserves raw data so it round-trips through
     * pack/unpack and save/load without silent data loss.
     * hot-reload's serialize→deserialize cycle naturally reconciles these
     * when the def becomes available again.
     */
    _unresolvedTraits: Map<string, { binary?: Uint8Array; json?: Record<string, unknown> }> | null;

    /**
     * @internal validation issues per trait (keyed by trait slot). populated
     * at scene load and at inspector commit time. derived state, not persisted,
     * not replicated. use `setTraitIssues` / `clearTraitIssues` to mutate so
     * empty entries are cleaned up.
     */
    _traitIssues: Map<number, ValidationIssue[]> | null;

    /**
     * if non-null, this node is a prefab instance. its children are
     * instantiated from the referenced scene. only the prefab config
     * is persisted, children have persist: false.
     */
    prefab: PrefabConfig | null;

    /**
     * @internal runtime-only prefab instantiation state.
     * not serialized, not replicated, reconstructed on instantiation.
     */
    _prefabState: PrefabState | null;
};

/* uuid, retained for namespace ids (e.g. `play-<uuid>` rooms); not used for node identity. */

/** shared empty map, so read paths can iterate a node with no unresolved traits without a branch. */
export const EMPTY_UNRESOLVED: ReadonlyMap<string, { binary?: Uint8Array; json?: Record<string, unknown> }> = new Map();

export function generateUuid(): string {
    // use crypto.randomUUID if available (modern browsers + Node 19+),
    // otherwise fall back to a simple v4-like generator.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // fallback: pseudo-random v4 UUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function createNodeObject(name?: string, id?: number, persist?: boolean, realm?: Realm): Node {
    return {
        id: id ?? 0,
        name: name ?? undefined,
        parent: null,
        children: [],
        _childIndex: 0,
        scene: null,
        _dirtyIn: null,
        owner: null,
        persist: persist ?? true,
        realm: realm ?? 'inherit',
        _traits: [],
        _bitset: bitset.init(),
        _unresolvedTraits: null,
        _traitIssues: null,
        prefab: null,
        _prefabState: null,
        _sync: { version: 0 },
    };
}

/* version bumping */

/** per-node replication version, the send path's node-level early-out gate.
 *  the trait/field versions live on each trait instance's `_sync`; only this
 *  node-level rollup lives here, since it spans all of a node's traits. */
export type NodeSyncState = {
    /** bumped on ANY replicable change to the node (structure, traits, fields). */
    version: number;
};

/** mark a node into its scene tree's per-tick discovery dirty set. server-side
 *  only (gated on `!env.client`), a no-op in the client bundle, where nothing
 *  drains the set. every version bump funnels through here, so structural, trait,
 *  and field changes all land in `dirtyNodes` for the per-client fan-out. room
 *  scene trees are drained + cleared each tick by `Discovery.flush`. */
export function markNodeDirty(sceneTree: SceneTree, node: Node): void {
    if (env.client || node._dirtyIn === sceneTree) return;
    node._dirtyIn = sceneTree;
    sceneTree.dirtyNodes.push(node);
}

/** drop everything filed this tick. Pairs with `markNodeDirty`; nothing else clears the marks. */
export function clearDirtyNodes(sceneTree: SceneTree): void {
    const dirty = sceneTree.dirtyNodes;
    for (let i = 0; i < dirty.length; i++) dirty[i]!._dirtyIn = null;
    dirty.length = 0;
}

/** bump a node's structural version */
export function bumpNodeVersion(sceneTree: SceneTree, node: Node): void {
    node._sync.version = ++sceneTree._versions.counter;
    markNodeDirty(sceneTree, node);
}

/** bump a specific trait's version on a node (+ the node version). */
export function bumpTraitVersion(sceneTree: SceneTree, node: Node, traitSlot: number): void {
    const v = ++sceneTree._versions.counter;
    const inst = node._traits[traitSlot];
    if (inst?._sync) inst._sync.traitVersion = v;
    node._sync.version = v;
    markNodeDirty(sceneTree, node);
}

/** bump a single field's version (+ the trait + node versions). takes the
 *  instance + slice index directly, the diff already has both in hand. */
export function bumpFieldVersion(sceneTree: SceneTree, node: Node, instance: TraitBase, i: number): void {
    const v = ++sceneTree._versions.counter;
    if (instance._sync) {
        instance._sync.versions[i] = v;
        instance._sync.traitVersion = v;
    }
    node._sync.version = v;
    markNodeDirty(sceneTree, node);
}

/* node scene tree */

export type SceneTree = {
    /** the root node of this scene tree. always present, cannot be destroyed. */
    root: Node;

    /** all nodes in this scene tree (including root) */
    nodes: Set<Node>;

    /** monotonically incrementing counter for runtime node IDs (server / shared) */
    _nextNodeId: number;

    /** monotonically decrementing counter for client-only node IDs (negative) */
    _nextClientNodeId: number;

    /** node ID → node */
    _idToNode: Map<number, Node>;

    /**
     * playerId → live nodes whose `owner === playerId`. maintained by
     * `setOwner` plus the detach paths (`destroyNode` / `unregisterSubtree`).
     * lets the client's per-tick owner-sync replication walk only the local
     * player's nodes instead of every node in the graph. server uses the
     * same bookkeeping so the invariant is unconditional.
     */
    playerIdToOwnedNodes: Map<PlayerId, Set<Node>>;

    /** single monotonic source for replication versions. the per-node/trait/field
     *  versions live on `node._sync` / `instance._sync`; this is just the counter. */
    _versions: {
        counter: number;
    };

    /**
     * @internal index of live nodes whose `prefab !== null`. maintained by
     * registerSubtree / unregisterSubtree (lifecycle) and by setPrefab
     * (mid-life mutation). used by `markPrefabAnchorsDirty` to translate a
     * dispatch-resolved set of dirty prefab ids into anchor reconciles
     * without walking the full tree.
     */
    _prefabNodes: Set<Node>;

    /**
     * @internal subset of `_prefabNodes` that needs reconcile. populated by:
     *   - prefab anchor entering the graph (registerSubtree), first init
     *   - setPrefab (set or change), config / args edits
     *   - markPrefabAnchorsDirty, dispatch DepGraph propagation
     * drained by the prefab tick once each node finishes reconcile (or is
     * filtered out by realm/cycle/deps-not-ready). steady-state size is zero
     * → tick is O(churn), not O(prefab count). same path on both edit and
     * play modes, play rooms just don't get dispatch-driven dirty marks,
     * so they stay stable across HMR.
     */
    _prefabsDirty: Set<Node>;

    /**
     * @internal transforms whose local TRS changed since the last
     * `Interpolation.snapshot` drain. populated by `markTransformDirty`
     * (writes via setPosition/setQuaternion/setScale/sync unpack).
     * drained by `snapshot()` to refresh prev pose for interpolated nodes,
     * scales per-frame snapshot cost with motion, not scene size.
     */
    _transformDirty: Set<TransformTrait>;

    /**
     * @internal transforms whose owner called `setInterpolation(node, true)`.
     * the per-frame `interpolate()` pass iterates this set instead of running
     * a query. populated by `setInterpolation`, cleared by
     * `setInterpolation(node, false)` and by trait/node removal.
     */
    _interpolating: Set<TransformTrait>;

    /** query hash -> query */
    queries: Map<string, Query<any>>;

    /**
     * @internal the same queries as a dense array. Membership sites iterate
     * this per node, and `Map.values()` allocates a fresh iterator on every
     * call — once per node per site during a subtree attach.
     */
    _queryList: Array<Query<any>>;

    /**
     * @internal trait slot → queries that mention that slot in ANY term. A node
     * can only match, or stop matching, a query that references one of its
     * traits, so membership work consults these rather than every query in the
     * tree. Indexed by every mentioned slot, not just positive ones: removing
     * `T` can make a node newly satisfy a `Not(T)`, and adding the target of an
     * `Up` term changes that node's own resolution.
     */
    _queriesByTrait: Array<Array<Query<any>> | undefined>;
    /**
     * @internal queries with no positive self-trait requirement (`[Not(Tag)]`,
     * or a lone `Up` term). These can match a node bearing nothing the index
     * would find, so they are always consulted.
     */
    _queriesAlways: Array<Query<any>>;
    /** @internal reused candidate buffer; `_visitGeneration` dedupes a query
     *  reachable through two of a node's traits without allocating a Set. */
    _queryScratch: Array<Query<any>>;
    _visitGeneration: number;

    /** @internal this tree's live query `Up`/`Ancestor` terms, bucketed by the trait slot
     *  they resolve. One bucket is one walk. Maintained as queries are registered and
     *  released, so there is nothing to invalidate and nothing to rebuild. */
    _queryResolutionGroups: Resolution[][];

    /**
     * @internal server-side discovery driver. nodes touched this tick (created,
     * structural change, trait add/remove, field change, or destroyed), the set
     * the per-client scene-sync fan-out iterates instead of walking the whole tree.
     * a destroyed node is parked here too; the fan-out recognises it by
     * `node.scene === null` and emits `node_destroyed`. populated by the
     * `bump*Version` helpers + `registerSubtree` + `destroyNode` (gated on
     * `!env.client`, so it stays empty in the client bundle), drained + cleared each
     * tick by `Discovery.flush`.
     */
    dirtyNodes: Node[];

    /**
     * server-side region index of transform roots, for region-tied AOI (see
     * `isTransformRoot`). region is the AOI/streaming granularity (bigger than a
     * storage chunk, see `REGION_CHUNKS_PER_AXIS` in voxels.ts) so this index shares
     * the same coordinate system voxel discovery streams by, which is what keeps a
     * root's presence test and its invalidation trigger synchronized. `regionToRoots`
     * maps a region key → the roots currently filed in it (the reverse lookup the
     * per-player discovery consumes); `rootToRegion` maps a root → the region key it
     * is filed under (so a mover can be pulled from its stale bucket, and so its
     * current region is an O(1) lookup). Maintained by `reconcileRootRegions` off
     * `dirtyNodes` each tick, gated `!env.client` like `dirtyNodes` itself, so both
     * stay empty in the client bundle. The filed-root set is exactly `rootToRegion`'s
     * keys, so there is no separate membership set.
     */
    regionToRoots: Map<string, Set<Node>>;
    rootToRegion: Map<Node, string>;

    /**
     * transform-root region transitions produced by `reconcileRootRegions` this tick:
     * a root that was filed, unfiled, or moved between regions. `from`/`to` are region
     * keys, `null` meaning "not filed" (newly eligible, or destroyed/shadowed). The
     * per-player AOI presence pass reads this to (re)evaluate a moved root's presence
     * against each client's region without ever climbing the tree. Cleared + refilled
     * each `reconcileRootRegions`, consumed by the same tick's scene fan-out.
     */
    rootRegionChanges: RootRegionChange[];

    /**
     * optional runtime reference. when set, registerSubtree creates script instances,
     * unregisterSubtree disposes them, and reparent fires enter/exit hooks automatically.
     * set this after createSceneTree, before adding live nodes.
     */
    context: SceneTreeContext | undefined;
};

export function createSceneTree(): SceneTree {
    const sceneTree: SceneTree = {
        root: null!,
        nodes: new Set(),
        queries: new Map(),
        _queryList: [],
        _queriesByTrait: [],
        _queriesAlways: [],
        _queryScratch: [],
        _visitGeneration: 0,
        _queryResolutionGroups: [],

        _nextNodeId: 1,
        _nextClientNodeId: -1,
        _idToNode: new Map(),
        playerIdToOwnedNodes: new Map(),
        _versions: { counter: 0 },
        _prefabNodes: new Set(),
        _prefabsDirty: new Set(),
        _transformDirty: new Set(),
        _interpolating: new Set(),
        dirtyNodes: [],
        regionToRoots: new Map(),
        rootToRegion: new Map(),
        rootRegionChanges: [],
        context: undefined,
    };

    // create root node, always present, cannot be destroyed.
    // root is explicitly 'shared' so 'inherit' descendants resolve there.
    const root = createNodeObject('Root', undefined, undefined, 'shared');
    root.id = sceneTree._nextNodeId++;
    root.scene = sceneTree;
    sceneTree.nodes.add(root);
    sceneTree._idToNode.set(root.id, root);
    sceneTree.root = root;

    return sceneTree;
}

/* node lifecycle */

export type CreateNodeOptions = {
    name?: string;
    /** provide a runtime numeric ID (e.g. when unpacking from network). auto-assigned if omitted. */
    id?: number;
    /** whether this node is saved to scene files. default: true. */
    persist?: boolean;
    /**
     * which side(s) this node lives on. defaults to `'inherit'`, which means
     * "take the effective realm from the nearest non-inherit ancestor". the
     * scene tree root is `'shared'`, so an `'inherit'` chain bottoms out
     * there unless an ancestor explicitly opts into `'server'`/`'client'`/`'each'`.
     */
    realm?: Realm;
};

/**
 * create a new **detached** node, not registered in any scene tree,
 * no script init, no queries. attach with `addChild(parent, node)` to
 * make it live; the scene tree allocates an id at attach time (negative
 * on the client, positive on the server).
 *
 * realm defaults to `'inherit'`, so the node takes whatever its eventual
 * parent dictates. set explicitly (`'server'`, `'client'`, `'each'`,
 * `'shared'`) to override.
 */
export function createNode(options?: CreateNodeOptions): Node {
    return createNodeObject(options?.name, options?.id, options?.persist, options?.realm);
}

/**
 * look up a node by its runtime ID. returns undefined if not found.
 */
export function getNodeById(sceneTree: SceneTree, id: number): Node | undefined {
    return sceneTree._idToNode.get(id);
}

/**
 * returns whether a node is alive (registered in a scene tree).
 */
export function nodeExists(node: Node): boolean {
    return node.scene !== null;
}

/**
 * set a node's owner, keeping `sceneTree.playerIdToOwnedNodes` in sync. all owner
 * writes outside tests should route through here, the index drives the
 * client's per-tick owner-sync replication loop, so silent direct assignment
 * to `node.owner` will desync that walk.
 */
export function setOwner(sceneTree: SceneTree, node: Node, owner: PlayerId | null): void {
    const prev = node.owner;
    if (prev === owner) return;
    if (prev !== null) {
        const prevSet = sceneTree.playerIdToOwnedNodes.get(prev);
        if (prevSet) {
            prevSet.delete(node);
            if (prevSet.size === 0) sceneTree.playerIdToOwnedNodes.delete(prev);
        }
    }
    node.owner = owner;
    if (owner !== null) {
        let set = sceneTree.playerIdToOwnedNodes.get(owner);
        if (!set) {
            set = new Set();
            sceneTree.playerIdToOwnedNodes.set(owner, set);
        }
        set.add(node);
    }
    // owner is replicated (node_owner); mark the change for discovery when the
    // node is live. (editor/scene-pack paths also bump explicitly, harmless.)
    if (node.scene) bumpNodeVersion(node.scene, node);
}

/**
 * set a node's realm. realm controls which side(s)/clients a node replicates to,
 * so changing it can flip the effective relevance of the whole subtree
 * (descendants inherit), mark them all dirty so the per-client discovery fan-out
 * re-evaluates visibility (create on become-visible, destroy on become-hidden).
 * route runtime realm changes through here so the change can't bypass discovery.
 */
export function setRealm(node: Node, realm: Realm): void {
    if (node.realm === realm) return;
    node.realm = realm;
    const scene = node.scene;
    if (!scene) return;
    bumpSubtreeVersions(scene, node);
}

/**
 * returns true iff this node is replicable from server to clients, i.e. every
 * node on the chain from root down to (and including) this one resolves to
 * `'shared'`. a `'shared'` node under a `'server'`/`'each'`/`'client'`
 * ancestor isn't reachable for the client because the ancestor never
 * replicates, so the descendant can't either. `'inherit'` nodes are
 * transparent, they defer to whatever ancestor next sets a concrete realm.
 *
 * does not consult `mode`, callers (e.g. discovery in edit mode) decide
 * whether to bypass the filter.
 */
export function isReplicable(node: Node): boolean {
    let cur: Node | null = node;
    while (cur) {
        if (cur.realm !== 'shared' && cur.realm !== 'inherit') return false;
        cur = cur.parent;
    }
    return true;
}

/**
 * True iff this node was created locally on the current runtime rather than
 * allocated by the server. The server allocates positive ids (and nodes
 * replicated in from the server keep their positive server id); a client
 * allocates negative ids for nodes it creates locally (see id assignment in
 * the attach path above). So on a client this is false for server-owned
 * (replicated-in) nodes and true for client-only ones, a true *origin* test,
 * unlike `isReplicable` (a realm-policy test). Use it to decide who authors a
 * node's derived content (e.g. the character rig): the server builds for its
 * nodes, a client builds only its own local ones and otherwise defers to
 * replication.
 */
export function isLocalNode(node: Node): boolean {
    return node.id < 0;
}

/**
 * True iff `node` is a *transform root*: the topmost `TransformTrait` node in its
 * chain (has a transform, no ancestor has one), and is live + replicable. Transform
 * roots are the unit of chunk-tied AOI: a root's world chunk gates the
 * presence of its whole subtree on a client, and nested transforms ride their root.
 * Derived on demand (no maintained set), reconciled per tick off `dirtyNodes`.
 */
export function isTransformRoot(node: Node): boolean {
    return node.scene !== null && isReplicable(node) && hasTrait(node, TransformTrait) && findTransformAncestor(node) === null;
}

/* ── transform-root region index (server-side AOI) ─────────────────────── */

/** a transform root's region transition this tick. `from`/`to` are region keys,
 *  `null` = not filed (newly eligible → `from: null`; destroyed or shadowed →
 *  `to: null`). moved-within-region produces no entry. */
export type RootRegionChange = { root: Node; from: string | null; to: string | null };

function fileRoot(sceneTree: SceneTree, node: Node, key: string): void {
    let set = sceneTree.regionToRoots.get(key);
    if (!set) {
        set = new Set();
        sceneTree.regionToRoots.set(key, set);
    }
    set.add(node);
    sceneTree.rootToRegion.set(node, key);
}

function unfileRoot(sceneTree: SceneTree, node: Node, key: string): void {
    const set = sceneTree.regionToRoots.get(key);
    if (set) {
        set.delete(node);
        // delete-on-empty: the world is streaming-infinite, never accumulate empty buckets.
        if (set.size === 0) sceneTree.regionToRoots.delete(key);
    }
    sceneTree.rootToRegion.delete(node);
}

/** the transform roots currently filed in a region, or undefined if none. read by
 *  the per-player AOI discovery to turn a region transition into node create/destroy. */
export function rootsInRegion(sceneTree: SceneTree, key: string): Set<Node> | undefined {
    return sceneTree.regionToRoots.get(key);
}

/**
 * reconcile the region index against this tick's `dirtyNodes`: file newly-eligible
 * transform roots, unfile ones that stopped being roots (lost the trait, got shadowed
 * by an ancestor transform, or were destroyed → `scene === null`), and re-bucket movers
 * whose world region changed. Records every transition in `rootRegionChanges` so the
 * per-player presence pass can re-evaluate moved roots without climbing the tree.
 * O(`dirtyNodes`). Call once per room per tick, after scripts + physics and before the
 * per-player AOI discovery reads the index.
 */
export function reconcileRootRegions(sceneTree: SceneTree): void {
    sceneTree.rootRegionChanges.length = 0;
    // length re-read each step: a node filed during the pass is still picked up, matching
    // what iterating the set used to do.
    for (let i = 0; i < sceneTree.dirtyNodes.length; i++) {
        const node = sceneTree.dirtyNodes[i]!;
        const filed = sceneTree.rootToRegion.get(node);
        if (isTransformRoot(node)) {
            const t = getTrait(node, TransformTrait)!;
            const c = getWorldChunk(t);
            const key = regionKey(chunkToRegionCoord(c[0]), chunkToRegionCoord(c[1]), chunkToRegionCoord(c[2]));
            if (filed === key) continue; // already filed here, nothing moved
            if (filed !== undefined) unfileRoot(sceneTree, node, filed);
            fileRoot(sceneTree, node, key);
            sceneTree.rootRegionChanges.push({ root: node, from: filed ?? null, to: key });
        } else if (filed !== undefined) {
            unfileRoot(sceneTree, node, filed);
            sceneTree.rootRegionChanges.push({ root: node, from: filed, to: null });
        }
    }
}

/**
 * destroy a node: dispose scripts, remove from parent, recursively
 * destroy children, remove from all queries, and detach from the scene tree.
 *
 * the scene tree's root node cannot be destroyed.
 */
export function destroyNode(sceneTree: SceneTree, node: Node): void {
    if (node.scene !== sceneTree) return;
    if (node === sceneTree.root) return; // root node is permanent

    // park the node in the discovery dirty set (server-side; no-op on the client).
    // node.scene is nulled at the end of this fn, so the fan-out sees node.scene
    // === null and emits node_destroyed. recurses, so each destroyed node lands
    // here. if the same node is re-added this tick it becomes live again → the
    // fan-out treats it as a create/update instead (add→remove→add correctness).
    markNodeDirty(sceneTree, node);

    // destroy children first (iterate a copy since we mutate)
    const childrenCopy = node.children.slice();
    for (let i = 0; i < childrenCopy.length; i++) {
        destroyNode(sceneTree, childrenCopy[i]);
    }

    // dispose all script instances from runtime
    if (sceneTree.context) {
        const nodeInstances = sceneTree.context.instances.get(node.id);
        if (nodeInstances) {
            for (const instance of nodeInstances.values()) {
                disposeScriptInstance(instance);
            }
            sceneTree.context.instances.delete(node.id);
        }
    }
    node._unresolvedTraits = null;

    // remove from all queries
    // a node can only be a member of a query that references one of its traits
    // (or of one with no positive self-trait at all), so the candidate set is
    // sufficient here — no need to sweep every query in the tree.
    const candidates = sceneTree._queryScratch;
    const count = collectQueries(sceneTree, node);
    for (let i = 0; i < count; i++) {
        const q = candidates[i]!;
        if (queryIndexOf(q, node) !== -1) removeNodeFromQuery(q, node);
    }

    // detach from parent
    if (node.parent) {
        removeChildInternal(node.parent, node);
    }

    // detach from scene tree
    setOwner(sceneTree, node, null);
    sceneTree.nodes.delete(node);
    sceneTree._idToNode.delete(node.id);
    // mirrors the guarded add in `registerSubtree`: nothing files a node into these unless
    // it bears a prefab, and `setPrefab` keeps them in step for a live node, so a plain
    // node never needs the two deletes.
    if (node.prefab !== null) {
        sceneTree._prefabNodes.delete(node);
        sceneTree._prefabsDirty.delete(node);
    }
    const t = getTrait(node, TransformTrait);
    if (t) releaseTransform(sceneTree, t);
    node.scene = null;

    // recursive: each level flushes once its own node is fully detached, so a
    // handler always sees a coherent (bottom-up) teardown.
    flushQueryEvents();
}

/* trait operations */

// ── parent transform bookkeeping ──────────────────────────────────────
//
// every TransformTrait instance has a parent transform pointer to the
// nearest ancestor node's TransformTrait (or null if none), maintained
// eagerly on hierarchy and trait mutations so it's always fresh. The
// maintenance itself is a `Resolution` like any other (see the
// `resolutions` section below); only the initial resolve for a node's own
// pointer lives here.

/**
 * nearest ancestor's TransformTrait, or null. A typed adapter over the shared
 * `nearestTrait` walk: `_parent` is `TransformTrait | null` and consumers
 * compare against null (`hasTransformedParent`), so the undefined the generic
 * walk returns is normalised here rather than at four call sites.
 */
function findTransformAncestor(node: Node): TransformTrait | null {
    const traitSlot = TransformTrait._slot;
    if (traitSlot === undefined) return null;
    return (nearestTrait(node, traitSlot, false) as TransformTrait | undefined) ?? null;
}

/** user-facing props for addTrait, only the trait's own declared fields, minus base fields. */
export type TraitProps<T extends TraitBase> = Partial<Omit<T, 'node' | '_def' | '_sync'>>;

/**
 * add a trait to a node. pass an optional props object to override defaults.
 *
 *   addTrait(node, Health, { current: 50, max: 100 })
 *
 * works on both detached and live nodes. for detached nodes, scene-tree-level ops
 * (version bump, query reindex) and script instantiation are skipped and
 * deferred to registerSubtree.
 *
 * if the trait def has registered scripts (via `script(handle, ...)`) and
 * the node is live in a scene tree with a runtime, one ScriptInstance is
 * created per script and onInit/onEnter fire immediately.
 */
export function addTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>, props?: TraitProps<T>): T {
    const traitSlot = handle._slot;

    // Re-adding a trait that's already present is a REPLACE: tear the old
    // instance down first (dispose its scripts → onExit fires — e.g. a
    // CharacterTrait unmounts its rig), so nothing it set up is orphaned.
    // Without this, a re-add silently overwrites the old instance and leaks
    // its scripts and any side effects (mounted nodes, listeners, ...).
    if (bitset.has(node._bitset, traitSlot)) {
        removeTrait(node, handle);
    }

    // build plain instance from field defs, apply prop overrides
    const instance = buildTraitInstance(handle._def, props as Record<string, unknown> | undefined) as T;
    attachTraitInstance(node, traitSlot, instance);

    const scene = node.scene;
    // descendants resolving this trait from the hierarchy now resolve to it.
    // runs detached too: a subtree is often fully built before it is attached.
    resolveChildren(scene, node, traitSlot);

    if (scene) {
        bumpNodeVersion(scene, node);
        reindex(scene, node, traitSlot);
        if (scene.context) {
            const created = instantiateTraitScripts(scene.context, node, instance, handle._def);
            for (const i of created) initScriptInstance(i);
            if (node.parent) {
                for (const i of created) {
                    for (const fn of i.onEnter) {
                        try {
                            fn(node.parent);
                        } catch (err) {
                            logScriptError(`script '${i.def.key}'.onEnter @${node.id}`, err);
                        }
                    }
                }
            }
        }
        // after the new trait's own scripts exist and have inited
        flushQueryEvents();
    }

    return instance;
}

/**
 * instantiate every script registered on `def` for this trait instance,
 * fire `onInit`, then `onEnter` if the node is in-graph. used by addTrait
 * (live path) and registerSubtree (scene-load path).
 */
function instantiateTraitScripts(runtime: SceneTreeContext, node: Node, trait: TraitBase, def: TraitDef): ScriptInstance[] {
    if (def.scripts.length === 0) return [];

    let nodeInstances = runtime.instances.get(node.id);
    if (!nodeInstances) {
        nodeInstances = new Map();
        runtime.instances.set(node.id, nodeInstances);
    }

    const created: ScriptInstance[] = [];
    for (const scriptDef of def.scripts) {
        if (nodeInstances.has(scriptDef.key)) continue;
        const instance = createScriptInstance(scriptDef, trait, node, runtime);
        nodeInstances.set(scriptDef.key, instance);
        created.push(instance);
    }
    return created;
}

/**
 * dispose every live script instance bound to a specific trait on a node.
 * fires onExit then onDispose. called from removeTrait and destroyNode paths.
 */
function disposeTraitScripts(runtime: SceneTreeContext, node: Node, def: TraitDef): void {
    if (def.scripts.length === 0) return;
    const nodeInstances = runtime.instances.get(node.id);
    if (!nodeInstances) return;

    for (const scriptDef of def.scripts) {
        const instance = nodeInstances.get(scriptDef.key);
        if (!instance) continue;
        if (node.parent) {
            for (const fn of instance.onExit) {
                try {
                    fn(node.parent);
                } catch (err) {
                    logScriptError(`script '${scriptDef.key}'.onExit @${node.id}`, err);
                }
            }
        }
        disposeScriptInstance(instance);
        nodeInstances.delete(scriptDef.key);
    }

    if (nodeInstances.size === 0) runtime.instances.delete(node.id);
}

/**
 * write a trait instance into a node's trait map and bitset. does not touch
 * the scene tree, queries, or transform parent pointers, those side
 * effects belong to addTrait. used by addTrait and cloneNode.
 */
function attachTraitInstance(node: Node, traitSlot: number, instance: TraitBase): void {
    instance._node = node;
    node._traits[traitSlot] = instance;
    bitset.add(node._bitset, traitSlot);
}

export function removeTrait(node: Node, handle: TraitHandle): void {
    const scene = node.scene;
    const traitSlot = handle._slot;
    if (traitSlot === undefined) return;

    if (bitset.has(node._bitset, traitSlot)) {
        // dispose scripts before clearing trait state, onExit fires while
        // the trait value is still resolvable.
        if (scene?.context) disposeTraitScripts(scene.context, node, handle._def);

        if (traitSlot === TransformTrait._slot) {
            releaseTransform(scene, getTrait(node, TransformTrait)!);
        }

        // update bitset so queries see the node as no longer matching
        bitset.remove(node._bitset, traitSlot);
        if (scene) {
            bumpNodeVersion(scene, node);
            // reindex this node, callbacks fire while trait value still in _traits
            reindex(scene, node, traitSlot);
        }
        // now safe to delete the value
        node._traits[traitSlot] = undefined;
        // descendants that resolved to this trait now fall through to the next
        // one above. runs after the delete so the walk sees the new answer.
        resolveChildren(scene, node, traitSlot);
        flushQueryEvents();
    }
}

export function getTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>): T | undefined {
    const traitSlot = handle._slot;
    if (traitSlot === undefined) return undefined;
    return node._traits[traitSlot] as T | undefined;
}

export function hasTrait(node: Node, handle: TraitHandle): boolean {
    const traitSlot = handle._slot;
    if (traitSlot === undefined) return false;
    return bitset.has(node._bitset, traitSlot);
}

/**
 * remove a trait by its numeric index. used internally by the inspector
 * and other engine code that works with numeric indices directly.
 */
export function removeTraitBySlot(node: Node, traitSlot: number): void {
    const scene = node.scene;

    if (bitset.has(node._bitset, traitSlot)) {
        if (scene?.context) {
            const def = registry.slotToTrait[traitSlot];
            if (def) disposeTraitScripts(scene.context, node, def);
        }

        if (traitSlot === TransformTrait._slot) {
            releaseTransform(scene, getTrait(node, TransformTrait)!);
        }

        bitset.remove(node._bitset, traitSlot);
        if (scene) {
            bumpNodeVersion(scene, node);
            reindex(scene, node, traitSlot);
        }
        node._traits[traitSlot] = undefined;
        resolveChildren(scene, node, traitSlot);
        flushQueryEvents();
    }
}

/**
 * add a trait by its numeric index. used internally by the inspector
 * and other engine code that works with numeric indices directly.
 */
export function addTraitBySlot(node: Node, traitSlot: number, props?: Record<string, unknown>): TraitBase | null {
    const scene = node.scene;

    const def = registry.slotToTrait[traitSlot];
    if (!def) return null;

    const instance = buildTraitInstance(def, props);
    instance._node = node;

    node._traits[traitSlot] = instance;
    bitset.add(node._bitset, traitSlot);


    // descendants resolving this trait from the hierarchy now resolve to it.
    // outside the `scene` guard: this path hydrates detached trees (scene-pack).
    resolveChildren(scene, node, traitSlot);

    if (scene) {
        bumpNodeVersion(scene, node);
        reindex(scene, node, traitSlot);
    }

    if (scene?.context) {
        const created = instantiateTraitScripts(scene.context, node, instance, def);
        for (const i of created) initScriptInstance(i);
        if (node.parent) {
            for (const i of created) {
                for (const fn of i.onEnter) {
                    try {
                        fn(node.parent);
                    } catch (err) {
                        logScriptError(`script '${i.def.key}'.onEnter @${node.id}`, err);
                    }
                }
            }
        }
    }

    flushQueryEvents();

    return instance;
}

/* trait validation issues */

/**
 * compute issues for every prop field on a trait instance against its def.
 * returned array is empty when the instance conforms to all schemas.
 */
export function computeTraitIssues(def: TraitDef, instance: TraitBase): Issue[] {
    if (def.controls.length === 0) return [];
    const issues: Issue[] = [];
    for (const reg of def.controls) {
        const value = reg.get(instance);
        const fieldIssues = validate(reg.schema, value);
        for (const issue of fieldIssues) {
            issues.push({
                ...issue,
                path: [reg.controlId, ...issue.path],
            });
        }
    }
    return issues;
}

/** read issues for a trait on a node. returns undefined if none recorded. */
export function getTraitIssues(node: Node, traitSlot: number): Issue[] | undefined {
    return node._traitIssues?.get(traitSlot);
}

/** set/clear issues for a trait. an empty array deletes the entry. */
export function setTraitIssues(node: Node, traitSlot: number, issues: Issue[]): void {
    if (issues.length === 0) node._traitIssues?.delete(traitSlot);
    else (node._traitIssues ??= new Map()).set(traitSlot, issues);
}

/** clear issues for one trait, or all traits when traitSlot is omitted. */
export function clearTraitIssues(node: Node, traitSlot?: number): void {
    if (traitSlot === undefined) node._traitIssues = null;
    else node._traitIssues?.delete(traitSlot);
}

/** true when the node has any trait with recorded issues. */
export function hasNodeIssues(node: Node): boolean {
    return (node._traitIssues?.size ?? 0) > 0;
}

/**
 * recompute and store issues for a trait, logging a console warning per
 * issue. label is prepended to the warning (e.g. node name or scene path)
 * so the source of the bad data is identifiable in mixed logs.
 */
export function refreshTraitIssues(node: Node, def: TraitDef, instance: TraitBase, label?: string): Issue[] {
    const issues = computeTraitIssues(def, instance);
    setTraitIssues(node, def.slot, issues);
    if (issues.length > 0) {
        const prefix = label ? `[bongle] ${label}` : '[bongle]';
        for (const issue of issues) {
            const where = formatIssuePath(issue.path);
            console.warn(`${prefix} trait '${def.id}' invalid at '${where}': ${issue.message}`);
        }
    }
    return issues;
}

/* script lifecycle (driven by trait attach / detach) */

/**
 * fire onInit on all uninitialized script instances in a scene tree.
 *
 * scripts are now owned by traits, for each trait on each node, instantiate
 * any missing script instance, then init, then fire enter hooks.
 *
 * call this after the tree is fully built and all runtime context is wired
 * (e.g. client.room, client.state) so onInit handlers can safely access them.
 * used by the client after unpackSceneTree + room wiring, before the first tick.
 */
export function initSceneTree(sceneTree: SceneTree): void {
    if (!sceneTree.context) return;

    // pass 1: create instances for any node-trait pairs that don't have one
    // (e.g. the client unpack path: unpackSceneTree runs without runtime, then
    // engine-client sets sceneTree.runtime and calls initSceneTree to instantiate)
    for (const node of sceneTree.nodes) {
        const nodeTraits = node._traits;
        for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
            const trait = nodeTraits[traitSlot];
            if (trait === undefined) continue;
            const def = registry.slotToTrait[traitSlot];
            if (!def || def.scripts.length === 0) continue;
            instantiateTraitScripts(sceneTree.context, node, trait, def);
        }
    }

    // pass 2: init all instances that haven't been initialized
    for (const nodeInstances of sceneTree.context.instances.values()) {
        for (const instance of nodeInstances.values()) {
            if (!instance.initialized) initScriptInstance(instance);
        }
    }

    // pass 3: fire enter hooks after all inits
    for (const node of sceneTree.nodes) {
        if (node.parent) fireEnterHooks(sceneTree.context, node, node.parent);
    }
}

/* hierarchy */

/**
 * add a child node to a parent. if the child already has a parent, it is
 * removed from the old parent first. if the parent is in a scene tree, the
 * child (and its descendants) are registered in that scene tree.
 */
export function addChild(parent: Node, child: Node): void {
    // if child already has a parent, detach first
    if (child.parent) {
        removeChildInternal(child.parent, child);
    }

    child.parent = parent;
    child._childIndex = parent.children.length;
    parent.children.push(child);

    // if parent is in a scene tree, register child subtree
    if (parent.scene) {
        registerSubtree(parent.scene, child);
    }

    // re-resolve every resolution over the attached subtree. runs even when
    // `parent` is itself detached — pointers within the subtree still matter.
    resolveSubtree(parent.scene, child, undefined);

    // last, so an enter handler reading a world matrix sees fresh pointers
    flushQueryEvents();
}

/**
 * remove a child from its parent. the child (and its descendants) are
 * detached from the scene tree and removed from all queries.
 */
export function removeChild(parent: Node, child: Node): void {
    if (child.parent !== parent) return;

    // detach subtree from scene tree first
    if (child.scene) {
        unregisterSubtree(child.scene, child);
    }

    removeChildInternal(parent, child);

    resolveSubtree(null, child, parent);

    flushQueryEvents();
}

/**
 * get a node's parent, or null if it has none.
 */
export function getParent(node: Node): Node | null {
    return node.parent;
}

/**
 * get a readonly snapshot of a node's children.
 */
export function getChildren(node: Node): Node[] {
    return node.children;
}

/**
 * position of `node` among its siblings, 0 when it has no parent.
 *
 * The hint on the node makes this O(1) for the replication fan-out, which asks for it once per known
 * node per client per flush and was scanning the sibling array every time. Any code that reorders
 * `children` without updating the hint just costs one repair here.
 */
export function childIndexOf(node: Node): number {
    const parent = node.parent;
    if (parent === null) return 0;
    const hint = node._childIndex;
    if (parent.children[hint] === node) return hint;
    const index = parent.children.indexOf(node);
    node._childIndex = index;
    return index;
}

/** renumber `children` from `start` after a splice. */
function reindexChildren(parent: Node, start: number): void {
    const children = parent.children;
    for (let i = start; i < children.length; i++) children[i]!._childIndex = i;
}

/**
 * move a node to a new parent. the node must be in the same scene tree as
 * the new parent, or detached (will be registered if parent is in a scene tree).
 */
export function reparent(node: Node, newParent: Node): void {
    if (node.parent === newParent) return;

    // can only reparent within the same scene tree (or from detached)
    if (node.scene !== null && node.scene !== newParent.scene) {
        throw new Error(`cannot reparent node to a different scene tree`);
    }
    if (newParent.scene === null) {
        throw new Error(`cannot reparent to a detached parent`);
    }

    const scene = newParent.scene;
    const oldParent = node.parent;
    const wasInTree = node.scene !== null;

    // fire onExit before detaching, old parent is still set
    if (oldParent && node.scene !== null && scene.context) {
        fireExitHooks(scene.context, node, oldParent);
    }

    if (node.parent) {
        removeChildInternal(node.parent, node);
    }
    node.parent = newParent;
    node._childIndex = newParent.children.length;
    newParent.children.push(node);

    // if node was detached, register it now (also fires onInit + onEnter + marks dirty)
    if (node.scene === null) {
        registerSubtree(scene, node);
    } else {
        // already in-tree reparent: fire onEnter with the new parent.
        if (scene.context) fireEnterHooks(scene.context, node, newParent);
        // mark the whole moved subtree for discovery: reparenting can flip
        // effective relevance (e.g. moving under a non-shared parent), and
        // descendants inherit it, the per-client fan-out must re-evaluate them.
        bumpSubtreeVersions(scene, node);
    }

    // re-resolve every resolution over the moved subtree. a node that was
    // already live carries its old parent, so ones that resolve identically
    // either side of the move skip their walk entirely.
    resolveSubtree(scene, node, wasInTree ? oldParent : null);

    flushQueryEvents();
}

/**
 * move a child to a specific index in its parent's children array.
 * does nothing if the child is not a child of parent.
 */
export function reorderChild(parent: Node, child: Node, index: number): void {
    if (child.parent !== parent) return;
    const current = childIndexOf(child);
    if (current === -1) return;
    parent.children.splice(current, 1);
    const target = Math.min(index, parent.children.length);
    parent.children.splice(target, 0, child);
    reindexChildren(parent, Math.min(current, target));
    // index change is a structural change discovery must replicate (it bumped
    // nothing before, the old per-client walk diffed childIndex directly).
    if (child.scene) bumpNodeVersion(child.scene, child);
}

/**
 * replace all children of `root` with `node`, destroying every other child.
 * `node` must be a direct child of `root`. analogous to the DOM's
 * `replaceChildren()`, useful after eager prefab instantiation when you
 * want to keep only one sub-node and discard the rest.
 */
export function replaceChildren(root: Node, node: Node): void {
    if (node.parent !== root) {
        throw new Error('replaceChildren: node must be a direct child of root');
    }
    const scene = root.scene;
    for (const child of root.children.slice()) {
        if (child === node) continue;
        if (scene) {
            destroyNode(scene, child);
        } else {
            // detached, just unlink
            child.parent = null;
        }
    }
    root.children = [node];
    node._childIndex = 0;
}

/**
 * returns true if `ancestor` is an ancestor of `descendant` (i.e. the
 * descendant is somewhere below the ancestor in the tree).
 */
export function isAncestorOf(ancestor: Node, descendant: Node): boolean {
    let current = descendant.parent;
    while (current !== null) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

/* hierarchy internals */

/** remove a child from parent's children array (does not touch scene tree registration) */
function removeChildInternal(parent: Node, child: Node): void {
    const idx = childIndexOf(child);
    if (idx !== -1) {
        parent.children.splice(idx, 1);
        reindexChildren(parent, idx);
    }
    child.parent = null;
    child._childIndex = 0;
}

/**
 * register a node and all its descendants into a scene tree.
 *
 * two-pass for scripts:
 *   pass 1, register: register nodes, index into queries, create script instances (if runtime present).
 *   pass 2, init: fire onInit on all newly created script instances.
 *
 * this ensures all nodes in the subtree are registered and all scripts
 * have their state available before any onInit fires.
 *
 * query enter events raised in pass 1 are staged, not emitted: the caller
 * flushes once transform pointers are rebuilt too. see `flushQueryEvents`.
 */
function registerSubtree(sceneTree: SceneTree, node: Node): void {
    // collect all nodes in the subtree (pre-order)
    const subtree: Node[] = [];
    collectSubtree(node, subtree);

    // pass 1: register all nodes in the scene tree + index into queries + create script instances
    const newScriptInstances: ScriptInstance[] = [];

    for (const n of subtree) {
        n.scene = sceneTree;
        sceneTree.nodes.add(n);
        // a node entering the live tree is a create for the discovery fan-out.
        // server-only (gated inside markNodeDirty); pre-order so creates emit
        // parent-first (fan-out also depth-orders as a backstop).
        markNodeDirty(sceneTree, n);
        if (n.prefab) {
            sceneTree._prefabNodes.add(n);
            sceneTree._prefabsDirty.add(n);
        }

        // assign runtime ID if needed (node entering scene tree from detached state).
        // client picks from the negative id space, server from the positive id space.
        if (n.id === 0) {
            n.id = env.client ? sceneTree._nextClientNodeId-- : sceneTree._nextNodeId++;
        } else if (n.id >= sceneTree._nextNodeId) {
            // pre-assigned id (e.g. from network unpack), bump counter past it
            sceneTree._nextNodeId = n.id + 1;
        }
        sceneTree._idToNode.set(n.id, n);

        const candidates = sceneTree._queryScratch;
        const candidateCount = collectQueries(sceneTree, n);
        for (let qi = 0; qi < candidateCount; qi++) {
            const q = candidates[qi]!;
            if (nodeMatchesQuery(n, q) && queryIndexOf(q, n) === -1) {
                addNodeToQuery(q, n);
            }
        }

        // create script instances for every trait on this node
        if (sceneTree.context) {
            const nodeTraits = n._traits;
            for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
                const trait = nodeTraits[traitSlot];
                if (trait === undefined) continue;
                const def = registry.slotToTrait[traitSlot];
                if (!def || def.scripts.length === 0) continue;
                const created = instantiateTraitScripts(sceneTree.context, n, trait, def);
                for (const i of created) newScriptInstances.push(i);
            }
        }
    }

    // fill the hierarchy slots pass 1 deferred, before any user code runs.
    // pass 2 fires `onInit`, and a script reading a query tuple there must not
    // see a half-built match.

    // pass 2: fire onInit on all new script instances
    for (const instance of newScriptInstances) {
        initScriptInstance(instance);
    }

    // pass 3: fire onEnter on each node that has a parent (all nodes in the subtree do)
    if (sceneTree.context) {
        for (const n of subtree) {
            if (n.parent) {
                fireEnterHooks(sceneTree.context, n, n.parent);
            }
        }
    }
}

/**
 * unregister a node and all its descendants from a scene tree.
 * disposes scripts, removes from queries, detaches from scene tree.
 */
function unregisterSubtree(sceneTree: SceneTree, node: Node): void {
    // unregister children first (bottom-up)
    for (let i = 0; i < node.children.length; i++) {
        unregisterSubtree(sceneTree, node.children[i]);
    }

    // fire onExit before disposing, parent is still set here
    if (sceneTree.context && node.parent) {
        fireExitHooks(sceneTree.context, node, node.parent);
    }

    // dispose all script instances from runtime, scripts re-instantiate
    // from traits when the subtree re-registers, so we drop the lot here.
    if (sceneTree.context) {
        const nodeInstances = sceneTree.context.instances.get(node.id);
        if (nodeInstances) {
            for (const instance of nodeInstances.values()) {
                disposeScriptInstance(instance);
            }
            sceneTree.context.instances.delete(node.id);
        }
    }

    const candidates = sceneTree._queryScratch;
    const candidateCount = collectQueries(sceneTree, node);
    for (let i = 0; i < candidateCount; i++) {
        const q = candidates[i]!;
        if (queryIndexOf(q, node) !== -1) removeNodeFromQuery(q, node);
    }

    setOwner(sceneTree, node, null);
    sceneTree.nodes.delete(node);
    sceneTree._idToNode.delete(node.id);
    // mirrors the guarded add in `registerSubtree`: nothing files a node into these unless
    // it bears a prefab, and `setPrefab` keeps them in step for a live node, so a plain
    // node never needs the two deletes.
    if (node.prefab !== null) {
        sceneTree._prefabNodes.delete(node);
        sceneTree._prefabsDirty.delete(node);
    }
    // a node leaving the live tree is a destroy for the discovery fan-out,
    // symmetric with registerSubtree marking entering nodes dirty. server-only
    // (gated inside markNodeDirty). the node ends this fn in dirtyNodes with
    // scene === null, so the fan-out emits node_destroyed (only to clients that
    // knew it). without this, removing a server-owned (owner === null) node via
    // removeChild never replicated, setOwner above only dirties when the owner
    // actually changes, which it doesn't for an already-server-owned node.
    markNodeDirty(sceneTree, node);
    node.scene = null;
}

/** collect all nodes in a subtree (pre-order) into the output array */
/** bump every node in the subtree, without materialising it. */
function bumpSubtreeVersions(scene: SceneTree, node: Node): void {
    bumpNodeVersion(scene, node);
    const children = node.children;
    for (let i = 0; i < children.length; i++) bumpSubtreeVersions(scene, children[i]!);
}

function collectSubtree(node: Node, out: Node[]): void {
    out.push(node);
    for (let i = 0; i < node.children.length; i++) {
        collectSubtree(node.children[i], out);
    }
}

/* traversal */

// re-exported from traverse.ts
export { traverse } from './traverse';

/* scene-tree-level script driving */

// memoised `script/<hook>/<key>` metric ids, built once per (hook, script) so the
// hot path (incl. while the client panel is closed and begin/end no-op) does no
// string work.
const perfKeyCache = new Map<string, Map<string, string>>();
function perfKey(hook: string, key: string): string {
    let byKey = perfKeyCache.get(hook);
    if (byKey === undefined) {
        byKey = new Map();
        perfKeyCache.set(hook, byKey);
    }
    let id = byKey.get(key);
    if (id === undefined) {
        id = `script/${hook}/${key}`;
        byKey.set(key, id);
    }
    return id;
}

// disabled metrics for hooks we don't surface (the physics-step hooks run from
// physics.tick, which has no metrics handle); begin/end no-op on it.
const SILENT = Debug.createMetrics(false);

// the one driver behind every runOn* below: walk initialized instances, run each
// `select`-ed hook fn with `args`, time it as `script/<hook>/<key>` (begin/end
// self-gate on metrics.enabled), and log errors with the node + hook name.
function runHook<A>(
    sceneTree: SceneTree,
    args: A,
    metrics: Debug.Metrics,
    hook: string,
    select: (i: ScriptInstance) => Iterable<(a: A) => void>,
): void {
    if (!sceneTree.context) return;
    for (const nodeInstances of sceneTree.context.instances.values()) {
        for (const instance of nodeInstances.values()) {
            if (!instance.initialized) continue;
            for (const fn of select(instance)) {
                const id = perfKey(hook, instance.def.key);
                Debug.begin(metrics, id);
                try {
                    fn(args);
                } catch (err) {
                    logScriptError(`script '${instance.def.key}'.${hook} @${instance.node.id}`, err);
                }
                Debug.end(metrics, id);
            }
        }
    }
}

/**
 * fire onInput hooks on all scripts. runs at the very start of each frame,
 * before runOnUpdate, so consumers can pre-process / consume input (e.g. an
 * editor zeroing mk._dx/_dy) before player controllers read it.
 */
export function runOnInput(sceneTree: SceneTree, args: FrameArgs, metrics: Debug.Metrics): void {
    runHook(sceneTree, args, metrics, 'onInput', (i) => i.onInput);
}

/**
 * update all scripts in the scene tree. fires once per frame before the
 * fixed-timestep tick loop, intended for input polling and camera binding.
 */
export function runOnUpdate(sceneTree: SceneTree, args: UpdateArgs, metrics: Debug.Metrics): void {
    runHook(sceneTree, args, metrics, 'onUpdate', (i) => i.onUpdate);
}

/**
 * tick all scripts in the scene tree. iterates all nodes and calls onTick
 * on each script instance.
 */
export function runOnTick(sceneTree: SceneTree, args: TickArgs, metrics: Debug.Metrics): void {
    runHook(sceneTree, args, metrics, 'onTick', (i) => i.onTick);
}

/**
 * fire onPrePhysicsStep hooks on all scripts in the scene tree. called after
 * tickSceneTree but before the physics step. routes through SILENT, it runs
 * from physics.tick, which carries no metrics, and isn't surfaced in the digest.
 */
export function runOnPrePhysicsStep(sceneTree: SceneTree, args: TickArgs): void {
    runHook(sceneTree, args, SILENT, 'onPrePhysicsStep', (i) => i.onPrePhysicsStep);
}

/**
 * fire onPostPhysicsStep hooks on all scripts in the scene tree. called after
 * the physics step, before frameSceneTree. SILENT, see runOnPrePhysicsStep.
 */
export function runOnPostPhysicsStep(sceneTree: SceneTree, args: TickArgs): void {
    runHook(sceneTree, args, SILENT, 'onPostPhysicsStep', (i) => i.onPostPhysicsStep);
}

/**
 * fire onPostAnimate hooks on all scripts in the scene tree.
 * called after Animation.tick (animator sampling) and before world-matrix
 * recompute, so post-anim callbacks see fresh local TRS but world matrices
 * are still last-tick.
 */
export function runOnPostAnimate(sceneTree: SceneTree, args: TickArgs, metrics: Debug.Metrics): void {
    runHook(sceneTree, args, metrics, 'onPostAnimate', (i) => i.onPostAnimate);
}

/**
 * frame all scripts in the scene tree. iterates all nodes and calls onFrame
 * on each script instance. intended for client-side render frame updates.
 */
export function runOnFrame(sceneTree: SceneTree, args: FrameArgs, metrics: Debug.Metrics): void {
    runHook(sceneTree, args, metrics, 'onFrame', (i) => i.onFrame);
}

/* serialization, schema-driven */

export type SerializeOptions = {
    /** if true, skip nodes with persist: false and traits with persist: false. */
    persistOnly?: boolean;
};

export type SerializedTrait = {
    id: string;
    /** persisted control values (only `control()`-decorated fields). undefined for tag traits. */
    controls: Record<string, unknown> | undefined;
};

export type SerializedNode = {
    realm: Realm;
    name: string | undefined;
    traits: SerializedTrait[];
    children: SerializedNode[];
    /** true means the node is persistent. omitted when true (the default). */
    persist?: boolean;
    /** present only on prefab nodes, references a scene resource. */
    prefab?: PrefabConfig;
};

/**
 * serialize a trait instance to a plain object for scene files.
 * only `control()`-decorated fields are serialized. tag traits get `controls: undefined`.
 */
function serializeTrait(traitSlot: number, instance: TraitBase, options?: SerializeOptions): SerializedTrait | null {
    const def = registry.slotToTrait[traitSlot];
    if (!def) return null;
    if (options?.persistOnly && !def.persist) return null;

    // tag trait: no controls
    if (def.controls.length === 0) {
        return { id: def.id, controls: undefined };
    }

    // extract control values from the instance. clone, callers (scene save,
    // blueprint capture, undo snapshots) retain this and reapply later;
    // sharing references with the live instance would let runtime mutations
    // (vec3.copy on transform.position etc.) corrupt the snapshot.
    const controls: Record<string, unknown> = {};
    for (const reg of def.controls) {
        const value = reg.get(instance);
        controls[reg.controlId] = value !== null && typeof value === 'object' ? cloneTraitValue(value) : value;
    }
    return { id: def.id, controls };
}

/**
 * serialize a node and all its descendants to a plain object.
 *
 * for each trait, only `control()`-decorated fields are serialized. runtime-only
 * fields and sync-only fields are skipped.
 *
 * tag traits (empty class) are serialized with `controls: undefined`.
 */
export function serializeNode(node: Node, options?: SerializeOptions): SerializedNode {
    // serialize traits
    const serializedTraits: SerializedTrait[] = [];

    const nodeTraits = node._traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const serialized = serializeTrait(traitSlot, instance, options);
        if (serialized) {
            serializedTraits.push(serialized);
        }
    }

    // include unresolved traits
    for (const [id, data] of node._unresolvedTraits ?? EMPTY_UNRESOLVED) {
        serializedTraits.push({ id, controls: data.json });
    }

    // prefab nodes own no authored children, all children are derived
    // from the prefab source and get re-instantiated at load time.
    // never persist them to avoid stale/circular data on disk.
    const children: SerializedNode[] = [];
    if (!node.prefab) {
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            if (options?.persistOnly && !child.persist) continue;
            children.push(serializeNode(child, options));
        }
    }

    return {
        realm: node.realm,
        name: node.name,
        persist: node.persist === false ? false : undefined,
        traits: serializedTraits,
        children,
        prefab: node.prefab ? structuredClone(node.prefab) : undefined,
    };
}

/**
 * deserialize a node tree from a plain object. the returned node is **detached**,
 * caller is responsible for `addChild(parent, node)` if attachment is desired.
 *
 * traits are restored from their definitions; their bound scripts are
 * instantiated by registerSubtree (via addChild) if sceneTree.runtime is set.
 *
 * resilient to schema changes:
 * - if a property field exists in saved data but not in the current schema, it is ignored.
 * - if a property field exists in the schema but not in saved data, the default is used.
 * - if a trait id is not registered, it is stashed as unresolved (preserving json data).
 */
export function deserializeNode(data: SerializedNode): Node {
    const node = createNodeObject(data.name, 0, data.persist !== false);

    // clone, node.prefab.args is mutable and the source data is often a cached
    // resource (prefab scene cache, scene file cache) shared across instantiations.
    node.prefab = data.prefab ? structuredClone(data.prefab) : null;

    node.realm = data.realm;

    for (const st of data.traits) {
        const def = registry.traits.byId.get(st.id);
        if (!def) {
            console.warn(`[bongle] unresolved trait "${st.id}" on node "${data.name ?? '(unnamed)'}" — preserving raw data`);
            // clone, _unresolvedTraits is read back on re-serialization;
            // mutations to control values elsewhere shouldn't corrupt the round-trip.
            (node._unresolvedTraits ??= new Map()).set(st.id, {
                json: st.controls ? (cloneTraitValue(st.controls) as Record<string, unknown>) : undefined,
            });
            continue;
        }

        // clone control values, trait fields like TransformTrait.position get
        // mutated in place (vec3.copy etc.). without this, mutations leak back
        // into the source data, contaminating future deserializations from the
        // same cached resource.
        const controls = st.controls ? (cloneTraitValue(st.controls) as Record<string, unknown>) : undefined;
        const instance = buildTraitInstance(def, controls);
        instance._node = node;
        node._traits[def.slot] = instance;
        bitset.add(node._bitset, def.slot);
        refreshTraitIssues(node, def, instance, `node "${data.name ?? '(unnamed)'}"`);
    }

    for (let i = 0; i < data.children.length; i++) {
        const child = deserializeNode(data.children[i]);
        addChild(node, child);
    }

    return node;
}

/**
 * clone a node and all its descendants. the returned subtree is **detached**,
 * it has no parent, is not registered in any scene tree, and its scripts are
 * not instantiated. add it to the graph with `addChild(parent, clone)` to wake
 * it up; `onInit` for any scripts fires at that point.
 *
 * source node may be detached.
 *
 * controls (editor + persisted state) are deep-copied via per-control packcat
 * codecs (`getControlCodecs`). runtime-only fields reset to defaults on the
 * clone, systems re-derive them on first tick (e.g. RigidBodyTrait.body
 * comes back null, and the installer rebuilds from the cloned `def` on the
 * next preStep).
 *
 * the clone root inherits the source's realm. callers who want a different
 * realm on the clone can assign `clone.realm = ...` before `addChild`.
 */
export function cloneNode(source: Node): Node {
    const clone = createNodeObject(source.name, 0, source.persist, source.realm);
    clone.prefab = source.prefab;

    const nodeTraits = source._traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const sourceInstance = nodeTraits[traitSlot];
        if (sourceInstance === undefined) continue;
        const def = sourceInstance._def;
        const cloneInstance = buildTraitInstance(def);
        const codecs = getControlCodecs(def);
        if (codecs) {
            for (let i = 0; i < codecs.length; i++) {
                const codec = codecs[i];
                const bytes = codec.pack(sourceInstance, source);
                const reg = def.controls[i];
                reg.set(cloneInstance, codec.unpack(bytes));
            }
        }
        attachTraitInstance(clone, traitSlot, cloneInstance);
    }

    // round-trip preserve traits whose defs aren't in the registry
    for (const [id, data] of source._unresolvedTraits ?? EMPTY_UNRESOLVED) {
        (clone._unresolvedTraits ??= new Map()).set(id, { json: data.json });
    }

    // scripts ride on traits, clone needs no script copy; registerSubtree
    // re-instantiates from the cloned trait list.

    for (const child of source.children) {
        addChild(clone, cloneNode(child));
    }

    return clone;
}

/**
 * find the first descendant of `node` (depth-first) whose `name` matches `name`.
 * returns null if none found. `node` itself is not considered a match.
 *
 * useful for resolving rig joint targets in animations and similar
 * name-keyed lookups (mirrors three.js `Object3D.getObjectByName`).
 */
export function findChildByName(node: Node, name: string): Node | null {
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.name === name) return child;
        const deeper = findChildByName(child, name);
        if (deeper) return deeper;
    }
    return null;
}

/**
 * find every descendant of `node` (depth-first) whose `name` matches `name`.
 * returns an empty array if none found. `node` itself is not considered a match.
 *
 * use when you genuinely need to handle multiple matches (e.g. counted-suffix
 * names from non-unique gltf labels). prefer `findChildByName` for unique lookups.
 */
export function findChildrenByName(node: Node, name: string): Node[] {
    const out: Node[] = [];
    collectChildrenByName(out, node, name);
    return out;
}

function collectChildrenByName(out: Node[], node: Node, name: string): void {
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.name === name) out.push(child);
        collectChildrenByName(out, child, name);
    }
}

/**
 * serialize the entire scene tree. the root node is a regular SerializedNode
 * with its children nested inside.
 */
export type SerializedSceneTree = {
    /** the root node of the scene, including all descendants */
    root: SerializedNode;
};

/**
 * save the scene tree to a JSON-friendly structure for writing to disk.
 * respects persist flags, skips nodes with persist: false and traits with
 * persist: false. only property fields are included.
 *
 * the root node is serialized as a regular node with its children nested inside.
 */
export function saveSceneTree(sceneTree: SceneTree): SerializedSceneTree {
    const options: SerializeOptions = { persistOnly: true };
    return { root: serializeNode(sceneTree.root, options) };
}

/**
 * load a scene tree from serialized JSON data (from disk).
 * clears existing children of root and replaces them with the loaded scene.
 * root traits, scripts, and name are restored from the saved data.
 *
 * if sceneTree.runtime is set, script instances are created and initialized as nodes
 * are added. set sceneTree.runtime before calling this function if you want live scripts.
 */
export function loadSceneTree(sceneTree: SceneTree, data: SerializedSceneTree): void {
    const root = sceneTree.root;
    const rootData = data.root;

    // clear existing children
    const existingChildren = root.children.slice();
    for (const child of existingChildren) {
        destroyNode(sceneTree, child);
    }

    // clear existing root scripts (data + instances)
    if (sceneTree.context) {
        const rootInstances = sceneTree.context.instances.get(root.id);
        if (rootInstances) {
            for (const instance of rootInstances.values()) {
                disposeScriptInstance(instance);
            }
            sceneTree.context.instances.delete(root.id);
        }
    }
    root._traits.length = 0;
    root._bitset = bitset.init();
    root._unresolvedTraits = null;
    root._traitIssues = null;

    // restore root name
    root.name = rootData.name;

    // restore root traits
    if (rootData.traits) {
        for (const st of rootData.traits) {
            const def = registry.traits.byId.get(st.id);
            if (!def) {
                console.warn(`[bongle] unresolved trait "${st.id}" on root node — preserving raw data`);
                (root._unresolvedTraits ??= new Map()).set(st.id, {
                    json: st.controls as Record<string, unknown> | undefined,
                });
                continue;
            }

            const controls = st.controls ? (cloneTraitValue(st.controls) as Record<string, unknown>) : undefined;
            const instance = buildTraitInstance(def, controls);
            instance._node = root;
            root._traits[def.slot] = instance;
            bitset.add(root._bitset, def.slot);
            refreshTraitIssues(root, def, instance, 'root node');
        }
        reindex(sceneTree, root);
    }

    // root scripts ride on traits, instantiate per trait if runtime present
    if (sceneTree.context) {
        const nodeTraits = root._traits;
        for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
            const trait = nodeTraits[traitSlot];
            if (trait === undefined) continue;
            const def = registry.slotToTrait[traitSlot];
            if (!def || def.scripts.length === 0) continue;
            const created = instantiateTraitScripts(sceneTree.context, root, trait, def);
            for (const i of created) initScriptInstance(i);
        }
    }

    // the root's own reindex above is staged; drain it before children land
    flushQueryEvents();

    // deserialize children of root (registerSubtree fires via addChild, creating instances)
    for (const nodeData of rootData.children) {
        const child = deserializeNode(nodeData);
        addChild(root, child);
    }
}

/* query system */

/**
 * Sparse-index key for a node id. Server ids count up from 1 and client ids
 * down from -1, and a client tree holds both (replicated nodes arrive with
 * server ids), so the two runs are interleaved into one dense-ish key space.
 */
/** record `node`'s position in `q.matches`, in whichever sparse array owns its id's sign. */
function sparseSet(q: Query<any>, id: number, index: number): void {
    if (id >= 0) q._sparse[id] = index;
    else q._sparseNeg[-id] = index;
}

/** remove `value` from `arr` by swap-pop, if present. */
function swapRemove<T>(arr: T[], value: T): void {
    const i = arr.indexOf(value);
    if (i === -1) return;
    arr[i] = arr[arr.length - 1]!;
    arr.pop();
}

function pushCandidates(sceneTree: SceneTree, slot: number, gen: number, out: Array<Query<any>>, n: number): number {
    const list = sceneTree._queriesByTrait[slot];
    if (list === undefined) return n;
    for (let i = 0; i < list.length; i++) {
        const q = list[i]!;
        if (q._visitGeneration === gen) continue;
        q._visitGeneration = gen;
        out[n++] = q;
    }
    return n;
}

/**
 * Gather the queries whose verdict for `node` could have changed, into the
 * scene tree's scratch buffer; returns how many. Pass `changedSlot` when a
 * single trait was added or removed, otherwise every trait the node bears is
 * considered.
 *
 * Walks the node's bitset words rather than its trait map: iterating a Map
 * allocates an iterator, and this runs once per node per membership site.
 */
function collectQueries(sceneTree: SceneTree, node: Node, changedSlot?: number): number {
    const gen = ++sceneTree._visitGeneration;
    const out = sceneTree._queryScratch;
    let n = 0;

    const always = sceneTree._queriesAlways;
    for (let i = 0; i < always.length; i++) {
        const q = always[i]!;
        q._visitGeneration = gen;
        out[n++] = q;
    }

    if (changedSlot !== undefined) return pushCandidates(sceneTree, changedSlot, gen, out, n);

    const bits = node._bitset;
    for (let w = 0; w < bits.length; w++) {
        let word = bits[w]!;
        while (word !== 0) {
            const bit = word & -word;
            n = pushCandidates(sceneTree, w * 32 + (31 - Math.clz32(bit)), gen, out, n);
            word ^= bit;
        }
    }
    return n;
}


/** position of `node` in `q.matches`, or -1. */
function queryIndexOf(q: Query<any>, node: Node): number {
    const id = node.id;
    const i = id >= 0 ? q._sparse[id] : q._sparseNeg[-id];
    return i !== undefined && q.matchNodes[i] === node ? i : -1;
}

/** placeholder until `query()` binds a term's apply to its query. */
function noopApply(): void {}

export type Query<Conditions extends Array<Condition<any, any, any>>> = {
    hash: string;
    conditions: [...Conditions];
    withTraits: number[];
    withBitset: Bitset;
    withoutBitset: Bitset;
    matches: Array<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /** the node behind each entry of `matches`, same index. Also the validity
     *  check for `_sparse`, whose entries are allowed to go stale. */
    matchNodes: Node[];
    /**
     * @internal sparse membership index: node id (zigzagged, since client ids
     * are negative) → position in `matches`. A plain array, not a Map: node
     * ids are integers so V8 keeps this as a fast elements-kind array, and
     * membership is looked up once per resolution per visited node in the walk,
     * which measured as the dominant cost of the walk.
     *
     * Entries are never cleared on removal — a stale index is caught by
     * `matchNodes[i] === node`, the same trick koota's SparseSet uses.
     */
    _sparse: number[];
    /** @internal the negative-id half of `_sparse`, indexed by `-id`. Split by sign rather
     *  than zigzagged into one array: a scene tree's ids are effectively all one sign
     *  (server positive, client negative), so interleaving doubled the length and left
     *  every other slot a permanent hole. */
    _sparseNeg: number[];
    /** @internal Self-sourced `Optional` terms, with the tuple slot each writes. These are
     *  the only terms whose value can change while membership does not: a required Self term
     *  changing flips membership, and hierarchy terms are maintained by the resolve walk. */
    _optionalSelfTerms: Array<{ traitSlot: number; tupleIndex: number }>;
    /** @internal `conditions` minus the `Not` terms, in tuple order. Precomputed so
     *  `buildQueryTuple` knows its exact arity and can build a literal. */
    _tupleTerms: Array<Condition<any, any, any>>;
    /** terms whose value comes from the hierarchy (`Up` / `Ancestor`), with the
     *  tuple slot each writes. empty for the ordinary self-only query, which is
     *  what lets structural mutations skip the resolve walk entirely. */
    traversals: TraversalTerm[];
    /** node started matching. subscribe with {@link onQueryEnter}, never directly:
     *  the topic alone has no backfill, no error isolation, and no lifetime. */
    onEnter: Topic<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /** node stopped matching. subscribe with {@link onQueryExit}. */
    onExit: Topic<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /**
     * live ref-count from script instances that called `query(ctx, ...)`.
     * 0 + `acquired` false → engine-persistent (never reaped).
     * 0 + `acquired` true → all script holders released; reap on next releaseQuery.
     */
    refcount: number;
    /** true once any script instance has acquired this query; gates reaping. */
    acquired: boolean;
    /** @internal dedupe stamp for candidate collection. */
    _visitGeneration: number;
    [Symbol.iterator](): Iterator<[...traits: ExtractTraitsFromConditions<Conditions>]>;
};

/**
 * the full `matches` array of a query, keyed by the same condition args you pass to {@link query}
 * (e.g. `QueryMatches<[typeof ScoreTrait, typeof TransformTrait]>`). use it to type a function that
 * receives query matches without hand-respelling the trait tuple:
 *
 * ```ts
 * const fighters = query(ctx, [ScoreTrait, TransformTrait]);
 * const positions = (matches: QueryMatches<[typeof ScoreTrait, typeof TransformTrait]>) => ...;
 * positions(fighters.matches);
 * ```
 */
export type QueryMatches<Args extends ConditionArgs[]> = Query<ConditionArgsToConditions<Args>>['matches'];
/** one element of {@link QueryMatches}, the trait tuple a single query result yields. */
export type QueryMatch<Args extends ConditionArgs[]> = QueryMatches<Args>[number];

/**
 * one `Up` / `Ancestor` term of a query, resolved against the hierarchy rather
 * than the node's own bitset. `tupleIndex` is the slot it writes in a match;
 * `required` terms also gate membership, so a re-resolve can add or drop a node.
 */
export type TraversalTerm = Resolution & {
    required: boolean;
    tupleIndex: number;
};

/**
 * nearest trait instance at or above `node`, per `inclusive`. the walk is
 * O(depth) map lookups and runs only on structural change, never per frame.
 */
function nearestTrait(node: Node | null, traitSlot: number, inclusive: boolean): TraitBase | undefined {
    let cur: Node | null = inclusive ? node : (node?.parent ?? null);
    while (cur) {
        const t = cur._traits[traitSlot];
        if (t !== undefined) return t;
        cur = cur.parent;
    }
    return undefined;
}

/** resolve one term's value for `node`, honouring its source. */
function resolveTerm(node: Node, condition: Condition<any, any, any>): TraitBase | undefined {
    const traitSlot = condition.trait._slot;
    if (traitSlot === undefined) return undefined;
    if (condition.src === Src.Self) return node._traits[traitSlot];
    return nearestTrait(node, traitSlot, condition.src === Src.Up);
}

function buildConditionBitsets(conditions: ConditionArgs[]): {
    parsedConditions: Array<Condition<any, any, any>>;
    withBitset: Bitset;
    withoutBitset: Bitset;
    withTraits: number[];
    traversals: TraversalTerm[];
    optionalSelfTerms: Array<{ traitSlot: number; tupleIndex: number }>;
} {
    const parsedConditions = conditions.map((cond): Condition<any, any, any> => {
        if (typeof cond === 'object' && cond !== null && '_slot' in cond) {
            // bare trait handle → implicit With
            return { trait: cond, oper: Oper.And, src: Src.Self };
        }
        return cond as Condition<any, any, any>;
    });

    let withBitset = bitset.init();
    let withoutBitset = bitset.init();
    const withTraits: number[] = [];
    const traversals: TraversalTerm[] = [];
    const optionalSelfTerms: Array<{ traitSlot: number; tupleIndex: number }> = [];

    // tuple index advances for every value-carrying term, i.e. everything but Not.
    let tupleIndex = 0;
    for (const condition of parsedConditions) {
        const traitSlot = condition.trait._slot;
        if (condition.oper === Oper.Not) {
            if (traitSlot !== undefined) withoutBitset = bitset.add(withoutBitset, traitSlot);
            continue;
        }
        if (traitSlot !== undefined) {
            if (condition.src === Src.Self) {
                // only a self-sourced requirement is a bitmask test on the node.
                if (condition.oper === Oper.And) {
                    withBitset = bitset.add(withBitset, traitSlot);
                    withTraits.push(traitSlot);
                } else {
                    optionalSelfTerms.push({ traitSlot, tupleIndex });
                }
            } else {
                traversals.push({
                    traitSlot,
                    // a query term writes into its members, not into one trait's instances.
                    ownerSlot: -1,
                    inclusive: condition.src === Src.Up,
                    required: condition.oper === Oper.And,
                    tupleIndex,
                    // bound to the query below, once it exists.
                    apply: noopApply,
                });
            }
        }
        tupleIndex++;
    }

    return {
        parsedConditions,
        withBitset: bitset.trim(withBitset),
        withoutBitset: bitset.trim(withoutBitset),
        withTraits,
        traversals,
        optionalSelfTerms,
    };
}

export function query<const Args extends ConditionArgs[]>(
    sceneTree: SceneTree,
    conditions: Args,
): Query<ConditionArgsToConditions<Args>> {
    const { parsedConditions, withBitset, withoutBitset, withTraits, traversals, optionalSelfTerms } =
        buildConditionBitsets(conditions);

    // hash conditions (order matters, do not sort). oper and src both belong in
    // the key: `[Mesh, Up(Model)]` and `[Mesh, Model]` are different queries.
    const hashParts: string[] = [];
    for (const c of parsedConditions) {
        hashParts.push(`${OPER_TAG[c.oper]}${SRC_TAG[c.src]}${c.trait._slot}`);
    }
    const hash = hashParts.join(',');

    // return existing query if already registered
    const existing = sceneTree.queries.get(hash);
    if (existing) {
        return existing as Query<ConditionArgsToConditions<Args>>;
    }

    // create query
    const q: Query<ConditionArgsToConditions<Args>> = {
        hash,
        conditions: parsedConditions as unknown as [...ConditionArgsToConditions<Args>],
        withTraits,
        withBitset,
        withoutBitset,
        matches: [],
        matchNodes: [],
        _sparse: [],
        _sparseNeg: [],
        _optionalSelfTerms: optionalSelfTerms,
        _tupleTerms: parsedConditions.filter((c) => c.oper !== Oper.Not),
        traversals,
        onEnter: topic(),
        onExit: topic(),
        refcount: 0,
        acquired: false,
        _visitGeneration: 0,
        [Symbol.iterator]() {
            return this.matches[Symbol.iterator]();
        },
    };

    // bind each traversal term's apply to this query. one closure per term for
    // the life of the query, so the resolve walk allocates nothing.
    for (const term of traversals) {
        term.apply = (node, resolved) => applyTraversal(q, term, node, resolved);
    }

    // register query
    sceneTree.queries.set(hash, q);
    sceneTree._queryList.push(q);
    if (withTraits.length === 0) {
        sceneTree._queriesAlways.push(q);
    } else {
        for (const c of parsedConditions) {
            const slot = c.trait._slot;
            if (slot === undefined) continue;
            const list = sceneTree._queriesByTrait[slot];
            if (list === undefined) sceneTree._queriesByTrait[slot] = [q];
            else list.push(q);
        }
    }
    for (const term of traversals) addQueryResolution(sceneTree, term);

    // populate with existing matching nodes
    for (const node of sceneTree.nodes) {
        if (nodeMatchesQuery(node, q)) {
            addNodeToQuery(q, node);
        }
    }

    return q;
}

/**
 * acquire a script-side reference to a query. paired with `releaseQuery`.
 * engine-side callers of `query()` skip this and let the query persist for
 * the lifetime of the scene tree.
 */
export function acquireQuery(_sceneTree: SceneTree, q: Query<any>): void {
    q.refcount++;
    q.acquired = true;
}

/**
 * release a script-side reference. when refcount hits zero on a query that
 * was ever acquired, evict from `sceneTree.queries` so per-mutation walks stop
 * paying for it.
 */
export function releaseQuery(sceneTree: SceneTree, q: Query<any>): void {
    q.refcount--;
    if (q.refcount <= 0 && q.acquired) {
        sceneTree.queries.delete(q.hash);
        swapRemove(sceneTree._queryList, q);
        swapRemove(sceneTree._queriesAlways, q);
        for (const c of q.conditions) {
            const slot = (c as Condition<any, any, any>).trait._slot;
            if (slot === undefined) continue;
            const list = sceneTree._queriesByTrait[slot];
            if (list !== undefined) swapRemove(list, q);
        }
        for (const term of q.traversals) {
            removeQueryResolution(sceneTree, term);
        }
    }
}

/**
 * one-shot match, returns nodes satisfying `conditions` at call time.
 *
 * unlike `query()`, no caching, no event subscriptions, no `sceneTree.queries` entry.
 * use this when you need a snapshot (e.g. populating an inspector picker)
 * rather than a live-maintained set.
 */
export function filter<const Args extends ConditionArgs[]>(sceneTree: SceneTree, conditions: Args): Node[] {
    const { withBitset, withoutBitset } = buildConditionBitsets(conditions);
    const result: Node[] = [];
    for (const node of sceneTree.nodes) {
        if (bitset.containsAll(node._bitset, withBitset) && bitset.containsNone(node._bitset, withoutBitset)) {
            result.push(node);
        }
    }
    return result;
}

/* ── query membership events ──────────────────────────────────────────
 *
 * enter/exit are staged, not emitted inline. a node is indexed into queries
 * partway through `registerSubtree` (before its own scripts exist) and in
 * `addTrait` (before the new trait's scripts are instantiated), so emitting
 * at index time would hand handlers a node that is not finished being built.
 * every public mutation entry point calls `flushQueryEvents` once it has a
 * consistent tree, which is also the point where nested mutations raised by a
 * handler drain: `_flushingQueryEvents` makes a nested flush a no-op and the
 * outer loop picks up whatever was appended.
 */

type QueryEvent = { topic: Topic<any>; tuple: any[] };

const _pendingQueryEvents: QueryEvent[] = [];
let _flushingQueryEvents = false;

function callQueryListener(listener: Listener<any>, tuple: any[]): void {
    try {
        listener(...tuple);
    } catch (err) {
        // script-registered listeners log their own identity and never throw;
        // this catches engine-side subscribers so one cannot abort the drain.
        logScriptError('query membership handler', err);
    }
}

function emitQueryEvent(t: Topic<any>, tuple: any[]): void {
    for (const listener of t.listeners) {
        callQueryListener(listener, tuple);
    }
}

/**
 * emit every staged enter/exit. called at the end of each public mutation
 * (addChild, removeChild, reparent, destroyNode, addTrait, removeTrait, ...),
 * once the tree is consistent again.
 */
export function flushQueryEvents(): void {
    if (_flushingQueryEvents) return;
    _flushingQueryEvents = true;
    // length is read every iteration on purpose: a handler that mutates the
    // tree appends to this same queue and gets drained by this loop.
    for (let i = 0; i < _pendingQueryEvents.length; i++) {
        const event = _pendingQueryEvents[i]!;
        emitQueryEvent(event.topic, event.tuple);
    }
    _pendingQueryEvents.length = 0;
    _flushingQueryEvents = false;
}

/**
 * subscribe to nodes *starting* to match `q`.
 *
 * **subscribing is itself an enter**: the handler fires immediately for every
 * node already matching, so a subscriber never has to hand-write a backfill
 * loop over `q.matches` (the classic way to miss everything that loaded before
 * the subscriber existed).
 *
 * fires after the node is fully live: its whole subtree is registered and its
 * own scripts have run `onInit`. structural changes made inside a handler take
 * effect immediately, and any membership events they raise drain in the same
 * flush.
 */
export function onQueryEnter<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): Unsubscribe {
    q.onEnter.add(fn as Listener<any>);
    // snapshot: a handler is free to mutate the tree, which swap-removes from
    // `matches` underneath us.
    for (const tuple of q.matches.slice()) {
        callQueryListener(fn as Listener<any>, tuple as any[]);
    }
    return () => offQueryEnter(q, fn);
}

/** drop an {@link onQueryEnter} subscription. no exit drain, enter has no
 *  teardown half. idempotent. */
export function offQueryEnter<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): void {
    q.onEnter.remove(fn as Listener<any>);
}

/**
 * subscribe to nodes *stopping* matching `q`.
 *
 * **unsubscribing is itself an exit**: the handler fires for every node still
 * matching when the subscription ends. paired with {@link onQueryEnter}'s
 * backfill that gives one invariant worth relying on, every enter is matched by
 * exactly one exit, so a per-node resource owned by a handler cannot leak, not
 * across scene teardown and not across a hot reload.
 */
export function onQueryExit<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): Unsubscribe {
    q.onExit.add(fn as Listener<any>);
    return () => offQueryExit(q, fn);
}

/**
 * drop an {@link onQueryExit} subscription, firing it one last time for every
 * node still matching. idempotent: a second call drains nothing.
 */
export function offQueryExit<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): void {
    if (!q.onExit.listeners.has(fn as Listener<any>)) return;
    q.onExit.remove(fn as Listener<any>);
    for (const tuple of q.matches.slice()) {
        callQueryListener(fn as Listener<any>, tuple as any[]);
    }
}

/* query internals */

function nodeMatchesQuery(node: Node, q: Query<any>): boolean {
    if (!bitset.containsAll(node._bitset, q.withBitset)) return false;
    if (!bitset.containsNone(node._bitset, q.withoutBitset)) return false;
    // a required hierarchy term can't be answered from the node's own bitset.
    for (let i = 0; i < q.traversals.length; i++) {
        const term = q.traversals[i]!;
        if (!term.required) continue;
        if (nearestTrait(node, term.traitSlot, term.inclusive) === undefined) return false;
    }
    return true;
}

/**
 * Build a match tuple. `Not` terms contribute no slot; everything else does, `null` when
 * unresolved, so a tuple's arity never depends on what resolved.
 *
 * Hierarchy terms resolve here, with an O(depth) ancestor walk per node. A bulk register
 * used to defer them to null and let the resolve walk carry values down instead, O(1) per
 * node — asymptotically better, but it measured as indistinguishable even on a 64-deep
 * chain, and it cost a queued-enter aliasing trick plus five threaded flags to keep
 * straight. A tuple is now complete the moment it is built.
 */
function termValue(condition: Condition<any, any, any>, node: Node): unknown {
    return resolveTerm(node, condition) ?? null;
}

function buildQueryTuple(q: Query<any>, node: Node): any[] {
    // an array literal allocates its elements store at the exact arity; `[]` plus
    // `push` allocates a 16-slot store no matter how few elements go in.
    const terms = q._tupleTerms;
    switch (terms.length) {
        case 0:
            return [];
        case 1:
            return [termValue(terms[0]!, node)];
        case 2:
            return [termValue(terms[0]!, node), termValue(terms[1]!, node)];
        case 3:
            return [termValue(terms[0]!, node), termValue(terms[1]!, node), termValue(terms[2]!, node)];
        case 4:
            return [
                termValue(terms[0]!, node),
                termValue(terms[1]!, node),
                termValue(terms[2]!, node),
                termValue(terms[3]!, node),
            ];
    }
    const tuple: any[] = [];
    for (let i = 0; i < terms.length; i++) tuple.push(termValue(terms[i]!, node));
    return tuple;
}

function addNodeToQuery(q: Query<any>, node: Node): void {
    const tuple = buildQueryTuple(q, node);
    sparseSet(q, node.id, q.matches.length);
    q.matchNodes.push(node);
    q.matches.push(tuple as any);

    // the tuple pushed above is the event payload: it stays valid even if a
    // later swap-remove moves it out of `matches` before the flush.
    if (q.onEnter.listeners.size > 0) {
        _pendingQueryEvents.push({ topic: q.onEnter, tuple });
    }
}

function removeNodeFromQuery(q: Query<any>, node: Node): void {
    const index = queryIndexOf(q, node);
    if (index === -1) return;

    // capture the payload BEFORE the swap-remove: removeTrait deletes the
    // trait value from `_traits` right after reindexing, so it has to be read
    // here, and a handler must never see the departing node still in `matches`.
    const tuple = q.onExit.listeners.size > 0 ? buildQueryTuple(q, node) : null;

    // swap-remove from matches, keeping matchNodes in lockstep. The moved
    // entry's sparse slot is repointed; the departing node's is left stale,
    // since `matchNodes[i] === node` will reject it.
    const lastIndex = q.matches.length - 1;
    if (index !== lastIndex) {
        q.matches[index] = q.matches[lastIndex] as any;
        const movedNode = q.matchNodes[lastIndex]!;
        q.matchNodes[index] = movedNode;
        sparseSet(q, movedNode.id, index);
    }

    q.matches.pop();
    q.matchNodes.pop();

    if (tuple !== null) {
        _pendingQueryEvents.push({ topic: q.onExit, tuple });
    }
}

/* ── resolutions ──────────────────────────────────────────────────────
 *
 * A `Resolution` keeps "the nearest trait at or above me" resolved for
 * every node, and is re-resolved when the tree changes shape or the target
 * trait is added/removed. Two kinds of consumer, one mechanism:
 *
 *   - a query's `Up` / `Ancestor` terms, whose apply writes the match tuple
 *   - `TransformTrait._parent`, whose apply writes the field and marks the
 *     subtree's world matrices stale
 *
 * Invalidation is pushed from the mutation rather than discovered by
 * rescanning: `resolveSubtree` after the tree around a node changed shape,
 * `resolveChildren` when the target trait on the node itself changed.
 *
 * The walk prunes: at a node bearing the target trait, everything below
 * already resolves to that node and cannot have been affected by whatever
 * changed above it, so the descent stops there.
 */

/** apply a freshly resolved value for one query term to one node. */
function applyTraversal(q: Query<any>, term: TraversalTerm, node: Node, resolved: TraitBase | undefined): void {
    const index = queryIndexOf(q, node);
    if (term.required) {
        // a required term gates membership, so its resolution flipping can add
        // or drop the node. re-test the whole query: cheap, and correct against
        // the node's other conditions.
        const matches = nodeMatchesQuery(node, q);
        if (matches && index === -1) {
            addNodeToQuery(q, node);
            return;
        }
        if (!matches) {
            if (index !== -1) removeNodeFromQuery(q, node);
            return;
        }
        // still a member and nothing was added or removed, so the index above still stands.
    }

    if (index === -1) return;
    const tuple = q.matches[index] as any[];
    const next = resolved ?? null;
    if (tuple[term.tupleIndex] === next) return;
    replaceTuple(q, index, tuple, term.tupleIndex, next);
}

/**
 * A still-matching node whose tuple contents changed: what the consumer was handed is no
 * longer valid, so the old tuple is retired with an exit and a fresh one entered. Membership
 * itself is untouched — `matchNodes` and the sparse index keep their slots — so this costs
 * one tuple, not a remove-and-re-add.
 *
 * During the initial fill there is nothing to retire: `addNodeToQuery` already queued an
 * enter holding this very array, and the fill writes through that same reference so the
 * handler sees completed values. Mutating in place is what makes that aliasing work.
 */
function replaceTuple(q: Query<any>, index: number, tuple: any[], slot: number, next: unknown): void {
    if (q.onExit.listeners.size === 0 && q.onEnter.listeners.size === 0) {
        tuple[slot] = next;
        return;
    }
    const replacement = tuple.slice();
    replacement[slot] = next;
    q.matches[index] = replacement as never;
    if (q.onExit.listeners.size > 0) _pendingQueryEvents.push({ topic: q.onExit, tuple: tuple as never });
    if (q.onEnter.listeners.size > 0) _pendingQueryEvents.push({ topic: q.onEnter, tuple: replacement as never });
}

/**
 * re-resolve one slot's worth of resolutions over `node` and, unless pruned, its
 * descendants. Every member of `group` targets the same trait slot, so they share the
 * walk, what the node bears, and the prune; only which value each is handed differs.
 */
function resolveFrom(group: Resolution[], node: Node, inherited: TraitBase | undefined): void {
    const own = node._traits[group[0]!.traitSlot];
    const upValue = own ?? inherited;
    for (let i = 0; i < group.length; i++) {
        const resolution = group[i]!;
        resolution.apply(node, resolution.inclusive ? upValue : inherited);
    }
    // stop at a bearer: everything below already resolves to it, and nothing above
    // changed that.
    if (own !== undefined) return;
    for (const child of node.children) {
        resolveFrom(group, child, upValue);
    }
}

/**
 * re-resolve every live resolution over `node`'s subtree, seeding each from what
 * `node` inherits from strictly above. Call after the tree around `node` has
 * changed shape (attach, detach, reparent).
 */
export function resolveSubtree(sceneTree: SceneTree | null, node: Node, movedFrom?: Node | null): void {
    invalidateTransformAncestry(node, movedFrom);
    if (sceneTree !== null) resolveSubtreeFor(sceneTree._queryResolutionGroups, node, movedFrom);
}

/** file a query's traversal term under its target slot, opening a bucket if it is the first. */
function addQueryResolution(sceneTree: SceneTree, term: Resolution): void {
    const groups = sceneTree._queryResolutionGroups;
    for (let i = 0; i < groups.length; i++) {
        if (groups[i]![0]!.traitSlot === term.traitSlot) {
            groups[i]!.push(term);
            return;
        }
    }
    groups.push([term]);
}

/** drop a released query's term, closing the bucket if it was the last one in it. */
function removeQueryResolution(sceneTree: SceneTree, term: Resolution): void {
    const groups = sceneTree._queryResolutionGroups;
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!;
        const j = group.indexOf(term);
        if (j === -1) continue;
        group[j] = group[group.length - 1]!;
        group.pop();
        if (group.length === 0) {
            groups[i] = groups[groups.length - 1]!;
            groups.pop();
        }
        return;
    }
}

function resolveSubtreeFor(groups: Resolution[][], node: Node, movedFrom?: Node | null): void {
    for (let g = 0; g < groups.length; g++) {
        const group = groups[g]!;
        const resolution = group[0]!;
        const inherited = nearestTrait(node.parent, resolution.traitSlot, true);
        // A move whose old and new parents resolve this to the same value
        // changes nothing anywhere in the subtree: every resolution inside it
        // derives from what the subtree inherits, and the subtree's own shape
        // and traits didn't change. Two O(depth) walks replace one O(subtree)
        // one. Only offered for a move of an already-live node, where "the
        // subtree is otherwise unchanged" is guaranteed.
        if (movedFrom !== undefined && movedFrom !== null) {
            if (nearestTrait(movedFrom, resolution.traitSlot, true) === inherited) continue;
        }
        resolveFrom(group, node, inherited);
    }
}

/**
 * re-resolve over `node`'s descendants only, for the case where the
 * target trait *on `node` itself* changed: the node's own value is the
 * caller's business, but its descendants inherit differently now and must not
 * prune at the node that changed.
 */
function resolveChildren(sceneTree: SceneTree | null, node: Node, traitSlot: number): void {
    if (traitSlot === TransformTrait._slot) invalidateTransformChildren(node);
    if (sceneTree !== null) resolveChildrenFor(sceneTree._queryResolutionGroups, node, traitSlot);
}

function resolveChildrenFor(groups: Resolution[][], node: Node, traitSlot: number): void {
    for (let g = 0; g < groups.length; g++) {
        const group = groups[g]!;
        if (group[0]!.traitSlot !== traitSlot) continue;
        const own = node._traits[traitSlot];
        const above = nearestTrait(node.parent, traitSlot, true);
        const upValue = own ?? above;
        // an `Up` term on the node itself also just changed answer, and nothing
        // else re-resolves it: membership didn't change, so `reindex` no-ops.
        for (let i = 0; i < group.length; i++) {
            const resolution = group[i]!;
            resolution.apply(node, resolution.inclusive ? upValue : above);
        }
        for (const child of node.children) {
            resolveFrom(group, child, upValue);
        }
        return; // a slot has exactly one group
    }
}

/**
 * Re-test `node`'s membership. `changedSlot` narrows the work to queries that
 * reference the trait that just came or went; omit it when several traits
 * changed at once and every trait the node bears should be considered.
 */
function reindex(sceneTree: SceneTree, node: Node, changedSlot?: number): void {
    const candidates = sceneTree._queryScratch;
    const count = collectQueries(sceneTree, node, changedSlot);
    for (let i = 0; i < count; i++) {
        const q = candidates[i]!;
        const matches = nodeMatchesQuery(node, q);
        const index = queryIndexOf(q, node);

        if (matches && index === -1) {
            addNodeToQuery(q, node);
        } else if (!matches && index !== -1) {
            removeNodeFromQuery(q, node);
        } else if (matches) {
            // still a member, but a Self-sourced Optional it carries may have just come or
            // gone. Nothing else refreshes those: they gate no membership, and only
            // hierarchy terms have a resolve walk behind them.
            refreshOptionalSelf(q, node, index, changedSlot);
        }
    }
}

/** rewrite the tuple slots of Self-sourced `Optional` terms for a node that stayed a member. */
function refreshOptionalSelf(q: Query<any>, node: Node, index: number, changedSlot?: number): void {
    const terms = q._optionalSelfTerms;
    if (terms.length === 0) return;
    const tuple = q.matches[index] as unknown as unknown[];
    for (let i = 0; i < terms.length; i++) {
        const term = terms[i]!;
        if (changedSlot !== undefined && term.traitSlot !== changedSlot) continue;
        // the bitset is the truth here, not `_traits`: `removeTraitBySlot` clears the bit
        // before reindexing but keeps the instance until after, so `onExit` handlers can
        // still read the departing value.
        const next = bitset.has(node._bitset, term.traitSlot) ? (node._traits[term.traitSlot] ?? null) : null;
        if (tuple[term.tupleIndex] === next) continue;
        tuple[term.tupleIndex] = next;
    }
}

/* ── findAncestor ── */

/**
 * walk up the tree from `node.parent` toward the root and return the first
 * ancestor that has **all** of the given traits. returns a tuple of
 * `[...traitValues]`, or `null` if no ancestor matches. access the ancestor
 * node via any returned trait's `.node` property.
 *
 * this is an ad-hoc traversal, it is **not** reactive. call it when you
 * need to resolve inherited / contextual data from the hierarchy.
 *
 * @example
 * ```ts
 * const result = findAncestor(node, [Physics]);
 * if (result) {
 *   const [physics] = result;
 *   console.log(physics.gravity);
 *   console.log(physics.node); // the ancestor node
 * }
 * ```
 */
export function findAncestor<const Args extends TraitHandle[]>(
    node: Node,
    traits: Args,
): [...traits: { [K in keyof Args]: Args[K] extends TraitHandle<infer T> ? T : never }] | null {
    let current = node.parent;
    while (current !== null) {
        let allMatch = true;
        for (let i = 0; i < traits.length; i++) {
            const traitSlot = traits[i]._slot;
            if (traitSlot === undefined || !bitset.has(current._bitset, traitSlot)) {
                allMatch = false;
                break;
            }
        }
        if (allMatch) {
            const tuple: any[] = [];
            for (let i = 0; i < traits.length; i++) {
                const traitSlot = traits[i]._slot;
                if (traitSlot !== undefined) {
                    tuple.push(current._traits[traitSlot]);
                }
            }
            return tuple as any;
        }
        current = current.parent;
    }
    return null;
}

/* ── prefab config (persisted + replicated) ── */

export type PrefabConfig = {
    prefabId: string;
    args: unknown;
};

/* ── prefab state (runtime-only, not serialized, not replicated) ── */

export type PrefabState = {
    /**
     * post-apply voxels from the last reconciliation. cached so prefab-visuals
     * can render the ghost without re-running def.apply. populated in edit mode
     * for voxel-bearing prefabs; null in play mode (voxels stamped into world)
     * and for non-voxel prefabs.
     */
    voxels: Voxels | null;
    /**
     * monotonic counter bumped every time this prefab is (re)instantiated.
     * downstream consumers (editor ghost cache, future things) use it as a
     * "did the prefab content actually change" key. dirty-set membership is
     * the staleness signal; this just lets ghost caches notice they're out of date.
     */
    generation: number;
};

/* ── prefab helpers ── */

/**
 * set or clear a node's prefab config and reconcile the scene tree's
 * `_prefabNodes` / `_prefabsDirty` indices. callers mutating `node.prefab`
 * on a *live* node (one that's already attached) MUST use this, direct
 * assignment leaves the indices stale and the prefab tick driver won't
 * pick the node up.
 *
 * detached nodes (pre-`addChild`) can assign `node.prefab` directly;
 * `registerSubtree` indexes them on attach.
 *
 * always resets `_prefabState` to null. callers of this function are
 * making an explicit prefab change, so force re-instantiation matches
 * historical editor / SetPrefab behavior even when args are unchanged.
 */
export function setPrefab(node: Node, config: PrefabConfig | null): void {
    node.prefab = config;
    node._prefabState = null;
    const scene = node.scene;
    if (!scene) return;
    if (config) {
        scene._prefabNodes.add(node);
        scene._prefabsDirty.add(node);
    } else {
        scene._prefabNodes.delete(node);
        scene._prefabsDirty.delete(node);
    }
}

/**
 * flip a live node's `persist` flag, controls whether the node is written to
 * scene files. use this rather than mutating `node.persist` directly when the
 * node is already attached to a scene tree.
 */
export function setNodePersist(node: Node, persist: boolean): void {
    if (node.persist === persist) return;
    node.persist = persist;
}

/**
 * mark every anchor in `_prefabNodes` whose `prefab.prefabId` is in
 * `dirtyPrefabIds` for reconcile. called from `applyRegistryChanges*` after
 * `collectDirtyByRegistry` resolves which prefab defs were directly or
 * transitively touched by the flush. drives the edit-mode + play-mode tick
 * uniformly off the same dirty set, neither side scans the full prefab
 * node set on its own.
 */
export function markPrefabAnchorsDirty(sceneTree: SceneTree, dirtyPrefabIds: ReadonlySet<string>): void {
    if (dirtyPrefabIds.size === 0) return;
    for (const node of sceneTree._prefabNodes) {
        if (!node.prefab) continue;
        if (dirtyPrefabIds.has(node.prefab.prefabId)) sceneTree._prefabsDirty.add(node);
    }
}

/** create a default PrefabConfig. */
export function createPrefabConfig(
    prefabId: string,
    opts?: {
        args?: unknown;
    },
): PrefabConfig {
    return {
        prefabId,
        args: opts?.args,
    };
}

/**
 * encode a PrefabConfig to a json string for network replication.
 * only used in edit-mode scene sync.
 */
export function encodePrefabConfig(config: PrefabConfig): string {
    return JSON.stringify(config);
}

/**
 * decode a json-encoded PrefabConfig from network replication.
 * returns null if the string is missing or malformed.
 */
export function decodePrefabConfig(encoded: string | undefined): PrefabConfig | null {
    if (!encoded) return null;
    try {
        return JSON.parse(encoded) as PrefabConfig;
    } catch {
        return null;
    }
}
