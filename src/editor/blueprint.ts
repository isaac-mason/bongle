// blueprint, captured snapshot of voxels and/or nodes for copy/paste.
//
// a blueprint stores voxel data in a Voxels instance (local space, with
// the AABB min corner at the voxel origin) and node data as serialized
// trait snapshots with positions relative to the blueprint origin.
//
// voxel data uses the same Voxels type as the world, no custom chunk
// format needed. this means setBlock/getBlock/createVoxelModel all
// work directly on blueprint voxels.
//
// usage: import * as Blueprint from './blueprint'

import type { Quat, Vec3 } from 'mathcat';
import { TransformTrait } from '../builtins/transform';
import type { ScenePayload } from '../core/content/scene-store';
import { registry as kindRegistry } from '../core/registry';
import type { SceneTree, PrefabConfig, SerializedNode } from '../core/scene/scene-tree';
import { addTrait, createNode, getNodeById, getTrait, serializeNode } from '../core/scene/scene-tree';
import { expandPrefab } from '../core/scene/prefab';
import type { SceneTreeContext } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import type { BlockRegistry } from '../core/voxels/block-registry';
import { flipBlockKey, rotateBlockKey } from '../core/voxels/block-transform';
import { loadVoxels, type SavedVoxels, saveVoxels } from '../core/voxels/voxel-savefile';
import type { Voxels } from '../core/voxels/voxels';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, createVoxels, getBlock, setBlock } from '../core/voxels/voxels';
import { useEditor } from './editor-store';

// ── types ──────────────────────────────────────────────────────────
//
// nodes are stored as SerializedNode trees, the same format scene files
// use. each top-level node's transform.position is **origin-relative**
// (we shift it during bake). children carry their normal parent-relative
// positions and rotate naturally with their parent.

export type Blueprint = {
    id: number;

    // voxel data in local space. null if node-only selection.
    // chunk coords are origin-relative (AABB min corner = local (0,0,0)).
    voxels: Voxels | null;

    // tight AABB size in voxels ([0,0,0] if no voxels)
    size: Vec3;

    // total non-air block count
    blockCount: number;

    // captured node subtrees (empty array if voxel-only). each top-level
    // node's transform.position is origin-relative.
    nodes: SerializedNode[];

    // world-space origin of the blueprint (min corner of voxel AABB,
    // or centroid of selected nodes if no voxels).
    // node positions are stored relative to this.
    origin: Vec3;

    // human-readable label ("3x2x3, 14 blocks, 2 nodes")
    label: string;

    // what content types this blueprint contains
    hasVoxels: boolean;
    hasNodes: boolean;

    // present when the blueprint was baked from a prefab. preview uses the
    // snapshotted voxels/nodes, but commit emits a single wrapper node
    // carrying this config so the placed instance stays linked to the prefab
    // (children re-instantiated by the runtime). cleared when the user copies
    // the blueprint to the clipboard, that path is explicit "freeze".
    sourcePrefab?: PrefabConfig;
};

// ── transform-trait helper ─────────────────────────────────────────

type TransformProps = { position: Vec3; quaternion: Quat; scale: Vec3 };

/**
 * find the transform trait on a serialized node and return its controls as
 * typed Vec3/Quat tuples. returns null if no transform trait is present.
 *
 * the returned object has fresh tuples, mutate or replace freely without
 * affecting the source. caller is responsible for writing back via
 * `setTransformProps` if mutation is desired on the source node.
 */
function readTransformProps(node: SerializedNode): TransformProps | null {
    const t = node.traits.find((st) => st.id === 'transform');
    if (!t?.controls) return null;
    const p = t.controls as { position?: number[]; quaternion?: number[]; scale?: number[] };
    return {
        position: [p.position?.[0] ?? 0, p.position?.[1] ?? 0, p.position?.[2] ?? 0],
        quaternion: [p.quaternion?.[0] ?? 0, p.quaternion?.[1] ?? 0, p.quaternion?.[2] ?? 0, p.quaternion?.[3] ?? 1],
        scale: [p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.scale?.[2] ?? 1],
    };
}

/** mutate a serialized node's transform-trait controls in place. no-op if no transform trait. */
function writeTransformProps(node: SerializedNode, props: Partial<TransformProps>): void {
    const t = node.traits.find((st) => st.id === 'transform');
    if (!t) return;
    if (!t.controls) t.controls = {};
    const p = t.controls as { position?: Vec3; quaternion?: Quat; scale?: Vec3 };
    if (props.position) p.position = [...props.position] as Vec3;
    if (props.quaternion) p.quaternion = [...props.quaternion] as Quat;
    if (props.scale) p.scale = [...props.scale] as Vec3;
}

// ── id counter ─────────────────────────────────────────────────────

let nextBlueprintId = 1;

// ── copy ───────────────────────────────────────────────────────────

/**
 * copy selected voxels and/or nodes into a Blueprint.
 * captures whatever the selection contains, voxels, nodes, or both.
 *
 * voxel data is copied into a fresh Voxels instance with coords shifted
 * so the AABB min corner sits at local (0,0,0).
 *
 * node trait data is serialized via serializeNode. positions are stored
 * relative to the blueprint origin.
 */
export function copySelection(worldVoxels: Voxels, sceneTree: SceneTree, selection: Selection.Selection): Blueprint {
    const voxelCount = Selection.countVoxels(selection);
    const hasVoxels = voxelCount > 0;
    const hasNodes = selection.nodes.size > 0;

    // ── voxels ──
    let blueprintVoxels: Voxels | null = null;
    let size: Vec3 = [0, 0, 0];
    let voxelOrigin: Vec3 = [0, 0, 0];
    let blockCount = 0;

    if (hasVoxels) {
        // scan AABB of selected voxels
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        Selection.forEach(selection, (wx, wy, wz) => {
            if (wx < minX) minX = wx;
            if (wy < minY) minY = wy;
            if (wz < minZ) minZ = wz;
            if (wx > maxX) maxX = wx;
            if (wy > maxY) maxY = wy;
            if (wz > maxZ) maxZ = wz;
        });

        voxelOrigin = [minX, minY, minZ];
        // size is inclusive max - min + 1 (number of voxels per axis)
        size = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];

        // copy selected voxels into local-space Voxels
        blueprintVoxels = createVoxels(worldVoxels.registry);

        Selection.forEach(selection, (wx, wy, wz) => {
            const key = getBlock(worldVoxels, wx, wy, wz);
            if (key === BLOCK_AIR) return;
            setBlock(blueprintVoxels!, wx - minX, wy - minY, wz - minZ, key);
            blockCount++;
        });
    }

    // ── nodes ──
    const blueprintNodes: SerializedNode[] = [];

    if (hasNodes) {
        // compute origin for nodes: use voxel origin if we have voxels,
        // otherwise use centroid of selected node positions.
        let nodeOrigin: Vec3;
        if (hasVoxels) {
            nodeOrigin = voxelOrigin;
        } else {
            let cx = 0;
            let cy = 0;
            let cz = 0;
            let count = 0;
            for (const nodeId of selection.nodes) {
                const node = getNodeById(sceneTree, nodeId);
                if (!node) continue;
                const transform = getTrait(node, TransformTrait);
                if (!transform) continue;
                cx += transform.position[0];
                cy += transform.position[1];
                cz += transform.position[2];
                count++;
            }
            if (count > 0) {
                nodeOrigin = [cx / count, cy / count, cz / count];
            } else {
                nodeOrigin = [0, 0, 0];
            }
            voxelOrigin = nodeOrigin;
        }

        for (const nodeId of selection.nodes) {
            const node = getNodeById(sceneTree, nodeId);
            if (!node) continue;

            const serialized = serializeNode(node);
            const tProps = readTransformProps(serialized);
            if (tProps) {
                writeTransformProps(serialized, {
                    position: [
                        tProps.position[0] - nodeOrigin[0],
                        tProps.position[1] - nodeOrigin[1],
                        tProps.position[2] - nodeOrigin[2],
                    ],
                });
            }
            blueprintNodes.push(serialized);
        }
    }

    // ── label ──
    const parts: string[] = [];
    if (hasVoxels) {
        parts.push(`${size[0]}x${size[1]}x${size[2]}`);
        parts.push(`${blockCount} block${blockCount !== 1 ? 's' : ''}`);
    }
    if (hasNodes) {
        parts.push(`${blueprintNodes.length} node${blueprintNodes.length !== 1 ? 's' : ''}`);
    }
    const label = parts.join(', ');

    return {
        id: nextBlueprintId++,
        voxels: blueprintVoxels,
        size,
        blockCount,
        nodes: blueprintNodes,
        origin: voxelOrigin,
        label,
        hasVoxels,
        hasNodes,
    };
}

// ── selection → ScenePayload (blueprint persistence) ──────────────
//
// captures the same content as `copySelection` but emits a ScenePayload
// ready to hand to `ContentManager.saveScene`, a synthetic root with the
// selected nodes as children + serialized voxels in local space. used by
// the "save selection as blueprint" flow (chat command, context menu).

export function selectionToScenePayload(worldVoxels: Voxels, sceneTree: SceneTree, selection: Selection.Selection): ScenePayload | null {
    const bp = copySelection(worldVoxels, sceneTree, selection);
    if (!bp.hasVoxels && !bp.hasNodes) return null;

    const root: SerializedNode = {
        realm: 'shared',
        name: 'Root',
        traits: [],
        children: bp.nodes,
    };

    return {
        nodes: { root },
        voxels: bp.voxels ? saveVoxels(bp.voxels) : null,
    };
}

// ── scene blueprint (placed-from-inventory) ───────────────────────
//
// build a Blueprint from a registered scene's payload. blueprint scenes
// (saved via selectionToScenePayload) carry voxels in local space and a
// synthetic root whose children are origin-relative nodes, exactly the
// shape Blueprint already wants. we just deserialize voxels, scan the
// AABB for size, and clone children.

export function createSceneBlueprint(sceneId: string, anchor: Vec3, registry: BlockRegistry): Blueprint | null {
    const payload = useEditor.getState().blueprints.get(sceneId);
    if (!payload) return null;

    let voxels: Voxels | null = null;
    let size: Vec3 = [0, 0, 0];
    let blockCount = 0;

    if (payload.voxels) {
        const tmp = createVoxels(registry);
        loadVoxels(tmp, payload.voxels, registry);

        let minX = Infinity,
            minY = Infinity,
            minZ = Infinity;
        let maxX = -Infinity,
            maxY = -Infinity,
            maxZ = -Infinity;
        for (const chunk of tmp.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;
                        const wx = chunk.wx + lx,
                            wy = chunk.wy + ly,
                            wz = chunk.wz + lz;
                        if (wx < minX) minX = wx;
                        if (wy < minY) minY = wy;
                        if (wz < minZ) minZ = wz;
                        if (wx > maxX) maxX = wx;
                        if (wy > maxY) maxY = wy;
                        if (wz > maxZ) maxZ = wz;
                        blockCount++;
                    }
                }
            }
        }
        if (blockCount > 0) {
            // saved blueprints are already local-space (min ≈ 0). general scenes
            // may not be, shift into local space so buildPasteOps can use
            // `chunk.wx + anchor` directly.
            if (minX === 0 && minY === 0 && minZ === 0) {
                voxels = tmp;
            } else {
                voxels = createVoxels(registry);
                for (const chunk of tmp.chunks.values()) {
                    if (chunk.nonAirCount === 0) continue;
                    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                                const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                                const key = chunk.paletteKeys[paletteIdx];
                                if (!key || key === BLOCK_AIR) continue;
                                setBlock(voxels, chunk.wx + lx - minX, chunk.wy + ly - minY, chunk.wz + lz - minZ, key);
                            }
                        }
                    }
                }
            }
            size = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
        }
    }

    const hasVoxels = blockCount > 0;
    const nodes: SerializedNode[] = payload.nodes.root.children.map((c) => structuredClone(c));
    const hasNodes = nodes.length > 0;
    if (!hasVoxels && !hasNodes) return null;

    const parts: string[] = [];
    if (hasVoxels) {
        parts.push(`${size[0]}x${size[1]}x${size[2]}`);
        parts.push(`${blockCount} block${blockCount !== 1 ? 's' : ''}`);
    }
    if (hasNodes) {
        parts.push(`${nodes.length} node${nodes.length !== 1 ? 's' : ''}`);
    }

    return {
        id: nextBlueprintId++,
        voxels,
        size,
        blockCount,
        nodes,
        origin: [anchor[0], anchor[1], anchor[2]],
        label: parts.length > 0 ? parts.join(', ') : sceneId,
        hasVoxels,
        hasNodes,
    };
}

// ── prefab blueprint (frozen instance) ─────────────────────────────

/**
 * build a Blueprint by instantiating a prefab into a synthetic root and
 * snapshotting the resulting voxels + child nodes. this lets prefab placement
 * flow through the same `enterPlacement` / `rotatePlacement` / `commitPlacement`
 * code path as ctrl+v paste, the preview shows the expanded content cheaply
 * without re-running the prefab fn on every ghost frame.
 *
 * the resulting blueprint carries `sourcePrefab`, so commit emits a single
 * wrapper node with the prefab config attached (linkage preserved) and the
 * runtime re-instantiates the contents on the real node. for a "freeze"
 * (concretize) flow, drop `sourcePrefab` before committing.
 *
 * returns null if the prefab id is not registered.
 */
export function createPrefabBlueprint(
    prefabId: string,
    anchor: Vec3,
    runtime: SceneTreeContext,
    registry: BlockRegistry,
): Blueprint | null {
    const def = kindRegistry.prefabs.byId.get(prefabId)?.payload;
    if (!def) return null;

    const config: PrefabConfig = {
        prefabId,
        args: def.args ? structuredClone(def.args.default) : {},
    };

    // synthetic root with prefab config attached so expand() can read it
    const tempRoot = createNode({ name: prefabId, persist: false });
    tempRoot.prefab = config;
    addTrait(tempRoot, TransformTrait);

    // single source of truth: scene children + apply. returns prepared voxels
    // when the def has them; null otherwise.
    const preparedVoxels = expandPrefab(tempRoot, runtime, registry);

    // ── compute voxel AABB ──
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let blockCount = 0;

    if (preparedVoxels) {
        for (const chunk of preparedVoxels.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;
                        const wx = chunk.wx + lx;
                        const wy = chunk.wy + ly;
                        const wz = chunk.wz + lz;
                        if (wx < minX) minX = wx;
                        if (wy < minY) minY = wy;
                        if (wz < minZ) minZ = wz;
                        if (wx > maxX) maxX = wx;
                        if (wy > maxY) maxY = wy;
                        if (wz > maxZ) maxZ = wz;
                        blockCount++;
                    }
                }
            }
        }
    }

    const hasVoxels = blockCount > 0;
    let size: Vec3 = [0, 0, 0];
    let voxelOrigin: Vec3 = [0, 0, 0];
    let blueprintVoxels: Voxels | null = null;

    if (hasVoxels && preparedVoxels) {
        voxelOrigin = [minX, minY, minZ];
        size = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
        blueprintVoxels = createVoxels(registry);
        for (const chunk of preparedVoxels.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;
                        const wx = chunk.wx + lx;
                        const wy = chunk.wy + ly;
                        const wz = chunk.wz + lz;
                        setBlock(blueprintVoxels, wx - minX, wy - minY, wz - minZ, key);
                    }
                }
            }
        }
    }

    // ── snapshot child nodes ──
    // serializeNode captures the full subtree (children, traits, prefab linkage,
    // realm). we only shift the top-level transform.position so it's
    // origin-relative; children's positions are parent-relative and rotate
    // naturally with their parent at paste time.
    const blueprintNodes: SerializedNode[] = [];
    for (const child of tempRoot.children) {
        const serialized = serializeNode(child);
        const tProps = readTransformProps(serialized);
        if (tProps) {
            writeTransformProps(serialized, {
                position: [
                    tProps.position[0] - voxelOrigin[0],
                    tProps.position[1] - voxelOrigin[1],
                    tProps.position[2] - voxelOrigin[2],
                ],
            });
        }
        blueprintNodes.push(serialized);
    }

    const hasNodes = blueprintNodes.length > 0;

    const parts: string[] = [];
    if (hasVoxels) {
        parts.push(`${size[0]}x${size[1]}x${size[2]}`);
        parts.push(`${blockCount} block${blockCount !== 1 ? 's' : ''}`);
    }
    if (hasNodes) {
        parts.push(`${blueprintNodes.length} node${blueprintNodes.length !== 1 ? 's' : ''}`);
    }
    const label = parts.length > 0 ? parts.join(', ') : prefabId;

    return {
        id: nextBlueprintId++,
        voxels: blueprintVoxels,
        size,
        blockCount,
        nodes: blueprintNodes,
        origin: [anchor[0], anchor[1], anchor[2]],
        label,
        hasVoxels,
        hasNodes,
        sourcePrefab: config,
    };
}

// ── rotate ─────────────────────────────────────────────────────────

/**
 * rotate a blueprint around the Y axis by 90-degree increments.
 * returns a new Blueprint, the original is not mutated.
 *
 * voxel data: grid is remapped. for each voxel at (x, y, z) in a
 * volume of size (sx, sy, sz):
 *   turn 1 (90 cw):  new pos = (sz - 1 - z, y, x),      new size = (sz, sy, sx)
 *   turn 2 (180):    new pos = (sx - 1 - x, y, sz - 1 - z), new size = (sx, sy, sz)
 *   turn 3 (270 cw): new pos = (z, y, sx - 1 - x),      new size = (sz, sy, sx)
 *
 * node data: localPosition is rotated around Y by the same angle.
 * quaternion is composed with the rotation.
 */
export type RotationAxis = 'x' | 'y' | 'z';

/**
 * rotate a blueprint 90 degrees around the given axis.
 * direction: +1 = CW looking down the positive axis, -1 = CCW.
 *
 * this rebuilds the voxel data with remapped coordinates and rotates
 * node local positions + quaternions to match.
 */
export function rotateAxis(blueprint: Blueprint, axis: RotationAxis, direction: 1 | -1): Blueprint {
    const [sx, sy, sz] = blueprint.size;

    // ── rotate voxels ──
    let newVoxels: Voxels | null = null;
    let newSize: Vec3 = blueprint.size;
    let newBlockCount = blueprint.blockCount;

    // direction=+1 means CW looking down the positive axis, matching the
    // block-model convention (block-model.ts rotatePos step=1: +X → -Z).
    // direction=-1 means CCW.

    if (blueprint.voxels && blueprint.hasVoxels) {
        // new bounding size after rotation
        if (axis === 'y') {
            newSize = [sz, sy, sx];
        } else if (axis === 'x') {
            newSize = [sx, sz, sy];
        } else {
            newSize = [sy, sx, sz];
        }

        newVoxels = createVoxels(blueprint.voxels.registry);
        newBlockCount = 0;

        for (const chunk of blueprint.voxels.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;

                        const wx = chunk.wx + lx;
                        const wy = chunk.wy + ly;
                        const wz = chunk.wz + lz;

                        let nx: number, ny: number, nz: number;
                        if (axis === 'y') {
                            // CW from +Y: (x,z) → (z, sx-1-x)  i.e. +X → -Z
                            // CCW:        (x,z) → (sz-1-z, x)   i.e. +X → +Z
                            if (direction === 1) {
                                nx = wz;
                                ny = wy;
                                nz = sx - 1 - wx;
                            } else {
                                nx = sz - 1 - wz;
                                ny = wy;
                                nz = wx;
                            }
                        } else if (axis === 'x') {
                            // CW from +X: (y,z) → (z, sy-1-y)
                            // CCW:        (y,z) → (sz-1-z, y)
                            if (direction === 1) {
                                nx = wx;
                                ny = wz;
                                nz = sy - 1 - wy;
                            } else {
                                nx = wx;
                                ny = sz - 1 - wz;
                                nz = wy;
                            }
                        } else {
                            // CW from +Z: (x,y) → (y, sx-1-x)
                            // CCW:        (x,y) → (sy-1-y, x)
                            if (direction === 1) {
                                nx = wy;
                                ny = sx - 1 - wx;
                                nz = wz;
                            } else {
                                nx = sy - 1 - wy;
                                ny = wx;
                                nz = wz;
                            }
                        }

                        const rotatedKey = rotateBlockKey(key, axis, direction === 1, blueprint.voxels!.registry);
                        setBlock(newVoxels!, nx, ny, nz, rotatedKey);
                        newBlockCount++;
                    }
                }
            }
        }
    }

    // ── rotate nodes ──
    const angle = direction * (Math.PI / 2);
    const halfAngle = angle / 2;
    let rotQuat: Quat;
    if (axis === 'y') {
        rotQuat = [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)];
    } else if (axis === 'x') {
        rotQuat = [Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)];
    } else {
        rotQuat = [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
    }

    const cosA = Math.round(Math.cos(angle));
    const sinA = Math.round(Math.sin(angle));

    const newNodes: SerializedNode[] = blueprint.nodes.map((node) => {
        const cloned = structuredClone(node);
        const tProps = readTransformProps(cloned);
        if (!tProps) return cloned;
        const [px, py, pz] = tProps.position;
        let newPos: Vec3;
        if (axis === 'y') {
            newPos = [cosA * px + sinA * pz, py, -sinA * px + cosA * pz];
        } else if (axis === 'x') {
            newPos = [px, cosA * py + sinA * pz, -sinA * py + cosA * pz];
        } else {
            newPos = [cosA * px + sinA * py, -sinA * px + cosA * py, pz];
        }
        const newQuat = quatMultiply(rotQuat, tProps.quaternion);
        writeTransformProps(cloned, { position: newPos, quaternion: newQuat });
        return cloned;
    });

    // ── label ──
    const parts: string[] = [];
    if (blueprint.hasVoxels) {
        parts.push(`${newSize[0]}x${newSize[1]}x${newSize[2]}`);
        parts.push(`${newBlockCount} block${newBlockCount !== 1 ? 's' : ''}`);
    }
    if (blueprint.hasNodes) {
        parts.push(`${newNodes.length} node${newNodes.length !== 1 ? 's' : ''}`);
    }

    return {
        id: blueprint.id,
        voxels: newVoxels,
        size: newSize,
        blockCount: newBlockCount,
        nodes: newNodes,
        origin: blueprint.origin,
        label: parts.join(', '),
        hasVoxels: blueprint.hasVoxels,
        hasNodes: blueprint.hasNodes,
        sourcePrefab: blueprint.sourcePrefab,
    };
}

/** rotate around Y by 0-3 turns (legacy helper, delegates to rotateAxis). */
export function rotate(blueprint: Blueprint, turns: 0 | 1 | 2 | 3): Blueprint {
    if (turns === 0) return blueprint;
    let result = blueprint;
    for (let i = 0; i < turns; i++) {
        result = rotateAxis(result, 'y', 1);
    }
    return result;
}

// ── flip ──────────────────────────────────────────────────────────
//
// mirror across the plane perpendicular to `axis` passing through the
// blueprint origin. companion to rotateAxis, uses flipBlockKey from
// block-transform for per-block state handling.

/**
 * mirror a blueprint across the plane perpendicular to the given axis.
 * voxels: cells on the chosen axis are reflected: x → sx-1-x (and analogously
 * for y/z). nodes: position component on `axis` is negated; quaternion is
 * mirrored across the same plane (the two perpendicular components flip sign).
 */
export function flipAxis(blueprint: Blueprint, axis: RotationAxis): Blueprint {
    const [sx, sy, sz] = blueprint.size;

    // ── flip voxels ──
    let newVoxels: Voxels | null = null;
    let newBlockCount = blueprint.blockCount;

    if (blueprint.voxels && blueprint.hasVoxels) {
        newVoxels = createVoxels(blueprint.voxels.registry);
        newBlockCount = 0;

        for (const chunk of blueprint.voxels.chunks.values()) {
            if (chunk.nonAirCount === 0) continue;
            for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                        const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                        const key = chunk.paletteKeys[paletteIdx];
                        if (!key || key === BLOCK_AIR) continue;

                        const wx = chunk.wx + lx;
                        const wy = chunk.wy + ly;
                        const wz = chunk.wz + lz;

                        const nx = axis === 'x' ? sx - 1 - wx : wx;
                        const ny = axis === 'y' ? sy - 1 - wy : wy;
                        const nz = axis === 'z' ? sz - 1 - wz : wz;

                        const flippedKey = flipBlockKey(key, axis, blueprint.voxels!.registry);
                        setBlock(newVoxels!, nx, ny, nz, flippedKey);
                        newBlockCount++;
                    }
                }
            }
        }
    }

    // ── flip nodes ──
    // mirror across the plane perpendicular to `axis` through origin: negate
    // that position component. for the quaternion, mirroring a rotation
    // across a plane normal to axis A flips the two quat components NOT on A
    // (and the scalar w stays). e.g. axis=x: (qx, qy, qz, qw) → (qx, -qy, -qz, qw).
    const newNodes: SerializedNode[] = blueprint.nodes.map((node) => {
        const cloned = structuredClone(node);
        const tProps = readTransformProps(cloned);
        if (!tProps) return cloned;
        const [px, py, pz] = tProps.position;
        const [qx, qy, qz, qw] = tProps.quaternion;
        let newPos: Vec3;
        let newQuat: Quat;
        if (axis === 'x') {
            newPos = [-px, py, pz];
            newQuat = [qx, -qy, -qz, qw];
        } else if (axis === 'y') {
            newPos = [px, -py, pz];
            newQuat = [-qx, qy, -qz, qw];
        } else {
            newPos = [px, py, -pz];
            newQuat = [-qx, -qy, qz, qw];
        }
        writeTransformProps(cloned, { position: newPos, quaternion: newQuat });
        return cloned;
    });

    // ── label ──
    const parts: string[] = [];
    if (blueprint.hasVoxels) {
        parts.push(`${sx}x${sy}x${sz}`);
        parts.push(`${newBlockCount} block${newBlockCount !== 1 ? 's' : ''}`);
    }
    if (blueprint.hasNodes) {
        parts.push(`${newNodes.length} node${newNodes.length !== 1 ? 's' : ''}`);
    }

    return {
        id: blueprint.id,
        voxels: newVoxels,
        size: blueprint.size,
        blockCount: newBlockCount,
        nodes: newNodes,
        origin: blueprint.origin,
        label: parts.join(', '),
        hasVoxels: blueprint.hasVoxels,
        hasNodes: blueprint.hasNodes,
        sourcePrefab: blueprint.sourcePrefab,
    };
}

// ── paste ops (voxels) ─────────────────────────────────────────────

export type VoxelOp = { wx: number; wy: number; wz: number; key: string };

/**
 * build forward/reverse voxel ops for committing a blueprint's voxels
 * to the world at a given anchor position.
 *
 * anchor is the world-space position of the blueprint's local (0,0,0).
 * forward ops write blueprint blocks into the world.
 * reverse ops capture the current world state at those positions (for undo).
 *
 * returns empty arrays if the blueprint has no voxels.
 */
export function buildPasteOps(
    blueprint: Blueprint,
    anchor: Vec3,
    worldVoxels: Voxels,
): { forward: VoxelOp[]; reverse: VoxelOp[] } {
    const forward: VoxelOp[] = [];
    const reverse: VoxelOp[] = [];

    if (!blueprint.voxels || !blueprint.hasVoxels) return { forward, reverse };

    for (const chunk of blueprint.voxels.chunks.values()) {
        if (chunk.nonAirCount === 0) continue;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const paletteIdx = chunk.data[(ly << (CHUNK_BITS + CHUNK_BITS)) | (lz << CHUNK_BITS) | lx]!;
                    const key = chunk.paletteKeys[paletteIdx];
                    if (!key || key === BLOCK_AIR) continue;

                    const wx = chunk.wx + lx + anchor[0];
                    const wy = chunk.wy + ly + anchor[1];
                    const wz = chunk.wz + lz + anchor[2];

                    // capture current world block for undo
                    const existingKey = getBlock(worldVoxels, wx, wy, wz);
                    reverse.push({ wx, wy, wz, key: existingKey });
                    forward.push({ wx, wy, wz, key });
                }
            }
        }
    }

    return { forward, reverse };
}

// ── paste commands (nodes) ─────────────────────────────────────────

/**
 * build node creation data for committing a blueprint's nodes into the
 * scene at a given offset + rotation from the original blueprint origin.
 *
 * each entry is a fully-formed SerializedNode whose top-level
 * transform.position/quaternion has been re-anchored to world space and
 * rotated by `rotation`. children are untouched (their positions are
 * parent-relative and the engine compounds at render time).
 *
 * the caller is responsible for actually creating nodes and sending
 * commands, this function only produces the data.
 *
 * returns empty entries if the blueprint has no nodes.
 */
export function buildNodePaste(blueprint: Blueprint, offset: Vec3, rotation: Quat): { entries: SerializedNode[] } {
    const entries: SerializedNode[] = [];
    if (!blueprint.hasNodes) return { entries };

    for (const node of blueprint.nodes) {
        const cloned = structuredClone(node);
        const tProps = readTransformProps(cloned);
        if (tProps) {
            const rotatedPos = rotateVec3ByQuat(tProps.position, rotation);
            writeTransformProps(cloned, {
                position: [rotatedPos[0] + offset[0], rotatedPos[1] + offset[1], rotatedPos[2] + offset[2]],
                quaternion: quatMultiply(rotation, tProps.quaternion),
            });
        }
        entries.push(cloned);
    }

    return { entries };
}

// ── math helpers (inline to avoid import deps) ─────────────────────

// quaternion multiply: a * b
function quatMultiply(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

// rotate a vec3 by a quaternion: q * v * q^-1
function rotateVec3ByQuat(v: Vec3, q: Quat): Vec3 {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;

    // q * v (treat v as quaternion [vx, vy, vz, 0])
    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;

    // (q * v) * q^-1 (conjugate for unit quaternion is [-x,-y,-z,w])
    return [
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
}

// ── clipboard serialization ────────────────────────────────────────
//
// blueprints are written to the system clipboard as JSON strings.
// the format is identified by a `type: "blocks-blueprint"` field.
// voxel data uses the same base64-encoded chunk format as mapfile
// persistence (via voxel-savefile), so it's compact and stable across
// registry rebuilds.
//
// this means you can ctrl+c in one browser tab and ctrl+v in another.

const CLIPBOARD_TYPE = 'blocks-blueprint';
const CLIPBOARD_VERSION = 1;

type ClipboardBlueprint = {
    type: typeof CLIPBOARD_TYPE;
    version: number;
    size: Vec3;
    blockCount: number;
    origin: Vec3;
    hasVoxels: boolean;
    hasNodes: boolean;
    voxels: SavedVoxels | null;
    nodes: SerializedNode[];
};

/**
 * serialize a blueprint to a JSON string suitable for the system clipboard.
 */
export function toClipboardString(blueprint: Blueprint): string {
    const payload: ClipboardBlueprint = {
        type: CLIPBOARD_TYPE,
        version: CLIPBOARD_VERSION,
        size: blueprint.size,
        blockCount: blueprint.blockCount,
        origin: blueprint.origin,
        hasVoxels: blueprint.hasVoxels,
        hasNodes: blueprint.hasNodes,
        voxels: blueprint.voxels ? saveVoxels(blueprint.voxels) : null,
        nodes: blueprint.nodes,
    };
    return JSON.stringify(payload);
}

/**
 * attempt to deserialize a clipboard string into a Blueprint.
 * returns null if the string is not a valid blocks blueprint.
 *
 * the registry is needed to rebuild runtime palette ids from the
 * stable string keys stored in the serialized voxel data.
 */
export function fromClipboardString(text: string, registry: BlockRegistry): Blueprint | null {
    let parsed: ClipboardBlueprint;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (!parsed || parsed.type !== CLIPBOARD_TYPE) return null;

    // rebuild voxels from serialized data
    let voxels: Voxels | null = null;
    if (parsed.voxels && parsed.hasVoxels) {
        voxels = createVoxels(registry);
        loadVoxels(voxels, parsed.voxels, registry);
    }

    // rebuild label
    const parts: string[] = [];
    if (parsed.hasVoxels) {
        parts.push(`${parsed.size[0]}x${parsed.size[1]}x${parsed.size[2]}`);
        parts.push(`${parsed.blockCount} block${parsed.blockCount !== 1 ? 's' : ''}`);
    }
    if (parsed.hasNodes) {
        parts.push(`${parsed.nodes.length} node${parsed.nodes.length !== 1 ? 's' : ''}`);
    }

    return {
        id: nextBlueprintId++,
        voxels,
        size: parsed.size,
        blockCount: parsed.blockCount,
        nodes: parsed.nodes ?? [],
        origin: parsed.origin,
        label: parts.join(', '),
        hasVoxels: parsed.hasVoxels,
        hasNodes: parsed.hasNodes,
    };
}
