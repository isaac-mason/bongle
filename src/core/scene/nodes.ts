import { env } from '../../api/env';
import { markAncestryChanged, TransformTrait } from '../../builtins/transform';
import type { PlayerId } from '../client';
import * as Debug from '../debug';
import { registry } from '../registry';
import type { Bitset } from '../utils/bitset';
import * as bitset from '../utils/bitset';
import { type Topic, topic } from '../utils/topic';
import type { Voxels } from '../voxels/voxels';
import { getControlCodecs } from './packcat-bridge';
import { formatIssuePath, type Issue, validate } from './prop';
import { logScriptError } from './script-errors';
import type { NodesContext, ScriptInstance } from './scripts';
import { createScriptInstance, disposeScriptInstance, fireEnterHooks, fireExitHooks, initScriptInstance } from './scripts';
import { buildTraitInstance, type TraitBase, type TraitDef, type TraitHandle } from './traits';

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
 * the scene graph root is always `'shared'`, so an `'inherit'` node with no
 * explicit realm anywhere in its chain resolves to `'shared'`.
 */
export type Realm = 'inherit' | 'shared' | 'client' | 'server' | 'each';

export type Node = {
    /** runtime-only numeric ID, assigned by the scene graph's incrementing counter. not persisted. */
    id: number;

    /**
     * persistent UUID, stored in scene files for cross-references.
     * null until needed. assigned at attach time for persist:true nodes in edit-mode
     * scene graphs (or explicitly set when deserializing from disk).
     * non-persistent / play-mode nodes never get one — they're identified by runtime id.
     */
    _uuid: string | null;

    /** optional name — a non-unique label. */
    name: string | undefined;

    /** parent node, or null if this is a root node */
    parent: Node | null;

    /** ordered list of child nodes */
    children: Node[];

    /** the scene graph this node belongs to, or null if detached */
    scene: Nodes | null;

    /**
     * which Player owns this node. null = server-owned (default).
     * Ownership is keyed per-Player (not per-Client) so parallel
     * memberships — same client with multiple Players in a room — don't
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

    /** @internal trait data stored directly on the node, keyed by trait slot */
    _traits: Map<number, TraitBase>;

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
    _unresolvedTraits: Map<string, { binary?: Uint8Array; json?: Record<string, unknown> }>;

    /**
     * @internal validation issues per trait (keyed by trait slot). populated
     * at scene load and at inspector commit time. derived state — not persisted,
     * not replicated. use `setTraitIssues` / `clearTraitIssues` to mutate so
     * empty entries are cleaned up.
     */
    _traitIssues: Map<number, import('./prop').Issue[]>;

    /**
     * if non-null, this node is a prefab instance. its children are
     * instantiated from the referenced scene. only the prefab config
     * is persisted — children have persist: false.
     */
    prefab: PrefabConfig | null;

    /**
     * @internal runtime-only prefab instantiation state.
     * not serialized, not replicated — reconstructed on instantiation.
     */
    _prefabState: PrefabState | null;
};

/* uuid */

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

function createNodeObject(name?: string, id?: number, uuid?: string, persist?: boolean, realm?: Realm): Node {
    return {
        id: id ?? 0,
        _uuid: uuid ?? null,
        name: name ?? undefined,
        parent: null,
        children: [],
        scene: null,
        owner: null,
        persist: persist ?? true,
        realm: realm ?? 'inherit',
        _traits: new Map(),
        _bitset: bitset.init(),
        _unresolvedTraits: new Map(),
        _traitIssues: new Map(),
        prefab: null,
        _prefabState: null,
        _sync: { version: 0 },
    };
}

/* version bumping */

/** per-node replication version — the send path's node-level early-out gate.
 *  the trait/field versions live on each trait instance's `_sync`; only this
 *  node-level rollup lives here, since it spans all of a node's traits. */
export type NodeSyncState = {
    /** bumped on ANY replicable change to the node (structure, traits, fields). */
    version: number;
};

/** mark a node into its scene graph's per-tick discovery dirty set. server-side
 *  only (gated on `!env.client`) — a no-op in the client bundle, where nothing
 *  drains the set. every version bump funnels through here, so structural, trait,
 *  and field changes all land in `dirtyNodes` for the per-client fan-out. room
 *  graphs are drained + cleared each tick by `Discovery.flush`. */
export function markNodeDirty(sg: Nodes, node: Node): void {
    if (!env.client) sg.dirtyNodes.add(node);
}

/** bump a node's structural version */
export function bumpNodeVersion(sg: Nodes, node: Node): void {
    node._sync.version = ++sg._versions.counter;
    markNodeDirty(sg, node);
}

/** bump a specific trait's version on a node (+ the node version). */
export function bumpTraitVersion(sg: Nodes, node: Node, traitSlot: number): void {
    const v = ++sg._versions.counter;
    const inst = node._traits.get(traitSlot);
    if (inst?._sync) inst._sync.traitVersion = v;
    node._sync.version = v;
    markNodeDirty(sg, node);
}

/** bump a single field's version (+ the trait + node versions). takes the
 *  instance + slice index directly — the diff already has both in hand. */
export function bumpFieldVersion(sg: Nodes, node: Node, instance: TraitBase, i: number): void {
    const v = ++sg._versions.counter;
    if (instance._sync) {
        instance._sync.versions[i] = v;
        instance._sync.traitVersion = v;
    }
    node._sync.version = v;
    markNodeDirty(sg, node);
}

/* node scene graph */

export type Nodes = {
    /** the root node of this scene graph. always present, cannot be destroyed. */
    root: Node;

    /**
     * the viewer's mode for this scene graph (the PlayerMode of the
     * Player it represents). passed to scripts via `ctx.mode`. drives
     * script-side filtering of editor vs play behavior.
     */
    mode: 'edit' | 'play';

    /**
     * the room's authoritative mode (independent of the viewer). drives
     * room-level decisions like prefab previews vs voxel baking — an
     * edit Player attached to a play room still bakes voxels (no
     * preview ghosts), because the room is play.
     */
    roomMode: 'edit' | 'play';

    /** all nodes in this scene graph (including root) */
    nodes: Set<Node>;

    /** monotonically incrementing counter for runtime node IDs (server / shared) */
    _nextNodeId: number;

    /** monotonically decrementing counter for client-only node IDs (negative) */
    _nextClientNodeId: number;

    /** node ID → node */
    _idToNode: Map<number, Node>;

    /** node UUID → node */
    _uuidToNode: Map<string, Node>;

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
     *   - prefab anchor entering the graph (registerSubtree) — first init
     *   - setPrefab (set or change) — config / args edits
     *   - markPrefabAnchorsDirty — dispatch DepGraph propagation
     * drained by the prefab tick once each node finishes reconcile (or is
     * filtered out by realm/cycle/deps-not-ready). steady-state size is zero
     * → tick is O(churn), not O(prefab count). same path on both edit and
     * play modes — play rooms just don't get dispatch-driven dirty marks,
     * so they stay stable across HMR.
     */
    _prefabsDirty: Set<Node>;

    /**
     * @internal transforms whose local TRS changed since the last
     * `Interpolation.snapshot` drain. populated by `markTransformDirty`
     * (writes via setPosition/setQuaternion/setScale/sync unpack).
     * drained by `snapshot()` to refresh prev pose for interpolated nodes
     * — scales per-frame snapshot cost with motion, not scene size.
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
     * @internal server-side discovery driver. nodes touched this tick (created,
     * structural change, trait add/remove, field change, or destroyed) — the set
     * the per-client scene-sync fan-out iterates instead of walking the whole tree.
     * a destroyed node is parked here too; the fan-out recognises it by
     * `node.context === null` and emits `node_destroyed`. populated by the
     * `bump*Version` helpers + `registerSubtree` + `destroyNode` (gated on
     * `!env.client`, so it stays empty in the client bundle), drained + cleared each
     * tick by `Discovery.flush`.
     */
    dirtyNodes: Set<Node>;

    /**
     * optional runtime reference. when set, registerSubtree creates script instances,
     * unregisterSubtree disposes them, and reparent fires enter/exit hooks automatically.
     * set this after createSceneGraph, before adding live nodes.
     */
    runtime?: NodesContext;
};

export type CreateSceneGraphOptions = {
    /** viewer's PlayerMode for this scene graph. defaults to `'edit'`. */
    mode?: 'edit' | 'play';
    /** room's authoritative RoomMode. defaults to `mode`. */
    roomMode?: 'edit' | 'play';
};

export function createSceneGraph(options?: CreateSceneGraphOptions): Nodes {
    const mode = options?.mode ?? 'edit';
    const sg: Nodes = {
        root: null!,
        mode,
        roomMode: options?.roomMode ?? mode,
        nodes: new Set(),
        queries: new Map(),
        _nextNodeId: 1,
        _nextClientNodeId: -1,
        _idToNode: new Map(),
        _uuidToNode: new Map(),
        playerIdToOwnedNodes: new Map(),
        _versions: { counter: 0 },
        _prefabNodes: new Set(),
        _prefabsDirty: new Set(),
        _transformDirty: new Set(),
        _interpolating: new Set(),
        dirtyNodes: new Set(),
    };

    // create root node — always present, cannot be destroyed.
    // root always gets a uuid up front (it's persisted in every scene file).
    // root is explicitly 'shared' so 'inherit' descendants resolve there.
    const root = createNodeObject('Root', undefined, generateUuid(), undefined, 'shared');
    root.id = sg._nextNodeId++;
    root.scene = sg;
    sg.nodes.add(root);
    sg._idToNode.set(root.id, root);
    sg._uuidToNode.set(root._uuid!, root);
    sg.root = root;

    return sg;
}

/* node lifecycle */

export type CreateNodeOptions = {
    name?: string;
    /** provide a runtime numeric ID (e.g. when unpacking from network). auto-assigned if omitted. */
    id?: number;
    /** provide a persistent UUID (e.g. when deserializing). auto-generated if omitted. */
    uuid?: string;
    /** whether this node is saved to scene files. default: true. */
    persist?: boolean;
    /**
     * which side(s) this node lives on. defaults to `'inherit'`, which means
     * "take the effective realm from the nearest non-inherit ancestor". the
     * scene graph root is `'shared'`, so an `'inherit'` chain bottoms out
     * there unless an ancestor explicitly opts into `'server'`/`'client'`/`'each'`.
     */
    realm?: Realm;
};

/**
 * create a new **detached** node — not registered in any scene graph,
 * no script init, no queries. attach with `addChild(parent, node)` to
 * make it live; the scene graph allocates an id at attach time (negative
 * on the client, positive on the server).
 *
 * realm defaults to `'inherit'`, so the node takes whatever its eventual
 * parent dictates. set explicitly (`'server'`, `'client'`, `'each'`,
 * `'shared'`) to override.
 */
export function createNode(options?: CreateNodeOptions): Node {
    return createNodeObject(options?.name, options?.id, options?.uuid, options?.persist, options?.realm);
}

/**
 * look up a node by its runtime ID. returns undefined if not found.
 */
export function getNodeById(sg: Nodes, id: number): Node | undefined {
    return sg._idToNode.get(id);
}

/**
 * look up a node by its persistent UUID. returns undefined if not found.
 */
export function getNodeByUUID(sg: Nodes, uuid: string): Node | undefined {
    return sg._uuidToNode.get(uuid);
}

/**
 * returns whether a node is alive (registered in a scene graph).
 */
export function nodeExists(node: Node): boolean {
    return node.scene !== null;
}

/**
 * set a node's owner, keeping `sg.playerIdToOwnedNodes` in sync. all owner
 * writes outside tests should route through here — the index drives the
 * client's per-tick owner-sync replication loop, so silent direct assignment
 * to `node.owner` will desync that walk.
 */
export function setOwner(sg: Nodes, node: Node, owner: PlayerId | null): void {
    const prev = node.owner;
    if (prev === owner) return;
    if (prev !== null) {
        const prevSet = sg.playerIdToOwnedNodes.get(prev);
        if (prevSet) {
            prevSet.delete(node);
            if (prevSet.size === 0) sg.playerIdToOwnedNodes.delete(prev);
        }
    }
    node.owner = owner;
    if (owner !== null) {
        let set = sg.playerIdToOwnedNodes.get(owner);
        if (!set) {
            set = new Set();
            sg.playerIdToOwnedNodes.set(owner, set);
        }
        set.add(node);
    }
    // owner is replicated (node_owner); mark the change for discovery when the
    // node is live. (editor/scene-pack paths also bump explicitly — harmless.)
    if (node.scene) bumpNodeVersion(node.scene, node);
}

/**
 * set a node's realm. realm controls which side(s)/clients a node replicates to,
 * so changing it can flip the effective relevance of the whole subtree
 * (descendants inherit) — mark them all dirty so the per-client discovery fan-out
 * re-evaluates visibility (create on become-visible, destroy on become-hidden).
 * route runtime realm changes through here so the change can't bypass discovery.
 */
export function setRealm(node: Node, realm: Realm): void {
    if (node.realm === realm) return;
    node.realm = realm;
    const sg = node.scene;
    if (!sg) return;
    const subtree: Node[] = [];
    collectSubtree(node, subtree);
    for (const n of subtree) bumpNodeVersion(sg, n);
}

/**
 * returns true iff this node is replicable from server to clients — i.e. every
 * node on the chain from root down to (and including) this one resolves to
 * `'shared'`. a `'shared'` node under a `'server'`/`'each'`/`'client'`
 * ancestor isn't reachable for the client because the ancestor never
 * replicates, so the descendant can't either. `'inherit'` nodes are
 * transparent — they defer to whatever ancestor next sets a concrete realm.
 *
 * does not consult `mode` — callers (e.g. discovery in edit mode) decide
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
 * destroy a node: dispose scripts, remove from parent, recursively
 * destroy children, remove from all queries, and detach from the scene graph.
 *
 * the scene graph's root node cannot be destroyed.
 */
export function destroyNode(nodes: Nodes, node: Node): void {
    if (node.scene !== nodes) return;
    if (node === nodes.root) return; // root node is permanent

    // park the node in the discovery dirty set (server-side; no-op on the client).
    // node.context is nulled at the end of this fn, so the fan-out sees node.context
    // === null and emits node_destroyed. recurses, so each destroyed node lands
    // here. if the same node is re-added this tick it becomes live again → the
    // fan-out treats it as a create/update instead (add→remove→add correctness).
    if (!env.client) nodes.dirtyNodes.add(node);

    // destroy children first (iterate a copy since we mutate)
    const childrenCopy = node.children.slice();
    for (let i = 0; i < childrenCopy.length; i++) {
        destroyNode(nodes, childrenCopy[i]);
    }

    // dispose all script instances from runtime
    if (nodes.runtime) {
        const nodeInstances = nodes.runtime.instances.get(node.id);
        if (nodeInstances) {
            for (const instance of nodeInstances.values()) {
                disposeScriptInstance(instance);
            }
            nodes.runtime.instances.delete(node.id);
        }
    }
    node._unresolvedTraits.clear();

    // remove from all queries
    for (const q of nodes.queries.values()) {
        if (q.nodeToIndex.has(node)) {
            removeNodeFromQuery(q, node);
        }
    }

    // detach from parent
    if (node.parent) {
        removeChildInternal(node.parent, node);
    }

    // detach from scene graph
    setOwner(nodes, node, null);
    nodes.nodes.delete(node);
    nodes._idToNode.delete(node.id);
    if (node._uuid) nodes._uuidToNode.delete(node._uuid);
    nodes._prefabNodes.delete(node);
    nodes._prefabsDirty.delete(node);
    const t = getTrait(node, TransformTrait);
    if (t) {
        nodes._transformDirty.delete(t);
        nodes._interpolating.delete(t);
    }
    node.scene = null;
}

/* trait operations */

// ── parent transform bookkeeping ──────────────────────────────────────
//
// every TransformTrait instance has a parent transform pointer to the
// nearest ancestor node's TransformTrait (or null if none). maintained
// eagerly on hierarchy and trait mutations so it's always fresh.

/** walk up the parent chain to find the nearest ancestor with a TransformTrait. */
function findTransformAncestor(node: Node): TransformTrait | null {
    let cur = node.parent;
    while (cur) {
        const t = getTrait(cur, TransformTrait);
        if (t) return t;
        cur = cur.parent;
    }
    return null;
}

/**
 * update parent transform for all TransformTrait instances in the
 * immediate children of `node`. for each child: if it has a TransformTrait,
 * set its parent transform to `ancestor`, mark it dirty (parent changed so
 * cached world values are stale), and stop (its own children already
 * point to it). if it doesn't, recurse into its children.
 */
function updateChildTransformPointers(node: Node, ancestor: TransformTrait | null): void {
    for (const child of node.children) {
        const t = getTrait(child, TransformTrait);
        if (t) {
            t._parent = ancestor;
            markAncestryChanged(child);
        } else {
            updateChildTransformPointers(child, ancestor);
        }
    }
}

/**
 * update parent transform for the root of a moved/attached subtree and
 * propagate down. the root gets `ancestor`; its children get the root's
 * transform (if it has one) or pass `ancestor` through.
 * also marks all affected transforms dirty since parent pointers changed.
 */
function updateSubtreeTransformPointers(subtreeRoot: Node, ancestor: TransformTrait | null): void {
    const t = getTrait(subtreeRoot, TransformTrait);
    if (t) {
        t._parent = ancestor;
        // mark this node + descendants dirty (ancestry changed)
        markAncestryChanged(subtreeRoot);
        // children of this node point to it
        updateChildTransformPointers(subtreeRoot, t);
    } else {
        // no transform here — children inherit the same ancestor
        updateChildTransformPointers(subtreeRoot, ancestor);
    }
}

/** user-facing props for addTrait — only the trait's own declared fields, minus base fields. */
export type TraitProps<T extends TraitBase> = Partial<Omit<T, 'node' | '_def' | '_sync'>>;

/**
 * add a trait to a node. pass an optional props object to override defaults.
 *
 *   addTrait(node, Health, { current: 50, max: 100 })
 *
 * works on both detached and live nodes. for detached nodes, sg-level ops
 * (version bump, query reindex) and script instantiation are skipped and
 * deferred to registerSubtree.
 *
 * if the trait def has registered scripts (via `script(handle, ...)`) and
 * the node is live in a scene graph with a runtime, one ScriptInstance is
 * created per script and onInit/onEnter fire immediately.
 */
export function addTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>, props?: TraitProps<T>): T {
    const traitSlot = handle._slot;

    // build plain instance from field defs, apply prop overrides
    const instance = buildTraitInstance(handle._def, props as Record<string, unknown> | undefined) as T;
    attachTraitInstance(node, traitSlot, instance);

    // maintain parent transform pointers (works purely within local subtree)
    if (traitSlot === TransformTrait._slot) {
        const t = getTrait(node, TransformTrait)!;
        t._parent = findTransformAncestor(node);
        updateChildTransformPointers(node, t);
    }

    const nodes = node.scene;

    if (nodes) {
        bumpNodeVersion(nodes, node);
        reindex(nodes, node);
        if (nodes.runtime) {
            const created = instantiateTraitScripts(nodes.runtime, node, instance, handle._def);
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
    }

    return instance;
}

/**
 * instantiate every script registered on `def` for this trait instance,
 * fire `onInit`, then `onEnter` if the node is in-graph. used by addTrait
 * (live path) and registerSubtree (scene-load path).
 */
function instantiateTraitScripts(runtime: NodesContext, node: Node, trait: TraitBase, def: TraitDef): ScriptInstance[] {
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
function disposeTraitScripts(runtime: NodesContext, node: Node, def: TraitDef): void {
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
 * the scene graph, queries, or transform parent pointers — those side
 * effects belong to addTrait. used by addTrait and cloneNode.
 */
function attachTraitInstance(node: Node, traitSlot: number, instance: TraitBase): void {
    instance._node = node;
    node._traits.set(traitSlot, instance);
    bitset.add(node._bitset, traitSlot);
}

export function removeTrait(node: Node, handle: TraitHandle): void {
    const sg = node.scene;
    const traitSlot = handle._slot;
    if (traitSlot === undefined) return;

    if (bitset.has(node._bitset, traitSlot)) {
        // dispose scripts before clearing trait state — onExit fires while
        // the trait value is still resolvable.
        if (sg?.runtime) disposeTraitScripts(sg.runtime, node, handle._def);

        // maintain parent transform pointers — children that pointed to this
        // transform now inherit this transform's own parent
        if (traitSlot === TransformTrait._slot) {
            const t = getTrait(node, TransformTrait)!;
            const ancestor = t._parent ?? null;
            updateChildTransformPointers(node, ancestor);
        }

        // update bitset so queries see the node as no longer matching
        bitset.remove(node._bitset, traitSlot);
        if (sg) {
            bumpNodeVersion(sg, node);
            // reindex this node — callbacks fire while trait value still in _traits
            reindex(sg, node);
        }
        // now safe to delete the value
        node._traits.delete(traitSlot);
    }
}

export function getTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>): T | undefined {
    const traitSlot = handle._slot;
    if (traitSlot === undefined) return undefined;
    return node._traits.get(traitSlot) as T | undefined;
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
    const nodes = node.scene;

    if (bitset.has(node._bitset, traitSlot)) {
        if (nodes?.runtime) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (def) disposeTraitScripts(nodes.runtime, node, def);
        }

        // maintain parent transform pointers
        if (traitSlot === TransformTrait._slot) {
            const t = getTrait(node, TransformTrait)!;
            const ancestor = t._parent ?? null;
            updateChildTransformPointers(node, ancestor);
            if (nodes) {
                nodes._transformDirty.delete(t);
                nodes._interpolating.delete(t);
            }
        }

        bitset.remove(node._bitset, traitSlot);
        if (nodes) {
            bumpNodeVersion(nodes, node);
            reindex(nodes, node);
        }
        node._traits.delete(traitSlot);
    }
}

/**
 * add a trait by its numeric index. used internally by the inspector
 * and other engine code that works with numeric indices directly.
 */
export function addTraitBySlot(
    node: Node,
    traitSlot: number,
    props?: Record<string, unknown>,
): TraitBase | null {
    const nodes = node.scene;

    const def = registry.traitsBySlot.get(traitSlot);
    if (!def) return null;

    const instance = buildTraitInstance(def, props);
    instance._node = node;

    node._traits.set(traitSlot, instance);
    bitset.add(node._bitset, traitSlot);

    // maintain parent transform pointers. prev pose seeding is owned by
    // `setInterpolation(node, true)` — callers that want interpolation
    // (physics coordinator, character controller scripts) opt in
    // explicitly, which seeds prev = current at that point and avoids the
    // "addTrait happens before node.context is wired" hydration race.
    if (traitSlot === TransformTrait._slot) {
        const t = getTrait(node, TransformTrait)!;
        t._parent = findTransformAncestor(node);
        updateChildTransformPointers(node, t);
    }

    if (nodes) {
        bumpNodeVersion(nodes, node);
        reindex(nodes, node);
    }

    if (nodes?.runtime) {
        const created = instantiateTraitScripts(nodes.runtime, node, instance, def);
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
    return node._traitIssues.get(traitSlot);
}

/** set/clear issues for a trait. an empty array deletes the entry. */
export function setTraitIssues(node: Node, traitSlot: number, issues: Issue[]): void {
    if (issues.length === 0) node._traitIssues.delete(traitSlot);
    else node._traitIssues.set(traitSlot, issues);
}

/** clear issues for one trait, or all traits when traitSlot is omitted. */
export function clearTraitIssues(node: Node, traitSlot?: number): void {
    if (traitSlot === undefined) node._traitIssues.clear();
    else node._traitIssues.delete(traitSlot);
}

/** true when the node has any trait with recorded issues. */
export function hasNodeIssues(node: Node): boolean {
    return node._traitIssues.size > 0;
}

/**
 * recompute and store issues for a trait, logging a console warning per
 * issue. label is prepended to the warning (e.g. node uuid or scene path)
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
 * fire onInit on all uninitialized script instances in a scene graph.
 *
 * scripts are now owned by traits — for each trait on each node, instantiate
 * any missing script instance, then init, then fire enter hooks.
 *
 * call this after the graph is fully built and all runtime context is wired
 * (e.g. client.room, client.state) so onInit handlers can safely access them.
 * used by the client after unpackSceneGraph + room wiring, before the first tick.
 */
export function initSceneGraph(sg: Nodes): void {
    if (!sg.runtime) return;

    // pass 1: create instances for any node-trait pairs that don't have one
    // (e.g. the client unpack path: unpackSceneGraph runs without runtime, then
    // engine-client sets sg.runtime and calls initSceneGraph to instantiate)
    for (const node of sg.nodes) {
        for (const [traitSlot, trait] of node._traits) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (!def || def.scripts.length === 0) continue;
            instantiateTraitScripts(sg.runtime, node, trait, def);
        }
    }

    // pass 2: init all instances that haven't been initialized
    for (const nodeInstances of sg.runtime.instances.values()) {
        for (const instance of nodeInstances.values()) {
            if (!instance.initialized) initScriptInstance(instance);
        }
    }

    // pass 3: fire enter hooks after all inits
    for (const node of sg.nodes) {
        if (node.parent) fireEnterHooks(sg.runtime, node, node.parent);
    }
}

/* hierarchy */

/**
 * add a child node to a parent. if the child already has a parent, it is
 * removed from the old parent first. if the parent is in a scene graph, the
 * child (and its descendants) are registered in that scene graph.
 */
export function addChild(parent: Node, child: Node): void {
    // if child already has a parent, detach first
    if (child.parent) {
        removeChildInternal(child.parent, child);
    }

    child.parent = parent;
    parent.children.push(child);

    // if parent is in a scene graph, register child subtree
    if (parent.scene) {
        registerSubtree(parent.scene, child);
    }

    // update parent transform pointers for the attached subtree
    const ancestor = findTransformAncestor(child);
    updateSubtreeTransformPointers(child, ancestor);
}

/**
 * remove a child from its parent. the child (and its descendants) are
 * detached from the scene graph and removed from all queries.
 */
export function removeChild(parent: Node, child: Node): void {
    if (child.parent !== parent) return;

    // detach subtree from scene graph first
    if (child.scene) {
        unregisterSubtree(child.scene, child);
    }

    removeChildInternal(parent, child);
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
export function getChildren(node: Node): readonly Node[] {
    return node.children;
}

/**
 * move a node to a new parent. the node must be in the same scene graph as
 * the new parent, or detached (will be registered if parent is in a scene graph).
 */
export function reparent(node: Node, newParent: Node): void {
    if (node.parent === newParent) return;

    // can only reparent within the same scene graph (or from detached)
    if (node.scene !== null && node.scene !== newParent.scene) {
        throw new Error(`cannot reparent node to a different scene graph`);
    }
    if (newParent.scene === null) {
        throw new Error(`cannot reparent to a detached parent`);
    }

    const sg = newParent.scene;
    const oldParent = node.parent;

    // fire onExit before detaching — old parent is still set
    if (oldParent && node.scene !== null && sg.runtime) {
        fireExitHooks(sg.runtime, node, oldParent);
    }

    if (node.parent) {
        removeChildInternal(node.parent, node);
    }
    node.parent = newParent;
    newParent.children.push(node);

    // if node was detached, register it now (also fires onInit + onEnter + marks dirty)
    if (node.scene === null) {
        registerSubtree(sg, node);
    } else {
        // already in-tree reparent: fire onEnter with the new parent.
        if (sg.runtime) fireEnterHooks(sg.runtime, node, newParent);
        // mark the whole moved subtree for discovery: reparenting can flip
        // effective relevance (e.g. moving under a non-shared parent), and
        // descendants inherit it — the per-client fan-out must re-evaluate them.
        const moved: Node[] = [];
        collectSubtree(node, moved);
        for (const n of moved) bumpNodeVersion(sg, n);
    }

    // update parent transform pointers for the moved subtree
    const ancestor = findTransformAncestor(node);
    updateSubtreeTransformPointers(node, ancestor);
}

/**
 * move a child to a specific index in its parent's children array.
 * does nothing if the child is not a child of parent.
 */
export function reorderChild(parent: Node, child: Node, index: number): void {
    if (child.parent !== parent) return;
    const current = parent.children.indexOf(child);
    if (current === -1) return;
    parent.children.splice(current, 1);
    parent.children.splice(Math.min(index, parent.children.length), 0, child);
    // index change is a structural change discovery must replicate (it bumped
    // nothing before — the old per-client walk diffed childIndex directly).
    if (child.scene) bumpNodeVersion(child.scene, child);
}

/**
 * replace all children of `root` with `node`, destroying every other child.
 * `node` must be a direct child of `root`. analogous to the DOM's
 * `replaceChildren()` — useful after eager prefab instantiation when you
 * want to keep only one sub-node and discard the rest.
 */
export function replaceChildren(root: Node, node: Node): void {
    if (node.parent !== root) {
        throw new Error('replaceChildren: node must be a direct child of root');
    }
    const sg = root.scene;
    for (const child of root.children.slice()) {
        if (child === node) continue;
        if (sg) {
            destroyNode(sg, child);
        } else {
            // detached — just unlink
            child.parent = null;
        }
    }
    root.children = [node];
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

/** remove a child from parent's children array (does not touch scene graph registration) */
function removeChildInternal(parent: Node, child: Node): void {
    const idx = parent.children.indexOf(child);
    if (idx !== -1) {
        parent.children.splice(idx, 1);
    }
    child.parent = null;
}

/**
 * register a node and all its descendants into a scene graph.
 *
 * two-pass for scripts:
 *   pass 1 — register: register nodes, index into queries, create script instances (if runtime present).
 *   pass 2 — init: fire onInit on all newly created script instances.
 *
 * this ensures all nodes in the subtree are registered and all scripts
 * have their state available before any onInit fires.
 */
function registerSubtree(sg: Nodes, node: Node): void {
    // collect all nodes in the subtree (pre-order)
    const subtree: Node[] = [];
    collectSubtree(node, subtree);

    // pass 1: register all nodes in the scene graph + index into queries + create script instances
    const newScriptInstances: ScriptInstance[] = [];

    for (const n of subtree) {
        n.scene = sg;
        sg.nodes.add(n);
        // a node entering the live graph is a create for the discovery fan-out.
        // server-only (gated inside markNodeDirty); pre-order so creates emit
        // parent-first (fan-out also depth-orders as a backstop).
        markNodeDirty(sg, n);
        if (n.prefab) {
            sg._prefabNodes.add(n);
            sg._prefabsDirty.add(n);
        }

        // assign runtime ID if needed (node entering scene graph from detached state).
        // client picks from the negative id space, server from the positive id space.
        if (n.id === 0) {
            n.id = env.client ? sg._nextClientNodeId-- : sg._nextNodeId++;
        } else if (n.id >= sg._nextNodeId) {
            // pre-assigned id (e.g. from network unpack) — bump counter past it
            sg._nextNodeId = n.id + 1;
        }
        sg._idToNode.set(n.id, n);

        // lazy uuid: only persist:true edit-mode nodes get one. play-mode rooms
        // and non-persistent nodes (client-locals, prefab children, etc.) skip
        // both generation and indexing.
        if (!n._uuid && n.persist && sg.mode === 'edit') {
            let uuid = generateUuid();
            while (sg._uuidToNode.has(uuid)) uuid = generateUuid();
            n._uuid = uuid;
        }
        if (n._uuid) {
            // collision (e.g. cached prefab subtree re-instantiated, or load
            // restoring a uuid that's already in flight): regenerate so the
            // index stays unique. only matters in edit-mode persist subtrees.
            if (n.persist && sg.mode === 'edit') {
                while (sg._uuidToNode.has(n._uuid) && sg._uuidToNode.get(n._uuid) !== n) {
                    n._uuid = generateUuid();
                }
            }
            sg._uuidToNode.set(n._uuid, n);
        }

        for (const q of sg.queries.values()) {
            if (nodeMatchesQuery(n, q) && !q.nodeToIndex.has(n)) {
                addNodeToQuery(q, n);
            }
        }

        // create script instances for every trait on this node
        if (sg.runtime) {
            for (const [traitSlot, trait] of n._traits) {
                const def = registry.traitsBySlot.get(traitSlot);
                if (!def || def.scripts.length === 0) continue;
                const created = instantiateTraitScripts(sg.runtime, n, trait, def);
                for (const i of created) newScriptInstances.push(i);
            }
        }
    }

    // pass 2: fire onInit on all new script instances
    for (const instance of newScriptInstances) {
        initScriptInstance(instance);
    }

    // pass 3: fire onEnter on each node that has a parent (all nodes in the subtree do)
    if (sg.runtime) {
        for (const n of subtree) {
            if (n.parent) {
                fireEnterHooks(sg.runtime, n, n.parent);
            }
        }
    }
}

/**
 * unregister a node and all its descendants from a scene graph.
 * disposes scripts, removes from queries, detaches from scene graph.
 */
function unregisterSubtree(sg: Nodes, node: Node): void {
    // unregister children first (bottom-up)
    for (let i = 0; i < node.children.length; i++) {
        unregisterSubtree(sg, node.children[i]);
    }

    // fire onExit before disposing — parent is still set here
    if (sg.runtime && node.parent) {
        fireExitHooks(sg.runtime, node, node.parent);
    }

    // dispose all script instances from runtime — scripts re-instantiate
    // from traits when the subtree re-registers, so we drop the lot here.
    if (sg.runtime) {
        const nodeInstances = sg.runtime.instances.get(node.id);
        if (nodeInstances) {
            for (const instance of nodeInstances.values()) {
                disposeScriptInstance(instance);
            }
            sg.runtime.instances.delete(node.id);
        }
    }

    // remove from all queries
    for (const q of sg.queries.values()) {
        if (q.nodeToIndex.has(node)) {
            removeNodeFromQuery(q, node);
        }
    }

    setOwner(sg, node, null);
    sg.nodes.delete(node);
    sg._idToNode.delete(node.id);
    if (node._uuid) sg._uuidToNode.delete(node._uuid);
    sg._prefabNodes.delete(node);
    sg._prefabsDirty.delete(node);
    node.scene = null;
}

/** collect all nodes in a subtree (pre-order) into the output array */
function collectSubtree(node: Node, out: Node[]): void {
    out.push(node);
    for (let i = 0; i < node.children.length; i++) {
        collectSubtree(node.children[i], out);
    }
}

/* traversal */

// re-exported from traverse.ts
export { traverse } from './traverse';

/* scene-graph-level script driving */

// memoised `script/<hook>/<key>` metric ids — built once per (hook, script) so the
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
function runHook<A>(sg: Nodes, args: A, metrics: Debug.Metrics, hook: string, select: (i: ScriptInstance) => Iterable<(a: A) => void>): void {
    if (!sg.runtime) return;
    for (const nodeInstances of sg.runtime.instances.values()) {
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
export function runOnInput(sg: Nodes, args: import('./scripts').FrameArgs, metrics: Debug.Metrics): void {
    runHook(sg, args, metrics, 'onInput', (i) => i.onInput);
}

/**
 * update all scripts in the scene graph. fires once per frame before the
 * fixed-timestep tick loop — intended for input polling and camera binding.
 */
export function runOnUpdate(sg: Nodes, args: import('./scripts').UpdateArgs, metrics: Debug.Metrics): void {
    runHook(sg, args, metrics, 'onUpdate', (i) => i.onUpdate);
}

/**
 * tick all scripts in the scene graph. iterates all nodes and calls onTick
 * on each script instance.
 */
export function runOnTick(sg: Nodes, args: import('./scripts').TickArgs, metrics: Debug.Metrics): void {
    runHook(sg, args, metrics, 'onTick', (i) => i.onTick);
}

/**
 * fire onPrePhysicsStep hooks on all scripts in the scene graph. called after
 * tickSceneGraph but before the physics step. routes through SILENT — it runs
 * from physics.tick, which carries no metrics, and isn't surfaced in the digest.
 */
export function runOnPrePhysicsStep(sg: Nodes, args: import('./scripts').TickArgs): void {
    runHook(sg, args, SILENT, 'onPrePhysicsStep', (i) => i.onPrePhysicsStep);
}

/**
 * fire onPostPhysicsStep hooks on all scripts in the scene graph. called after
 * the physics step, before frameSceneGraph. SILENT — see runOnPrePhysicsStep.
 */
export function runOnPostPhysicsStep(sg: Nodes, args: import('./scripts').TickArgs): void {
    runHook(sg, args, SILENT, 'onPostPhysicsStep', (i) => i.onPostPhysicsStep);
}

/**
 * fire onPostAnimate hooks on all scripts in the scene graph.
 * called after Animation.tick (animator sampling) and before world-matrix
 * recompute, so post-anim callbacks see fresh local TRS but world matrices
 * are still last-tick.
 */
export function runOnPostAnimate(sg: Nodes, args: import('./scripts').TickArgs, metrics: Debug.Metrics): void {
    runHook(sg, args, metrics, 'onPostAnimate', (i) => i.onPostAnimate);
}

/**
 * frame all scripts in the scene graph. iterates all nodes and calls onFrame
 * on each script instance. intended for client-side render frame updates.
 */
export function runOnFrame(sg: Nodes, args: import('./scripts').FrameArgs, metrics: Debug.Metrics): void {
    runHook(sg, args, metrics, 'onFrame', (i) => i.onFrame);
}

/* serialization — schema-driven */

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
    /** persistent uuid. omitted on nodes that never received one (non-persist or play-mode). */
    uuid?: string;
    name: string | undefined;
    traits: SerializedTrait[];
    children: SerializedNode[];
    /** true means the node is persistent. omitted when true (the default). */
    persist?: boolean;
    /** present only on prefab nodes — references a scene resource. */
    prefab?: PrefabConfig;
};

/**
 * serialize a trait instance to a plain object for scene files.
 * only `control()`-decorated fields are serialized. tag traits get `controls: undefined`.
 */
function serializeTrait(
    traitSlot: number,
    instance: TraitBase,
    options?: SerializeOptions,
): SerializedTrait | null {
    const def = registry.traitsBySlot.get(traitSlot);
    if (!def) return null;
    if (options?.persistOnly && !def.persist) return null;

    // tag trait: no controls
    if (def.controls.length === 0) {
        return { id: def.id, controls: undefined };
    }

    // extract control values from the instance. clone — callers (scene save,
    // blueprint capture, undo snapshots) retain this and reapply later;
    // sharing references with the live instance would let runtime mutations
    // (vec3.copy on transform.position etc.) corrupt the snapshot.
    const controls: Record<string, unknown> = {};
    for (const reg of def.controls) {
        const value = reg.get(instance);
        controls[reg.controlId] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
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

    for (const [traitSlot, instance] of node._traits) {
        const serialized = serializeTrait(traitSlot, instance, options);
        if (serialized) {
            serializedTraits.push(serialized);
        }
    }

    // include unresolved traits
    for (const [id, data] of node._unresolvedTraits) {
        serializedTraits.push({ id, controls: data.json });
    }

    // prefab nodes own no authored children — all children are derived
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
        uuid: node._uuid ?? undefined,
        name: node.name,
        persist: node.persist === false ? false : undefined,
        traits: serializedTraits,
        children,
        prefab: node.prefab ? structuredClone(node.prefab) : undefined,
    };
}

/**
 * deserialize a node tree from a plain object. the returned node is **detached** —
 * caller is responsible for `addChild(parent, node)` if attachment is desired.
 *
 * traits are restored from their definitions; their bound scripts are
 * instantiated by registerSubtree (via addChild) if sg.runtime is set.
 *
 * resilient to schema changes:
 * - if a property field exists in saved data but not in the current schema, it is ignored.
 * - if a property field exists in the schema but not in saved data, the default is used.
 * - if a trait id is not registered, it is stashed as unresolved (preserving json data).
 */
export function deserializeNode(data: SerializedNode): Node {
    const node = createNodeObject(data.name, 0, data.uuid, data.persist !== false);

    // clone — node.prefab.args is mutable and the source data is often a cached
    // resource (prefab scene cache, scene file cache) shared across instantiations.
    node.prefab = data.prefab ? structuredClone(data.prefab) : null;

    node.realm = data.realm;

    for (const st of data.traits) {
        const def = registry.traits.byId.get(st.id)?.payload;
        if (!def) {
            console.warn(`[bongle] unresolved trait "${st.id}" on node "${data.name ?? data.uuid}" — preserving raw data`);
            // clone — _unresolvedTraits is read back on re-serialization;
            // mutations to control values elsewhere shouldn't corrupt the round-trip.
            node._unresolvedTraits.set(st.id, {
                json: structuredClone(st.controls),
            });
            continue;
        }

        // clone control values — trait fields like TransformTrait.position get
        // mutated in place (vec3.copy etc.). without this, mutations leak back
        // into the source data, contaminating future deserializations from the
        // same cached resource.
        const controls = structuredClone(st.controls);
        const instance = buildTraitInstance(def, controls);
        instance._node = node;
        node._traits.set(def.slot, instance);
        bitset.add(node._bitset, def.slot);
        refreshTraitIssues(node, def, instance, `node "${data.name ?? data.uuid}"`);
    }

    for (let i = 0; i < data.children.length; i++) {
        const child = deserializeNode(data.children[i]);
        addChild(node, child);
    }

    return node;
}

/**
 * clone a node and all its descendants. the returned subtree is **detached** —
 * it has no parent, is not registered in any scene graph, and its scripts are
 * not instantiated. add it to the graph with `addChild(parent, clone)` to wake
 * it up; `onInit` for any scripts fires at that point.
 *
 * source node may be detached.
 *
 * uuids are dropped on the clone — attach time decides whether a fresh uuid is
 * needed (only persist:true edit-mode subtrees get one). this means the common
 * case (clone → attach as persist:false) does zero uuid work.
 *
 * controls (editor + persisted state) are deep-copied via per-control packcat
 * codecs (`getControlCodecs`). runtime-only fields reset to defaults on the
 * clone — systems re-derive them on first tick (e.g. RigidBodyTrait.body
 * comes back null, and the installer rebuilds from the cloned `def` on the
 * next preStep).
 *
 * the clone root inherits the source's realm. callers who want a different
 * realm on the clone can assign `clone.realm = ...` before `addChild`.
 */
export function cloneNode(source: Node): Node {
    const clone = createNodeObject(source.name, 0, undefined, source.persist, source.realm);
    clone.prefab = source.prefab;

    for (const [traitSlot, sourceInstance] of source._traits) {
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
    for (const [id, data] of source._unresolvedTraits) {
        clone._unresolvedTraits.set(id, { json: data.json });
    }

    // scripts ride on traits — clone needs no script copy; registerSubtree
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
 * serialize the entire scene graph. the root node is a regular SerializedNode
 * with its children nested inside.
 */
export type SerializedSceneGraph = {
    /** the root node of the scene, including all descendants */
    root: SerializedNode;
};

/**
 * save the scene graph to a JSON-friendly structure for writing to disk.
 * respects persist flags — skips nodes with persist: false and traits with
 * persist: false. only property fields are included.
 *
 * the root node is serialized as a regular node with its children nested inside.
 */
export function saveSceneGraph(sg: Nodes): SerializedSceneGraph {
    const options: SerializeOptions = { persistOnly: true };
    return { root: serializeNode(sg.root, options) };
}

/**
 * load a scene graph from serialized JSON data (from disk).
 * clears existing children of root and replaces them with the loaded scene.
 * root traits, scripts, uuid, and name are restored from the saved data.
 *
 * if sg.runtime is set, script instances are created and initialized as nodes
 * are added. set sg.runtime before calling this function if you want live scripts.
 */
export function loadSceneGraph(sg: Nodes, data: SerializedSceneGraph): void {
    const root = sg.root;
    const rootData = data.root;

    // clear existing children
    const existingChildren = root.children.slice();
    for (const child of existingChildren) {
        destroyNode(sg, child);
    }

    // clear existing root scripts (data + instances)
    if (sg.runtime) {
        const rootInstances = sg.runtime.instances.get(root.id);
        if (rootInstances) {
            for (const instance of rootInstances.values()) {
                disposeScriptInstance(instance);
            }
            sg.runtime.instances.delete(root.id);
        }
    }
    root._traits.clear();
    root._bitset = bitset.init();
    root._unresolvedTraits.clear();
    root._traitIssues.clear();

    // restore root uuid
    if (rootData.uuid) {
        if (root._uuid) sg._uuidToNode.delete(root._uuid);
        root._uuid = rootData.uuid;
        sg._uuidToNode.set(root._uuid, root);
    }

    // restore root name
    root.name = rootData.name;

    // restore root traits
    if (rootData.traits) {
        for (const st of rootData.traits) {
            const def = registry.traits.byId.get(st.id)?.payload;
            if (!def) {
                console.warn(`[bongle] unresolved trait "${st.id}" on root node — preserving raw data`);
                root._unresolvedTraits.set(st.id, { json: st.controls as Record<string, unknown> | undefined });
                continue;
            }

            const controls = structuredClone(st.controls);
            const instance = buildTraitInstance(def, controls);
            instance._node = root;
            root._traits.set(def.slot, instance);
            bitset.add(root._bitset, def.slot);
            refreshTraitIssues(root, def, instance, 'root node');
        }
        reindex(sg, root);
    }

    // root scripts ride on traits — instantiate per trait if runtime present
    if (sg.runtime) {
        for (const [traitSlot, trait] of root._traits) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (!def || def.scripts.length === 0) continue;
            const created = instantiateTraitScripts(sg.runtime, root, trait, def);
            for (const i of created) initScriptInstance(i);
        }
    }

    // deserialize children of root (registerSubtree fires via addChild, creating instances)
    for (const nodeData of rootData.children) {
        const child = deserializeNode(nodeData);
        addChild(root, child);
    }
}

/* query system */

export enum ConditionType {
    WITH,
    NOT,
}

export type WithCondition<T extends TraitHandle> = {
    type: ConditionType.WITH;
    trait: T;
};

export type NotCondition<T extends TraitHandle> = {
    type: ConditionType.NOT;
    trait: T;
};

export function With<T extends TraitHandle>(t: T): WithCondition<T> {
    return { type: ConditionType.WITH, trait: t };
}

export function Not<T extends TraitHandle>(t: T): NotCondition<T> {
    return { type: ConditionType.NOT, trait: t };
}

export type Condition = WithCondition<any> | NotCondition<any>;

export type ConditionArgs = TraitHandle | WithCondition<any> | NotCondition<any>;

export type ConditionArgsToConditions<Args extends ConditionArgs[]> = {
    [K in keyof Args]: Args[K] extends TraitHandle
        ? WithCondition<Args[K]>
        : Args[K] extends WithCondition<any>
          ? Args[K]
          : Args[K] extends NotCondition<any>
            ? Args[K]
            : never;
};

/** extract trait instance types from WITH conditions (NOT conditions don't provide values) */
type ExtractTraitsFromConditions<Conditions extends Condition[]> = Conditions extends [
    infer First,
    ...infer Rest extends Condition[],
]
    ? First extends WithCondition<TraitHandle<infer T>>
        ? [T, ...ExtractTraitsFromConditions<Rest>]
        : ExtractTraitsFromConditions<Rest>
    : [];

export type Query<Conditions extends Array<Condition>> = {
    hash: string;
    conditions: [...Conditions];
    withTraits: number[];
    withBitset: Bitset;
    withoutBitset: Bitset;
    matches: Array<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    nodeToIndex: Map<Node, number>;
    onAdd: Topic<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    onRemove: Topic<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /**
     * live ref-count from script instances that called `query(ctx, ...)`.
     * 0 + `acquired` false → engine-persistent (never reaped).
     * 0 + `acquired` true → all script holders released; reap on next releaseQuery.
     */
    refcount: number;
    /** true once any script instance has acquired this query; gates reaping. */
    acquired: boolean;
    [Symbol.iterator](): Iterator<[...traits: ExtractTraitsFromConditions<Conditions>]>;
};

function buildConditionBitsets(conditions: ConditionArgs[]): {
    parsedConditions: Condition[];
    withBitset: Bitset;
    withoutBitset: Bitset;
    withTraits: number[];
} {
    const parsedConditions: Condition[] = conditions.map((cond): Condition => {
        if (typeof cond === 'object' && cond !== null && '_slot' in cond) {
            // bare trait handle → implicit WITH
            return { type: ConditionType.WITH, trait: cond } as WithCondition<any>;
        }
        return cond as Condition;
    });

    let withBitset = bitset.init();
    let withoutBitset = bitset.init();
    const withTraits: number[] = [];

    for (const condition of parsedConditions) {
        const traitSlot = condition.trait._slot;
        if (traitSlot === undefined) continue;
        switch (condition.type) {
            case ConditionType.WITH:
                withBitset = bitset.add(withBitset, traitSlot);
                withTraits.push(traitSlot);
                break;
            case ConditionType.NOT:
                withoutBitset = bitset.add(withoutBitset, traitSlot);
                break;
        }
    }

    return { parsedConditions, withBitset, withoutBitset, withTraits };
}

export function query<const Args extends ConditionArgs[]>(sg: Nodes, conditions: Args): Query<ConditionArgsToConditions<Args>> {
    const { parsedConditions, withBitset, withoutBitset, withTraits } = buildConditionBitsets(conditions);

    // hash conditions (order matters, do not sort)
    const hashParts: string[] = [];
    for (const c of parsedConditions) {
        const index = c.trait._slot;
        switch (c.type) {
            case ConditionType.WITH:
                hashParts.push(`W${index}`);
                break;
            case ConditionType.NOT:
                hashParts.push(`N${index}`);
                break;
        }
    }
    const hash = hashParts.join(',');

    // return existing query if already registered
    const existing = sg.queries.get(hash);
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
        nodeToIndex: new Map(),
        onAdd: topic(),
        onRemove: topic(),
        refcount: 0,
        acquired: false,
        [Symbol.iterator]() {
            return this.matches[Symbol.iterator]();
        },
    };

    // register query
    sg.queries.set(hash, q);

    // populate with existing matching nodes
    for (const node of sg.nodes) {
        if (nodeMatchesQuery(node, q)) {
            addNodeToQuery(q, node);
        }
    }

    return q;
}

/**
 * acquire a script-side reference to a query. paired with `releaseQuery`.
 * engine-side callers of `query()` skip this and let the query persist for
 * the lifetime of the scene graph.
 */
export function acquireQuery(_sg: Nodes, q: Query<any>): void {
    q.refcount++;
    q.acquired = true;
}

/**
 * release a script-side reference. when refcount hits zero on a query that
 * was ever acquired, evict from `sg.queries` so per-mutation walks stop
 * paying for it.
 */
export function releaseQuery(sg: Nodes, q: Query<any>): void {
    q.refcount--;
    if (q.refcount <= 0 && q.acquired) {
        sg.queries.delete(q.hash);
    }
}

/**
 * one-shot match — returns nodes satisfying `conditions` at call time.
 *
 * unlike `query()`, no caching, no event subscriptions, no `sg.queries` entry.
 * use this when you need a snapshot (e.g. populating an inspector picker)
 * rather than a live-maintained set.
 */
export function filter<const Args extends ConditionArgs[]>(sg: Nodes, conditions: Args): Node[] {
    const { withBitset, withoutBitset } = buildConditionBitsets(conditions);
    const result: Node[] = [];
    for (const node of sg.nodes) {
        if (bitset.containsAll(node._bitset, withBitset) && bitset.containsNone(node._bitset, withoutBitset)) {
            result.push(node);
        }
    }
    return result;
}

/* query internals */

function nodeMatchesQuery(node: Node, q: Query<any>): boolean {
    if (!bitset.containsAll(node._bitset, q.withBitset)) return false;
    if (!bitset.containsNone(node._bitset, q.withoutBitset)) return false;
    return true;
}

function addNodeToQuery(q: Query<any>, node: Node): void {
    const tuple: any[] = [];
    for (const condition of q.conditions) {
        if (condition.type === ConditionType.WITH) {
            const index = condition.trait._slot;
            if (index !== undefined) {
                tuple.push(node._traits.get(index));
            }
        }
        // NOT conditions don't contribute to tuple
    }
    q.nodeToIndex.set(node, q.matches.length);
    q.matches.push(tuple as any);

    if (q.onAdd.listeners.size > 0) {
        (q.onAdd.emit as any)(...tuple);
    }
}

function removeNodeFromQuery(q: Query<any>, node: Node): void {
    const index = q.nodeToIndex.get(node);
    if (index === undefined) return;

    if (q.onRemove.listeners.size > 0) {
        const tuple: any[] = [];
        for (const condition of q.conditions) {
            if (condition.type === ConditionType.WITH) {
                const traitSlot = condition.trait._slot;
                if (traitSlot !== undefined) {
                    tuple.push(node._traits.get(traitSlot));
                }
            }
        }
        (q.onRemove.emit as any)(...tuple);
    }

    // swap-remove from matches
    const lastIndex = q.matches.length - 1;
    if (index !== lastIndex) {
        const lastTuple = q.matches[lastIndex] as any[];
        q.matches[index] = lastTuple as any;
        // get node from first trait's back-reference for nodeToIndex update
        const lastNode = (lastTuple[0] as TraitBase)?._node;
        if (lastNode) q.nodeToIndex.set(lastNode, index);
    }

    q.matches.pop();
    q.nodeToIndex.delete(node);
}

function reindex(sg: Nodes, node: Node): void {
    for (const q of sg.queries.values()) {
        const matches = nodeMatchesQuery(node, q);
        const wasInQuery = q.nodeToIndex.has(node);

        if (matches && !wasInQuery) {
            addNodeToQuery(q, node);
        } else if (!matches && wasInQuery) {
            removeNodeFromQuery(q, node);
        }
    }
}

/* ── findAncestor ── */

/**
 * walk up the tree from `node.parent` toward the root and return the first
 * ancestor that has **all** of the given traits. returns a tuple of
 * `[...traitValues]`, or `null` if no ancestor matches. access the ancestor
 * node via any returned trait's `.node` property.
 *
 * this is an ad-hoc traversal — it is **not** reactive. call it when you
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
                    tuple.push(current._traits.get(traitSlot));
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
 * set or clear a node's prefab config and reconcile the scene graph's
 * `_prefabNodes` / `_prefabsDirty` indices. callers mutating `node.prefab`
 * on a *live* node (one that's already attached) MUST use this — direct
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
    const sg = node.scene;
    if (!sg) return;
    if (config) {
        sg._prefabNodes.add(node);
        sg._prefabsDirty.add(node);
    } else {
        sg._prefabNodes.delete(node);
        sg._prefabsDirty.delete(node);
    }
}

/**
 * flip a live node's `persist` flag and keep the uuid index in sync.
 *
 * persist:false nodes don't carry a uuid (createNodeObject path); flipping a
 * runtime-instantiated child (e.g. prefab output) to persist:true is meaningless
 * for scene save until we mint one. flipping back to persist:false drops the
 * uuid from the index but leaves it on the node — round-trip preserves identity
 * if the caller flips back without destroying the node.
 *
 * use this rather than mutating `node.persist` directly when the node is
 * already attached to a scene graph.
 */
export function setNodePersist(node: Node, persist: boolean): void {
    if (node.persist === persist) return;
    node.persist = persist;
    const sg = node.scene;
    if (!sg) return;
    if (persist && !node._uuid && sg.mode === 'edit') {
        let uuid = generateUuid();
        while (sg._uuidToNode.has(uuid)) uuid = generateUuid();
        node._uuid = uuid;
        sg._uuidToNode.set(uuid, node);
    } else if (!persist && node._uuid) {
        if (sg._uuidToNode.get(node._uuid) === node) sg._uuidToNode.delete(node._uuid);
    }
}

/**
 * mark every anchor in `_prefabNodes` whose `prefab.prefabId` is in
 * `dirtyPrefabIds` for reconcile. called from `applyRegistryChanges*` after
 * `collectDirtyByRegistry` resolves which prefab defs were directly or
 * transitively touched by the flush. drives the edit-mode + play-mode tick
 * uniformly off the same dirty set — neither side scans the full prefab
 * node set on its own.
 */
export function markPrefabAnchorsDirty(sg: Nodes, dirtyPrefabIds: ReadonlySet<string>): void {
    if (dirtyPrefabIds.size === 0) return;
    for (const node of sg._prefabNodes) {
        if (!node.prefab) continue;
        if (dirtyPrefabIds.has(node.prefab.prefabId)) sg._prefabsDirty.add(node);
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
