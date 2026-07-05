/**
 * fly controller, trait + script.
 *
 * the trait holds tunables (speed, look sensitivity, scroll-adjust bounds)
 * so they can be edited in the inspector. on init the script grabs the active
 * camera node (`getCamera(ctx)`) and writes pose to its TransformTrait each
 * frame while it's the subject; the renderer reads pose + projection from
 * there. the editor lens points `client.camera` at a lens-private camera so
 * its pose survives play↔edit toggles.
 *
 * polls blocks' Input each frame instead of attaching DOM listeners (only
 * exception: contextmenu suppression so right-drag works, and pointer-lock
 * request/exit on right-button press/release).
 */

import { type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { env } from '../api/env';
import { isKeyDown, isMouseDragStart, isMouseJustUp } from '../api/input';
import { setPointerLock } from '../api/pointer-lock';
import { prop } from '../api/prop';
import { getTrait } from '../api/scene-graph';
import { onDispose, onFrame, script } from '../api/scripts';
import { getCamera, getSubject } from '../api/subject';
import { control, type TraitType, trait } from '../api/traits';
import { getWorldPosition, getWorldQuaternion, setWorldPosition, setWorldQuaternion } from '../api/transforms';
import { TransformTrait } from './transform';

const _EPS = 0.000001;

// scratch, single-threaded, safe to share
const _forward: Vec3 = [0, 0, 0];
const _right: Vec3 = [0, 0, 0];
const _moveDir: Vec3 = [0, 0, 0];
const _qYaw: Quat = [0, 0, 0, 1];
const _qPitch: Quat = [0, 0, 0, 1];
const _qTmp: Quat = [0, 0, 0, 1];
const _qOut: Quat = [0, 0, 0, 1];
const _posOut: Vec3 = [0, 0, 0];

const AXIS_UP: Vec3 = [0, 1, 0];
const AXIS_RIGHT: Vec3 = [1, 0, 0];

const PITCH_LIMIT = Math.PI / 2 - 0.01;

// ── trait ─────────────────────────────────────────────────────────────

/**
 * fly controller tunables.
 *
 * `speed` is the live move speed; updated by the wheel-adjust path while
 * pointer-locked. the rest are caps and rates configurable via inspector.
 */
export const FlyControllerTrait = trait(
    'engine:fly-controller',
    {
        /** current move speed in units per second. wheel-adjusts within [minSpeed, maxSpeed]. */
        speed: 10,

        /** look sensitivity in radians per pixel of mouse movement. */
        lookSpeed: 0.002,

        /** wheel scroll up / down scales speed by this factor each notch. */
        speedScrollFactor: 1.1,
        minSpeed: 0.1,
        maxSpeed: 200,

        /**
         * smoothing half-life in seconds for both translation and look.
         * 0 = off (instant, snappy, default).
         * higher = smoother for cinematic / video capture (try 0.1-0.3).
         */
        damping: 0,
    },
    { persist: false },
);

/** instance type for FlyControllerTrait */
export type FlyControllerTrait = TraitType<typeof FlyControllerTrait>;

control(FlyControllerTrait, 'speed', {
    schema: prop.number(),
    get: (t) => t.speed,
    set: (t, v) => {
        t.speed = v;
    },
});
control(FlyControllerTrait, 'lookSpeed', {
    schema: prop.number(),
    get: (t) => t.lookSpeed,
    set: (t, v) => {
        t.lookSpeed = v;
    },
});
control(FlyControllerTrait, 'speedScrollFactor', {
    schema: prop.number(),
    get: (t) => t.speedScrollFactor,
    set: (t, v) => {
        t.speedScrollFactor = v;
    },
});
control(FlyControllerTrait, 'minSpeed', {
    schema: prop.number(),
    get: (t) => t.minSpeed,
    set: (t, v) => {
        t.minSpeed = v;
    },
});
control(FlyControllerTrait, 'maxSpeed', {
    schema: prop.number(),
    get: (t) => t.maxSpeed,
    set: (t, v) => {
        t.maxSpeed = v;
    },
});
control(FlyControllerTrait, 'damping', {
    schema: prop.number(),
    get: (t) => t.damping,
    set: (t, v) => {
        t.damping = v;
    },
});

script(
    FlyControllerTrait,
    'controller',
    (ctx) => {
        if (!env.client) return;

        const client = ctx.client!;
        const room = client.room!;
        const { input } = client;

        // ── camera: the active camera node on the client state
        // (`getCamera(ctx)`, the room default in play, a lens-private camera
        // under the editor). the camera node lives at the scene root (NOT
        // parented under ctx.node) which dodges parent-frame
        // inheritance from controllers like CharacterController whose body yaw
        // would otherwise drag the camera with the head.
        // re-resolved each active frame in onFrame; the init value seeds baseQuat.
        let cameraNode = getCamera(ctx)!;
        let cameraTransform = getTrait(cameraNode, TransformTrait)!;

        // mirror targets for the camera pose. fly only writes to cameraTransform
        // (a separate scene-root camera node), so ctx.node's TransformTrait never
        // moves. that matters because:
        //  - real edit room: ctx.node === room.playerNode, server-authoritative.
        //    server's Discovery.getPlayerChunkCoord reads this trait, without
        //    a write here, the anchor stays stuck at spawn.
        //  - local editor lens: ctx.node is a realm:'client' editorNode the
        //    server never sees; we additionally mirror into room.playerNode so
        //    its owner-synced TransformTrait carries the anchor to the server.
        const nodeTransform = getTrait(ctx.node, TransformTrait);

        // ── state (closure, mutable) ───────────────────────────────────
        // base orientation captured at takeover (and on any external camera
        // change); yaw/pitch are deltas applied around world-Y and local-X
        // respectively. this preserves any prior orientation including roll
        // exactly at the moment of transition (orbit→fly handoff).
        const baseQuat: Quat = quat.clone(getWorldQuaternion(cameraTransform));
        // applied yaw/pitch; lerps toward target* when damping > 0
        let yawDelta = 0;
        let pitchDelta = 0;
        // raw input accumulators, receive mouse delta directly
        let targetYawDelta = 0;
        let targetPitchDelta = 0;
        // absolute world-pitch baked into baseQuat. the clamp below enforces
        // basePitch + pitchDelta ∈ [−PITCH_LIMIT, PITCH_LIMIT] so total pitch
        // stays bounded across rebases (right-click handoff or focusNode teleport).
        let basePitch = 0;
        const lastQuaternion: Quat = quat.clone(baseQuat);
        // damped move velocity (world-space). lerps toward _targetVel each frame.
        const _velocity: Vec3 = [0, 0, 0];
        const _targetVel: Vec3 = [0, 0, 0];

        // adopt the current camera orientation as the new base. used at startup
        // and whenever an external system (focusNode teleport) overwrites the
        // camera quat between frames.
        const rebaseToCurrent = (): void => {
            quat.copy(baseQuat, getWorldQuaternion(cameraTransform));
            yawDelta = 0;
            pitchDelta = 0;
            targetYawDelta = 0;
            targetPitchDelta = 0;
            // kill momentum on rebase, focusNode teleports / takeover should
            // not preserve velocity from the prior orientation.
            vec3.set(_velocity, 0, 0, 0);
            vec3.set(_forward, 0, 0, -1);
            vec3.transformQuat(_forward, _forward, baseQuat);
            basePitch = Math.asin(Math.max(-1, Math.min(1, _forward[1])));
        };

        // suppress browser context menu so right-drag look doesn't pop the menu.
        const onContextMenu = (e: Event): void => {
            e.preventDefault();
        };
        window.addEventListener('contextmenu', onContextMenu);

        // fly declares no persistent lock intent — it locks only during a right-
        // drag. clear any intent a prior lens (character) left set on this room.
        setPointerLock(ctx, false);

        onDispose(ctx, () => {
            window.removeEventListener('contextmenu', onContextMenu);
            setPointerLock(ctx, false);
        });

        onFrame(ctx, ({ delta }) => {
            if (getSubject(ctx) !== ctx.node) return;
            // re-resolve the active camera (subject ⟹ client.camera is ours),
            // so an editor lens swap never strands us on a stale camera node.
            cameraNode = getCamera(ctx)!;
            cameraTransform = getTrait(cameraNode, TransformTrait)!;
            const fly = ctx.trait;

            // rebase if the camera quaternion was changed externally
            // (e.g. focusNode teleport), adopt the new orientation as base
            // and zero deltas so the next frame produces it exactly.
            const camQuat = getWorldQuaternion(cameraTransform);
            const dot =
                lastQuaternion[0] * camQuat[0] +
                lastQuaternion[1] * camQuat[1] +
                lastQuaternion[2] * camQuat[2] +
                lastQuaternion[3] * camQuat[3];
            if (8 * (1 - Math.abs(dot)) > 1e-6) {
                rebaseToCurrent();
            }

            // ── pointer-lock right-drag look ───────────────────────
            // wait for the drag threshold so a quick right-click stays
            // available to other tools (e.g. build tool placement).
            if (isMouseDragStart(input.mouseKeyboard, 'right')) {
                // rebase on click so the ±PITCH_LIMIT clamp is measured
                // from the current orientation rather than the original base.
                rebaseToCurrent();
                // the right button is held here (active user gesture), so this
                // acquires the lock immediately.
                setPointerLock(ctx, true);
            }
            if (isMouseJustUp(input.mouseKeyboard, 'right')) {
                setPointerLock(ctx, false);
            }

            // the actual lock is the source of truth for look/move/wheel: ESC
            // frees it and everything stops the same frame, no `looking` desync.
            const locked = !!document.pointerLockElement;
            if (locked) {
                targetYawDelta -= input.mouseKeyboard._dx * fly.lookSpeed;
                targetPitchDelta -= input.mouseKeyboard._dy * fly.lookSpeed;
                targetPitchDelta = Math.max(-PITCH_LIMIT - basePitch, Math.min(PITCH_LIMIT - basePitch, targetPitchDelta));
            }

            // exponential smoothing factor, k=1 when damping=0 (instant snap,
            // preserves the original snappy behavior). higher damping → slower
            // lerp, smoother camera for video capture.
            const k = fly.damping > 0 ? 1 - Math.exp(-delta / fly.damping) : 1;
            yawDelta += (targetYawDelta - yawDelta) * k;
            pitchDelta += (targetPitchDelta - pitchDelta) * k;

            // ── wheel speed adjust ─────────────────────────────────
            // gate on the lock so the wheel is free for editor scrolling
            // (e.g. inventory, inspector) when the user isn't actively flying.
            if (locked && input.mouseKeyboard._wheelDeltaY !== 0) {
                if (input.mouseKeyboard._wheelDeltaY < 0) {
                    fly.speed = Math.min(fly.maxSpeed, fly.speed * fly.speedScrollFactor);
                } else {
                    fly.speed = Math.max(fly.minSpeed, fly.speed / fly.speedScrollFactor);
                }
                // flySpeedShownAt is per-room editor state. play rooms have no
                // edit-room store registered, the write silently no-ops there.
                room.editorStore?.setState({ flySpeedShownAt: performance.now() });
            }

            // ── compose target world-quat from base + yaw + pitch ──
            quat.setAxisAngle(_qYaw, AXIS_UP, yawDelta);
            quat.setAxisAngle(_qPitch, AXIS_RIGHT, pitchDelta);
            quat.multiply(_qTmp, _qYaw, baseQuat);
            quat.multiply(_qOut, _qTmp, _qPitch);

            // ── WASD movement (pointer-locked only) ────────────────
            // gate all movement on the lock so WASD/Space/Shift stay free
            // for editor shortcuts and selection modifiers when not flying.
            const fwd = locked
                ? (isKeyDown(input.mouseKeyboard, 'KeyW') ? 1 : 0) - (isKeyDown(input.mouseKeyboard, 'KeyS') ? 1 : 0)
                : 0;
            const strafe = locked
                ? (isKeyDown(input.mouseKeyboard, 'KeyD') ? 1 : 0) - (isKeyDown(input.mouseKeyboard, 'KeyA') ? 1 : 0)
                : 0;
            const vertical = locked
                ? (isKeyDown(input.mouseKeyboard, 'Space') ? 1 : 0) -
                  (isKeyDown(input.mouseKeyboard, 'ShiftLeft') || isKeyDown(input.mouseKeyboard, 'ShiftRight') ? 1 : 0)
                : 0;
            // build target velocity in world-space (zero when no input, lerps
            // velocity back to zero on key-up for smooth deceleration).
            vec3.set(_targetVel, 0, 0, 0);
            if (fwd !== 0 || strafe !== 0 || vertical !== 0) {
                vec3.set(_forward, 0, 0, -1);
                vec3.transformQuat(_forward, _forward, _qOut);
                vec3.set(_right, 1, 0, 0);
                vec3.transformQuat(_right, _right, _qOut);
                vec3.set(_moveDir, 0, 0, 0);
                vec3.scaleAndAdd(_moveDir, _moveDir, _forward, fwd);
                vec3.scaleAndAdd(_moveDir, _moveDir, _right, strafe);
                _moveDir[1] += vertical;
                const len = vec3.length(_moveDir);
                if (len > _EPS) vec3.scale(_targetVel, _moveDir, fly.speed / len);
            }
            _velocity[0] += (_targetVel[0] - _velocity[0]) * k;
            _velocity[1] += (_targetVel[1] - _velocity[1]) * k;
            _velocity[2] += (_targetVel[2] - _velocity[2]) * k;

            // ── write pose to the camera node transform ────────────
            const camPos = getWorldPosition(cameraTransform);
            _posOut[0] = camPos[0] + _velocity[0] * delta;
            _posOut[1] = camPos[1] + _velocity[1] * delta;
            _posOut[2] = camPos[2] + _velocity[2] * delta;
            setWorldPosition(cameraTransform, _posOut);
            setWorldQuaternion(cameraTransform, _qOut);
            if (nodeTransform) setWorldPosition(nodeTransform, _posOut);

            quat.copy(lastQuaternion, _qOut);

            // sync speed back to store if it changed (UI indicator).
            // covers both wheel-adjust and inspector edits.
            const editorStore = room.editorStore;
            if (editorStore && fly.speed !== editorStore.getState().flySpeed) {
                editorStore.setState({ flySpeed: fly.speed });
            }
        });
    },
    { editor: true },
);
