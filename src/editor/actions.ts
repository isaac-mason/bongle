/**
 * editor action functions, unified voxel and scene mutations.
 *
 * each function takes the per-room store api as its first arg and a
 * ScriptContext as the second (both are available inside the editor script
 * factory). applies the mutation optimistically on the client, pushes an
 * undo entry onto the room editor stack, and sends the corresponding typed
 * command to the server.
 *
 * call-sites are the store closures set up in EditorScript client onInit.
 * components call e.g. useEditRoom((s) => s.createNode)(...), they never
 * import this file directly.
 */

import type { Quat } from 'mathcat';
import { TransformTrait } from '../builtins/transform';
import { registry } from '../core/registry';
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
    type Nodes,
    type PrefabConfig,
    type Realm,
    removeTraitBySlot,
    reorderChild,
    reparent,
    type SerializedTrait,
    serializeNode,
    setPrefab,
} from '../core/scene/nodes';
import type { ScriptContext } from '../core/scene/scripts';
import { send } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
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
import { runSmooth } from './tools/smooth';
import { commitVoxelOps } from './voxel-edit';

/* ── voxel actions ── */

const OPS_PER_PACKET = 4096;

function sendVoxelOps(ctx: ScriptContext, ops: VoxelOp[]): void {
    for (let i = 0; i < ops.length; i += OPS_PER_PACKET) {
        commitVoxelOps(ctx, ops.slice(i, i + OPS_PER_PACKET));
    }
}

/** resolve the active hotbar slot's block key for `$active` pattern tokens.
 *  empty string when the slot is empty or holds a non-block, the sampler
 *  will fall back to air for that case, which mirrors how `build` behaves
 *  with an empty hand. */
function activeBlockKey(state: EditRoomState): string {
    const slot = useEditor.getState().hotbar[state.activeSlotIndex];
    return slot && slot.kind === 'block' ? slot.blockKey : '';
}

/** resolve a fill into paired forward/reverse op lists in a single pass.
 *  drops mask-rejected voxels and no-ops where new key == old key. */
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
        },
        undo() {
            sendVoxelOps(ctx, reverse);
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

    // build forward+reverse voxel ops in a single pass, skipping air cells.
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

    // snapshot nodes for undo (capture before destroying)
    let nodeCreateArgs: ReturnType<typeof captureSubtreeAsCreateArgs>[] | null = null;
    let nodeIds: number[] | null = null;
    if (hasNodes) {
        nodeIds = [];
        nodeCreateArgs = [];
        for (const nodeId of sel.nodes) {
            const node = getNodeById(ctx.nodes, nodeId);
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
            if (nodeIds) {
                for (const nid of nodeIds) {
                    const n = getNodeById(ctx.nodes, nid);
                    if (!n) continue;
                    destroyNode(ctx.nodes, n);
                    send(ctx, DestroyNodeCommand, { id: nid });
                }
            }
            state.markDirty();
        },
        undo() {
            if (reverseVoxelOps) sendVoxelOps(ctx, reverseVoxelOps);
            if (nodeCreateArgs) {
                for (const createArgs of nodeCreateArgs) {
                    for (const args of createArgs) {
                        const parent = getNodeById(ctx.nodes, args.parentId);
                        if (!parent) continue;
                        const n = createNode({ id: args.id, name: args.name, persist: args.persist });
                        addChild(parent, n);
                        for (const st of args.traits) {
                            const def = registry.traits.byId.get(st.id)?.payload;
                            if (def) addTraitBySlot(n, def.slot, st.controls as Record<string, unknown>);
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
            state.markDirty();
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

/** for each non-air voxel in the selection, set the cell directly above to
 *  `pattern`, but only when that cell is currently air. mirrors WorldEdit's
 *  //overlay. the overlay row may sit one block outside the selection AABB. */
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
        },
        undo() {
            sendVoxelOps(ctx, reverse);
        },
    });
    state.clearVoxelSelection();
    return forward.length;
}

/** worldedit-style `//walls`: paint the pattern onto every voxel in the
 *  selection whose ±x or ±z neighbour falls outside the selection. vertical
 *  neighbours don't count, so the top and bottom of the selection are left
 *  untouched, you get the 4 vertical sides only. */
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
        },
        undo() {
            sendVoxelOps(ctx, reverse);
        },
    });
    return forward.length;
}

/** axiom-style `/elevation` over the current selection. walks each (x,z)
 *  column inside the selection, finds the topmost non-air block within
 *  the column's selection-y band, then raises/lowers/flattens by
 *  `amount` blocks (clamped to the column's band). flatten target
 *  defaults to the average of column tops. no falloff or image, those
 *  are brush-only. leaves the selection intact. */
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
        },
        undo() {
            sendVoxelOps(ctx, reverse);
        },
    });
    return forward.length;
}

/** worldedit-style `//smooth` over the current selection. projects to a per-
 *  (x,z) heightmap (topmost block matching `heightmapMask`, or any non-air
 *  when null), runs `iterations` 5×5 gaussian passes, then raises/lowers
 *  each column inside its selection y band. unlike //fill/replace, leaves
 *  the selection intact so you can iterate. */
export function smoothSelection(state: EditRoomState, ctx: ScriptContext, iterations: number, heightmapMask?: Mask): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    const { forward, reverse } = runSmooth(ctx.voxels, sel, iterations, heightmapMask ?? null);
    if (forward.length === 0) return 0;

    state.action({
        label: 'smooth',
        do() {
            sendVoxelOps(ctx, forward);
        },
        undo() {
            sendVoxelOps(ctx, reverse);
        },
    });
    return forward.length;
}

export function replace(state: EditRoomState, ctx: ScriptContext, pattern: Pattern, from?: Mask): number {
    const sel = state.selection;
    if (Selection.isEmpty(sel)) return 0;

    // replace = fill restricted to non-air (or caller-supplied mask).
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
        },
        undo() {
            sendVoxelOps(ctx, reverse);
        },
    });
    state.clearVoxelSelection();
    return forward.length;
}

/* ── scene actions ── */

export function createNodeAction(state: EditRoomState, ctx: ScriptContext, parentId: number, index: number, name?: string): void {
    send(ctx, CreateNodeCommand, {
        id: ctx.nodes._nextNodeId,
        parentId,
        index,
        name,
        persist: undefined,
        traits: JSON.stringify([]),
        children: undefined,
        prefab: undefined,
    });
    state.markDirty();
}

export function destroyNodeAction(state: EditRoomState, ctx: ScriptContext, nodeId: number): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node?.parent) return;

    const createArgs = captureSubtreeAsCreateArgs(node);

    state.action({
        label: 'delete node',
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            destroyNode(ctx.nodes, n);
            send(ctx, DestroyNodeCommand, { id: nodeId });
            state.markDirty();
        },
        undo() {
            for (const args of createArgs) {
                const parent = getNodeById(ctx.nodes, args.parentId);
                if (!parent) continue;
                const n = createNode({ id: args.id, name: args.name, persist: args.persist });
                addChild(parent, n);
                for (const st of args.traits) {
                    const def = registry.traits.byId.get(st.id)?.payload;
                    if (def) addTraitBySlot(n, def.slot, st.controls as Record<string, unknown>);
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
            state.markDirty();
        },
    });
}

export function destroyNodesAction(state: EditRoomState, ctx: ScriptContext, nodeIds: Iterable<number>): void {
    const ids: number[] = [];
    const createArgs: ReturnType<typeof captureSubtreeAsCreateArgs>[] = [];
    for (const id of nodeIds) {
        const node = getNodeById(ctx.nodes, id);
        if (!node?.parent) continue;
        ids.push(id);
        createArgs.push(captureSubtreeAsCreateArgs(node));
    }
    if (ids.length === 0) return;

    state.action({
        label: ids.length === 1 ? 'delete node' : `delete ${ids.length} nodes`,
        do() {
            for (const id of ids) {
                const n = getNodeById(ctx.nodes, id);
                if (!n) continue;
                destroyNode(ctx.nodes, n);
                send(ctx, DestroyNodeCommand, { id });
            }
            state.markDirty();
        },
        undo() {
            for (const args of createArgs) {
                for (const a of args) {
                    const parent = getNodeById(ctx.nodes, a.parentId);
                    if (!parent) continue;
                    const n = createNode({ id: a.id, name: a.name, persist: a.persist });
                    addChild(parent, n);
                    for (const st of a.traits) {
                        const def = registry.traits.byId.get(st.id)?.payload;
                        if (def) addTraitBySlot(n, def.slot, st.controls as Record<string, unknown>);
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
            state.markDirty();
        },
    });
}

export function setNameAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, name: string | undefined): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node) return;

    const prevName = node.name;

    state.action({
        label: name ? `rename → "${name}"` : 'clear name',
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            n.name = name;
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetNameCommand, { id: nodeId, name: name ?? null });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            n.name = prevName;
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetNameCommand, { id: nodeId, name: prevName ?? null });
            state.markDirty();
        },
    });
}

export function setRealmAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, realm: Realm): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node) return;

    const prevRealm = node.realm;
    if (prevRealm === realm) return;

    state.action({
        label: `realm → ${realm}`,
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            n.realm = realm;
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetRealmCommand, { id: nodeId, realm });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            n.realm = prevRealm;
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetRealmCommand, { id: nodeId, realm: prevRealm });
            state.markDirty();
        },
    });
}

export function reparentAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, parentId: number, index: number): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node?.parent) return;
    const newParent = getNodeById(ctx.nodes, parentId);
    if (!newParent) return;
    if (node === newParent || isAncestorOf(node, newParent)) return;

    const prevParentId = node.parent.id;
    const prevIndex = Math.max(0, node.parent.children.indexOf(node));

    state.action({
        label: 'reparent',
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            const np = getNodeById(ctx.nodes, parentId);
            if (!n || !np) return;
            reparent(n, np);
            reorderChild(np, n, index);
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, ReparentCommand, { id: nodeId, parentId, index });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            const pp = getNodeById(ctx.nodes, prevParentId);
            if (!n || !pp) return;
            reparent(n, pp);
            reorderChild(pp, n, prevIndex);
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, ReparentCommand, { id: nodeId, parentId: prevParentId, index: prevIndex });
            state.markDirty();
        },
    });
}

export function reorderAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, index: number): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node?.parent) return;

    const prevIndex = Math.max(0, node.parent.children.indexOf(node));

    state.action({
        label: 'reorder',
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n?.parent) return;
            reorderChild(n.parent, n, index);
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, ReorderCommand, { id: nodeId, index });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n?.parent) return;
            reorderChild(n.parent, n, prevIndex);
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, ReorderCommand, { id: nodeId, index: prevIndex });
            state.markDirty();
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
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node) return;

    const prevProps = captureTraitProps(node, traitId);

    state.action({
        label: `set ${traitId}`,
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            setTraitProps(ctx.nodes, n, traitId, props);
            send(ctx, SetTraitCommand, { id: nodeId, traitId, props: JSON.stringify(props) });
            state.markDirty();
        },
        undo() {
            if (!prevProps) return;
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            setTraitProps(ctx.nodes, n, traitId, prevProps);
            send(ctx, SetTraitCommand, { id: nodeId, traitId, props: JSON.stringify(prevProps) });
            state.markDirty();
        },
    });
}

export function addTraitAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, traitId: string): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node) return;

    state.action({
        label: `add ${traitId}`,
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (def) addTraitBySlot(n, def.slot);
            send(ctx, AddTraitCommand, { id: nodeId, traitId, props: undefined });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (def) removeTraitBySlot(n, def.slot);
            send(ctx, RemoveTraitCommand, { id: nodeId, traitId });
            state.markDirty();
        },
    });
}

export function removeTraitAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, traitId: string): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node) return;

    const prevProps = captureTraitProps(node, traitId);

    state.action({
        label: `remove ${traitId}`,
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (def) removeTraitBySlot(n, def.slot);
            else n._unresolvedTraits.delete(traitId);
            send(ctx, RemoveTraitCommand, { id: nodeId, traitId });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            const def = registry.traits.byId.get(traitId)?.payload;
            if (def) addTraitBySlot(n, def.slot, prevProps ?? undefined);
            send(ctx, AddTraitCommand, { id: nodeId, traitId, props: prevProps ? JSON.stringify(prevProps) : undefined });
            state.markDirty();
        },
    });
}

/* ── snapshot helpers ── */

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
    const def = registry.traits.byId.get(traitId)?.payload;
    if (!def) {
        const json = node._unresolvedTraits.get(traitId)?.json;
        return json ? structuredClone(json) : null;
    }
    const instance = node._traits.get(def.slot);
    if (!instance) return null;
    // clone, captured props are retained on the action's closure for undo;
    // sharing references with the live trait would let runtime mutations
    // (or a subsequent re-add) corrupt the snapshot.
    const props: Record<string, unknown> = {};
    for (const reg of def.controls) {
        const value = reg.get(instance);
        props[reg.controlId] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
    }
    return props;
}

export function setTraitProps(sg: Nodes, node: Node, traitId: string, props: Record<string, unknown>): void {
    const def = registry.traits.byId.get(traitId)?.payload;
    if (!def) {
        const unresolved = node._unresolvedTraits.get(traitId);
        if (unresolved) unresolved.json = { ...unresolved.json, ...props };
        bumpNodeVersion(sg, node);
        return;
    }
    const instance = node._traits.get(def.slot);
    if (!instance) return;
    for (const key of Object.keys(props)) {
        const ci = def.controlsById.get(key);
        if (!ci) continue;
        ci.reg.set(instance, props[key]);
    }
    bumpTraitVersion(sg, node, def.slot);
    bumpNodeVersion(sg, node);
}

/* ── prefab actions ── */

export function setPrefabAction(state: EditRoomState, ctx: ScriptContext, nodeId: number, config: PrefabConfig): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node) return;

    const prevPrefab = node.prefab ? { ...node.prefab } : null;

    state.action({
        label: `set prefab → ${config.prefabId}`,
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            setPrefab(n, { ...config });
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: JSON.stringify(config) });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            setPrefab(n, prevPrefab ? { ...prevPrefab } : null);
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: prevPrefab ? JSON.stringify(prevPrefab) : undefined });
            state.markDirty();
        },
    });
}

export function clearPrefabAction(state: EditRoomState, ctx: ScriptContext, nodeId: number): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node?.prefab) return;

    const prevPrefab = { ...node.prefab };

    state.action({
        label: 'clear prefab',
        do() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            setPrefab(n, null);
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: undefined });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            setPrefab(n, { ...prevPrefab });
            bumpNodeVersion(ctx.nodes, n);
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: JSON.stringify(prevPrefab) });
            state.markDirty();
        },
    });
}

/**
 * concretize a prefab wrapper: stamp its current voxel content into the world,
 * promote its non-persistent prefab-emitted children to persist:true so they
 * survive the prefab clear, and strip `node.prefab`. snapshots forward/reverse
 * voxel ops at action-creation time; child id lookups happen lazily inside
 * do/undo so redo (after the reconciler destroys + recreates with fresh ids)
 * still targets the right nodes.
 */
export function bakePrefabAction(state: EditRoomState, ctx: ScriptContext, nodeId: number): void {
    const node = getNodeById(ctx.nodes, nodeId);
    if (!node?.prefab) return;

    const prevPrefab = { ...node.prefab };

    // snapshot voxel forward/reverse ops by re-creating the same world stamp
    // the play-mode reconciler does (rotateVoxelsByQuat + round position).
    const forwardOps: VoxelOp[] = [];
    const reverseOps: VoxelOp[] = [];
    const preparedVoxels = node._prefabState?.voxels;
    if (preparedVoxels) {
        const t = getTrait(node, TransformTrait);
        const ox = t ? Math.round(t.position[0]) : 0;
        const oy = t ? Math.round(t.position[1]) : 0;
        const oz = t ? Math.round(t.position[2]) : 0;
        const q: Quat = t ? [t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]] : [0, 0, 0, 1];

        const rotated = rotateVoxelsByQuat(preparedVoxels, q, ctx.blocks);
        for (const chunk of rotated.chunks.values()) {
            if (chunk.aggregate === 0) continue;
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
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            // capture child ids lazily, after undo + redo the reconciler will
            // have recreated children with fresh ids.
            const childIds = n.children.map((c) => c.id);

            if (forwardOps.length > 0) sendVoxelOps(ctx, forwardOps);
            for (const id of childIds) {
                send(ctx, SetNodePersistCommand, { id, persist: true });
            }
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: undefined });
            state.markDirty();
        },
        undo() {
            const n = getNodeById(ctx.nodes, nodeId);
            if (!n) return;
            // children survive prefab clear as persist:true, flip them back
            // to persist:false before restoring the prefab so the next
            // reconcile tick destroys them and re-expands the def fresh.
            const childIds = n.children.map((c) => c.id);
            for (const id of childIds) {
                send(ctx, SetNodePersistCommand, { id, persist: false });
            }
            send(ctx, SetPrefabCommand, { id: nodeId, prefab: JSON.stringify(prevPrefab) });
            if (reverseOps.length > 0) sendVoxelOps(ctx, reverseOps);
            state.markDirty();
        },
    });
}
