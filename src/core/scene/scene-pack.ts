/**
 * binary scene graph packing / unpacking for network transfer.
 *
 * packSceneGraph(sg) → Uint8Array, full scene graph to binary
 * unpackSceneGraph(sg, data), binary to scene graph (clears + rebuilds)
 * applySceneSyncUpdate(sg, update), apply a single incremental scene_sync update
 *
 * all trait field data is packcat-encoded. the receiver uses traitId to
 * look up the per-trait serdes for unpacking.
 */

import type { BinaryField, BinaryTrait, PackedNode, RoomMode, SceneSyncUpdate } from '../protocol';
import { packPackedSceneGraph, unpackPackedSceneGraph } from '../protocol';
import { registry, resolveTraitWireRef, type WireIndex } from '../registry';
import {
    addChild,
    addTraitBySlot,
    bumpNodeVersion,
    createNode,
    decodePrefabConfig,
    destroyNode,
    encodePrefabConfig,
    getNodeById,
    type Node,
    type Nodes,
    type Realm,
    removeTraitBySlot,
    reorderChild,
    reparent,
    setOwner,
    setPrefab,
} from './nodes';
import { getControlCodecs, getSyncCodecs } from './packcat-bridge';
import { disposeScriptInstance, type NodesContext } from './scripts';
import { buildTraitInstance, type TraitBase, type TraitDef } from './traits';

/* ── pack ── */

/**
 * pack a scene graph into a binary Uint8Array for network transfer.
 * includes all nodes regardless of persist flag. trait control data is
 * packcat-encoded per-control via getControlCodecs.
 *
 * root is the first node in the list with parentId: 0.
 *
 * mode: 'edit' includes node.prefab in packed data. 'play' omits it,
 * play mode instantiates children server-side, clients just see normal nodes.
 */
export function packSceneGraph(sg: Nodes, mode: RoomMode): Uint8Array {
    const root = sg.root;
    const wireIndex = registry.traitWireIndex;

    // pack all nodes in parent-first order (root first). in play mode prunes
    // non-shared subtrees, those are server- or client-local and never
    // replicated. edit mode includes everything for the editor.
    const nodes: PackedNode[] = [];
    walkReplicable(root, mode, 'shared', (node) => {
        const parentId = node.parent?.id ?? 0;
        const index = node.parent ? node.parent.children.indexOf(node) : 0;

        const traits: BinaryTrait[] = [];
        for (const [traitSlot, instance] of node._traits) {
            const def = registry.traitsBySlot.get(traitSlot);
            if (!def) continue;
            traits.push({
                netIndex: wireIndex.idToIndex.get(def.id),
                id: undefined,
                fields: packAllControls(def, instance, node),
                syncs: packAllSyncs(def, instance, node),
            });
        }
        // include unresolved traits (round-trip preservation, no field data).
        // these never have a wire index (no local def), so always emit the
        // string id fallback.
        for (const [id] of node._unresolvedTraits) {
            traits.push({ netIndex: undefined, id, fields: [], syncs: [] });
        }

        nodes.push({
            id: node.id,
            name: node.name,
            parentId,
            index: Math.max(0, index),
            persist: node.persist ? undefined : false,
            owner: node.owner ?? undefined,
            traits,
            prefab: mode === 'edit' && node.prefab ? encodePrefabConfig(node.prefab) : undefined,
        });
    });

    return packPackedSceneGraph({ nodes });
}

/* ── unpack ── */

/**
 * unpack a binary scene graph into an existing scene graph.
 * clears existing children/traits/scripts on root, then rebuilds
 * the full tree from the packed data.
 *
 * the first node in the list is the root (parentId: 0).
 *
 * `traitWireIndex` is the INBOUND wire-index table for the peer that
 * packed `data`, the receiver maintains it from `wire_table` messages
 * and passes it here. callers without a peer (in-process pack/unpack in
 * tests) omit it and the runtime's local table is used.
 */
export function unpackSceneGraph(sg: Nodes, runtime: NodesContext, data: Uint8Array, traitWireIndex?: WireIndex): void {
    const unpacked = unpackPackedSceneGraph(data);
    const root = sg.root;
    const wireIndex = traitWireIndex ?? registry.traitWireIndex;

    // clear existing children
    const existingChildren = root.children.slice();
    for (const child of existingChildren) {
        destroyNode(sg, child);
    }

    // clear existing root traits + script instances (scripts re-instantiate from traits)
    if (runtime?.instances) {
        const rootInstances = runtime.instances.get(root.id);
        if (rootInstances) {
            for (const instance of rootInstances.values()) disposeScriptInstance(instance);
            runtime.instances.delete(root.id);
        }
    }
    root._traits.clear();
    root._unresolvedTraits.clear();

    // first node is root
    const rootPacked = unpacked.nodes[0];
    if (!rootPacked) return;

    // restore root id to match the server's
    sg._idToNode.delete(root.id);
    root.id = rootPacked.id;
    sg._idToNode.set(root.id, root);
    if (root.id >= sg._nextNodeId) {
        sg._nextNodeId = root.id + 1;
    }

    // restore root name
    root.name = rootPacked.name;

    // restore root owner
    setOwner(sg, root, rootPacked.owner ?? null);

    // restore root prefab config
    setPrefab(root, decodePrefabConfig(rootPacked.prefab) ?? null);

    // restore root traits
    for (const bt of rootPacked.traits) {
        const traitId = resolveTraitWireRef(wireIndex, bt.netIndex, bt.id);
        if (traitId === undefined) continue;
        const def = registry.traits.byId.get(traitId)?.payload;
        if (!def) {
            console.warn(`[bongle] unresolved trait "${traitId}" on root node (binary) — preserving raw data`);
            root._unresolvedTraits.set(traitId, { binary: new Uint8Array(0) });
            continue;
        }
        const props = unpackFields(def, bt.fields);
        const instance = buildTraitInstance(def, props ?? undefined);
        applySyncFields(def, bt.syncs, instance);
        instance._node = root;
        root._traits.set(def.slot, instance);
    }

    // root script instances re-instantiate from the trait list at initSceneGraph time

    // create remaining nodes in parent-first order
    for (let i = 1; i < unpacked.nodes.length; i++) {
        const pn = unpacked.nodes[i];
        applyNodeCreated(sg, runtime, pn, wireIndex);
    }
}

/* ── apply a single scene_sync update to a client scene graph ── */

/**
 * apply a single incremental scene_sync update to a scene graph.
 * used by the client to process server discovery updates.
 *
 * `traitWireIndex` is the INBOUND wire-index table for the peer that
 * packed the update (the server, when called from the client inbox).
 * absent → runtime's local table is used (in-process tests).
 */
export function applySceneSyncUpdate(
    sg: Nodes,
    runtime: NodesContext,
    update: SceneSyncUpdate,
    traitWireIndex?: WireIndex,
): void {
    const wireIndex = traitWireIndex ?? registry.traitWireIndex;
    switch (update.type) {
        case 'node_created': {
            applyNodeCreated(sg, runtime, update, wireIndex);
            break;
        }

        case 'node_structure': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            const newParent = getNodeById(sg, update.parentId);
            if (!newParent) break;

            if (node.parent !== newParent) {
                reparent(node, newParent);
            }
            reorderChild(newParent, node, update.index);
            bumpNodeVersion(sg, node);
            break;
        }

        case 'node_name': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            node.name = update.name;
            bumpNodeVersion(sg, node);
            break;
        }

        case 'node_owner': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            setOwner(sg, node, update.owner ?? null);
            bumpNodeVersion(sg, node);
            break;
        }

        case 'node_trait_fields': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            const traitId = wireIndex.indexToId[update.traitNetIndex];
            if (traitId === undefined) break;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (!def) break;

            const instance = node._traits.get(def.slot);
            if (!instance) break;

            applySyncFields(def, update.fields, instance);
            bumpNodeVersion(sg, node);
            break;
        }

        case 'node_trait_added': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            const traitId = resolveTraitWireRef(wireIndex, update.traitNetIndex, update.traitId);
            if (traitId === undefined) break;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (!def) {
                console.warn(`[bongle] unresolved trait "${traitId}" in node_trait_added sync — preserving`);
                node._unresolvedTraits.set(traitId, { binary: new Uint8Array(0) });
                bumpNodeVersion(sg, node);
                break;
            }

            // if already present, treat as update
            const existing = node._traits.get(def.slot);
            if (existing) {
                applyControlFields(def, update.fields, existing);
                applySyncFields(def, update.syncs, existing);
            } else {
                const props = unpackFields(def, update.fields);
                const instance = addTraitBySlot(node, def.slot, props ?? undefined);
                if (instance) applySyncFields(def, update.syncs, instance);
            }
            bumpNodeVersion(sg, node);
            break;
        }

        case 'node_trait_removed': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            const traitId = resolveTraitWireRef(wireIndex, update.traitNetIndex, update.traitId);
            if (traitId === undefined) break;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (!def) {
                // remove from unresolved if present
                node._unresolvedTraits.delete(traitId);
                bumpNodeVersion(sg, node);
                break;
            }
            removeTraitBySlot(node, def.slot);
            break;
        }

        case 'node_destroyed': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            destroyNode(sg, node);
            break;
        }

        case 'node_prefab': {
            const node = getNodeById(sg, update.id);
            if (!node) break;
            setPrefab(node, decodePrefabConfig(update.prefab) ?? null);
            bumpNodeVersion(sg, node);
            break;
        }
    }
}

/* ── internal helpers ── */

/**
 * walk a node tree in parent-first (pre-order) order. in play mode prunes
 * subtrees whose effective realm isn't `'shared'`. `inheritedRealm` is the
 * effective realm of the parent (root callers pass `'shared'`); `'inherit'`
 * nodes resolve to that value. iterative, no recursion, no stack growth on
 * deep trees.
 */
function walkReplicable(node: Node, mode: RoomMode, inheritedRealm: Realm, callback: (node: Node) => void): void {
    const stack: Array<{ node: Node; inherited: Realm }> = [{ node, inherited: inheritedRealm }];
    while (stack.length > 0) {
        const { node: cur, inherited } = stack.pop()!;
        const effective = cur.realm === 'inherit' ? inherited : cur.realm;
        if (mode === 'play' && effective !== 'shared') continue;
        callback(cur);
        // push children in reverse so they pop in original order
        for (let i = cur.children.length - 1; i >= 0; i--) {
            stack.push({ node: cur.children[i], inherited: effective });
        }
    }
}

/**
 * create a node from packed data and add it to the scene graph.
 * shared between unpackSceneGraph and applySceneSyncUpdate('node_created').
 */
function applyNodeCreated(sg: Nodes, _runtime: NodesContext, pn: PackedNode, traitWireIndex: WireIndex): void {
    const parent = getNodeById(sg, pn.parentId);
    if (!parent) return;

    const node = createNode({
        name: pn.name,
        id: pn.id,
        persist: pn.persist !== false,
    });
    addChild(parent, node);
    setOwner(sg, node, pn.owner ?? null);
    setPrefab(node, decodePrefabConfig(pn.prefab) ?? null);

    // add traits
    for (const bt of pn.traits) {
        const traitId = resolveTraitWireRef(traitWireIndex, bt.netIndex, bt.id);
        if (traitId === undefined) continue;
        const def = registry.traits.byId.get(traitId)?.payload;
        if (!def) {
            console.warn(`[bongle] unresolved trait "${traitId}" on node "${pn.name ?? pn.id}" (binary) — preserving raw data`);
            node._unresolvedTraits.set(traitId, { binary: new Uint8Array(0) });
            continue;
        }
        const props = unpackFields(def, bt.fields);
        const instance = addTraitBySlot(node, def.slot, props ?? undefined);
        if (instance) applySyncFields(def, bt.syncs, instance);
    }

    // scripts ride on traits, addTraitBySlot above creates instances in the live runtime

    // move to correct index
    reorderChild(parent, node, pn.index);
}

/**
 * pack all controls of a trait instance to BinaryField entries (positional,
 * the wire `index` is the control's position in `def.controls`). used by
 * packSceneGraph for full scene serialization.
 */
function packAllControls(def: TraitDef, instance: TraitBase, node: Node): BinaryField[] {
    const codecs = getControlCodecs(def);
    if (!codecs) return [];

    const entries: BinaryField[] = [];
    for (let i = 0; i < codecs.length; i++) {
        entries.push({ index: i, data: codecs[i].pack(instance, node) });
    }
    return entries;
}

/**
 * pack all sync slices of a trait instance to BinaryField entries (positional,
 * the wire `index` is the sync's position in `def.syncDefs`). seeds initial
 * replicated state on the receiver so 'dirty'-rate syncs reach the client at
 * join time and non-dirty syncs are aligned with the server's snapshot.
 */
function packAllSyncs(def: TraitDef, instance: TraitBase, node: Node): BinaryField[] {
    const codecs = getSyncCodecs(def);
    if (!codecs) return [];

    const entries: BinaryField[] = [];
    for (let i = 0; i < codecs.length; i++) {
        entries.push({ index: i, data: codecs[i].pack(instance, node) });
    }
    return entries;
}

/**
 * unpack BinaryField entries into a props object keyed by control id.
 * returns null if there are no fields to unpack.
 */
function unpackFields(def: TraitDef, fields: BinaryField[]): Record<string, unknown> | null {
    if (fields.length === 0) return null;

    const codecs = getControlCodecs(def);
    if (!codecs) return null;

    const props: Record<string, unknown> = {};
    for (const entry of fields) {
        const i = entry.index;
        const codec = codecs[i];
        const reg = def.controls[i];
        if (!codec || !reg) continue;
        try {
            props[reg.controlId] = codec.unpack(entry.data);
        } catch (e) {
            console.error(`[bongle] failed to unpack control '${def.id}.${reg.controlId}':`, e);
        }
    }
    return Object.keys(props).length > 0 ? props : null;
}

/**
 * apply control-shaped BinaryField entries to a trait instance.
 * used for full-state events (node_trait_added) where each entry is a
 * single control value indexed by control position.
 */
function applyControlFields(def: TraitDef, fields: BinaryField[], instance: TraitBase): void {
    const codecs = getControlCodecs(def);
    if (!codecs) return;

    for (const entry of fields) {
        const codec = codecs[entry.index];
        if (!codec) continue;
        codec.apply(entry.data, instance);
    }
}

/**
 * apply sync-shaped BinaryField entries to a trait instance.
 * used for incremental sync updates (node_trait_fields) where each entry
 * is a sync slice indexed by sync position.
 */
function applySyncFields(def: TraitDef, fields: BinaryField[], instance: TraitBase): void {
    const codecs = getSyncCodecs(def);
    if (!codecs) return;

    for (const entry of fields) {
        const codec = codecs[entry.index];
        if (!codec) continue;
        codec.apply(entry.data, instance);
    }
}
