import { type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import {
    getVisualWorldMatrix,
    getVisualWorldPosition,
    getWorldPosition,
    TransformTrait,
    worldToLocalPosition,
} from '../builtins/transform';
import { registry } from '../core/registry';
import { setAtPath } from '../core/scene/prop/path';
import { findShape, type ShapeSite } from '../core/scene/prop/specs';
import {
    addChild,
    addTraitBySlot,
    bumpNodeVersion,
    bumpTraitVersion,
    createNode,
    destroyNode,
    getNodeById,
    getTrait,
    isAncestorOf,
    type Node,
    type PrefabConfig,
    type Realm,
    removeTraitBySlot,
    reorderChild,
    reparent,
    type SceneTree,
    type SerializedTrait,
    serializeNode,
    setPrefab,
} from '../core/scene/scene-tree';
import type { ScriptContext } from '../core/scene/scripts';
import { send } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { controlsById } from '../core/scene/traits';
import { rotateVoxelsByQuat } from '../core/voxels/voxel-rotate';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, getBlock, type Voxels } from '../core/voxels/voxels';
import type { VoxelOp } from './blueprint';
import {
    AddTraitCommand,
    CreateNodeCommand,
    DestroyNodeCommand,
    RemoveTraitCommand,
    ReorderCommand,
    ReparentCommand,
    SetNameCommand,
    SetNodePersistCommand,
    SetPrefabCommand,
    SetRealmCommand,
    SetTraitCommand,
} from './commands';
import type { EditRoomState, ElevationMode } from './edit-room-store';
import { useEditor } from './editor-store';
import { type Mask, testMask } from './scene/mask';
import { type Pattern, samplePattern } from './scene/pattern';
import { playBulkEdit } from './sounds';
import { runSmooth } from './tools/smooth';
import { commitVoxelOps } from './voxel-edit';

const OPS_PER_PACKET = 4096;

function sendVoxelOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        commitVoxelOps(ctx, ops.slice(i, i + OPS_PER_PACKET));
    }
}

/** empty string when the slot is empty or holds a non-block; the sampler falls back to air, mirroring `build` with an empty hand. */
function activeBlockKey(state: EditRoomState): string {
    const slot = useEditor.getState().hotbar[state.activeSlotIndex];
    return slot && slot.kind === 'block' ? slot.blockKey : '';
}

function resolveFill(
    voxels: Voxels,
    selection: Selection.Selection,
    pattern: Pattern,
    mask: Mask | undefined,
    active: string,
): { forward: VoxelOp[]; reverse: VoxelOp[] } {
    const rng = Math.random;
    const forward: VoxelOp[] = [];
    const reverse: VoxelOp[] = [];
    Selection.forEach(selection, (wx, wy, wz) => {
        if (mask && !testMask(mask, voxels, wx, wy, wz, rng)) return;
        const newKey = samplePattern(pattern, voxels, wx, wy, wz, active, rng);
        const oldKey = getBlock(voxels, wx, wy, wz);
        if (oldKey === newKey) return;
        forward.push({ wx, wy, wz, key: newKey });
        reverse.push({ wx, wy, wz, key: oldKey });
    });
    return { forward, reverse };
}

export function fill(state: EditRoomState, ctx: ScriptContext, pattern: Pattern, mask?: Mask): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    const { forward, reverse } = resolveFill(ctx.voxels, sel, pattern, mask, activeBlockKey(state));
    if (forward.length === 0) {
        state.clearVoxelSelection();
        return 0;
    }

    state.action({
        label: 'fill',
        do() {
            sendVoxelOps(ctx, forward);
            playBulkEdit(ctx, forward, reverse);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
            playBulkEdit(ctx, reverse, forward);
        },
    });
    state.clearVoxelSelection();
    return forward.length;
}

export function del(state: EditRoomState, ctx: ScriptContext): void {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return;

    const hasVoxels = sel.chunks.size > 0 && Selection.countVoxels(sel) > 0;
    const hasNodes = sel.nodes.size > 0;
    if (!hasVoxels && !hasNodes) return;

    let forwardVoxelOps: VoxelOp[] | null = null;
    let reverseVoxelOps: VoxelOp[] | null = null;
    if (hasVoxels) {
        forwardVoxelOps = [];
        reverseVoxelOps = [];
        Selection.forEach(sel, (wx, wy, wz) => {
            const oldKey = getBlock(ctx.voxels, wx, wy, wz);
            if (oldKey === BLOCK_AIR) return;
            forwardVoxelOps!.push({ wx, wy, wz, key: BLOCK_AIR });
            reverseVoxelOps!.push({ wx, wy, wz, key: oldKey });
        });
        if (forwardVoxelOps.length === 0) {
            forwardVoxelOps = null;
            reverseVoxelOps = null;
        }
    }

    let nodeCreateArgs: ReturnType<typeof captureSubtreeAsCreateArgs>[] | null = null;
    let nodeIds: number[] | null = null;
    if (hasNodes) {
        nodeIds = [];
        nodeCreateArgs = [];
        for (const nodeId of sel.nodes) {
            const node = getNodeById(ctx.scene, nodeId);
            if (!node?.parent) continue;
            nodeIds.push(nodeId);
            nodeCreateArgs.push(captureSubtreeAsCreateArgs(node));
        }
    }

    const hasVoxelOps = forwardVoxelOps !== null;
    const hasNodeOps = (nodeIds?.length ?? 0) > 0;
    if (!hasVoxelOps && !hasNodeOps) {
        state.clearVoxelSelection();
        return;
    }
    const label = hasVoxelOps && hasNodeOps ? 'delete selection' : hasVoxelOps ? 'delete voxels' : 'delete nodes';

    state.action({
        label,
        do() {
            if (forwardVoxelOps) sendVoxelOps(ctx, forwardVoxelOps);
            if (forwardVoxelOps && reverseVoxelOps) playBulkEdit(ctx, forwardVoxelOps, reverseVoxelOps);
            if (nodeIds) {
                for (const nid of nodeIds) {
                    const n = getNodeById(ctx.scene, nid);
                    if (!n) continue;
                    destroyNode(ctx.scene, n);
                    send(ctx, DestroyNodeCommand, { id: nid });
                }
            }
        },
        undo() {
            if (reverseVoxelOps) sendVoxelOps(ctx, reverseVoxelOps);
            if (forwardVoxelOps && reverseVoxelOps) playBulkEdit(ctx, reverseVoxelOps, forwardVoxelOps);
            if (nodeCreateArgs) {
                for (const createArgs of nodeCreateArgs) {
                    for (const args of createArgs) {
                        const parent = getNodeById(ctx.scene, args.parentId);
                        if (!parent) continue;
                        const n = createNode({ id: args.id, name: args.name, persist: args.persist });
                        addChild(parent, n);
                        for (const st of args.traits) {
                            const handle = registry.traits.handles.get(st.id);
                            if (handle) addTraitBySlot(n, handle.slot, st.controls as Record<string, unknown>);
                        }
                        reorderChild(parent, n, args.index);
                        send(ctx, CreateNodeCommand, {
                            id: args.id,
                            parentId: args.parentId,
                            index: args.index,
                            name: args.name,
                            persist: args.persist,
                            traits: JSON.stringify(args.traits),
                            children: undefined,
                            prefab: args.prefab ? JSON.stringify(args.prefab) : undefined,
                        });
                    }
                }
            }
        },
    });
    state.clearVoxelSelection();
}

export function pickBlock(state: EditRoomState, ctx: ScriptContext): void {
    let wx: number | undefined;
    let wy: number | undefined;
    let wz: number | undefined;

    if (state.hoverVoxel) {
        [wx, wy, wz] = state.hoverVoxel;
    } else {
        Selection.forEach(state.selection, (x, y, z) => {
            if (wx === undefined) {
                wx = x;
                wy = y;
                wz = z;
            }
        });
    }

    if (wx === undefined || wy === undefined || wz === undefined) return;

    const key = getBlock(ctx.voxels, wx, wy, wz);
    if (key === BLOCK_AIR) return;

    const { activeSlotIndex } = state;
    useEditor.getState().setHotbarSlot(activeSlotIndex, { kind: 'block', blockKey: key });
}

/** mirrors WorldEdit's //overlay; the overlay row may sit one block outside the selection AABB. */
export function overlay(state: EditRoomState, ctx: ScriptContext, pattern: Pattern): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    const rng = Math.random;
    const active = activeBlockKey(state);
    const forward: VoxelOp[] = [];
    const reverse: VoxelOp[] = [];
    Selection.forEach(sel, (wx, wy, wz) => {
        const here = getBlock(ctx.voxels, wx, wy, wz);
        if (here === BLOCK_AIR) return;
        const aboveOld = getBlock(ctx.voxels, wx, wy + 1, wz);
        if (aboveOld !== BLOCK_AIR) return;
        const newKey = samplePattern(pattern, ctx.voxels, wx, wy + 1, wz, active, rng);
        if (newKey === BLOCK_AIR) return;
        forward.push({ wx, wy: wy + 1, wz, key: newKey });
        reverse.push({ wx, wy: wy + 1, wz, key: aboveOld });
    });
    if (forward.length === 0) {
        state.clearVoxelSelection();
        return 0;
    }

    state.action({
        label: 'overlay',
        do() {
            sendVoxelOps(ctx, forward);
            playBulkEdit(ctx, forward, reverse);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
            playBulkEdit(ctx, reverse, forward);
        },
    });
    state.clearVoxelSelection();
    return forward.length;
}

/** worldedit-style `//walls`: paints voxels whose +-x or +-z neighbour falls outside the
 *  selection. vertical neighbours don't count, so only the 4 vertical sides are touched. */
export function walls(state: EditRoomState, ctx: ScriptContext, pattern: Pattern): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    const rng = Math.random;
    const active = activeBlockKey(state);
    const forward: VoxelOp[] = [];
    const reverse: VoxelOp[] = [];
    Selection.forEach(sel, (wx, wy, wz) => {
        const isWall =
            !Selection.has(sel, wx + 1, wy, wz) ||
            !Selection.has(sel, wx - 1, wy, wz) ||
            !Selection.has(sel, wx, wy, wz + 1) ||
            !Selection.has(sel, wx, wy, wz - 1);
        if (!isWall) return;
        const newKey = samplePattern(pattern, ctx.voxels, wx, wy, wz, active, rng);
        const oldKey = getBlock(ctx.voxels, wx, wy, wz);
        if (oldKey === newKey) return;
        forward.push({ wx, wy, wz, key: newKey });
        reverse.push({ wx, wy, wz, key: oldKey });
    });
    if (forward.length === 0) return 0;

    state.action({
        label: 'walls',
        do() {
            sendVoxelOps(ctx, forward);
            playBulkEdit(ctx, forward, reverse);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
            playBulkEdit(ctx, reverse, forward);
        },
    });
    return forward.length;
}

/** raises/lowers/flattens each (x,z) column's topmost non-air block by `amount`, clamped to the
 *  column's selection-y band. flatten target defaults to the average of column tops. no falloff
 *  or image (those are brush-only). leaves the selection intact. */
export function elevateSelection(
    state: EditRoomState,
    ctx: ScriptContext,
    mode: ElevationMode,
    amount: number,
    targetY?: number,
): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    type Range = { yLo: number; yHi: number };
    const ranges = new Map<string, Range>();
    Selection.forEach(sel, (wx, wy, wz) => {
        const k = `${wx},${wz}`;
        const r = ranges.get(k);
        if (!r) ranges.set(k, { yLo: wy, yHi: wy });
        else {
            if (wy < r.yLo) r.yLo = wy;
            if (wy > r.yHi) r.yHi = wy;
        }
    });

    type ColInfo = { wx: number; wz: number; yLo: number; yHi: number; oldH: number; oldKey: string };
    const cols: ColInfo[] = [];
    let sumH = 0;
    for (const [k, r] of ranges) {
        const sep = k.indexOf(',');
        const wx = Number(k.slice(0, sep));
        const wz = Number(k.slice(sep + 1));
        let oldH = -1;
        let oldKey = BLOCK_AIR;
        for (let y = r.yHi; y >= r.yLo; y--) {
            const key = getBlock(ctx.voxels, wx, y, wz);
            if (key !== BLOCK_AIR) {
                oldH = y;
                oldKey = key;
                break;
            }
        }
        if (oldH === -1) continue;
        cols.push({ wx, wz, yLo: r.yLo, yHi: r.yHi, oldH, oldKey });
        sumH += oldH;
    }
    if (cols.length === 0) return 0;

    const blocks = Math.max(1, Math.floor(amount));
    const flattenTarget = targetY !== undefined ? Math.floor(targetY) : Math.round(sumH / cols.length);

    const forward: VoxelOp[] = [];
    const reverse: VoxelOp[] = [];
    for (const col of cols) {
        const { wx, wz, yLo, yHi, oldH, oldKey } = col;
        if (mode === 'raise') {
            const targetH = Math.min(yHi, oldH + blocks);
            for (let y = oldH + 1; y <= targetH; y++) {
                const cur = getBlock(ctx.voxels, wx, y, wz);
                if (cur === oldKey) continue;
                forward.push({ wx, wy: y, wz, key: oldKey });
                reverse.push({ wx, wy: y, wz, key: cur });
            }
        } else if (mode === 'lower') {
            const targetH = Math.max(yLo, oldH - blocks);
            for (let y = oldH; y > targetH; y--) {
                const cur = getBlock(ctx.voxels, wx, y, wz);
                if (cur === BLOCK_AIR) continue;
                forward.push({ wx, wy: y, wz, key: BLOCK_AIR });
                reverse.push({ wx, wy: y, wz, key: cur });
            }
        } else {
            const dir = Math.sign(flattenTarget - oldH);
            if (dir === 0) continue;
            if (dir > 0) {
                const targetH = Math.min(yHi, Math.min(flattenTarget, oldH + blocks));
                for (let y = oldH + 1; y <= targetH; y++) {
                    const cur = getBlock(ctx.voxels, wx, y, wz);
                    if (cur === oldKey) continue;
                    forward.push({ wx, wy: y, wz, key: oldKey });
                    reverse.push({ wx, wy: y, wz, key: cur });
                }
            } else {
                const targetH = Math.max(yLo, Math.max(flattenTarget, oldH - blocks));
                for (let y = oldH; y > targetH; y--) {
                    const cur = getBlock(ctx.voxels, wx, y, wz);
                    if (cur === BLOCK_AIR) continue;
                    forward.push({ wx, wy: y, wz, key: BLOCK_AIR });
                    reverse.push({ wx, wy: y, wz, key: cur });
                }
            }
        }
    }
    if (forward.length === 0) return 0;

    state.action({
        label: 'elevation',
        do() {
            sendVoxelOps(ctx, forward);
            playBulkEdit(ctx, forward, reverse);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
            playBulkEdit(ctx, reverse, forward);
        },
    });
    return forward.length;
}

/** worldedit-style `//smooth`. unlike //fill/replace, leaves the selection intact so you can iterate. */
export function smoothSelection(state: EditRoomState, ctx: ScriptContext, iterations: number, heightmapMask?: Mask): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    const { forward, reverse } = runSmooth(ctx.voxels, sel, iterations, heightmapMask ?? null);
    if (forward.length === 0) return 0;

    state.action({
        label: 'smooth',
        do() {
            sendVoxelOps(ctx, forward);
            playBulkEdit(ctx, forward, reverse);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
            playBulkEdit(ctx, reverse, forward);
        },
    });
    return forward.length;
}

export function replace(state: EditRoomState, ctx: ScriptContext, pattern: Pattern, from?: Mask): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    const mask: Mask = from ?? { kind: 'existing' };
    const { forward, reverse } = resolveFill(ctx.voxels, sel, pattern, mask, activeBlockKey(state));
    if (forward.length === 0) {
        state.clearVoxelSelection();
        return 0;
    }

    state.action({
        label: 'replace',
        do() {
            sendVoxelOps(ctx, forward);
            playBulkEdit(ctx, forward, reverse);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
            playBulkEdit(ctx, reverse, forward);
        },
    });
    state.clearVoxelSelection();
    return forward.length;
}

export function createNodeAction(ctx: ScriptContext, parentId: number, index: number, name?: string): void {
    send(ctx, CreateNodeCommand, {
        id: ctx.scene.nextServerId,
        parentId,
        index,
        name,
        persist: undefined,
        traits: JSON.stringify([]),
        children: undefined,
        prefab: undefined,
    });
}

/** returns the id the node lands with, allocated up front the way placement does. */
export function createNodeAtAction(ctx: ScriptContext, position: Vec3, name = 'New Node'): number {
    const scene = ctx.scene;
    const id = scene.nextServerId++;
    send(ctx, CreateNodeCommand, {
        id,
        parentId: scene.root.id,
        index: scene.root.children.length,
        name,
        persist: undefined,
        traits: JSON.stringify([
            { id: 'transform', controls: { position: [...position], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } },
        ]),
        children: undefined,
        prefab: undefined,
    });
    return id;
}

export function destroyNodeAction(state: EditRoomState, ctx: ScriptContext, nodeId: number): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node?.parent) return;

    const createArgs = captureSubtreeAsCreateArgs(node);

    state.action({
        label: 'delete node',
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            destroyNode(ctx.scene, n);
            send(ctx, DestroyNodeCommand, { id: nodeId });
        },
        undo() {
            for (const args of createArgs) {
                const parent = getNodeById(ctx.scene, args.parentId);
                if (!parent) continue;
                const n = createNode({ id: args.id, name: args.name, persist: args.persist });
                addChild(parent, n);
                for (const st of args.traits) {
                    const handle = registry.traits.handles.get(st.id);
                    if (handle) addTraitBySlot(n, handle.slot, st.controls as Record<string, unknown>);
                }
                reorderChild(parent, n, args.index);
                send(ctx, CreateNodeCommand, {
                    id: args.id,
                    parentId: args.parentId,
                    index: args.index,
                    name: args.name,
                    persist: args.persist,
                    traits: JSON.stringify(args.traits),
                    children: undefined,
                    prefab: args.prefab ? JSON.stringify(args.prefab) : undefined,
                });
            }
        },
    });
}

export function destroyNodesAction(state: EditRoomState, ctx: ScriptContext, nodeIds: Iterable<number>): void {
    const ids: number[] = [];
    const createArgs: ReturnType<typeof captureSubtreeAsCreateArgs>[] = [];
    for (const id of nodeIds) {
        const node = getNodeById(ctx.scene, id);
        if (!node?.parent) continue;
        ids.push(id);
        createArgs.push(captureSubtreeAsCreateArgs(node));
    }
    if (ids.length === 0) return;

    state.action({
        label: ids.length === 1 ? 'delete node' : `delete ${ids.length} nodes`,
        do() {
            for (const id of ids) {
                const n = getNodeById(ctx.scene, id);
                if (!n) continue;
                destroyNode(ctx.scene, n);
                send(ctx, DestroyNodeCommand, { id });
            }
        },
        undo() {
            for (const args of createArgs) {
                for (const a of args) {
                    const parent = getNodeById(ctx.scene, a.parentId);
                    if (!parent) continue;
                    const n = createNode({ id: a.id, name: a.name, persist: a.persist });
                    addChild(parent, n);
                    for (const st of a.traits) {
                        const handle = registry.traits.handles.get(st.id);
                        if (handle) addTraitBySlot(n, handle.slot, st.controls as Record<string, unknown>);
                    }
                    reorderChild(parent, n, a.index);
                    send(ctx, CreateNodeCommand, {
                        id: a.id,
                        parentId: a.parentId,
                        index: a.index,
                        name: a.name,
                        persist: a.persist,
                        traits: JSON.stringify(a.traits),
                        children: undefined,
                        prefab: a.prefab ? JSON.stringify(a.prefab) : undefined,
                    });
                }
            }
        },
    });
}

export function setNameAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, name: string | undefined): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return;

    const prevName = node.name;

    state.action({
        label: name ? `rename → "${name}"` : 'clear name',
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            n.name = name;
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetNameCommand, { id: nodeId, name: name ?? null });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            n.name = prevName;
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetNameCommand, { id: nodeId, name: prevName ?? null });
        },
    });
}

export function setRealmAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, realm: Realm): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return;

    const prevRealm = node.realm;
    if (prevRealm === realm) return;

    state.action({
        label: `realm → ${realm}`,
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            n.realm = realm;
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetRealmCommand, { id: nodeId, realm });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            n.realm = prevRealm;
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetRealmCommand, { id: nodeId, realm: prevRealm });
        },
    });
}

export function reparentAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, parentId: number, index: number): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node?.parent) return;
    const newParent = getNodeById(ctx.scene, parentId);
    if (!newParent) return;
    if (node === newParent || isAncestorOf(node, newParent)) return;

    const prevParentId = node.parent.id;
    const prevIndex = Math.max(0, node.parent.children.indexOf(node));

    state.action({
        label: 'reparent',
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            const np = getNodeById(ctx.scene, parentId);
            if (!n || !np) return;
            reparent(n, np);
            reorderChild(np, n, index);
            bumpNodeVersion(ctx.scene, n);
            send(ctx, ReparentCommand, { id: nodeId, parentId, index });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            const pp = getNodeById(ctx.scene, prevParentId);
            if (!n || !pp) return;
            reparent(n, pp);
            reorderChild(pp, n, prevIndex);
            bumpNodeVersion(ctx.scene, n);
            send(ctx, ReparentCommand, { id: nodeId, parentId: prevParentId, index: prevIndex });
        },
    });
}

export function reorderAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, index: number): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node?.parent) return;

    const prevIndex = Math.max(0, node.parent.children.indexOf(node));

    state.action({
        label: 'reorder',
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n?.parent) return;
            reorderChild(n.parent, n, index);
            bumpNodeVersion(ctx.scene, n);
            send(ctx, ReorderCommand, { id: nodeId, index });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n?.parent) return;
            reorderChild(n.parent, n, prevIndex);
            bumpNodeVersion(ctx.scene, n);
            send(ctx, ReorderCommand, { id: nodeId, index: prevIndex });
        },
    });
}

export function setTraitAction(
    state: EditRoomState,
    ctx: ScriptContext,
    nodeId: number,
    traitId: string,
    props: Record<string, unknown>,
): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return;

    const prevProps = captureTraitProps(node, traitId);

    state.action({
        label: `set ${traitId}`,
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            setTraitProps(ctx.scene, n, traitId, props);
            send(ctx, SetTraitCommand, { id: nodeId, traitId, props: JSON.stringify(props) });
        },
        undo() {
            if (!prevProps) return;
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            setTraitProps(ctx.scene, n, traitId, prevProps);
            send(ctx, SetTraitCommand, { id: nodeId, traitId, props: JSON.stringify(prevProps) });
        },
    });
}

export function addTraitAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, traitId: string): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return;

    state.action({
        label: `add ${traitId}`,
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            const handle = registry.traits.handles.get(traitId);
            if (handle) addTraitBySlot(n, handle.slot);
            send(ctx, AddTraitCommand, { id: nodeId, traitId, props: undefined });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            const handle = registry.traits.handles.get(traitId);
            if (handle) removeTraitBySlot(n, handle.slot);
            send(ctx, RemoveTraitCommand, { id: nodeId, traitId });
        },
    });
}

export function removeTraitAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, traitId: string): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return;

    const prevProps = captureTraitProps(node, traitId);

    state.action({
        label: `remove ${traitId}`,
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            const handle = registry.traits.handles.get(traitId);
            if (handle) removeTraitBySlot(n, handle.slot);
            else n.unresolved?.delete(traitId);
            send(ctx, RemoveTraitCommand, { id: nodeId, traitId });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            const handle = registry.traits.handles.get(traitId);
            if (handle) addTraitBySlot(n, handle.slot, prevProps ?? undefined);
            send(ctx, AddTraitCommand, { id: nodeId, traitId, props: prevProps ? JSON.stringify(prevProps) : undefined });
        },
    });
}

type CreateArgs = {
    id: number;
    parentId: number;
    index: number;
    name: string | undefined;
    persist: boolean | undefined;
    traits: SerializedTrait[];
    prefab: PrefabConfig | undefined;
};

function captureSubtreeAsCreateArgs(node: Node): CreateArgs[] {
    const result: CreateArgs[] = [];
    captureNode(node, result);
    return result;
}

function captureNode(node: Node, out: CreateArgs[]): void {
    if (!node.parent) return;
    const serialized = serializeNode(node);
    out.push({
        id: node.id,
        parentId: node.parent.id,
        index: Math.max(0, node.parent.children.indexOf(node)),
        name: node.name,
        persist: node.persist ? undefined : false,
        traits: serialized.traits,
        prefab: node.prefab ? structuredClone(node.prefab) : undefined,
    });
    for (const child of node.children) captureNode(child, out);
}

function captureTraitProps(node: Node, traitId: string): Record<string, unknown> | null {
    const handle = registry.traits.handles.get(traitId);
    if (!handle) {
        const controls = node.unresolved?.get(traitId);
        return controls ? structuredClone(controls) : null;
    }
    const instance = node.traits[handle.slot];
    if (!instance) return null;
    // clone, captured props are retained on the action's closure for undo;
    // sharing references with the live trait would let runtime mutations
    // (or a subsequent re-add) corrupt the snapshot.
    const props: Record<string, unknown> = {};
    for (const reg of handle.def.controls) {
        const value = reg.get(instance);
        props[reg.controlId] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
    }
    return props;
}

export function setTraitProps(sceneTree: SceneTree, node: Node, traitId: string, props: Record<string, unknown>): void {
    const handle = registry.traits.handles.get(traitId);
    if (!handle) {
        // the map entry IS the controls, so merging means replacing it. `has` rather than a
        // truthy `get`: an entry can legitimately be `undefined` (id known, payload not).
        const unresolved = node.unresolved;
        if (unresolved?.has(traitId)) unresolved.set(traitId, { ...unresolved.get(traitId), ...props });
        bumpNodeVersion(sceneTree, node);
        return;
    }
    const instance = node.traits[handle.slot];
    if (!instance) return;
    for (const key of Object.keys(props)) {
        const ci = controlsById(handle).get(key);
        if (!ci) continue;
        ci.reg.set(instance, props[key]);
    }
    bumpTraitVersion(sceneTree, node, handle.slot);
    bumpNodeVersion(sceneTree, node);
}

export type PendingShapeFit = { nodeId: number; bounds: Selection.Bounds; framesLeft: number };
const PENDING_FIT_FRAMES = 600;

/** the first shape-annotated control on any of the node's traits. */
export function findNodeShape(node: Node): { traitId: string; controlId: string; value: unknown; site: ShapeSite } | null {
    for (let slot = 0; slot < node.traits.length; slot++) {
        const instance = node.traits[slot];
        const handle = registry.slotToTrait[slot];
        if (!instance || !handle) continue;
        for (const reg of handle.def.controls) {
            const value = reg.get(instance);
            const site = findShape(reg.schema, value);
            if (site) return { traitId: handle.def.id, controlId: reg.controlId, value, site };
        }
    }
    return null;
}

function boundsCenter(bounds: Selection.Bounds): Vec3 {
    return [
        (bounds.min[0] + bounds.max[0] + 1) / 2,
        (bounds.min[1] + bounds.max[1] + 1) / 2,
        (bounds.min[2] + bounds.max[2] + 1) / 2,
    ];
}

const _fitFrame: Mat4 = mat4.create();
const _fitShapeFrame: Mat4 = mat4.create();
const _fitInverse: Mat4 = mat4.create();
const _fitRotation: Quat = [0, 0, 0, 1];
const _fitInverseRotation: Quat = [0, 0, 0, 1];
const _fitCorner: Vec3 = [0, 0, 0];
const IDENTITY: Mat4 = mat4.create();

// half extents of the bounds seen in the shape frame's rotation about `centre`: an axis-aligned selection under a
// rotated frame is enclosed, not matched.
function halfExtentsInFrame(bounds: Selection.Bounds, centre: Vec3, shapeFrame: Mat4): Vec3 {
    mat4.getRotation(_fitRotation, shapeFrame);
    quat.invert(_fitInverseRotation, _fitRotation);
    const half: Vec3 = [0, 0, 0];
    for (const sx of [0, 1]) {
        for (const sy of [0, 1]) {
            for (const sz of [0, 1]) {
                vec3.set(
                    _fitCorner,
                    (sx ? bounds.max[0] + 1 : bounds.min[0]) - centre[0],
                    (sy ? bounds.max[1] + 1 : bounds.min[1]) - centre[1],
                    (sz ? bounds.max[2] + 1 : bounds.min[2]) - centre[2],
                );
                vec3.transformQuat(_fitCorner, _fitCorner, _fitInverseRotation);
                half[0] = Math.max(half[0], Math.abs(_fitCorner[0]));
                half[1] = Math.max(half[1], Math.abs(_fitCorner[1]));
                half[2] = Math.max(half[2], Math.abs(_fitCorner[2]));
            }
        }
    }
    return half;
}

/**
 * moves the node's first shape onto the bounds and sizes it to them: a shape with a centre takes the centre itself,
 * otherwise the node moves; the extents are read in the shape's own frame. false when the node has no fittable shape.
 */
export function fitShapeToBoundsAction(
    state: EditRoomState,
    ctx: ScriptContext,
    nodeId: number,
    bounds: Selection.Bounds,
): boolean {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return false;
    const shape = findNodeShape(node);
    if (!shape) return false;
    const { spec, local, space } = shape.site;
    if (spec.kind === 'segment') return false;
    const transform = getTrait(node, TransformTrait);
    if (space === 'local' && !transform) return false;
    if (space === 'world' && !spec.center) return false;

    const nodeWorld = space === 'world' || !transform ? IDENTITY : getVisualWorldMatrix(transform);
    mat4.multiply(_fitFrame, nodeWorld, shape.site.matrix);
    mat4.multiply(_fitShapeFrame, nodeWorld, shape.site.shapeMatrix);
    const centre = boundsCenter(bounds);
    const half = halfExtentsInFrame(bounds, centre, _fitShapeFrame);

    const fitted: Record<string, unknown> =
        spec.kind === 'box3'
            ? { ...local, [spec.halfExtents]: half }
            : { ...local, [spec.radius]: Math.max(half[0], half[1], half[2]) };
    let nextTransformProps: Record<string, unknown> | null = null;
    if (spec.center) {
        mat4.invert(_fitInverse, _fitFrame);
        fitted[spec.center] = vec3.transformMat4([0, 0, 0], centre, _fitInverse);
    } else {
        // the shape sits at its frame origin: shift the node by that origin's offset from the bounds centre
        const origin: Vec3 = [_fitShapeFrame[12]!, _fitShapeFrame[13]!, _fitShapeFrame[14]!];
        const nodeWorldPosition = getVisualWorldPosition(transform!);
        const target: Vec3 = [
            nodeWorldPosition[0] + centre[0] - origin[0],
            nodeWorldPosition[1] + centre[1] - origin[1],
            nodeWorldPosition[2] + centre[2] - origin[2],
        ];
        nextTransformProps = { position: worldToLocalPosition(transform!, target, [0, 0, 0]) };
    }

    const nextShapeProps = { [shape.controlId]: setAtPath(shape.value, shape.site.path, fitted) };
    const prevShapeProps = captureTraitProps(node, shape.traitId);
    const prevTransformProps = nextTransformProps ? captureTraitProps(node, 'transform') : null;

    const write = (shapeProps: Record<string, unknown> | null, transformProps: Record<string, unknown> | null) => {
        const n = getNodeById(ctx.scene, nodeId);
        if (!n) return;
        if (shapeProps) {
            setTraitProps(ctx.scene, n, shape.traitId, shapeProps);
            send(ctx, SetTraitCommand, { id: nodeId, traitId: shape.traitId, props: JSON.stringify(shapeProps) });
        }
        if (transformProps) {
            setTraitProps(ctx.scene, n, 'transform', transformProps);
            send(ctx, SetTraitCommand, { id: nodeId, traitId: 'transform', props: JSON.stringify(transformProps) });
        }
    };
    state.action({
        label: 'fit to selection',
        do: () => write(nextShapeProps, nextTransformProps),
        undo: () => write(prevShapeProps, prevTransformProps),
    });
    return true;
}

/** a prefab node at the selection's centre; its shape is fitted once the node lands from the server. */
export function createFromSelectionAction(
    state: EditRoomState,
    ctx: ScriptContext,
    prefabId: string,
    bounds: Selection.Bounds,
): void {
    const def = registry.prefabs.byId.get(prefabId);
    if (!def) return;
    const scene = ctx.scene;
    const id = scene.nextServerId++;
    const prefab: PrefabConfig = { prefabId, args: def.args ? structuredClone(def.args.default) : {} };
    const center = boundsCenter(bounds);
    state.action({
        label: `create ${prefabId} from selection`,
        do() {
            send(ctx, CreateNodeCommand, {
                id,
                parentId: scene.root.id,
                index: scene.root.children.length,
                name: prefabId,
                persist: true,
                traits: JSON.stringify([
                    { id: 'transform', controls: { position: center, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } },
                ]),
                children: JSON.stringify([]),
                prefab: JSON.stringify(prefab),
            });
        },
        undo() {
            send(ctx, DestroyNodeCommand, { id });
        },
    });
    state.pendingShapeFits.push({ nodeId: id, bounds, framesLeft: PENDING_FIT_FRAMES });
}

/** once per frame: fits shapes on nodes created from a selection as soon as they exist with a fittable trait. */
export function drainPendingShapeFits(state: EditRoomState, ctx: ScriptContext): void {
    const pending = state.pendingShapeFits;
    for (let i = pending.length - 1; i >= 0; i--) {
        const fit = pending[i]!;
        const node = getNodeById(ctx.scene, fit.nodeId);
        const done =
            node !== undefined && findNodeShape(node) !== null && fitShapeToBoundsAction(state, ctx, fit.nodeId, fit.bounds);
        if (done || --fit.framesLeft <= 0) pending.splice(i, 1);
    }
}

// voxels whose centre lies inside the node's shape; rotation and scale are ignored, the shape is placed at the node's world position.
export function selectInsideShape(ctx: ScriptContext, nodeId: number): Selection.Selection | null {
    const node = getNodeById(ctx.scene, nodeId);
    const transform = node ? getTrait(node, TransformTrait) : null;
    if (!node || !transform) return null;
    const shape = findNodeShape(node);
    if (!shape) return null;
    const { spec, local } = shape.site;
    const origin: Vec3 = shape.site.space === 'world' ? [0, 0, 0] : getWorldPosition(transform);
    const selection = Selection.create();
    if (spec.kind === 'box3') {
        const half = local[spec.halfExtents] as Vec3;
        const center = spec.center ? ((local[spec.center] as Vec3 | undefined) ?? [0, 0, 0]) : [0, 0, 0];
        const cx = origin[0] + center[0];
        const cy = origin[1] + center[1];
        const cz = origin[2] + center[2];
        Selection.setAABB(
            selection,
            Math.ceil(cx - half[0] - 0.5),
            Math.ceil(cy - half[1] - 0.5),
            Math.ceil(cz - half[2] - 0.5),
            Math.floor(cx + half[0] - 0.5),
            Math.floor(cy + half[1] - 0.5),
            Math.floor(cz + half[2] - 0.5),
        );
        return selection;
    }
    if (spec.kind === 'sphere') {
        const radius = local[spec.radius] as number;
        const center = spec.center ? (local[spec.center] as Vec3) : [0, 0, 0];
        const cx = origin[0] + center[0];
        const cy = origin[1] + center[1];
        const cz = origin[2] + center[2];
        const r2 = radius * radius;
        for (let wx = Math.ceil(cx - radius - 0.5); wx <= Math.floor(cx + radius - 0.5); wx++) {
            for (let wy = Math.ceil(cy - radius - 0.5); wy <= Math.floor(cy + radius - 0.5); wy++) {
                for (let wz = Math.ceil(cz - radius - 0.5); wz <= Math.floor(cz + radius - 0.5); wz++) {
                    const ex = wx + 0.5 - cx;
                    const ey = wy + 0.5 - cy;
                    const ez = wz + 0.5 - cz;
                    if (ex * ex + ey * ey + ez * ez <= r2) Selection.set(selection, wx, wy, wz);
                }
            }
        }
        return selection;
    }
    return null;
}

export function setPrefabAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, config: PrefabConfig): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node) return;

    const prevPrefab = node.prefab ? { ...node.prefab } : null;

    state.action({
        label: `set prefab → ${config.prefabId}`,
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            setPrefab(n, { ...config });
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: JSON.stringify(config) });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            setPrefab(n, prevPrefab ? { ...prevPrefab } : null);
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: prevPrefab ? JSON.stringify(prevPrefab) : undefined });
        },
    });
}

export function clearPrefabAction(state: EditRoomState, ctx: ScriptContext, nodeId: number): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node?.prefab) return;

    const prevPrefab = { ...node.prefab };

    state.action({
        label: 'clear prefab',
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            setPrefab(n, null);
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: undefined });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            setPrefab(n, { ...prevPrefab });
            bumpNodeVersion(ctx.scene, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: JSON.stringify(prevPrefab) });
        },
    });
}

/**
 * concretizes a prefab wrapper: stamps its current voxel content into the world, promotes its
 * non-persistent prefab-emitted children to persist:true so they survive the prefab clear, and
 * strips `node.prefab`. voxel ops are snapshotted at action-creation time; child id lookups
 * happen lazily inside do/undo so redo (after the reconciler recreates children with fresh ids)
 * still targets the right nodes.
 */
export function bakePrefabAction(state: EditRoomState, ctx: ScriptContext, nodeId: number): void {
    const node = getNodeById(ctx.scene, nodeId);
    if (!node?.prefab) return;

    const prevPrefab = { ...node.prefab };

    // re-creates the same world stamp the play-mode reconciler does.
    const forwardOps: VoxelOp[] = [];
    const reverseOps: VoxelOp[] = [];
    const preparedVoxels = node.scene?.prefabs.state.get(node)?.voxels;
    if (preparedVoxels) {
        const t = getTrait(node, TransformTrait);
        const ox = t ? Math.round(t.position[0]) : 0;
        const oy = t ? Math.round(t.position[1]) : 0;
        const oz = t ? Math.round(t.position[2]) : 0;
        const q: Quat = t ? [t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]] : [0, 0, 0, 1];

        const rotated = rotateVoxelsByQuat(preparedVoxels, q, ctx.blocks);
        for (const chunk of rotated.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;
                        const wx = chunk.wx + lx + ox;
                        const wy = chunk.wy + ly + oy;
                        const wz = chunk.wz + lz + oz;
                        forwardOps.push({ wx, wy, wz, key });
                        reverseOps.push({ wx, wy, wz, key: getBlock(ctx.voxels, wx, wy, wz) });
                    }
                }
            }
        }
    }

    state.action({
        label: `bake prefab → ${prevPrefab.prefabId}`,
        do() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            const childIds = n.children.map((c) => c.id);

            if (forwardOps.length > 0) sendVoxelOps(ctx, forwardOps);
            for (const id of childIds) {
                send(ctx, SetNodePersistCommand, { id, persist: true });
            }
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: undefined });
        },
        undo() {
            const n = getNodeById(ctx.scene, nodeId);
            if (!n) return;
            // flip children back to persist:false before restoring the prefab so the next
            // reconcile tick destroys them and re-expands the def fresh.
            const childIds = n.children.map((c) => c.id);
            for (const id of childIds) {
                send(ctx, SetNodePersistCommand, { id, persist: false });
            }
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: JSON.stringify(prevPrefab) });
            if (reverseOps.length > 0) sendVoxelOps(ctx, reverseOps);
        },
    });
}
