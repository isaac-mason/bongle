// build tool update function.
//
// called each frame from EditorScript onFrame (client only).
// left click: break (delete) the hovered voxel.
// right click: place the active palette block on the adjacent face. the
// trigger is mode-aware:
//   - pointer already locked at RMB-down (e.g. character-controller view
//     where RMB is unambiguous) → fire immediately on down for snappy
//     placement feel.
//   - cursor visible at RMB-down (fly / orbit) → fire on tap (mouse-up
//     without crossing the drag threshold) so that a drag-look or
//     drag-pan release doesn't also place a block.
// the lock check on the tap branch prevents a double-fire: when the
// down branch already placed, RMB-up will still produce a tap event
// (no drag crossed because the cursor was frozen), but pointer-lock
// is still active on that frame so the tap branch self-suppresses.
//
// each break/place is a single undoable action.

import type { ScriptContext } from '../../core/scene/scripts';
import { send } from '../../core/scene/scripts';
import { VoxelEditCommand } from '../commands';
import type { Voxels } from '../../core/voxels/voxels';
import { BLOCK_AIR, getBlock } from '../../core/voxels/voxels';
import type { PlaceIO } from '../../core/voxels/blocks';
import type { BlockRegistry } from '../../core/voxels/block-registry';
import { parseKey } from '../../core/voxels/block-registry';
import type { PointerState } from '../pointer-state';
import { pointerJustDown } from '../pointer-state';
import type { EditRoomStoreApi } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { isMouseJustDown, isMouseTap } from '../../client/input';
import type { Input } from '../../client/input';
import type { TransformToolState } from './transform';
import { enterBlueprintPlacement, enterPrefabPlacement, isInPlacement } from './transform';
import { pitchFromQuat, yawFromQuat } from '../camera';
import type { PerspectiveCamera } from 'gpucat';
import type { Quat, Vec3 } from 'mathcat';

type Op = { wx: number; wy: number; wz: number; key: string };

// ── per-frame update ───────────────────────────────────────────────

export function updateBuild(
    store: EditRoomStoreApi,
    ctx: ScriptContext,
    pointer: PointerState,
    input: Input,
    voxels: Voxels,
    transformToolState: TransformToolState,
    camera: PerspectiveCamera,
): void {
    const s = store.getState();
    // auto-enter prefab placement when the active slot is a prefab. mirrors
    // ctrl+v→g — ghost follows the cursor and right-click commits, then the
    // continuous-placement loop re-arms the next instance. mismatch detection
    // (user switched slot mid-placement) lives in inspect.ts since activeTool
    // flips to 'transform' as soon as placement starts and we stop firing.
    const hotbar = useEditor.getState().hotbar;
    const activeSlotIndex = s.activeSlotIndex;
    const slot = hotbar[activeSlotIndex] ?? null;
    if (slot && slot.kind === 'prefab' && !isInPlacement(transformToolState) && s.hoverVoxel && s.hoverNormal) {
        const anchor: Vec3 = [
            s.hoverVoxel[0] + s.hoverNormal[0],
            s.hoverVoxel[1] + s.hoverNormal[1],
            s.hoverVoxel[2] + s.hoverNormal[2],
        ];
        store.setState({ placementContinuous: true });
        enterPrefabPlacement(transformToolState, slot.prefabId, anchor, ctx.nodes, ctx);
        return;
    }
    // same auto-enter flow for saved blueprints — the placement preview is
    // the saved scene's voxels + nodes, committed via the standard path.
    if (slot && slot.kind === 'blueprint' && !isInPlacement(transformToolState) && s.hoverVoxel && s.hoverNormal) {
        const anchor: Vec3 = [
            s.hoverVoxel[0] + s.hoverNormal[0],
            s.hoverVoxel[1] + s.hoverNormal[1],
            s.hoverVoxel[2] + s.hoverNormal[2],
        ];
        store.setState({ placementContinuous: true });
        enterBlueprintPlacement(transformToolState, slot.sceneId, anchor, ctx.nodes, ctx);
        return;
    }

    // left click: break the hovered block (set to air)
    if (pointerJustDown(pointer, input) && s.hoverVoxel) {
        const [wx, wy, wz] = s.hoverVoxel;
        const oldKey = getBlock(voxels, wx, wy, wz);

        // don't break air
        if (oldKey !== BLOCK_AIR) {
            const fwd: Op = { wx, wy, wz, key: BLOCK_AIR };
            const rev: Op = { wx, wy, wz, key: oldKey };

            store.getState().action({
                label: 'break',
                do() {
                    send(ctx, VoxelEditCommand, { ops: [fwd] });
                },
                undo() {
                    send(ctx, VoxelEditCommand, { ops: [rev] });
                },
            });
        }
    }

    // right click: place the active block on the adjacent face.
    // prefab slots never reach here — auto-enter above intercepts them and
    // commit/re-arm is driven by the transform-tool place-mode handler.
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
                    store.getState().action({
                        label: 'place',
                        do() {
                            send(ctx, VoxelEditCommand, { ops: placement.fwd });
                        },
                        undo() {
                            send(ctx, VoxelEditCommand, { ops: placement.rev });
                        },
                    });
                }
            }
        }
    }
}

// ── placement resolution ──────────────────────────────────────────
//
// runs the block's `place` hook (if any) against a recording `io`: each
// io.set becomes a forward edit op and (on first touch of a cell) captures
// that cell's original key as the reverse op for undo; io.get reads the
// world, reflecting this place-action's own pending writes. a block with no
// `place` hook just writes its selected key at the target cell. returns null
// if `place` wrote nothing (aborted) — e.g. a door with no headroom.

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
    registry: BlockRegistry,
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
        // hit point in the clicked block's [0..1]³ local space.
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
        // no place hook — write the selected key as-is at the target cell.
        io.set(targetX, targetY, targetZ, activeBlockKey);
    }

    if (writes.size === 0) return null;
    return { fwd: [...writes.values()], rev: [...reverses.values()] };
}
