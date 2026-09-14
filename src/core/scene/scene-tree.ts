import type { TransformTrait } from '../../builtins/transform';
import { env } from '../../env';
import type { PlayerId } from '../client';
import * as Debug from '../debug';
import { registry } from '../registry';
import type { Bitset } from '../utils/bitset';
import * as bitset from '../utils/bitset';
import { type Listener, type Topic, topic, type Unsubscribe } from '../utils/topic';
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
import type { PrefabState } from './prefab';
import { formatIssuePath, type Issue, validate } from './prop';
import { logScriptError } from './script-errors';
import type { FrameArgs, SceneTreeContext, ScriptInstance, TickArgs, UpdateArgs } from './scripts';
import { createScriptInstance, disposeScriptInstance, fireEnterHooks, fireExitHooks, initScriptInstance } from './scripts';
import { buildTraitInstance, cloneTraitValue, type TraitBase, type TraitDef, type TraitHandle } from './traits';
import {
    getWorldChunk,
    invalidateTransformAncestry,
    invalidateTransformChildren,
    parentTransform,
    releaseTransform,
    transformSlot,
} from './transform';

export type { TraitHandle } from './traits';

/** Which side(s) a node lives on: 'inherit' (default, takes the nearest non-inherit ancestor's realm), 'shared', 'client', 'server', or 'each' (server and every client get an independent copy). */
export type Realm = 'inherit' | 'shared' | 'client' | 'server' | 'each';

export type Node = {
    /** runtime-only numeric ID, not persisted. */
    id: number;

    name: string | undefined;

    parent: Node | null;

    children: Node[];

    /** cached sibling index, revalidated by {@link childIndexOf} before use. */
    childIndex: number;

    /** the scene tree this node belongs to, or null if detached. */
    scene: SceneTree | null;

    /** null = server-owned. Keyed per-Player rather than per-Client so one client holding multiple Players doesn't collapse onto one body. */
    owner: PlayerId | null;

    /** whether this node is saved to scene files; still replicated and hot-reloaded when false. default true. */
    persist: boolean;

    /** which side(s) this node lives on / is replicated to; see {@link Realm}. Realm boundaries cascade implicitly through 'inherit' descendants. */
    realm: Realm;

    /** trait instances indexed by trait slot; holes for slots the node doesn't carry. */
    traits: Array<TraitBase | undefined>;

    /** traits whose def isn't in the registry, keyed by trait id. */
    unresolved: Map<string, Record<string, unknown> | undefined> | null;

    bitset: Bitset;

    /** bumped on structural changes to the node. */
    version: number;

    /** if non-null, this node is a prefab instance; only the prefab config is persisted, its children have persist: false. */
    prefab: PrefabConfig | null;
};

/** shared empty map, so read paths can iterate a node with no unresolved traits without a branch. */
export const EMPTY_UNRESOLVED: ReadonlyMap<string, Record<string, unknown> | undefined> = new Map();

export function generateUuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
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
        childIndex: 0,
        scene: null,
        owner: null,
        persist: persist ?? true,
        realm: realm ?? 'inherit',
        traits: [],
        bitset: bitset.init(),
        unresolved: null,
        prefab: null,
        version: 0,
    };
}

/** Files a node into its scene tree's per-tick discovery set, drained by the per-client fan-out; server-side only, a no-op on the client. */
export function markNodeDirty(sceneTree: SceneTree, node: Node): void {
    if (env.client) return;
    sceneTree.replication.dirty.add(node);
}

/** Drop everything filed this tick. Pairs with `markNodeDirty`; nothing else empties it. */
export function clearDirtyNodes(sceneTree: SceneTree): void {
    sceneTree.replication.dirty.clear();
}

/** bump a node's structural version */
export function bumpNodeVersion(sceneTree: SceneTree, node: Node): void {
    node.version = ++sceneTree.replication.versionCounter;
    markNodeDirty(sceneTree, node);
}

/** bump a specific trait's version on a node (+ the node version). */
export function bumpTraitVersion(sceneTree: SceneTree, node: Node, traitSlot: number): void {
    const v = ++sceneTree.replication.versionCounter;
    const inst = node.traits[traitSlot];
    if (inst?._sync) inst._sync.traitVersion = v;
    node.version = v;
    markNodeDirty(sceneTree, node);
}

/** bump a single field's version (+ the trait + node versions); takes the instance + slice index directly since the diff already has both in hand. */
export function bumpFieldVersion(sceneTree: SceneTree, node: Node, instance: TraitBase, i: number): void {
    const v = ++sceneTree.replication.versionCounter;
    if (instance._sync) {
        instance._sync.versions[i] = v;
        instance._sync.traitVersion = v;
    }
    node.version = v;
    markNodeDirty(sceneTree, node);
}

export type SceneTree = {
    /** the root node of this scene tree; always present, cannot be destroyed. */
    root: Node;

    /** all nodes in this scene tree (including root). */
    nodes: Set<Node>;

    idToNode: Map<number, Node>;

    /** server ids count up from 1, client-created ones down from -1, so the two never collide on the wire. */
    nextServerId: number;
    nextClientId: number;

    /** replication bookkeeping for the per-client fan-out: `dirty` nodes to send this tick, `versionCounter` for node/trait sync versions, `owners` for authority checks. */
    replication: {
        dirty: Set<Node>;
        versionCounter: number;
        owners: Map<PlayerId, Set<Node>>;
    };

    /** prefab anchors: `nodes` is every anchor in the tree, `dirty` is the reconcile work list (an anchor whose deps aren't ready stays in it). */
    prefabs: {
        nodes: Set<Node>;
        dirty: Set<Node>;
        state: Map<Node, PrefabState>;
    };

    /** transforms with `setInterpolation(node, true)` set; the per-frame `interpolate()` pass iterates this instead of running a query. */
    interpolating: Set<TransformTrait>;

    /** every query on this tree, grouped since they're created, indexed and reaped together. */
    queries: {
        /** dedup by condition hash, so `query()` hands back the existing one for the same terms. */
        hashToQuery: Map<string, Query<any>>;
        /** trait slot -> the queries referencing it; the candidate index `collectQueries` walks. */
        traitToQuery: Array<Array<Query<any>> | undefined>;
        /** queries with no positive self-trait, which no bitset can rule out for a node. */
        always: Array<Query<any>>;
        /** queries holding staged enter/exit tuples, drained by `flushQueryEvents`. */
        events: Array<Query<any>>;
        /** live `Up` / `Ancestor` terms, bucketed by the trait slot they resolve, so a slot change touches one bucket. */
        traversals: TraversalTerm[][];
        /** stamp for deduping candidates within one `collectQueries`, so a query reachable through two of a node's traits is visited once. */
        visitGeneration: number;
        /** re-entrancy guard: a handler that mutates the tree stages more events, drained by the outer loop rather than starting a nested flush. */
        flushingEvents: boolean;
    };

    /** transform-root region index, the server-side AOI granularity; `rootRegionChanges` records this tick's transitions for the per-player pass. */
    regions: {
        regionToRoots: Map<string, Set<Node>>;
        rootToRegion: Map<Node, string>;
        rootRegionChanges: RootRegionChange[];
    };

    /** optional runtime reference; set this after createSceneTree, before adding live nodes. */
    context: SceneTreeContext | undefined;
};

export function createSceneTree(): SceneTree {
    const sceneTree: SceneTree = {
        root: null!,
        nodes: new Set(),
        idToNode: new Map(),
        nextServerId: 1,
        nextClientId: -1,
        replication: { dirty: new Set(), versionCounter: 0, owners: new Map() },
        queries: {
            hashToQuery: new Map(),
            traitToQuery: [],
            always: [],
            events: [],
            traversals: [],
            visitGeneration: 0,
            flushingEvents: false,
        },

        prefabs: { nodes: new Set(), dirty: new Set(), state: new Map() },
        interpolating: new Set(),
        regions: { regionToRoots: new Map(), rootToRegion: new Map(), rootRegionChanges: [] },
        context: undefined,
    };

    // root is explicitly 'shared' so 'inherit' descendants resolve there.
    const root = createNodeObject('Root', undefined, undefined, 'shared');
    root.id = sceneTree.nextServerId++;
    root.scene = sceneTree;
    sceneTree.nodes.add(root);
    sceneTree.idToNode.set(root.id, root);
    sceneTree.root = root;

    return sceneTree;
}

export type CreateNodeOptions = {
    name?: string;
    /** provide a runtime numeric ID (e.g. when unpacking from network); auto-assigned if omitted. */
    id?: number;
    /** whether this node is saved to scene files. default: true. */
    persist?: boolean;
    /** which side(s) this node lives on; see {@link Realm}. defaults to `'inherit'`. */
    realm?: Realm;
};

/** Creates a **detached** node: not registered in any scene tree, no script init, no queries; attach with `addChild(parent, node)` to make it live. */
export function createNode(options?: CreateNodeOptions): Node {
    return createNodeObject(options?.name, options?.id, options?.persist, options?.realm);
}

export function getNodeById(sceneTree: SceneTree, id: number): Node | undefined {
    return sceneTree.idToNode.get(id);
}

/** Sets a node's owner, keeping `sceneTree.replication.owners` in sync; route all owner writes through here, a direct assignment to `node.owner` desyncs replication. */
export function setOwner(sceneTree: SceneTree, node: Node, owner: PlayerId | null): void {
    const prev = node.owner;
    if (prev === owner) return;
    if (prev !== null) {
        const prevSet = sceneTree.replication.owners.get(prev);
        if (prevSet) {
            prevSet.delete(node);
            if (prevSet.size === 0) sceneTree.replication.owners.delete(prev);
        }
    }
    node.owner = owner;
    if (owner !== null) {
        let set = sceneTree.replication.owners.get(owner);
        if (!set) {
            set = new Set();
            sceneTree.replication.owners.set(owner, set);
        }
        set.add(node);
    }
    if (node.scene) bumpNodeVersion(node.scene, node);
}

/** Sets a node's realm; since descendants inherit it, this marks the subtree dirty for the per-client discovery fan-out. */
export function setRealm(node: Node, realm: Realm): void {
    if (node.realm === realm) return;
    node.realm = realm;
    const scene = node.scene;
    if (!scene) return;
    bumpSubtreeVersions(scene, node);
}

/** True iff every node from root down to (and including) this one resolves to `'shared'`; a `'shared'` node under a non-shared ancestor isn't reachable. */
export function isReplicable(node: Node): boolean {
    let current: Node | null = node;
    while (current) {
        if (current.realm !== 'shared' && current.realm !== 'inherit') return false;
        current = current.parent;
    }
    return true;
}

/** True iff this node was created locally (server allocates positive ids, a client negative ones); an origin test, unlike `isReplicable` (a realm-policy test). */
export function isLocalNode(node: Node): boolean {
    return node.id < 0;
}

/** True iff `node` is a *transform root*: the topmost `TransformTrait` node in its chain, and live + replicable. Derived on demand, not a maintained set. */
export function isTransformRoot(node: Node): boolean {
    const transform = node.traits[transformSlot()] as TransformTrait | undefined;
    return node.scene !== null && transform !== undefined && isReplicable(node) && parentTransform(transform) === null;
}

/** a transform root's region transition this tick; `null` means not filed (newly eligible -> `from: null`; destroyed or shadowed -> `to: null`). */
export type RootRegionChange = { root: Node; from: string | null; to: string | null };

function fileRoot(sceneTree: SceneTree, node: Node, key: string): void {
    let set = sceneTree.regions.regionToRoots.get(key);
    if (!set) {
        set = new Set();
        sceneTree.regions.regionToRoots.set(key, set);
    }
    set.add(node);
    sceneTree.regions.rootToRegion.set(node, key);
}

function unfileRoot(sceneTree: SceneTree, node: Node, key: string): void {
    const set = sceneTree.regions.regionToRoots.get(key);
    if (set) {
        set.delete(node);
        // delete-on-empty: the world is streaming-infinite, never accumulate empty buckets
        if (set.size === 0) sceneTree.regions.regionToRoots.delete(key);
    }
    sceneTree.regions.rootToRegion.delete(node);
}

/** the transform roots currently filed in a region, or undefined if none; read by per-player AOI discovery to turn a region transition into node create/destroy. */
export function rootsInRegion(sceneTree: SceneTree, key: string): Set<Node> | undefined {
    return sceneTree.regions.regionToRoots.get(key);
}

/** Reconciles the region index against this tick's `replication.dirty`, recording every transition in `rootRegionChanges`; call once per room per tick, after scripts + physics and before AOI discovery. */
export function reconcileRootRegions(sceneTree: SceneTree): void {
    sceneTree.regions.rootRegionChanges.length = 0;
    // a node filed during the pass is still picked up: Set iteration sees later additions
    for (const node of sceneTree.replication.dirty) {
        const filed = sceneTree.regions.rootToRegion.get(node);
        if (isTransformRoot(node)) {
            const transform = node.traits[transformSlot()] as TransformTrait;
            const c = getWorldChunk(transform);
            const key = regionKey(chunkToRegionCoord(c[0]), chunkToRegionCoord(c[1]), chunkToRegionCoord(c[2]));
            if (filed === key) continue; // already filed here, nothing moved
            if (filed !== undefined) unfileRoot(sceneTree, node, filed);
            fileRoot(sceneTree, node, key);
            sceneTree.regions.rootRegionChanges.push({ root: node, from: filed ?? null, to: key });
        } else if (filed !== undefined) {
            unfileRoot(sceneTree, node, filed);
            sceneTree.regions.rootRegionChanges.push({ root: node, from: filed, to: null });
        }
    }
}

/** Destroys a node: dispose scripts, remove from parent, recursively destroy children, remove from all queries, and detach from the scene tree. The root node cannot be destroyed. */
export function destroyNode(sceneTree: SceneTree, node: Node): void {
    if (node.scene !== sceneTree) return;
    if (node === sceneTree.root) return;

    // node.scene is nulled at the end of this fn, so the fan-out sees scene === null and emits node_destroyed
    markNodeDirty(sceneTree, node);

    const childrenCopy = node.children.slice();
    for (let i = 0; i < childrenCopy.length; i++) {
        destroyNode(sceneTree, childrenCopy[i]);
    }

    if (sceneTree.context) {
        const nodeInstances = sceneTree.context.instances.get(node.id);
        if (nodeInstances) {
            for (const instance of nodeInstances.values()) {
                disposeScriptInstance(instance);
            }
            sceneTree.context.instances.delete(node.id);
        }
    }
    node.unresolved = null;

    removeNodeFromAllQueries(sceneTree, node, []);

    if (node.parent) {
        removeChildInternal(node.parent, node);
    }

    setOwner(sceneTree, node, null);
    sceneTree.nodes.delete(node);
    sceneTree.idToNode.delete(node.id);
    if (node.prefab !== null) {
        sceneTree.prefabs.nodes.delete(node);
        sceneTree.prefabs.dirty.delete(node);
        sceneTree.prefabs.state.delete(node);
    }
    const transform = node.traits[transformSlot()] as TransformTrait | undefined;
    if (transform) releaseTransform(sceneTree, transform);
    node.scene = null;

    // recursive: each level flushes once its own node is detached, for bottom-up-consistent teardown
    flushQueryEvents(sceneTree);
}

/** user-facing props for addTrait, only the trait's own declared fields, minus base fields. */
export type TraitProps<T extends TraitBase> = Partial<Omit<T, 'node' | '_def' | '_sync'>>;

/** Adds a trait to a node, with optional prop overrides; works on detached nodes too, deferring scene-tree-level effects to `registerSubtree`. */
export function addTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>, props?: TraitProps<T>): T {
    const traitSlot = handle.slot;

    // re-adding an existing trait is a replace: tear down the old instance first so its scripts' onExit fires
    if (bitset.has(node.bitset, traitSlot)) {
        removeTrait(node, handle);
    }

    const instance = buildTraitInstance(handle, props as Record<string, unknown> | undefined) as T;
    attachTraitInstance(node, traitSlot, instance);

    const scene = node.scene;
    resolveChildren(scene, node, traitSlot);

    if (scene) {
        bumpNodeVersion(scene, node);
        reindex(scene, node, traitSlot);
        if (scene.context) {
            const created = instantiateTraitScripts(scene.context, node, instance, handle.def);
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
        flushQueryEvents(scene);
    }

    return instance;
}

/** instantiate every script registered on `def` for this trait instance; caller fires onInit/onEnter after. */
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

/** dispose every live script instance bound to a specific trait on a node, firing onExit then onDispose. */
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

/** write a trait instance into a node's trait map and bitset; scene tree, query and transform side effects belong to addTrait. */
function attachTraitInstance(node: Node, traitSlot: number, instance: TraitBase): void {
    instance._node = node;
    node.traits[traitSlot] = instance;
    bitset.add(node.bitset, traitSlot);
}

export function removeTrait(node: Node, handle: TraitHandle): void {
    const scene = node.scene;
    const traitSlot = handle.slot;
    if (traitSlot === undefined) return;

    if (bitset.has(node.bitset, traitSlot)) {
        // dispose scripts before clearing trait state, onExit fires while the trait value is still resolvable
        if (scene?.context) disposeTraitScripts(scene.context, node, handle.def);

        if (traitSlot === transformSlot()) {
            releaseTransform(scene, node.traits[transformSlot()] as TransformTrait);
        }

        bitset.remove(node.bitset, traitSlot);
        if (scene) {
            bumpNodeVersion(scene, node);
            reindex(scene, node, traitSlot);
        }
        node.traits[traitSlot] = undefined;
        resolveChildren(scene, node, traitSlot);
        flushQueryEvents(scene);
    }
}

export function getTrait<T extends TraitBase>(node: Node, handle: TraitHandle<T>): T | undefined {
    const traitSlot = handle.slot;
    if (traitSlot === undefined) return undefined;
    return node.traits[traitSlot] as T | undefined;
}

export function hasTrait(node: Node, handle: TraitHandle): boolean {
    const traitSlot = handle.slot;
    if (traitSlot === undefined) return false;
    return bitset.has(node.bitset, traitSlot);
}

/** remove a trait by its numeric slot; used internally by the inspector and other engine code that works with numeric indices directly. */
export function removeTraitBySlot(node: Node, traitSlot: number): void {
    const scene = node.scene;

    if (bitset.has(node.bitset, traitSlot)) {
        if (scene?.context) {
            const handle = registry.slotToTrait[traitSlot];
            if (handle) disposeTraitScripts(scene.context, node, handle.def);
        }

        if (traitSlot === transformSlot()) {
            releaseTransform(scene, node.traits[transformSlot()] as TransformTrait);
        }

        bitset.remove(node.bitset, traitSlot);
        if (scene) {
            bumpNodeVersion(scene, node);
            reindex(scene, node, traitSlot);
        }
        node.traits[traitSlot] = undefined;
        resolveChildren(scene, node, traitSlot);
        flushQueryEvents(scene);
    }
}

/** add a trait by its numeric slot; used internally by the inspector and other engine code that works with numeric indices directly. */
export function addTraitBySlot(node: Node, traitSlot: number, props?: Record<string, unknown>): TraitBase | null {
    const scene = node.scene;

    const handle = registry.slotToTrait[traitSlot];
    if (!handle) return null;

    const instance = buildTraitInstance(handle, props);
    instance._node = node;

    node.traits[traitSlot] = instance;
    bitset.add(node.bitset, traitSlot);

    // outside the `scene` guard: this path also hydrates detached trees (scene-pack)
    resolveChildren(scene, node, traitSlot);

    if (scene) {
        bumpNodeVersion(scene, node);
        reindex(scene, node, traitSlot);
    }

    if (scene?.context) {
        const created = instantiateTraitScripts(scene.context, node, instance, handle.def);
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

    flushQueryEvents(scene);

    return instance;
}

/** compute issues for every prop field on a trait instance against its def; empty when the instance conforms to all schemas. */
function computeTraitIssues(def: TraitDef, instance: TraitBase): Issue[] {
    if (def.controls.length === 0) return [];
    const issues: Issue[] = [];
    for (const control of def.controls) {
        const value = control.get(instance);
        const fieldIssues = validate(control.schema, value);
        for (const issue of fieldIssues) {
            issues.push({
                ...issue,
                path: [control.controlId, ...issue.path],
            });
        }
    }
    return issues;
}

/** Validates a trait's control values and warns once per issue; `label` is prepended so the source of bad data is identifiable in mixed logs. */
export function refreshTraitIssues(def: TraitDef, instance: TraitBase, label?: string): Issue[] {
    const issues = computeTraitIssues(def, instance);
    if (issues.length > 0) {
        const prefix = label ? `[bongle] ${label}` : '[bongle]';
        for (const issue of issues) {
            const where = formatIssuePath(issue.path);
            console.warn(`${prefix} trait '${def.id}' invalid at '${where}': ${issue.message}`);
        }
    }
    return issues;
}

/** Fires onInit on all uninitialized script instances in a scene tree; call after the tree is fully built and runtime context is wired. */
export function initSceneTree(sceneTree: SceneTree): void {
    if (!sceneTree.context) return;

    // pass 1: create instances for any node-trait pairs that don't have one yet
    for (const node of sceneTree.nodes) {
        const nodeTraits = node.traits;
        for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
            const trait = nodeTraits[traitSlot];
            if (trait === undefined) continue;
            const handle = registry.slotToTrait[traitSlot];
            if (!handle || handle.def.scripts.length === 0) continue;
            instantiateTraitScripts(sceneTree.context, node, trait, handle.def);
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

/** Adds a child node to a parent; if the child already has a parent it's removed first, and if the parent is in a scene tree the child registers into it. */
export function addChild(parent: Node, child: Node): void {
    if (child.parent) {
        removeChildInternal(child.parent, child);
    }

    child.parent = parent;
    child.childIndex = parent.children.length;
    parent.children.push(child);

    if (parent.scene) {
        registerSubtree(parent.scene, child);
    }

    // runs even when `parent` is itself detached, pointers within the subtree still matter
    resolveSubtree(parent.scene, child, undefined);

    // last, so an enter handler reading a world matrix sees fresh pointers
    flushQueryEvents(parent.scene);
}

/** Removes a child from its parent; the child (and its descendants) are detached from the scene tree and removed from all queries. */
export function removeChild(parent: Node, child: Node): void {
    if (child.parent !== parent) return;

    if (child.scene) {
        unregisterSubtree(child.scene, child);
    }

    removeChildInternal(parent, child);

    resolveSubtree(null, child, parent);

    flushQueryEvents(parent.scene);
}

export function getParent(node: Node): Node | null {
    return node.parent;
}

export function getChildren(node: Node): Node[] {
    return node.children;
}

/** Position of `node` among its siblings, 0 when it has no parent; the cached hint on the node makes this O(1) for the replication fan-out. */
export function childIndexOf(node: Node): number {
    const parent = node.parent;
    if (parent === null) return 0;
    const hint = node.childIndex;
    if (parent.children[hint] === node) return hint;
    const index = parent.children.indexOf(node);
    node.childIndex = index;
    return index;
}

/** renumber `children` from `start` after a splice. */
function reindexChildren(parent: Node, start: number): void {
    const children = parent.children;
    for (let i = start; i < children.length; i++) children[i]!.childIndex = i;
}

/** Moves a node to a new parent; the node must be in the same scene tree as the new parent, or detached (will be registered). */
export function reparent(node: Node, newParent: Node): void {
    if (node.parent === newParent) return;

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
    node.childIndex = newParent.children.length;
    newParent.children.push(node);

    if (node.scene === null) {
        // was detached: register now, which also fires onInit + onEnter + marks dirty
        registerSubtree(scene, node);
    } else {
        if (scene.context) fireEnterHooks(scene.context, node, newParent);
        // reparenting can flip effective relevance and descendants inherit it, so the whole moved subtree needs re-evaluating
        bumpSubtreeVersions(scene, node);
    }

    resolveSubtree(scene, node, wasInTree ? oldParent : null);

    flushQueryEvents(scene);
}

/** Moves a child to a specific index in its parent's children array; does nothing if the child is not a child of parent. */
export function reorderChild(parent: Node, child: Node, index: number): void {
    if (child.parent !== parent) return;
    const current = childIndexOf(child);
    if (current === -1) return;
    parent.children.splice(current, 1);
    const target = Math.min(index, parent.children.length);
    parent.children.splice(target, 0, child);
    reindexChildren(parent, Math.min(current, target));
    if (child.scene) bumpNodeVersion(child.scene, child);
}

/** Replaces all children of `root` with `node`, destroying every other child; `node` must be a direct child of `root`. Mirrors the DOM's `replaceChildren()`. */
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
            child.parent = null;
        }
    }
    root.children = [node];
    node.childIndex = 0;
}

/** True if `ancestor` is an ancestor of `descendant`. */
export function isAncestorOf(ancestor: Node, descendant: Node): boolean {
    let current = descendant.parent;
    while (current !== null) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

/** remove a child from parent's children array (does not touch scene tree registration) */
function removeChildInternal(parent: Node, child: Node): void {
    const index = childIndexOf(child);
    if (index !== -1) {
        parent.children.splice(index, 1);
        reindexChildren(parent, index);
    }
    child.parent = null;
    child.childIndex = 0;
}

/** Registers a node and all its descendants into a scene tree, two-pass: pass 1 registers nodes, indexes queries and creates script instances; pass 2 fires onInit on all of them. */
function registerSubtree(sceneTree: SceneTree, node: Node): void {
    const subtree: Node[] = [];
    collectSubtree(node, subtree);

    const newScriptInstances: ScriptInstance[] = [];
    // one candidate buffer for the whole subtree, refilled per node by `collectQueries`
    const candidates: Array<Query<any>> = [];

    for (const subtreeNode of subtree) {
        subtreeNode.scene = sceneTree;
        sceneTree.nodes.add(subtreeNode);
        markNodeDirty(sceneTree, subtreeNode);
        if (subtreeNode.prefab) {
            sceneTree.prefabs.nodes.add(subtreeNode);
            sceneTree.prefabs.dirty.add(subtreeNode);
        }

        if (subtreeNode.id === 0) {
            subtreeNode.id = env.client ? sceneTree.nextClientId-- : sceneTree.nextServerId++;
        } else if (subtreeNode.id >= sceneTree.nextServerId) {
            // pre-assigned id (e.g. from network unpack), bump counter past it
            sceneTree.nextServerId = subtreeNode.id + 1;
        }
        sceneTree.idToNode.set(subtreeNode.id, subtreeNode);

        const candidateCount = collectQueries(sceneTree, subtreeNode, candidates);
        for (let qi = 0; qi < candidateCount; qi++) reconcile(candidates[qi]!, subtreeNode, true);

        if (sceneTree.context) {
            const nodeTraits = subtreeNode.traits;
            for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
                const trait = nodeTraits[traitSlot];
                if (trait === undefined) continue;
                const handle = registry.slotToTrait[traitSlot];
                if (!handle || handle.def.scripts.length === 0) continue;
                const created = instantiateTraitScripts(sceneTree.context, subtreeNode, trait, handle.def);
                for (const i of created) newScriptInstances.push(i);
            }
        }
    }

    // pass 2: fire onInit on all new script instances
    for (const instance of newScriptInstances) {
        initScriptInstance(instance);
    }

    // pass 3: fire onEnter on each node that has a parent (all nodes in the subtree do)
    if (sceneTree.context) {
        for (const subtreeNode of subtree) {
            if (subtreeNode.parent) {
                fireEnterHooks(sceneTree.context, subtreeNode, subtreeNode.parent);
            }
        }
    }
}

/** Unregisters a node and all its descendants from a scene tree: disposes scripts, removes from queries, detaches from scene tree. */
function unregisterSubtree(sceneTree: SceneTree, node: Node, candidates: Array<Query<any>> = []): void {
    for (let i = 0; i < node.children.length; i++) {
        unregisterSubtree(sceneTree, node.children[i]!, candidates);
    }

    if (sceneTree.context && node.parent) {
        fireExitHooks(sceneTree.context, node, node.parent);
    }

    // scripts re-instantiate from traits when the subtree re-registers, so drop them all here
    if (sceneTree.context) {
        const nodeInstances = sceneTree.context.instances.get(node.id);
        if (nodeInstances) {
            for (const instance of nodeInstances.values()) {
                disposeScriptInstance(instance);
            }
            sceneTree.context.instances.delete(node.id);
        }
    }

    removeNodeFromAllQueries(sceneTree, node, candidates);

    setOwner(sceneTree, node, null);
    sceneTree.nodes.delete(node);
    sceneTree.idToNode.delete(node.id);
    if (node.prefab !== null) {
        sceneTree.prefabs.nodes.delete(node);
        sceneTree.prefabs.dirty.delete(node);
        sceneTree.prefabs.state.delete(node);
    }
    // ends with scene === null so it's reported even for an already-server-owned node, which setOwner above wouldn't dirty
    markNodeDirty(sceneTree, node);
    node.scene = null;
}

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

// re-exported from traverse.ts
export { traverse } from './traverse';

// memoised `script/<hook>/<key>` metric ids so the hot path does no string work even while the profiler is off
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

// a disabled profiler for hooks we don't surface (physics-step hooks run from physics.tick, which has no profiler handle)
const SILENT = Debug.createProfiler(false);

// the one driver behind every runOn* below: walk initialized instances and run each `select`-ed hook fn with `args`, one profiler span per instance
function runHook<A>(
    sceneTree: SceneTree,
    args: A,
    profiler: Debug.Profiler,
    hook: string,
    select: (i: ScriptInstance) => Iterable<(a: A) => void>,
): void {
    if (!sceneTree.context) return;
    for (const nodeInstances of sceneTree.context.instances.values()) {
        for (const instance of nodeInstances.values()) {
            if (!instance.initialized) continue;
            for (const fn of select(instance)) {
                const id = perfKey(hook, instance.def.key);
                Debug.begin(profiler, id);
                try {
                    fn(args);
                } catch (err) {
                    logScriptError(`script '${instance.def.key}'.${hook} @${instance.node.id}`, err);
                }
                Debug.end(profiler, id);
            }
        }
    }
}

/** fire onInput hooks on all scripts, before runOnUpdate so consumers can pre-process input before player controllers read it. */
export function runOnInput(sceneTree: SceneTree, args: FrameArgs, profiler: Debug.Profiler): void {
    runHook(sceneTree, args, profiler, 'onInput', (i) => i.onInput);
}

/** update all scripts in the scene tree, once per frame before the fixed-timestep tick loop. */
export function runOnUpdate(sceneTree: SceneTree, args: UpdateArgs, profiler: Debug.Profiler): void {
    runHook(sceneTree, args, profiler, 'onUpdate', (i) => i.onUpdate);
}

/** tick all scripts in the scene tree, calling onTick on each script instance. */
export function runOnTick(sceneTree: SceneTree, args: TickArgs, profiler: Debug.Profiler): void {
    runHook(sceneTree, args, profiler, 'onTick', (i) => i.onTick);
}

/** fire onPrePhysicsStep hooks on all scripts, after tickSceneTree but before the physics step; runs off the profiler since it runs from physics.tick. */
export function runOnPrePhysicsStep(sceneTree: SceneTree, args: TickArgs): void {
    runHook(sceneTree, args, SILENT, 'onPrePhysicsStep', (i) => i.onPrePhysicsStep);
}

/** fire onPostPhysicsStep hooks on all scripts, after the physics step, before frameSceneTree. */
export function runOnPostPhysicsStep(sceneTree: SceneTree, args: TickArgs): void {
    runHook(sceneTree, args, SILENT, 'onPostPhysicsStep', (i) => i.onPostPhysicsStep);
}

/** fire onPostAnimate hooks on all scripts, after Animation.tick and before world-matrix recompute, so callbacks see fresh local TRS but last-tick world matrices. */
export function runOnPostAnimate(sceneTree: SceneTree, args: FrameArgs, profiler: Debug.Profiler): void {
    runHook(sceneTree, args, profiler, 'onPostAnimate', (i) => i.onPostAnimate);
}

/** the last hook of the frame: after animation, post-animate and concatenation, before visibility and draw. */
export function runOnPreRender(sceneTree: SceneTree, args: FrameArgs, profiler: Debug.Profiler): void {
    runHook(sceneTree, args, profiler, 'onPreRender', (i) => i.onPreRender);
}

/** frame all scripts in the scene tree, calling onFrame on each script instance; client-side render frame updates. */
export function runOnFrame(sceneTree: SceneTree, args: FrameArgs, profiler: Debug.Profiler): void {
    runHook(sceneTree, args, profiler, 'onFrame', (i) => i.onFrame);
}

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

/** Serializes a trait instance to a plain object for scene files; only `control()`-decorated fields are serialized, tag traits get `controls: undefined`. */
function serializeTrait(traitSlot: number, instance: TraitBase, options?: SerializeOptions): SerializedTrait | null {
    const handle = registry.slotToTrait[traitSlot];
    if (!handle) return null;
    if (options?.persistOnly && !handle.def.persist) return null;

    if (handle.def.controls.length === 0) {
        return { id: handle.id, controls: undefined };
    }

    // clone control values: callers retain this and reapply later, so sharing refs with the live instance would let runtime mutations corrupt the snapshot
    const controls: Record<string, unknown> = {};
    for (const control of handle.def.controls) {
        const value = control.get(instance);
        controls[control.controlId] = value !== null && typeof value === 'object' ? cloneTraitValue(value) : value;
    }
    return { id: handle.id, controls };
}

/** Serializes a node and all its descendants to a plain object; for each trait, only `control()`-decorated fields are serialized. */
export function serializeNode(node: Node, options?: SerializeOptions): SerializedNode {
    const serializedTraits: SerializedTrait[] = [];

    const nodeTraits = node.traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const instance = nodeTraits[traitSlot];
        if (instance === undefined) continue;
        const serialized = serializeTrait(traitSlot, instance, options);
        if (serialized) {
            serializedTraits.push(serialized);
        }
    }

    for (const [id, controls] of node.unresolved ?? EMPTY_UNRESOLVED) {
        serializedTraits.push({ id, controls });
    }

    // prefab nodes own no authored children: they're re-instantiated at load time, so never persist them
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

/** Deserializes a node tree from a plain object into a **detached** node; the caller calls `addChild(parent, node)` to attach it. Resilient to schema changes. */
export function deserializeNode(data: SerializedNode): Node {
    const node = createNodeObject(data.name, 0, data.persist !== false, data.realm);
    const label = `node "${data.name ?? '(unnamed)'}"`;

    // detached, so this only records the config; the anchor is reconciled once it attaches
    if (data.prefab) setPrefab(node, structuredClone(data.prefab));

    for (const traitData of data.traits) {
        const controls = traitData.controls ? cloneTraitValue(traitData.controls) : undefined;

        const handle = registry.traits.handles.get(traitData.id);
        if (!handle) {
            console.warn(`[bongle] unresolved trait "${traitData.id}" on ${label} — preserving raw data`);
            if (node.unresolved === null) node.unresolved = new Map();
            node.unresolved.set(traitData.id, controls);
            continue;
        }

        const instance = addTraitBySlot(node, handle.slot, controls);
        if (instance !== null) refreshTraitIssues(handle.def, instance, label);
    }

    for (const child of data.children) addChild(node, deserializeNode(child));

    return node;
}

/** Clones a node and all its descendants into a **detached** subtree with no scripts instantiated; `addChild(parent, clone)` wakes it up. Controls are deep-copied via per-control codecs. */
export function cloneNode(source: Node): Node {
    const clone = createNodeObject(source.name, 0, source.persist, source.realm);
    clone.prefab = source.prefab;

    const nodeTraits = source.traits;
    for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
        const sourceInstance = nodeTraits[traitSlot];
        if (sourceInstance === undefined) continue;
        const traitHandle = registry.traits.handles.get(sourceInstance._def.id);
        if (!traitHandle) continue;
        const cloneInstance = buildTraitInstance(traitHandle);
        const codecs = getControlCodecs(traitHandle);
        if (codecs) {
            for (let i = 0; i < codecs.length; i++) {
                const codec = codecs[i];
                const bytes = codec.pack(sourceInstance, source);
                const control = traitHandle.def.controls[i];
                control.set(cloneInstance, codec.unpack(bytes));
            }
        }
        attachTraitInstance(clone, traitSlot, cloneInstance);
    }

    // round-trip preserve traits whose defs aren't in the registry
    for (const [id, controls] of source.unresolved ?? EMPTY_UNRESOLVED) {
        if (clone.unresolved === null) clone.unresolved = new Map();
        clone.unresolved.set(id, controls);
    }

    for (const child of source.children) {
        addChild(clone, cloneNode(child));
    }

    return clone;
}

/** Finds the first descendant of `node` (depth-first) whose `name` matches `name`, or null; `node` itself is not considered a match. */
export function findChildByName(node: Node, name: string): Node | null {
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.name === name) return child;
        const deeper = findChildByName(child, name);
        if (deeper) return deeper;
    }
    return null;
}

/** Finds every descendant of `node` (depth-first) whose `name` matches `name`; prefer `findChildByName` for unique lookups. */
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

export type SerializedSceneTree = {
    root: SerializedNode;
};

/** Saves the scene tree to a JSON-friendly structure for writing to disk; skips nodes and traits with persist: false. */
export function saveSceneTree(sceneTree: SceneTree): SerializedSceneTree {
    const options: SerializeOptions = { persistOnly: true };
    return { root: serializeNode(sceneTree.root, options) };
}

/** Loads a scene tree from serialized JSON data, replacing root's existing children and restoring root traits, scripts and name. */
export function loadSceneTree(sceneTree: SceneTree, data: SerializedSceneTree): void {
    const root = sceneTree.root;
    const rootData = data.root;

    const existingChildren = root.children.slice();
    for (const child of existingChildren) {
        destroyNode(sceneTree, child);
    }

    if (sceneTree.context) {
        const rootInstances = sceneTree.context.instances.get(root.id);
        if (rootInstances) {
            for (const instance of rootInstances.values()) {
                disposeScriptInstance(instance);
            }
            sceneTree.context.instances.delete(root.id);
        }
    }
    root.traits.length = 0;
    root.bitset = bitset.init();
    root.unresolved = null;

    root.name = rootData.name;

    if (rootData.traits) {
        for (const serializedTrait of rootData.traits) {
            const handle = registry.traits.handles.get(serializedTrait.id);
            if (!handle) {
                console.warn(`[bongle] unresolved trait "${serializedTrait.id}" on root node — preserving raw data`);
                if (root.unresolved === null) root.unresolved = new Map();
                // cloned so the round-trip copy doesn't alias the caller's retained rootData
                root.unresolved.set(
                    serializedTrait.id,
                    serializedTrait.controls ? cloneTraitValue(serializedTrait.controls) : undefined,
                );
                continue;
            }

            const controls = serializedTrait.controls ? cloneTraitValue(serializedTrait.controls) : undefined;
            const instance = buildTraitInstance(handle, controls);
            instance._node = root;
            root.traits[handle.slot] = instance;
            bitset.add(root.bitset, handle.slot);
            refreshTraitIssues(handle.def, instance, 'root node');
        }
        reindex(sceneTree, root);
    }

    if (sceneTree.context) {
        const nodeTraits = root.traits;
        for (let traitSlot = 0; traitSlot < nodeTraits.length; traitSlot++) {
            const trait = nodeTraits[traitSlot];
            if (trait === undefined) continue;
            const handle = registry.slotToTrait[traitSlot];
            if (!handle || handle.def.scripts.length === 0) continue;
            const created = instantiateTraitScripts(sceneTree.context, root, trait, handle.def);
            for (const i of created) initScriptInstance(i);
        }
    }

    // the root's own reindex above is staged; drain it before children land
    flushQueryEvents(sceneTree);

    for (const nodeData of rootData.children) {
        const child = deserializeNode(nodeData);
        addChild(root, child);
    }
}

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
    const list = sceneTree.queries.traitToQuery[slot];
    if (list === undefined) return n;
    for (let i = 0; i < list.length; i++) {
        const q = list[i]!;
        if (q._visitGeneration === gen) continue;
        q._visitGeneration = gen;
        out[n++] = q;
    }
    return n;
}

/** Gathers the queries whose verdict for `node` could have changed into the scene tree's scratch buffer, returning how many; pass `changedSlot` for a single trait add/remove. */
function collectQueries(sceneTree: SceneTree, node: Node, out: Array<Query<any>>, changedSlot?: number): number {
    const gen = ++sceneTree.queries.visitGeneration;
    let n = 0;

    const always = sceneTree.queries.always;
    for (let i = 0; i < always.length; i++) {
        const q = always[i]!;
        q._visitGeneration = gen;
        out[n++] = q;
    }

    if (changedSlot !== undefined) return pushCandidates(sceneTree, changedSlot, gen, out, n);

    const bits = node.bitset;
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

export type Query<Conditions extends Array<Condition<any, any, any>>> = {
    scene: SceneTree;
    /** tuples staged for `onExit` / `onEnter`, drained by `flushQueryEvents`; exits are emitted before enters. */
    _pendingExits: any[][];
    _pendingEnters: any[][];
    hash: string;
    conditions: [...Conditions];
    withTraits: number[];
    withBitset: Bitset;
    withoutBitset: Bitset;
    matches: Array<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /** the node behind each entry of `matches`, same index; also the validity check for `_sparse`, whose entries are allowed to go stale. */
    matchNodes: Node[];
    /** sparse membership index: node id -> position in `matches`. A plain array so V8 keeps it a fast elements-kind array. */
    _sparse: number[];
    /** the negative-id half of `_sparse`, indexed by `-id`; split by sign since a scene tree's ids are effectively all one sign. */
    _sparseNeg: number[];
    /** `conditions` minus the `Not` terms, in tuple order, so `buildQueryTuple` knows its exact arity. */
    _tupleTerms: Array<Condition<any, any, any>>;
    /** stamp written by `collectQueries` so a query reachable through two of a node's traits is added to the candidate list once. */
    _visitGeneration: number;
    /** terms whose value comes from the hierarchy (`Up` / `Ancestor`); empty for an ordinary self-only query, letting structural mutations skip the resolve walk entirely. */
    traversals: TraversalTerm[];
    /** node started matching; subscribe with {@link onQueryEnter}, never directly. */
    onEnter: Topic<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /** node stopped matching; subscribe with {@link onQueryExit}. */
    onExit: Topic<[...traits: ExtractTraitsFromConditions<Conditions>]>;
    /** live ref-count from script instances that called `query(ctx, ...)`; 0 + acquired false = engine-persistent, 0 + acquired true = reap on next releaseQuery. */
    refcount: number;
    /** true once any script instance has acquired this query; gates reaping. */
    acquired: boolean;
    [Symbol.iterator](): Iterator<[...traits: ExtractTraitsFromConditions<Conditions>]>;
};

/** The full `matches` array of a query, keyed by the same condition args passed to {@link query}. */
export type QueryMatches<Args extends ConditionArgs[]> = Query<ConditionArgsToConditions<Args>>['matches'];
/** one element of {@link QueryMatches}, the trait tuple a single query result yields. */
export type QueryMatch<Args extends ConditionArgs[]> = QueryMatches<Args>[number];

/** one `Up` / `Ancestor` term of a query, resolved against the hierarchy rather than the node's own bitset. */
type TraversalTerm = {
    traitSlot: number;
    /** `Up` counts the node itself; `Ancestor` starts at the parent. */
    inclusive: boolean;
    required: boolean;
    tupleIndex: number;
    query: Query<any>;
};

/** nearest trait instance at or above `node`, per `inclusive`; O(depth), runs only on structural change, never per frame. */
function nearestTrait(node: Node | null, traitSlot: number, inclusive: boolean): TraitBase | undefined {
    let current: Node | null = inclusive ? node : (node?.parent ?? null);
    while (current) {
        const trait = current.traits[traitSlot];
        if (trait !== undefined) return trait;
        current = current.parent;
    }
    return undefined;
}

/** resolve one term's value for `node`, honouring its source. */
function resolveTerm(node: Node, condition: Condition<any, any, any>): TraitBase | undefined {
    const traitSlot = condition.trait.slot;
    if (traitSlot === undefined) return undefined;
    // the bitset is the truth, not `_traits`: removeTraitBySlot clears the bit before reindexing but keeps the instance until after
    if (condition.src === Src.Self) {
        return bitset.has(node.bitset, traitSlot) ? node.traits[traitSlot] : undefined;
    }
    return nearestTrait(node, traitSlot, condition.src === Src.Up);
}

function buildConditionBitsets(conditions: ConditionArgs[]): {
    parsedConditions: Array<Condition<any, any, any>>;
    withBitset: Bitset;
    withoutBitset: Bitset;
    withTraits: number[];
    traversalSpecs: Array<Omit<TraversalTerm, 'query'>>;
} {
    const parsedConditions = conditions.map((cond): Condition<any, any, any> => {
        if (typeof cond === 'object' && cond !== null && 'slot' in cond) {
            // bare trait handle: implicit With
            return { trait: cond, oper: Oper.And, src: Src.Self };
        }
        return cond as Condition<any, any, any>;
    });

    let withBitset = bitset.init();
    let withoutBitset = bitset.init();
    const withTraits: number[] = [];
    const traversalSpecs: Array<Omit<TraversalTerm, 'query'>> = [];

    // tuple index advances for every value-carrying term, everything but Not
    let tupleIndex = 0;
    for (const condition of parsedConditions) {
        const traitSlot = condition.trait.slot;
        if (condition.oper === Oper.Not) {
            if (traitSlot !== undefined) withoutBitset = bitset.add(withoutBitset, traitSlot);
            continue;
        }
        if (traitSlot !== undefined) {
            if (condition.src === Src.Self) {
                // only a self-sourced requirement is a bitmask test; a self-sourced Optional needs no registration
                if (condition.oper === Oper.And) {
                    withBitset = bitset.add(withBitset, traitSlot);
                    withTraits.push(traitSlot);
                }
            } else {
                traversalSpecs.push({
                    traitSlot,
                    inclusive: condition.src === Src.Up,
                    required: condition.oper === Oper.And,
                    tupleIndex,
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
        traversalSpecs,
    };
}

export function query<const Args extends ConditionArgs[]>(
    sceneTree: SceneTree,
    conditions: Args,
): Query<ConditionArgsToConditions<Args>> {
    const { parsedConditions, withBitset, withoutBitset, withTraits, traversalSpecs } = buildConditionBitsets(conditions);

    // hash conditions (order matters, do not sort); oper and src both belong in the key since `[Mesh, Up(Model)]` and `[Mesh, Model]` are different queries
    const hashParts: string[] = [];
    for (const condition of parsedConditions) {
        hashParts.push(`${OPER_TAG[condition.oper]}${SRC_TAG[condition.src]}${condition.trait.slot}`);
    }
    const hash = hashParts.join(',');

    const existing = sceneTree.queries.hashToQuery.get(hash);
    if (existing) {
        return existing as Query<ConditionArgsToConditions<Args>>;
    }

    const q: Query<ConditionArgsToConditions<Args>> = {
        scene: sceneTree,
        _pendingExits: [],
        _pendingEnters: [],
        hash,
        conditions: parsedConditions as unknown as [...ConditionArgsToConditions<Args>],
        withTraits,
        withBitset,
        withoutBitset,
        matches: [],
        matchNodes: [],
        _sparse: [],
        _sparseNeg: [],
        _tupleTerms: parsedConditions.filter((c) => c.oper !== Oper.Not),
        traversals: [],
        onEnter: topic(),
        onExit: topic(),
        refcount: 0,
        acquired: false,
        _visitGeneration: 0,
        [Symbol.iterator]() {
            return this.matches[Symbol.iterator]();
        },
    };

    // terms carry their query, so the resolve walk calls `applyTraversal` directly rather than through a per-term closure
    const traversals = q.traversals;
    for (const spec of traversalSpecs) traversals.push({ ...spec, query: q });

    sceneTree.queries.hashToQuery.set(hash, q);
    if (withTraits.length === 0) {
        sceneTree.queries.always.push(q);
    } else {
        for (const condition of parsedConditions) {
            const slot = condition.trait.slot;
            if (slot === undefined) continue;
            const list = sceneTree.queries.traitToQuery[slot];
            if (list === undefined) sceneTree.queries.traitToQuery[slot] = [q];
            else list.push(q);
        }
    }
    for (const term of traversals) addQueryResolution(sceneTree, term);

    for (const node of sceneTree.nodes) {
        if (nodeMatchesQuery(node, q)) {
            addNodeToQuery(q, node);
        }
    }

    return q;
}

/** Acquires a script-side reference to a query, paired with `releaseQuery`; engine-side callers of `query()` skip this and let the query persist for the tree's lifetime. */
export function acquireQuery(_sceneTree: SceneTree, q: Query<any>): void {
    q.refcount++;
    q.acquired = true;
}

/** Releases a script-side reference; when refcount hits zero on a query that was ever acquired, evict from `sceneTree.queries` so per-mutation walks stop paying for it. */
export function releaseQuery(sceneTree: SceneTree, q: Query<any>): void {
    q.refcount--;
    if (q.refcount <= 0 && q.acquired) {
        sceneTree.queries.hashToQuery.delete(q.hash);
        swapRemove(sceneTree.queries.always, q);
        for (const condition of q.conditions) {
            const slot = (condition as Condition<any, any, any>).trait.slot;
            if (slot === undefined) continue;
            const list = sceneTree.queries.traitToQuery[slot];
            if (list !== undefined) swapRemove(list, q);
        }
        for (const term of q.traversals) {
            removeQueryResolution(sceneTree, term);
        }
    }
}

/** One-shot match returning nodes satisfying `conditions` at call time; unlike `query()`, no caching, no event subscriptions, no `sceneTree.queries` entry. */
export function filter<const Args extends ConditionArgs[]>(sceneTree: SceneTree, conditions: Args): Node[] {
    const { withBitset, withoutBitset } = buildConditionBitsets(conditions);
    const result: Node[] = [];
    for (const node of sceneTree.nodes) {
        if (bitset.containsAll(node.bitset, withBitset) && bitset.containsNone(node.bitset, withoutBitset)) {
            result.push(node);
        }
    }
    return result;
}

// query enter/exit events are staged, not emitted inline: a node is indexed into queries before its own scripts exist, so emitting at index time would hand a handler an unfinished node; every public mutation entry point calls flushQueryEvents once the tree is consistent again

/** stage `tuple` on one of the query's pending lists, enrolling the query for the drain. */
function stageQueryEvent(q: Query<any>, list: any[][], tuple: any[]): void {
    if (q._pendingExits.length === 0 && q._pendingEnters.length === 0) {
        q.scene.queries.events.push(q);
    }
    list.push(tuple);
}

function callQueryListener(listener: Listener<any>, tuple: any[]): void {
    try {
        listener(...tuple);
    } catch (err) {
        // catches engine-side subscribers (script-registered listeners log their own identity and never throw) so one cannot abort the drain
        logScriptError('query membership handler', err);
    }
}

function emitQueryEvents(eventTopic: Topic<any>, tuples: any[][]): void {
    for (let i = 0; i < tuples.length; i++) {
        for (const listener of eventTopic.listeners) {
            callQueryListener(listener, tuples[i]!);
        }
    }
}

/** emit every staged enter/exit; called at the end of each public mutation (addChild, removeChild, reparent, destroyNode, addTrait, removeTrait, ...) once the tree is consistent. */
export function flushQueryEvents(sceneTree: SceneTree | null): void {
    if (sceneTree === null || sceneTree.queries.flushingEvents) return;
    const queued = sceneTree.queries.events;
    sceneTree.queries.flushingEvents = true;
    // length is read every iteration on purpose: a handler that mutates the tree stages more events, re-enrolling its query, and this loop picks it up
    for (let i = 0; i < queued.length; i++) {
        const q = queued[i]!;
        const exits = q._pendingExits;
        const enters = q._pendingEnters;
        // detach both before emitting, so a handler re-staging on this same query enrolls it afresh rather than appending to a list being iterated
        q._pendingExits = [];
        q._pendingEnters = [];
        emitQueryEvents(q.onExit, exits);
        emitQueryEvents(q.onEnter, enters);
    }
    queued.length = 0;
    sceneTree.queries.flushingEvents = false;
}

/** Subscribes to nodes *starting* to match `q`; subscribing is itself an enter, firing immediately for every node already matching, after its own scripts have run `onInit`. */
export function onQueryEnter<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): Unsubscribe {
    q.onEnter.add(fn as Listener<any>);
    // snapshot: a handler is free to mutate the tree, which swap-removes from `matches` underneath us
    for (const tuple of q.matches.slice()) {
        callQueryListener(fn as Listener<any>, tuple as any[]);
    }
    return () => offQueryEnter(q, fn);
}

/** drop an {@link onQueryEnter} subscription; no exit drain, enter has no teardown half. idempotent. */
export function offQueryEnter<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): void {
    q.onEnter.remove(fn as Listener<any>);
}

/** Subscribes to nodes *stopping* matching `q`; unsubscribing is itself an exit, so paired with {@link onQueryEnter}'s backfill, every enter is matched by exactly one exit. */
export function onQueryExit<Conditions extends Condition[]>(
    q: Query<Conditions>,
    fn: Listener<[...traits: ExtractTraitsFromConditions<Conditions>]>,
): Unsubscribe {
    q.onExit.add(fn as Listener<any>);
    return () => offQueryExit(q, fn);
}

/** drop an {@link onQueryExit} subscription, firing it one last time for every node still matching. idempotent. */
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

function nodeMatchesQuery(node: Node, q: Query<any>): boolean {
    if (!bitset.containsAll(node.bitset, q.withBitset)) return false;
    if (!bitset.containsNone(node.bitset, q.withoutBitset)) return false;
    // a required hierarchy term can't be answered from the node's own bitset
    for (let i = 0; i < q.traversals.length; i++) {
        const term = q.traversals[i]!;
        if (!term.required) continue;
        if (nearestTrait(node, term.traitSlot, term.inclusive) === undefined) return false;
    }
    return true;
}

/** Builds a match tuple; `Not` terms contribute no slot, everything else does (`null` when unresolved), so a tuple's arity never depends on what resolved. */
function termValue(condition: Condition<any, any, any>, node: Node): unknown {
    return resolveTerm(node, condition) ?? null;
}

function buildQueryTuple(q: Query<any>, node: Node): any[] {
    // an array literal allocates its elements store at the exact arity; `[]` plus `push` allocates a 16-slot store regardless
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

    // the tuple pushed above is the event payload: it stays valid even if a later swap-remove moves it out of `matches` before the flush
    if (q.onEnter.listeners.size > 0) stageQueryEvent(q, q._pendingEnters, tuple);
}

function removeNodeFromQuery(q: Query<any>, node: Node): void {
    const index = queryIndexOf(q, node);
    if (index === -1) return;

    // captured before the swap-remove: rebuilding here would read post-change state and report values the node never had while it was a member
    const tuple = q.onExit.listeners.size > 0 ? (q.matches[index] as unknown as any[]) : null;

    // swap-remove from matches, keeping matchNodes in lockstep; the departing node's sparse slot is left stale since `matchNodes[i] === node` will reject it
    const lastIndex = q.matches.length - 1;
    if (index !== lastIndex) {
        q.matches[index] = q.matches[lastIndex] as any;
        const movedNode = q.matchNodes[lastIndex]!;
        q.matchNodes[index] = movedNode;
        sparseSet(q, movedNode.id, index);
    }

    q.matches.pop();
    q.matchNodes.pop();

    if (tuple !== null) stageQueryEvent(q, q._pendingExits, tuple);
}

// a query's `Up` / `Ancestor` term keeps "the nearest trait at or above me" resolved into every member's match tuple; invalidation is pushed from the mutation (resolveSubtree, resolveChildren) rather than discovered by rescanning

/** Reconciles `node` against every query with a term on this slot and, unless pruned, its descendants; every member of `group` targets the same trait slot, so they share the walk. */
function resolveFrom(group: TraversalTerm[], node: Node, above: TraitBase | undefined): void {
    const traitSlot = group[0]!.traitSlot;
    for (let i = 0; i < group.length; i++) {
        const term = group[i]!;
        reconcile(term.query, node, term.required, traitSlot, above);
    }
    // stop at a bearer: everything below already resolves to it
    if (node.traits[traitSlot] !== undefined) return;
    for (const child of node.children) {
        resolveFrom(group, child, above);
    }
}

/** re-resolve every live resolution over `node`'s subtree, seeding each from what `node` inherits from strictly above; call after the tree around `node` changed shape. */
function resolveSubtree(sceneTree: SceneTree | null, node: Node, movedFrom?: Node | null): void {
    invalidateTransformAncestry(node, movedFrom);
    if (sceneTree !== null) resolveSubtreeFor(sceneTree.queries.traversals, node, movedFrom);
}

/** file a query's traversal term under its target slot, opening a bucket if it is the first. */
function addQueryResolution(sceneTree: SceneTree, term: TraversalTerm): void {
    const groups = sceneTree.queries.traversals;
    for (let i = 0; i < groups.length; i++) {
        if (groups[i]![0]!.traitSlot === term.traitSlot) {
            groups[i]!.push(term);
            return;
        }
    }
    groups.push([term]);
}

/** drop a released query's term, closing the bucket if it was the last one in it. */
function removeQueryResolution(sceneTree: SceneTree, term: TraversalTerm): void {
    const groups = sceneTree.queries.traversals;
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

function resolveSubtreeFor(groups: TraversalTerm[][], node: Node, movedFrom?: Node | null): void {
    for (let g = 0; g < groups.length; g++) {
        const group = groups[g]!;
        const resolution = group[0]!;
        const inherited = nearestTrait(node.parent, resolution.traitSlot, true);
        // a move whose old and new parents resolve this to the same value changes nothing in the subtree, so two O(depth) walks replace one O(subtree) walk
        if (movedFrom !== undefined && movedFrom !== null) {
            if (nearestTrait(movedFrom, resolution.traitSlot, true) === inherited) continue;
        }
        resolveFrom(group, node, inherited);
    }
}

/** re-resolve over `node`'s descendants only, for when the target trait *on `node` itself* changed and must not prune at the changed node. */
function resolveChildren(sceneTree: SceneTree | null, node: Node, traitSlot: number): void {
    if (traitSlot === transformSlot()) invalidateTransformChildren(node);
    if (sceneTree !== null) resolveChildrenFor(sceneTree.queries.traversals, node, traitSlot);
}

function resolveChildrenFor(groups: TraversalTerm[][], node: Node, traitSlot: number): void {
    for (let g = 0; g < groups.length; g++) {
        const group = groups[g]!;
        if (group[0]!.traitSlot !== traitSlot) continue;
        const above = nearestTrait(node.parent, traitSlot, true);
        // an `Up` term on the node itself also just changed answer, and reindex alone would no-op since membership didn't change
        for (let i = 0; i < group.length; i++) {
            const term = group[i]!;
            reconcile(term.query, node, term.required, traitSlot, above);
        }
        const inherited = node.traits[traitSlot] ?? above;
        for (const child of node.children) {
            resolveFrom(group, child, inherited as TraitBase | undefined);
        }
        return; // a slot has exactly one group
    }
}

/** Brings `node`'s standing in `q` up to date, whatever changed; `mayJoin` skips the membership test for nodes that can't have become members, `knownSlot`/`knownAbove` memoize one slot's resolved value for a whole subtree walk. */
function reconcile(
    q: Query<any>,
    node: Node,
    mayJoin: boolean,
    knownSlot = -1,
    knownAbove: TraitBase | undefined = undefined,
): void {
    const index = queryIndexOf(q, node);

    if (index === -1) {
        if (mayJoin && nodeMatchesQuery(node, q)) addNodeToQuery(q, node);
        return;
    }

    // `_tupleTerms` excludes `Not` terms, so the negative bitmask is checked separately
    if (!bitset.containsNone(node.bitset, q.withoutBitset)) {
        removeNodeFromQuery(q, node);
        return;
    }

    const terms = q._tupleTerms;
    const stored = q.matches[index] as unknown as unknown[];
    let differs = false;
    for (let i = 0; i < terms.length; i++) {
        const term = terms[i]!;
        // a slot walk only re-resolves its own slot; a term sourced from the node's own traits or a different ancestry slot gets its own walk
        if (knownSlot >= 0 && term.trait.slot !== knownSlot) continue;
        const value =
            term.trait.slot === knownSlot && term.src !== Src.Self
                ? term.src === Src.Up
                    ? (node.traits[knownSlot] ?? knownAbove)
                    : knownAbove
                : resolveTerm(node, term);
        if (value === undefined && term.oper === Oper.And) {
            // a required term that no longer resolves drops the node
            removeNodeFromQuery(q, node);
            return;
        }
        if (stored[i] !== (value ?? null)) differs = true;
    }

    if (!differs) return;
    removeNodeFromQuery(q, node);
    addNodeToQuery(q, node);
}

/** Drops `node` from every query it is currently a member of; `candidates` is the caller's scratch, reused across a whole subtree-detach walk. */
function removeNodeFromAllQueries(sceneTree: SceneTree, node: Node, candidates: Array<Query<any>>): void {
    const count = collectQueries(sceneTree, node, candidates);
    for (let i = 0; i < count; i++) {
        const q = candidates[i]!;
        if (queryIndexOf(q, node) !== -1) removeNodeFromQuery(q, node);
    }
}

/** Re-tests `node` against every query that could care; `changedSlot` narrows the work to queries referencing the trait that just came or went. */
function reindex(sceneTree: SceneTree, node: Node, changedSlot?: number): void {
    const candidates: Array<Query<any>> = [];
    const count = collectQueries(sceneTree, node, candidates, changedSlot);
    for (let i = 0; i < count; i++) reconcile(candidates[i]!, node, true);
}

/** Walks up the tree from `node.parent` toward the root and returns the first ancestor that has all of the given traits, as a tuple, or null; ad-hoc, not reactive. */
export function findAncestor<const Args extends TraitHandle[]>(
    node: Node,
    traits: Args,
): [...traits: { [K in keyof Args]: Args[K] extends TraitHandle<infer T> ? T : never }] | null {
    let current = node.parent;
    while (current !== null) {
        let allMatch = true;
        for (let i = 0; i < traits.length; i++) {
            const traitSlot = traits[i].slot;
            if (traitSlot === undefined || !bitset.has(current.bitset, traitSlot)) {
                allMatch = false;
                break;
            }
        }
        if (allMatch) {
            const tuple: any[] = [];
            for (let i = 0; i < traits.length; i++) {
                const traitSlot = traits[i].slot;
                if (traitSlot !== undefined) {
                    tuple.push(current.traits[traitSlot]);
                }
            }
            return tuple as any;
        }
        current = current.parent;
    }
    return null;
}

export type PrefabConfig = {
    prefabId: string;
    args: unknown;
};

/** Sets or clears a node's prefab config and reconciles the scene tree's prefab indices; callers mutating `node.prefab` on a *live* node MUST use this, a direct assignment leaves the indices stale. */
export function setPrefab(node: Node, config: PrefabConfig | null): void {
    node.prefab = config;
    const scene = node.scene;
    if (!scene) return;
    // any cached instantiation is stale the moment the config changes
    scene.prefabs.state.delete(node);
    if (config) {
        scene.prefabs.nodes.add(node);
        scene.prefabs.dirty.add(node);
    } else {
        scene.prefabs.nodes.delete(node);
        scene.prefabs.dirty.delete(node);
    }
}

/** flip a live node's `persist` flag; use this rather than mutating `node.persist` directly when the node is already attached to a scene tree. */
export function setNodePersist(node: Node, persist: boolean): void {
    if (node.persist === persist) return;
    node.persist = persist;
}

/** mark every prefab anchor whose `prefab.prefabId` is in `dirtyPrefabIds` for reconcile,
 *  driving the edit-mode and play-mode tick off the same dirty set. */
export function markPrefabAnchorsDirty(sceneTree: SceneTree, dirtyPrefabIds: ReadonlySet<string>): void {
    if (dirtyPrefabIds.size === 0) return;
    for (const node of sceneTree.prefabs.nodes) {
        if (!node.prefab) continue;
        if (dirtyPrefabIds.has(node.prefab.prefabId)) sceneTree.prefabs.dirty.add(node);
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

/** encode a PrefabConfig to a json string for network replication. only used in edit-mode scene sync. */
export function encodePrefabConfig(config: PrefabConfig): string {
    return JSON.stringify(config);
}

/** decode a json-encoded PrefabConfig from network replication, or null if missing/malformed. */
export function decodePrefabConfig(encoded: string | undefined): PrefabConfig | null {
    if (!encoded) return null;
    try {
        return JSON.parse(encoded) as PrefabConfig;
    } catch {
        return null;
    }
}
