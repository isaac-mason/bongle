import type { PerspectiveCamera } from 'gpucat';
import type { Quat, Vec3 } from 'math';
import type { Input } from '../../client/input';
import { isMouseJustDown, isMouseTap } from '../../client/input';
import type { ScriptContext } from '../../core/scene/scripts';
import type { Blocks } from '../../core/voxels/block-registry';
import { parseKey, resolveKey } from '../../core/voxels/block-registry';
import type { PlaceIO } from '../../core/voxels/blocks';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import { pitchFromQuat, yawFromQuat } from '../camera';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { playBlockEdit } from '../sounds';
import { commitVoxelOps } from '../voxel-edit';
import type { PlacementTool } from './placement';
import { enterBlueprintPlacement, enterPrefabPlacement, isInPlacement } from './placement';

type Op = { wx: number; wy: number; wz: number; key: string };

export function updateBuild(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    input: Input,
    voxels: Voxels,
    placement: PlacementTool,
    camera: PerspectiveCamera,
): void {
    const s = store.getState();
    // auto-enters prefab placement when the active slot is a prefab, mirroring ctrl+v then g;
    // mismatch detection (slot switched mid-placement) lives in inspect.ts since activeTool
    // flips to 'transform' as soon as placement starts and this stops firing
    const hotbar = useEditor.getState().hotbar;
    const activeSlotIndex = s.activeSlotIndex;
    const slot = hotbar[activeSlotIndex] ?? null;
    if (slot && slot.kind === 'prefab' && !isInPlacement(placement) && s.hoverVoxel && s.hoverNormal) {
        const anchor: Vec3 = [
            s.hoverVoxel[0] + s.hoverNormal[0],
            s.hoverVoxel[1] + s.hoverNormal[1],
            s.hoverVoxel[2] + s.hoverNormal[2],
        ];
        store.setState({ placementContinuous: true });
        enterPrefabPlacement(placement, slot.prefabId, anchor, ctx.scene, ctx);
        return;
    }
    // same auto-enter flow for saved blueprints; the placement preview is the saved scene's voxels + nodes
    if (slot && slot.kind === 'blueprint' && !isInPlacement(placement) && s.hoverVoxel && s.hoverNormal) {
        const anchor: Vec3 = [
            s.hoverVoxel[0] + s.hoverNormal[0],
            s.hoverVoxel[1] + s.hoverNormal[1],
            s.hoverVoxel[2] + s.hoverNormal[2],
        ];
        store.setState({ placementContinuous: true });
        enterBlueprintPlacement(placement, slot.sceneId, anchor, ctx.scene, ctx);
        return;
    }

    // left click: break the hovered block (set to air)
    if (isMouseJustDown(input.mouseKeyboard, 'left') && s.hoverVoxel) {
        const [wx, wy, wz] = s.hoverVoxel;
        const oldKey = getBlock(voxels, wx, wy, wz);

        if (oldKey !== BLOCK_AIR) {
            const fwd: Op = { wx, wy, wz, key: BLOCK_AIR };
            const rev: Op = { wx, wy, wz, key: oldKey };
            // sfx identity resolved once at dispatch, since the cell reads as air from here on
            const state = resolveKey(ctx.blocks, oldKey);

            store.getState().action({
                label: 'break',
                do() {
                    commitVoxelOps(ctx, [fwd]);
                    playBlockEdit(ctx, state, 'break', wx, wy, wz);
                },
                undo() {
                    commitVoxelOps(ctx, [rev]);
                    playBlockEdit(ctx, state, 'place', wx, wy, wz);
                },
            });
        }
    }

    // right click places on the adjacent face: fires on down when pointer-locked (unambiguous RMB),
    // else on tap, so a drag-look/pan release doesn't also place; the lock check below then stops a double-fire.
    const locked = !!document.pointerLockElement;
    const rmb = locked ? isMouseJustDown(input.mouseKeyboard, 'right') : isMouseTap(input.mouseKeyboard, 'right');
    if (rmb && s.hoverVoxel && s.hoverNormal) {
        const activeBlockKey = slot && slot.kind === 'block' ? slot.blockKey : '';
        if (activeBlockKey) {
            const tx = s.hoverVoxel[0] + s.hoverNormal[0];
            const ty = s.hoverVoxel[1] + s.hoverNormal[1];
            const tz = s.hoverVoxel[2] + s.hoverNormal[2];

            // only place into air (the block's `place` may validate further cells)
            if (getBlock(voxels, tx, ty, tz) === BLOCK_AIR) {
                const placement = resolvePlacement(
                    activeBlockKey,
                    s.hoverVoxel,
                    s.hoverNormal,
                    s.hoverPoint,
                    camera.quaternion,
                    tx,
                    ty,
                    tz,
                    voxels,
                    ctx.blocks,
                );
                if (placement) {
                    // sfx keyed to the palette selection, not the written op: a multi-cell
                    // `place` hook (door, bed) writes several states but is one material and one sound
                    const state = resolveKey(ctx.blocks, activeBlockKey);

                    store.getState().action({
                        label: 'place',
                        do() {
                            commitVoxelOps(ctx, placement.fwd);
                            playBlockEdit(ctx, state, 'place', tx, ty, tz);
                        },
                        undo() {
                            commitVoxelOps(ctx, placement.rev);
                            playBlockEdit(ctx, state, 'break', tx, ty, tz);
                        },
                    });
                }
            }
        }
    }
}

// runs the block's `place` hook (if any) against a recording `io`, capturing each touched cell's
// original key for undo; returns null if `place` wrote nothing (aborted), e.g. a door with no headroom
function resolvePlacement(
    activeBlockKey: string,
    hoverVoxel: readonly [number, number, number],
    hoverNormal: Vec3,
    hoverPoint: readonly [number, number, number] | null,
    cameraQuat: Quat,
    targetX: number,
    targetY: number,
    targetZ: number,
    voxels: Voxels,
    registry: Blocks,
): { fwd: Op[]; rev: Op[] } | null {
    const parsed = parseKey(activeBlockKey);
    const def = parsed ? registry.idToDef.get(parsed.blockId) : null;

    const writes = new Map<string, Op>(); // last forward write per cell
    const reverses = new Map<string, Op>(); // original key per cell (first touch)
    const pending = new Map<string, string>(); // pending key per cell (for io.get)
    const cellId = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const io: PlaceIO = {
        get(x, y, z) {
            const p = pending.get(cellId(x, y, z));
            return p !== undefined ? p : getBlock(voxels, x, y, z);
        },
        set(x, y, z, key) {
            const id = cellId(x, y, z);
            if (!reverses.has(id)) {
                reverses.set(id, { wx: x, wy: y, wz: z, key: getBlock(voxels, x, y, z) });
            }
            writes.set(id, { wx: x, wy: y, wz: z, key });
            pending.set(id, key);
        },
    };

    if (def?.place && hoverPoint) {
        // hitX/Y/Z are in the clicked block's 0 to 1 local space
        def.place(
            {
                worldX: targetX,
                worldY: targetY,
                worldZ: targetZ,
                normalX: hoverNormal[0],
                normalY: hoverNormal[1],
                normalZ: hoverNormal[2],
                hitX: hoverPoint[0] - hoverVoxel[0],
                hitY: hoverPoint[1] - hoverVoxel[1],
                hitZ: hoverPoint[2] - hoverVoxel[2],
                yaw: yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]),
                pitch: pitchFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]),
            },
            io,
        );
    } else {
        io.set(targetX, targetY, targetZ, activeBlockKey);
    }

    if (writes.size === 0) return null;
    return { fwd: [...writes.values()], rev: [...reverses.values()] };
}
