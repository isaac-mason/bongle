import type { Quat, Vec3 } from 'math';
import { TransformTrait } from '../builtins/transform';
import type { ScenePayload } from '../core/content/scene-store';
import { registry as kindRegistry } from '../core/registry';
import { expandPrefab } from '../core/scene/prefab';
import type { PrefabConfig, SceneTree, SerializedNode } from '../core/scene/scene-tree';
import { addTrait, createNode, getNodeById, getTrait, serializeNode } from '../core/scene/scene-tree';
import type { SceneTreeContext } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import type { Blocks } from '../core/voxels/block-registry';
import { flipBlockKey, rotateBlockKey } from '../core/voxels/block-transform';
import { loadVoxels, type SavedVoxels, saveVoxels } from '../core/voxels/voxel-savefile';
import type { Voxels } from '../core/voxels/voxels';
import { BLOCK_AIR, CHUNK_BITS, CHUNK_SIZE, createVoxels, getBlock, setBlock } from '../core/voxels/voxels';
import { useEditor } from './editor-store';

// each top-level node's transform.position is origin-relative; children stay parent-relative.
export type Blueprint = {
    id: number;

    // null if node-only selection; local space, min corner at (0,0,0).
    voxels: Voxels | null;

    // [0,0,0] if no voxels.
    size: Vec3;

    blockCount: number;

    // empty array if voxel-only.
    nodes: SerializedNode[];

    // min corner of voxel AABB, or centroid of selected nodes if no voxels.
    origin: Vec3;

    label: string;

    hasVoxels: boolean;
    hasNodes: boolean;

    // set when baked from a prefab; commit emits a linked wrapper node, cleared on copy to clipboard.
    sourcePrefab?: PrefabConfig;
};

type TransformProps = { position: Vec3; quaternion: Quat; scale: Vec3 };

/** returns fresh tuples; write back via `writeTransformProps` if mutating the source node. */
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

let nextBlueprintId = 1;

/** captures whatever the selection contains (voxels, nodes, or both) into a Blueprint. */
export function copySelection(worldVoxels: Voxels, sceneTree: SceneTree, selection: Selection.Selection): Blueprint {
    const voxelCount = Selection.countVoxels(selection);
    const hasVoxels = voxelCount > 0;
    const hasNodes = selection.nodes.size > 0;

    let blueprintVoxels: Voxels | null = null;
    let size: Vec3 = [0, 0, 0];
    let voxelOrigin: Vec3 = [0, 0, 0];
    let blockCount = 0;

    if (hasVoxels) {
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
        // size is inclusive max - min + 1
        size = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];

        blueprintVoxels = createVoxels(worldVoxels.registry);

        Selection.forEach(selection, (wx, wy, wz) => {
            const key = getBlock(worldVoxels, wx, wy, wz);
            if (key === BLOCK_AIR) return;
            setBlock(blueprintVoxels!, wx - minX, wy - minY, wz - minZ, key);
            blockCount++;
        });
    }

    const blueprintNodes: SerializedNode[] = [];

    if (hasNodes) {
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

/** captures a selection as a ScenePayload for `ContentManager.saveScene` ("save selection as blueprint"). */
export function selectionToScenePayload(
    worldVoxels: Voxels,
    sceneTree: SceneTree,
    selection: Selection.Selection,
): ScenePayload | null {
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

/** builds a Blueprint from a registered scene's payload (voxels in local space, origin-relative children). */
export function createSceneBlueprint(sceneId: string, anchor: Vec3, registry: Blocks): Blueprint | null {
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
            // saved blueprints are already local-space; general scenes may not be, so shift into local space.
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

/** instantiates a prefab into a synthetic root and snapshots the resulting voxels + child nodes into a Blueprint. */
export function createPrefabBlueprint(
    prefabId: string,
    anchor: Vec3,
    runtime: SceneTreeContext,
    registry: Blocks,
): Blueprint | null {
    const def = kindRegistry.prefabs.byId.get(prefabId);
    if (!def) return null;

    const config: PrefabConfig = {
        prefabId,
        args: def.args ? structuredClone(def.args.default) : {},
    };

    // synthetic root with prefab config attached so expand() can read it
    const tempRoot = createNode({ name: prefabId, persist: false });
    tempRoot.prefab = config;
    addTrait(tempRoot, TransformTrait);

    const preparedVoxels = expandPrefab(tempRoot, runtime, registry);

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

    // only the top-level transform.position shifts to origin-relative; children stay parent-relative.
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

export type RotationAxis = 'x' | 'y' | 'z';

/** rotates a blueprint 90 degrees around the given axis (direction: +1 = CW, -1 = CCW looking down the axis), returning a new Blueprint. */
export function rotateAxis(blueprint: Blueprint, axis: RotationAxis, direction: 1 | -1): Blueprint {
    const [sx, sy, sz] = blueprint.size;

    let newVoxels: Voxels | null = null;
    let newSize: Vec3 = blueprint.size;
    let newBlockCount = blueprint.blockCount;

    if (blueprint.voxels && blueprint.hasVoxels) {
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

/** rotates a blueprint around Y by 0-3 turns, delegating to rotateAxis. */
export function rotate(blueprint: Blueprint, turns: 0 | 1 | 2 | 3): Blueprint {
    if (turns === 0) return blueprint;
    let result = blueprint;
    for (let i = 0; i < turns; i++) {
        result = rotateAxis(result, 'y', 1);
    }
    return result;
}

/** mirrors a blueprint across the plane perpendicular to `axis`, through the blueprint origin. */
export function flipAxis(blueprint: Blueprint, axis: RotationAxis): Blueprint {
    const [sx, sy, sz] = blueprint.size;

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

    // mirroring across a plane normal to axis A flips the two quat components not on A; w stays.
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

export type VoxelOp = { wx: number; wy: number; wz: number; key: string };

/** anchor is the world-space position of the blueprint's local (0,0,0); reverse ops capture current world state for undo. */
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

                    const existingKey = getBlock(worldVoxels, wx, wy, wz);
                    reverse.push({ wx, wy, wz, key: existingKey });
                    forward.push({ wx, wy, wz, key });
                }
            }
        }
    }

    return { forward, reverse };
}

/** each entry's top-level transform is re-anchored to world space and rotated; children stay parent-relative. */
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

// inline to avoid import deps
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

// q * v * q^-1, v treated as quaternion [vx, vy, vz, 0]
function rotateVec3ByQuat(v: Vec3, q: Quat): Vec3 {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;

    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;

    // conjugate of a unit quaternion is [-x,-y,-z,w]
    return [
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
}

// voxel data uses the same base64-encoded chunk format as voxel-savefile, so it round-trips through the system clipboard.
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

/** registry rebuilds runtime palette ids from the stable string keys stored in the serialized voxel data. */
export function fromClipboardString(text: string, registry: Blocks): Blueprint | null {
    let parsed: ClipboardBlueprint;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (!parsed || parsed.type !== CLIPBOARD_TYPE) return null;

    let voxels: Voxels | null = null;
    if (parsed.voxels && parsed.hasVoxels) {
        voxels = createVoxels(registry);
        loadVoxels(voxels, parsed.voxels, registry);
    }

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
