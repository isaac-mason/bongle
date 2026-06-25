/**
 * orbit controller script — orbit camera controller.
 *
 * polls blocks' Input each frame instead of attaching DOM listeners (only
 * exception: contextmenu suppression so right-drag pan doesn't pop the menu).
 *
 *   left drag   → rotate (azimuth/polar)
 *   right drag  → pan (screen-space)
 *   wheel       → dolly in/out
 *
 * resolves the camera node via CameraRefTrait on ctx.node (falling back to
 * `ctx.client.camera`) and writes pose to its TransformTrait each frame.
 * the renderer composes its per-room PerspectiveCamera from that node's
 * TransformTrait + CameraTrait via `Renderer.syncRenderCamera`. callers
 * can pre-seed the camera transform (or `target` on this trait) before
 * attach to open with a specific view.
 */

import { mat4, type Spherical, spherical, quat, type Vec3, vec3 } from 'mathcat';
import { env } from '../api/env';
import { isMouseDown, isMouseJustDown, isMouseJustUp } from '../api/input';
import { getTrait } from '../api/scene-graph';
import { getControlNode, onDispose, onFrame, script } from '../api/scripts';
import { trait, type TraitType } from '../api/traits';
import { getWorldPosition, getWorldQuaternion, setWorldPosition, setWorldQuaternion } from '../api/transforms';
import { resolveCamera } from './camera';
import { TransformTrait } from './transform';

const INITIAL_TARGET_DISTANCE = 5;

/**
 * orbit controller. attaching it wires up the orbit camera script
 * (left-drag rotate, right-drag pan, wheel dolly).
 *
 * `target` is the world-space focal point the camera orbits / pans around.
 * mutable — pan writes back into it and the editor reconcile loop seeds it
 * on takeover.
 *
 * `eye` is the initial world-space camera position. consumed once on
 * attach to seed the camera transform + spherical state. leave the
 * default (null) to use whatever pose the camera transform already
 * carries (set externally before attach, or the room default).
 */
export const OrbitControllerTrait = trait(
    'engine:orbit-controller',
    {
        target: () => [0, 0, -INITIAL_TARGET_DISTANCE] as Vec3,
        eye: null as Vec3 | null,
    },
    { persist: false },
);

export type OrbitControllerTrait = TraitType<typeof OrbitControllerTrait>;

const _TWO_PI = 2 * Math.PI;
const _v: Vec3 = [0, 0, 0];
const _right: Vec3 = [0, 0, 0];
const _up: Vec3 = [0, 0, 0];
const _eye: Vec3 = [0, 0, 0];
const _lookMat = mat4.create();
const _lookQuat = quat.create();
const _UP: Vec3 = [0, 1, 0];

// tunables
const ROTATE_SPEED = 1.0;
const PAN_SPEED = 1.0;
const ZOOM_SPEED = 1.0;
const DAMPING_FACTOR = 0.05;
const MIN_DISTANCE = 0.1;
const MAX_DISTANCE = 10000;
const MIN_POLAR = 0;
const MAX_POLAR = Math.PI;

type DragMode = 'none' | 'rotate' | 'pan';

script(
    OrbitControllerTrait,
    'controller',
    (ctx) => {
        if (!env.client) return;

        const client = ctx.client!;
        const { input } = client;
        const viewport = client.state!.viewport;
        const mk = input.mouseKeyboard;

        // ── camera — resolved through CameraRefTrait on ctx.node (with fallback
        // to the room's default at client.camera), so editor lenses that point
        // editorNode's CameraRefTrait at a lens-private camera drive their own
        // camera. camera-node lifecycle is owned by whoever installed the ref
        // (room init or editor lens); onDispose only clears the contextmenu
        // listener.
        const { camera: cameraTrait, node: cameraNode } = resolveCamera(ctx);
        const cameraTransform = getTrait(cameraNode, TransformTrait)!;

        // mirror targets for the orbit eye position. orbit only writes to
        // cameraTransform (a separate scene-root camera node), so ctx.node's
        // TransformTrait never moves. see fly-controller for the full
        // rationale — same two cases (real edit room: ctx.node ===
        // room.playerNode is the server-authoritative anchor; local lens:
        // ctx.node is client-only and we additionally mirror into
        // room.playerNode so owner-sync carries the anchor to the server).
        const nodeTransform = getTrait(ctx.node, TransformTrait);

        // ── state (closure, mutable) ───────────────────────────────────
        // initial eye: either the `eye` trait field if set, or whatever the
        // camera transform currently holds. target stays on the trait
        // (mutated by pan).
        const target = ctx.trait.target;
        const seedEye = ctx.trait.eye;
        if (seedEye) setWorldPosition(cameraTransform, seedEye);
        const eyeWp = getWorldPosition(cameraTransform);
        const eye: Vec3 = [eyeWp[0], eyeWp[1], eyeWp[2]];

        const sph: Spherical = spherical.create();
        const sphDelta: Spherical = spherical.create();
        const panOffset: Vec3 = [0, 0, 0];
        let scaleAccum = 1;

        vec3.subtract(_v, eye, target);
        spherical.setFromVec3(sph, _v);

        let dragMode: DragMode = 'none';

        // suppress browser context menu so right-drag pan doesn't pop the menu.
        const onContextMenu = (e: Event): void => {
            e.preventDefault();
        };
        window.addEventListener('contextmenu', onContextMenu);

        // point the camera at target (eye is already where we want it).
        mat4.targetTo(_lookMat, eye, target, _UP);
        quat.fromMat4(_lookQuat, _lookMat);
        setWorldQuaternion(cameraTransform, _lookQuat);

        onDispose(ctx, () => {
            window.removeEventListener('contextmenu', onContextMenu);
        });

        // pan in screen space: deltaX/deltaY are pixels
        const pan = (deltaX: number, deltaY: number): void => {
            const h = viewport.height;
            const camPos = getWorldPosition(cameraTransform);
            const camQuat = getWorldQuaternion(cameraTransform);
            vec3.subtract(_v, camPos, target);
            const targetDistance = vec3.length(_v) * Math.tan(cameraTrait.fov / 2);

            // pan left: -camera-right * (2 * dx * targetDistance / h)
            vec3.transformQuat(_right, [1, 0, 0], camQuat);
            vec3.scaleAndAdd(panOffset, panOffset, _right, (-2 * deltaX * targetDistance) / h);

            // pan up: camera-up * (2 * dy * targetDistance / h)
            vec3.transformQuat(_up, [0, 1, 0], camQuat);
            vec3.scaleAndAdd(panOffset, panOffset, _up, (2 * deltaY * targetDistance) / h);
        };

        const zoomScale = (delta: number): number => 0.95 ** (ZOOM_SPEED * Math.abs(delta * 0.01));

        onFrame(ctx, (_args) => {
            if (getControlNode(ctx) !== ctx.node) return;
            // Skip until the viewport has a real size — the ResizeObserver
            // hasn't fired yet on the first frame(s) after attach. Without
            // this, the `viewport.height || 1` fallback below divides mouse
            // deltas by 1 instead of ~the canvas height, amplifying any
            // early drag by ~1000x and hurling the camera into junk
            // spherical coords that persist after resize lands.
            if (!viewport.height) return;
            // ── drag mode transitions ─────────────────────────────
            if (dragMode === 'none') {
                if (isMouseJustDown(mk, 'left')) dragMode = 'rotate';
                else if (isMouseJustDown(mk, 'right')) dragMode = 'pan';
            }
            if (dragMode === 'rotate' && (isMouseJustUp(mk, 'left') || !isMouseDown(mk, 'left'))) {
                dragMode = 'none';
            }
            if (dragMode === 'pan' && (isMouseJustUp(mk, 'right') || !isMouseDown(mk, 'right'))) {
                dragMode = 'none';
            }

            // ── apply per-frame mouse delta ────────────────────────
            const h = viewport.height;
            if (dragMode === 'rotate') {
                // rotateLeft (azimuth) = -dx; rotateUp (polar) = -dy
                sphDelta[1] -= (_TWO_PI * mk._dx * ROTATE_SPEED) / h;
                sphDelta[2] -= (_TWO_PI * mk._dy * ROTATE_SPEED) / h;
            } else if (dragMode === 'pan') {
                pan(mk._dx * PAN_SPEED, mk._dy * PAN_SPEED);
            }

            // ── wheel dolly ───────────────────────────────────────
            if (mk._wheelDeltaY > 0) {
                scaleAccum /= zoomScale(mk._wheelDeltaY);
            } else if (mk._wheelDeltaY < 0) {
                scaleAccum *= zoomScale(mk._wheelDeltaY);
            }

            // ── update spherical from current eye relative to target ──
            const camPos = getWorldPosition(cameraTransform);
            eye[0] = camPos[0];
            eye[1] = camPos[1];
            eye[2] = camPos[2];
            vec3.subtract(_v, eye, target);
            spherical.setFromVec3(sph, _v);

            // apply deltas (with damping)
            sph[1] += sphDelta[1] * DAMPING_FACTOR;
            sph[2] += sphDelta[2] * DAMPING_FACTOR;

            // clamp polar
            sph[2] = Math.max(MIN_POLAR, Math.min(MAX_POLAR, sph[2]));
            spherical.makeSafe(sph, sph);

            // apply pan offset to target (with damping)
            vec3.scaleAndAdd(target, target, panOffset, DAMPING_FACTOR);

            // apply zoom scale to radius
            sph[0] = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, sph[0] * scaleAccum));

            // convert spherical back to eye position
            spherical.toVec3(_v, sph);
            vec3.add(_eye, target, _v);

            // write pose to the camera node transform
            setWorldPosition(cameraTransform, _eye);
            mat4.targetTo(_lookMat, _eye, target, _UP);
            quat.fromMat4(_lookQuat, _lookMat);
            setWorldQuaternion(cameraTransform, _lookQuat);
            if (nodeTransform) setWorldPosition(nodeTransform, _eye);

            // damping decay
            sphDelta[1] *= 1 - DAMPING_FACTOR;
            sphDelta[2] *= 1 - DAMPING_FACTOR;
            vec3.scale(panOffset, panOffset, 1 - DAMPING_FACTOR);
            scaleAccum = 1;
        });
    },
    { editor: true },
);
