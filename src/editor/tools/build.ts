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
import { BLOCK_AIR, getBlockKey } from '../../core/voxels/voxels';
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
import { applyDirectionalProps } from '../build-direction';
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
        const anchor: Vec3 = [s.hoverVoxel[0] + s.hoverNormal[0], s.hoverVoxel[1] + s.hoverNormal[1], s.hoverVoxel[2] + s.hoverNormal[2]];
        store.setState({ placementContinuous: true });
        enterPrefabPlacement(transformToolState, slot.prefabId, anchor, ctx.nodes, ctx);
        return;
    }
    // same auto-enter flow for saved blueprints — the placement preview is
    // the saved scene's voxels + nodes, committed via the standard path.
    if (slot && slot.kind === 'blueprint' && !isInPlacement(transformToolState) && s.hoverVoxel && s.hoverNormal) {
        const anchor: Vec3 = [s.hoverVoxel[0] + s.hoverNormal[0], s.hoverVoxel[1] + s.hoverNormal[1], s.hoverVoxel[2] + s.hoverNormal[2]];
        store.setState({ placementContinuous: true });
        enterBlueprintPlacement(transformToolState, slot.sceneId, anchor, ctx.nodes, ctx);
        return;
    }

    // left click: break the hovered block (set to air)
    if (pointerJustDown(pointer, input) && s.hoverVoxel) {
        const [wx, wy, wz] = s.hoverVoxel;
        const oldKey = getBlockKey(voxels, wx, wy, wz);

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
    const rmb = locked
        ? isMouseJustDown(input.mouseKeyboard, 'right')
        : isMouseTap(input.mouseKeyboard, 'right');
    if (rmb && s.hoverVoxel && s.hoverNormal) {
        const activeBlockKey = slot && slot.kind === 'block' ? slot.blockKey : '';
        if (activeBlockKey) {
            const wx = s.hoverVoxel[0] + s.hoverNormal[0];
            const wy = s.hoverVoxel[1] + s.hoverNormal[1];
            const wz = s.hoverVoxel[2] + s.hoverNormal[2];

            // only place into air
            const existingKey = getBlockKey(voxels, wx, wy, wz);
            if (existingKey === BLOCK_AIR) {
                const placedKey = resolvePlacedKey(
                    activeBlockKey,
                    s.hoverVoxel,
                    s.hoverNormal,
                    s.hoverPoint,
                    camera.quaternion,
                    wx,
                    wy,
                    wz,
                    voxels,
                    ctx.blocks,
                );
                const fwd: Op = { wx, wy, wz, key: placedKey };
                const rev: Op = { wx, wy, wz, key: BLOCK_AIR };

                store.getState().action({
                    label: 'place',
                    do() {
                        send(ctx, VoxelEditCommand, { ops: [fwd] });
                    },
                    undo() {
                        send(ctx, VoxelEditCommand, { ops: [rev] });
                    },
                });
            }
        }
    }
}

// ── placement resolution ──────────────────────────────────────────
//
// pick the final placed key. preference order:
//   1. block's `place` hook (if defined on its def) — gets the full
//      placement ctx (hit point, normal, yaw, pitch) and returns a stateId.
//   2. convention-based applyDirectionalProps — mutates `axis` / `facing`
//      props on the active key based on the hit normal and camera yaw.
//
// if place is defined, the block owns the decision — its return is used
// verbatim. only an unregistered stateId (stateToKey miss) falls through
// to convention, as a defensive guard.

function resolvePlacedKey(
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
): string {
    const parsed = parseKey(activeBlockKey);
    const def = parsed ? registry.idToDef.get(parsed.blockId) : null;

    if (def?.place && hoverPoint) {
        // hit point in clicked block's [0..1]³ local space.
        const hitX = hoverPoint[0] - hoverVoxel[0];
        const hitY = hoverPoint[1] - hoverVoxel[1];
        const hitZ = hoverPoint[2] - hoverVoxel[2];
        const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
        const pitch = pitchFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);

        const stateId = def.place({
            voxels,
            worldX: targetX,
            worldY: targetY,
            worldZ: targetZ,
            normalX: hoverNormal[0],
            normalY: hoverNormal[1],
            normalZ: hoverNormal[2],
            hitX,
            hitY,
            hitZ,
            yaw,
            pitch,
        });
        const key = registry.stateToKey[stateId];
        if (key) return key;
    }

    return applyDirectionalProps(activeBlockKey, hoverNormal, cameraQuat, registry);
}
