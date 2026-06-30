/**
 * player controller — mouse/keyboard input + camera + per-player UX.
 *
 * pairs with `CharacterControllerTrait` (the sim). this trait *writes* the
 * CC's input fields (facing/move/jump/sprint/crouch/noclip) from real input
 * and *reads* its output (velocity/grounded/_stepSmoothOffset) for camera +
 * debug viz. an NPC system would use CC directly without this trait.
 *
 * camera supports three perspectives, cycled with 'C':
 *   - first        — at the head, looking forward
 *   - third-back   — behind the head, looking forward
 *   - third-front  — in front of the head, looking back at the face
 *
 * third-person collision is a raycast from the head along the offset
 * direction; the camera distance is clamped to the nearest hit (against
 * voxels + bodies, excluding the character's own kinematic inner body).
 */

import { CastRayStatus, castRay, createClosestCastRayCollector, createDefaultCastRaySettings } from 'crashcat';
import {
    createSphereGeometry,
    LineMaterial,
    LineSegments,
    LineSegmentsGeometry,
    Material,
    Mesh,
    positionClip,
    type Scene,
    vec4f,
} from 'gpucat';
import type { Mat4, Quat, Vec3 } from 'mathcat';
import { degreesToRadians, mat4, quat, vec3 } from 'mathcat';
import { warn } from '../api/debug';
import { env } from '../api/env';
import {
    consumeTouchButtonLookDrag,
    getCanvasTouches,
    getJoystick,
    type Input,
    isKeyDown,
    isKeyJustDown,
    isTouchButtonDown,
} from '../api/input';
import { isTouchDevice, isTouchPrimary } from '../api/mobile';
import { createJoystick, createTouchButton } from '../api/mobile-controls';
import type { Physics } from '../api/physics';
import { prop } from '../api/prop';
import { getTrait } from '../api/scene-graph';
import { getControlNode, isOwner, onDispose, onFrame, onInit, onTick, onUpdate, script } from '../api/scripts';
import { control, type TraitType, trait } from '../api/traits';
import { getVisualWorldPosition, setWorldPosition, setWorldQuaternion } from '../api/transforms';
import { UILayer } from '../client/ui-layers';
import type * as vcc from '../core/physics/vcc';
import { BLOCK_FLAG_COLLISION } from '../core/voxels/block-registry';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import { type CameraTrait, resolveCamera } from './camera';
import { applyNoclipDisplacement, CharacterControllerTrait } from './character-controller';
import { TransformTrait } from './transform';

// ── perspective ───────────────────────────────────────────────────────

export type Perspective = 'first' | 'third-back' | 'third-front';
const PERSPECTIVE_ORDER: Perspective[] = ['first', 'third-back', 'third-front'];

/**
 * Input + HUD wiring for the player controller. One master switch plus
 * grouped sub-knobs for desktop and touch behaviours. Fields are mutated
 * live — flip `enabled` for pause menus, dialog modals, cutscenes; flip
 * individual sub-flags for settings UIs.
 */
export type ControlsConfig = {
    /** master switch. false → trait wires no input and mounts no HUD. */
    enabled: boolean;

    desktop: {
        /** double-tap W activates sprint until W releases. off for games
         *  where sprint is RMB-held or always-on. */
        doubleTapSprint: boolean;
        /** double-tap Space toggles noclip (free-fly). off by default; the
         *  editor flips it on for its character mode, and games that want a
         *  fly cheat can enable it too. the noclip movement itself lives on
         *  the CC and is independent of this gesture. */
        doubleTapNoclip: boolean;
    };

    touch: {
        /** auto-mount the default 'move' joystick on mobile. the joystick
         *  id is read into cc.move regardless — set false to suppress only
         *  the default mount (e.g. you're mounting your own at a custom
         *  position). */
        joystick: boolean;
        /** auto-mount default 'jump' button on mobile. */
        jumpButton: boolean;
        /** auto-mount 'sprint' button on mobile (off by default — joystick
         *  magnitude drives sprint instead). always-read regardless. */
        sprintButton: boolean;
        /** auto-mount 'crouch' button on mobile (off by default). */
        crouchButton: boolean;
        /** right-half canvas drag → cc.look on touch devices. */
        canvasLook: boolean;
    };
};

/**
 * Touch control ids that PlayerControllerTrait reads from `TouchInput`
 * when `controls.enabled` is true. Register a joystick / button at these
 * ids and the controller picks them up automatically. Unregistered ids
 * no-op (the touch input layer returns zero stubs), so reads are free
 * when nothing's mounted.
 */
export const PlayerControllerTouchIds = {
    moveJoystick: 'move',
    jumpButton: 'jump',
    sprintButton: 'sprint',
    crouchButton: 'crouch',
} as const;

export type CrosshairConfig = {
    /** show the four-tick crosshair HUD. */
    enabled: boolean;
    /** distance from screen center to inner edge of each tick (CSS px). */
    spread: number;
    /** length of each tick (CSS px). */
    length: number;
    /** width of each tick (CSS px). */
    thickness: number;
    /** CSS color for the tick fill. */
    color: string;
    /** how quickly the boxes lerp toward target geometry; higher = snappier. */
    lerpSpeed: number;
};

// ── trait ─────────────────────────────────────────────────────────────

// look direction lives on CharacterControllerTrait (`cc.input.look`) so it
// can be synced + driven by NPCs too. PC just integrates mouse delta into
// cc.input.look and reads it for camera composition. PC therefore has no
// `input` bucket of its own — only `config` (tuning + editor toggles) and
// `state` (per-frame runtime). The two well-named bundles (`crosshair`,
// `controls`) stay top-level for discoverability.

type PlayerControllerConfig = {
    perspective: Perspective;
    thirdPersonDistance: number;
    cameraCollisionMargin: number;
    /** ease rate (1/s) for the sprint FOV transition. (eye height now lives on
     *  CharacterControllerTrait — `config.eyeHeight`/`crouchEyeHeight`, eased into
     *  `state.eyeHeight` — so the camera reads it from there.) */
    fovLerpSpeed: number;
    fov: number;
    fovSprint: number;
    debugContacts: boolean;
    debugVelocity: boolean;
    debugPanel: boolean;
};

type PlayerControllerState = {
    currentFov: number;
    /** game-set multiplier on the target FOV (folded in before the ease) —
     *  < 1 zooms in, > 1 widens. lets game code drive transient FOV effects
     *  (aim-down-sights, a bow-draw zoom, a speed-line widen) without fighting
     *  the controller's own sprint-FOV easing. reset to 1 to clear. */
    fovScale: number;
    currentCameraDistance: number;
    elapsed: number;
    lastJumpDownTime: number;
    lastWDownTime: number;
    sprintActive: boolean;
    wantsCrouch: boolean;
    lastTeleportId: number;
};

export const PlayerControllerTrait = trait(
    'player-controller',
    {
        config: (): PlayerControllerConfig => ({
            perspective: 'first',
            thirdPersonDistance: 4,
            cameraCollisionMargin: 0.2,
            fovLerpSpeed: 10,
            fov: degreesToRadians(75),
            fovSprint: degreesToRadians(85),
            debugContacts: false,
            debugVelocity: false,
            debugPanel: false,
        }),

        state: (): PlayerControllerState => ({
            currentFov: degreesToRadians(75),
            fovScale: 1,
            currentCameraDistance: 0,
            elapsed: 0,
            lastJumpDownTime: -1,
            lastWDownTime: -1,
            sprintActive: false,
            wantsCrouch: false,
            lastTeleportId: 0,
        }),

        // four ticks (top/bottom/left/right). `spread` = gap from center to
        // inner edge of each tick; `length` = tick length; `thickness` =
        // tick width. game code can mutate these at runtime (recoil-bloom,
        // hit-marker pulses, focus tightening) and the boxes will smoothly
        // animate to the new geometry via `lerpSpeed`.
        crosshair: (): CrosshairConfig => ({
            enabled: true,
            spread: 0,
            length: 6,
            thickness: 2,
            color: 'rgba(255, 255, 255, 0.95)',
            lerpSpeed: 18,
        }),

        // controls (live; flip for pause menus / settings)
        controls: (): ControlsConfig => ({
            enabled: true,
            desktop: {
                doubleTapSprint: true,
                doubleTapNoclip: false,
            },
            touch: {
                joystick: true,
                jumpButton: true,
                sprintButton: false,
                crouchButton: false,
                canvasLook: true,
            },
        }),
    },
    { persist: false },
);

export type PlayerControllerTrait = TraitType<typeof PlayerControllerTrait>;

/* ── controls ── */

control(PlayerControllerTrait, 'debugContacts', {
    label: 'Debug: Contacts',
    schema: prop.boolean(),
    get: (t) => t.config.debugContacts,
    set: (t, v) => {
        t.config.debugContacts = v;
    },
});

control(PlayerControllerTrait, 'debugVelocity', {
    label: 'Debug: Velocity',
    schema: prop.boolean(),
    get: (t) => t.config.debugVelocity,
    set: (t, v) => {
        t.config.debugVelocity = v;
    },
});

control(PlayerControllerTrait, 'debugPanel', {
    label: 'Debug: Panel',
    schema: prop.boolean(),
    get: (t) => t.config.debugPanel,
    set: (t, v) => {
        t.config.debugPanel = v;
    },
});

// ── input / camera constants ──────────────────────────────────────────

const AXIS_UP: Vec3 = [0, 1, 0];
const LOOK_SENSITIVITY = 0.002;
const TOUCH_LOOK_SENSITIVITY = 0.005;
const SPRINT_MAG_THRESHOLD_SQ = 0.9 * 0.9;
const CHARACTER_PITCH_LIMIT = Math.PI / 2 - 0.01;
const CHARACTER_PHI_MIN = Math.PI / 2 - CHARACTER_PITCH_LIMIT;
const CHARACTER_PHI_MAX = Math.PI / 2 + CHARACTER_PITCH_LIMIT;
const DOUBLE_TAP_WINDOW = 0.35;

const NOCLIP_SPEED = 10;

const _noclipMove: Vec3 = [0, 0, 0];
const _center: Vec3 = [0, 0, 0];
const _vTmp1: Vec3 = [0, 0, 0];
const _voxelResult = createVoxelRaycastResult();
const _rayCollector = createClosestCastRayCollector();
const _raySettings = createDefaultCastRaySettings();
const _rayOrigin: Vec3 = [0, 0, 0];
const _rayDir: Vec3 = [0, 0, 0];

// ── input poll ────────────────────────────────────────────────────────

function pollInput(pc: PlayerControllerTrait, cc: CharacterControllerTrait, input: Input, viewportWidth: number): void {
    if (!pc.controls.enabled) return;
    const mk = input.mouseKeyboard;
    const t = input.touch;

    if (document.pointerLockElement) {
        cc.input.look[1] -= mk._dx * LOOK_SENSITIVITY;
        cc.input.look[2] -= mk._dy * LOOK_SENSITIVITY;
    }
    if (pc.controls.touch.canvasLook && viewportWidth > 0) {
        // right-half canvas drag = look. left half is reserved for the
        // joystick area so accidental tracking doesn't compete with it.
        const halfW = viewportWidth / 2;
        for (const touch of getCanvasTouches(t).values()) {
            if (touch.startX <= halfW) continue;
            cc.input.look[1] -= touch.dx * TOUCH_LOOK_SENSITIVITY;
            cc.input.look[2] -= touch.dy * TOUCH_LOOK_SENSITIVITY;
        }
    }
    // `look:true` touch buttons (e.g. a fire button you aim with) feed the same
    // look channel — position-independent, so unlike canvasLook there's no
    // half-screen gate. additive with the above, clamped together below.
    const buttonLook = consumeTouchButtonLookDrag(t);
    cc.input.look[1] -= buttonLook.dx * TOUCH_LOOK_SENSITIVITY;
    cc.input.look[2] -= buttonLook.dy * TOUCH_LOOK_SENSITIVITY;
    cc.input.look[2] = Math.max(CHARACTER_PHI_MIN, Math.min(CHARACTER_PHI_MAX, cc.input.look[2]));

    // move — keyboard + joystick additive, clamp to [-1, 1].
    const stick = getJoystick(t, PlayerControllerTouchIds.moveJoystick);
    const mx =
        (isKeyDown(mk, 'KeyA') || isKeyDown(mk, 'ArrowLeft') ? -1 : 0) +
        (isKeyDown(mk, 'KeyD') || isKeyDown(mk, 'ArrowRight') ? 1 : 0) +
        stick.x;
    const mz =
        (isKeyDown(mk, 'KeyW') || isKeyDown(mk, 'ArrowUp') ? 1 : 0) +
        (isKeyDown(mk, 'KeyS') || isKeyDown(mk, 'ArrowDown') ? -1 : 0) +
        -stick.y;
    cc.input.move[0] = Math.max(-1, Math.min(1, mx));
    cc.input.move[1] = Math.max(-1, Math.min(1, mz));

    cc.input.jump = isKeyDown(mk, 'Space') || isTouchButtonDown(t, PlayerControllerTouchIds.jumpButton);

    if (cc.input.noclip) {
        cc.input.sprint =
            isKeyDown(mk, 'ShiftLeft') ||
            isKeyDown(mk, 'ShiftRight') ||
            isTouchButtonDown(t, PlayerControllerTouchIds.sprintButton);
        pc.state.wantsCrouch = false;
        cc.input.crouch = false;
        return;
    }

    if (pc.controls.desktop.doubleTapSprint) {
        if (isKeyJustDown(mk, 'KeyW')) {
            if (pc.state.lastWDownTime >= 0 && pc.state.elapsed - pc.state.lastWDownTime < DOUBLE_TAP_WINDOW) {
                pc.state.sprintActive = true;
            }
            pc.state.lastWDownTime = pc.state.elapsed;
        }
        if (!isKeyDown(mk, 'KeyW') && !isKeyDown(mk, 'ArrowUp')) {
            pc.state.sprintActive = false;
        }
        if (pc.state.wantsCrouch) pc.state.sprintActive = false;
    } else {
        pc.state.sprintActive = false;
    }

    const stickMagSq = stick.x * stick.x + stick.y * stick.y;
    cc.input.sprint =
        pc.state.sprintActive ||
        isTouchButtonDown(t, PlayerControllerTouchIds.sprintButton) ||
        stickMagSq > SPRINT_MAG_THRESHOLD_SQ;

    pc.state.wantsCrouch =
        isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight') || isTouchButtonDown(t, PlayerControllerTouchIds.crouchButton);
    cc.input.crouch = pc.state.wantsCrouch;
}

// ── noclip tick (player-driven; uses camera pitch for fly direction) ─

function tickPlayerNoclip(
    _playerController: PlayerControllerTrait,
    characterController: CharacterControllerTrait,
    transform: TransformTrait,
    physics: Physics,
    dt: number,
): void {
    const theta = characterController.input.look[1];
    const phi = characterController.input.look[2];

    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const fwdX = -sinTheta * sinPhi;
    const fwdY = -cosPhi;
    const fwdZ = -cosTheta * sinPhi;
    const rgtX = cosTheta;
    const rgtZ = -sinTheta;

    const strafe = characterController.input.move[0];
    const fwd = characterController.input.move[1];
    const up = characterController.input.jump ? 1 : 0;
    const down = characterController.input.sprint ? -1 : 0;

    _noclipMove[0] = (fwdX * fwd + rgtX * strafe) * NOCLIP_SPEED;
    _noclipMove[1] = fwdY * fwd + (up + down) * NOCLIP_SPEED;
    _noclipMove[2] = (fwdZ * fwd + rgtZ * strafe) * NOCLIP_SPEED;

    applyNoclipDisplacement(characterController, transform, physics, _noclipMove, dt);
}

// ── camera collision ──────────────────────────────────────────────────
//
// raycast from `headPos` along `dir` for `maxDist`. returns the nearest
// hit fraction (in [0, 1]) considering both voxels and rigid bodies.
// the body query uses the CC's own `bodyFilter` so we skip the character's
// kinematic inner body (and voxels, which we DDA separately).

function castCameraRay(
    cc: CharacterControllerTrait,
    physics: Physics,
    headX: number,
    headY: number,
    headZ: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
): number {
    // DDA voxel raycast
    raycastVoxels(
        _voxelResult,
        physics.rigid.terrainShape.voxels,
        physics.rigid.terrainShape.voxels.registry,
        headX,
        headY,
        headZ,
        dx,
        dy,
        dz,
        maxDist,
        BLOCK_FLAG_COLLISION,
    );
    let hitDist = _voxelResult.hit ? _voxelResult.distance : maxDist;

    // body raycast — reuse vcc bodyFilter (excludes voxels + inner body)
    if (cc.state.vcc) {
        _rayOrigin[0] = headX;
        _rayOrigin[1] = headY;
        _rayOrigin[2] = headZ;
        _rayDir[0] = dx;
        _rayDir[1] = dy;
        _rayDir[2] = dz;
        _rayCollector.reset();
        castRay(physics.rigid.world, _rayCollector, _raySettings, _rayOrigin, _rayDir, maxDist, cc.state.vcc.bodyFilter);
        const hit = _rayCollector.hit;
        if (hit && hit.status === CastRayStatus.COLLIDING) {
            const bodyDist = hit.fraction * maxDist;
            if (bodyDist < hitDist) hitDist = bodyDist;
        }
    }

    return hitDist;
}

// ── camera update ─────────────────────────────────────────────────────

const _camPosScratch: Vec3 = [0, 0, 0];
const _camQuatScratch: Quat = [0, 0, 0, 1];
const _eyeScratch: Vec3 = [0, 0, 0];
const _targetScratch: Vec3 = [0, 0, 0];
const _lookMatScratch: Mat4 = mat4.create();

function updateCamera(
    playerController: PlayerControllerTrait,
    characterController: CharacterControllerTrait,
    transform: TransformTrait,
    physics: Physics,
    cameraTransform: TransformTrait,
    cameraTrait: CameraTrait,
    dt: number,
): void {
    // decay step-smooth offset toward zero — camera rises smoothly to match
    // physics position after a stair step-up. exp(-23*dt) mirrors Minetest.
    if (transform.teleport !== playerController.state.lastTeleportId) {
        playerController.state.lastTeleportId = transform.teleport;
        characterController.state.stepSmoothOffset = 0;
    } else if (characterController.state.stepSmoothOffset !== 0) {
        characterController.state.stepSmoothOffset *= Math.exp(-23 * dt);
        if (Math.abs(characterController.state.stepSmoothOffset) < 1e-3) characterController.state.stepSmoothOffset = 0;
    }

    const pos = getVisualWorldPosition(transform);
    // when step-smoothing, base camera Y on the authoritative position (not
    // interpolated) so the offset doesn't fight the prevPosition→position lerp
    // which would cause a one-frame dip before the smooth rise.
    const baseY = characterController.state.stepSmoothOffset !== 0 ? transform.position[1] : pos[1];
    const headX = pos[0];
    const headY = baseY + characterController.state.eyeHeight + characterController.state.stepSmoothOffset;
    const headZ = pos[2];

    const theta = characterController.input.look[1];
    const phi = characterController.input.look[2];

    // Forward (world-space look direction) from spherical.
    // Engine convention: theta=0, phi=π/2 → fwd = -Z (matches glTF /
    // three.js / orbit-controller). theta increases turning the look
    // CCW around +Y; phi is measured from -Y (phi=0 down, phi=π up).
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const fwdX = -sinTheta * sinPhi;
    const fwdY = -cosPhi;
    const fwdZ = -cosTheta * sinPhi;

    // Pick eye + target by perspective. mat4.targetTo(eye, target, up)
    // produces a transform whose local -Z points from eye toward target,
    // matching the renderer's camera convention. Set both, then derive
    // the camera quaternion from the resulting matrix — same math the
    // orbit-controller uses and a clean replacement for manual yaw*pitch
    // composition.
    let eyeX = headX;
    let eyeY = headY;
    let eyeZ = headZ;
    let targetX = headX + fwdX;
    let targetY = headY + fwdY;
    let targetZ = headZ + fwdZ;

    if (playerController.config.perspective === 'third-back') {
        // Camera behind head, looking the same direction as the player.
        const hitDist = castCameraRay(
            characterController,
            physics,
            headX,
            headY,
            headZ,
            -fwdX,
            -fwdY,
            -fwdZ,
            playerController.config.thirdPersonDistance,
        );
        const clamped = Math.max(0, hitDist - playerController.config.cameraCollisionMargin);
        playerController.state.currentCameraDistance = clamped;
        eyeX = headX - fwdX * clamped;
        eyeY = headY - fwdY * clamped;
        eyeZ = headZ - fwdZ * clamped;
        // target = head + fwd keeps the camera looking in +fwd direction.
    } else if (playerController.config.perspective === 'third-front') {
        // Camera in front of head, looking back at the head.
        const hitDist = castCameraRay(
            characterController,
            physics,
            headX,
            headY,
            headZ,
            fwdX,
            fwdY,
            fwdZ,
            playerController.config.thirdPersonDistance,
        );
        const clamped = Math.max(0, hitDist - playerController.config.cameraCollisionMargin);
        playerController.state.currentCameraDistance = clamped;
        eyeX = headX + fwdX * clamped;
        eyeY = headY + fwdY * clamped;
        eyeZ = headZ + fwdZ * clamped;
        // Target the head — view direction = -fwd (camera faces player).
        targetX = headX;
        targetY = headY;
        targetZ = headZ;
    } else {
        playerController.state.currentCameraDistance = 0;

        // First-person camera bob: shift eye and target by the same
        // offset so the look direction is preserved. Third-person skips
        // this — bobbing an orbit anchor produces visible jitter.
        if (characterController.state.bobOffsetX !== 0 || characterController.state.bobOffsetY !== 0) {
            const rightX = cosTheta;
            const rightZ = -sinTheta;
            const dx = rightX * characterController.state.bobOffsetX;
            const dy = characterController.state.bobOffsetY;
            const dz = rightZ * characterController.state.bobOffsetX;
            eyeX += dx;
            eyeY += dy;
            eyeZ += dz;
            targetX += dx;
            targetY += dy;
            targetZ += dz;
        }
    }

    _camPosScratch[0] = eyeX;
    _camPosScratch[1] = eyeY;
    _camPosScratch[2] = eyeZ;
    setWorldPosition(cameraTransform, _camPosScratch);

    _eyeScratch[0] = eyeX;
    _eyeScratch[1] = eyeY;
    _eyeScratch[2] = eyeZ;
    _targetScratch[0] = targetX;
    _targetScratch[1] = targetY;
    _targetScratch[2] = targetZ;
    mat4.targetTo(_lookMatScratch, _eyeScratch, _targetScratch, AXIS_UP);
    quat.fromMat4(_camQuatScratch, _lookMatScratch);
    setWorldQuaternion(cameraTransform, _camQuatScratch);

    cameraTrait.fov = playerController.state.currentFov;
}

// ── debug viz ─────────────────────────────────────────────────────────

const COLOR_CONTACT_MARKER: [number, number, number, number] = [0, 1, 0, 1];
const COLOR_CONTACT_NORMAL: [number, number, number, number] = [0, 1, 1, 1];
const COLOR_CHAR_VELOCITY: [number, number, number, number] = [1, 1, 1, 1];

const ARROW_NORMAL_LEN = 0.5;
const ARROW_VELOCITY_SCALE = 0.2;
const ARROW_VELOCITY_MAX = 3.0;
const CONTACT_SPHERE_RADIUS = 0.05;

type DebugHelpers = {
    contactMarkers: Mesh[];
    contactNormals: LineSegments[];
    characterVelocity: LineSegments | null;
};

function createDebugHelpers(): DebugHelpers {
    return { contactMarkers: [], contactNormals: [], characterVelocity: null };
}

function makeOnTopMaterial(rgba: [number, number, number, number]): Material {
    return new Material({
        name: 'player-controller-debug-on-top',
        vertex: positionClip,
        fragment: vec4f(...rgba),
        depthTest: false,
        depthWrite: false,
        transparent: rgba[3] < 1,
        cullMode: 'none',
    });
}

function makeOnTopLineMaterial(rgba: [number, number, number, number], lineWidth: number): LineMaterial {
    return new LineMaterial({ color: vec4f(...rgba), lineWidth, transparent: rgba[3] < 1 });
}

function disposeMesh(scene: Scene, m: Mesh | LineSegments | null): void {
    if (!m) return;
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
}

function clearDebugHelpers(scene: Scene | undefined, h: DebugHelpers): void {
    if (!scene) return;
    for (const m of h.contactMarkers) disposeMesh(scene, m);
    h.contactMarkers.length = 0;
    for (const m of h.contactNormals) disposeMesh(scene, m);
    h.contactNormals.length = 0;
    disposeMesh(scene, h.characterVelocity);
    h.characterVelocity = null;
}

function makeSphere(scene: Scene, pos: Vec3, radius: number, rgba: [number, number, number, number]): Mesh {
    const mesh = new Mesh(createSphereGeometry(radius, 8, 6), makeOnTopMaterial(rgba));
    mesh.name = 'player-controller-debug-contact-marker';
    mesh.frustumCulled = false;
    mesh.renderOrder = 999;
    mesh.position[0] = pos[0];
    mesh.position[1] = pos[1];
    mesh.position[2] = pos[2];
    scene.add(mesh);
    return mesh;
}

function makeArrow(scene: Scene, origin: Vec3, dir: Vec3, length: number, rgba: [number, number, number, number]): LineSegments {
    const ex = origin[0] + dir[0] * length;
    const ey = origin[1] + dir[1] * length;
    const ez = origin[2] + dir[2] * length;
    const geom = new LineSegmentsGeometry([origin[0], origin[1], origin[2], ex, ey, ez]);
    const line = new LineSegments(geom, makeOnTopLineMaterial(rgba, 3));
    line.name = 'player-controller-debug-arrow';
    line.frustumCulled = false;
    line.renderOrder = 999;
    scene.add(line);
    return line;
}

function renderContacts(scene: Scene, v: vcc.VCC, h: DebugHelpers): void {
    for (const c of v.contacts) {
        _center[0] = c.positionX;
        _center[1] = c.positionY;
        _center[2] = c.positionZ;
        h.contactMarkers.push(makeSphere(scene, _center, CONTACT_SPHERE_RADIUS, COLOR_CONTACT_MARKER));
        _vTmp1[0] = c.contactNormalX;
        _vTmp1[1] = c.contactNormalY;
        _vTmp1[2] = c.contactNormalZ;
        h.contactNormals.push(makeArrow(scene, _center, _vTmp1, ARROW_NORMAL_LEN, COLOR_CONTACT_NORMAL));
    }
}

function renderCharacterVelocity(scene: Scene, cc: CharacterControllerTrait, center: Vec3, h: DebugHelpers): void {
    const v = cc.state.velocity;
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len < 0.01) return;
    _vTmp1[0] = v[0] / len;
    _vTmp1[1] = v[1] / len;
    _vTmp1[2] = v[2] / len;
    const draw = Math.min(len * ARROW_VELOCITY_SCALE, ARROW_VELOCITY_MAX);
    h.characterVelocity = makeArrow(scene, center, _vTmp1, draw, COLOR_CHAR_VELOCITY);
}

function f3(n: number): string {
    return n.toFixed(3);
}

function v3str(v: Vec3): string {
    return `${f3(v[0])}, ${f3(v[1])}, ${f3(v[2])}`;
}

function formatVccState(cc: CharacterControllerTrait): string {
    const lines: string[] = [];
    const v = cc.state.velocity;
    const vlen = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    lines.push(`grounded:  ${cc.state.grounded}`);
    lines.push(`velocity:  ${v3str(v)}   |v|=${f3(vlen)}`);
    if (cc.state.vcc) {
        lines.push(`pos:       ${v3str(cc.state.vcc.position)}`);
        lines.push(`groundN:   ${v3str(cc.state.vcc.groundNormal)}`);
        lines.push(`contacts (${cc.state.vcc.contacts.length}):`);
        for (let i = 0; i < cc.state.vcc.contacts.length; i++) {
            const c = cc.state.vcc.contacts[i]!;
            const kind = c.bodyId === -1 ? 'voxel' : 'body';
            const src =
                c.bodyId === -1
                    ? `vx=${c.voxelX},${c.voxelY},${c.voxelZ}${
                          c.subAabbIndex >= 0 ? ` sub=${c.subAabbIndex}` : ''
                      } state=${c.stateId}`
                    : `body=${c.bodyId}`;
            lines.push(`  [${i}] ${kind} ${src} d=${f3(c.distance)} f=${f3(c.fraction)}`);
            lines.push(
                `       p=${f3(c.positionX)},${f3(c.positionY)},${f3(c.positionZ)} n=${f3(c.contactNormalX)},${f3(c.contactNormalY)},${f3(c.contactNormalZ)}`,
            );
        }
    }
    return lines.join('\n');
}

// ── script ────────────────────────────────────────────────────────────

script(
    PlayerControllerTrait,
    'controller',
    (ctx) => {
        const debugHelpers = createDebugHelpers();
        let debugPanelEl: HTMLDivElement | null = null;

        // handles to the camera this controller drives. resolved in onInit
        // through CameraRefTrait on ctx.node (with fallback to `ctx.client.camera`),
        // so bespoke setups that re-point CameraRefTrait still work. null for
        // non-owner instances (onInit bails early on isOwner). nothing to tear
        // down on dispose — camera-node lifecycle is owned by whoever installed
        // CameraRefTrait (room init or editor lens).
        let cameraTransform: TransformTrait | null = null;
        let cameraTrait: CameraTrait | null = null;

        const ensureDebugPanel = (): HTMLDivElement | null => {
            if (debugPanelEl) return debugPanelEl;
            const viewport = ctx.client?.viewport;
            if (!viewport) return null;
            const el = document.createElement('div');
            el.style.cssText = [
                'position: absolute',
                'bottom: 8px',
                'left: 8px',
                'padding: 8px 10px',
                'background: rgba(0,0,0,0.75)',
                'color: #fff',
                'font: 11px ui-monospace, Menlo, monospace',
                'white-space: pre',
                'pointer-events: auto',
                'user-select: text',
                'border: 1px solid #fff',
                `z-index: ${UILayer.debug}`,
            ].join('; ');
            viewport.appendChild(el);
            debugPanelEl = el;
            return el;
        };

        const removeDebugPanel = (): void => {
            if (debugPanelEl) {
                debugPanelEl.remove();
                debugPanelEl = null;
            }
        };

        // ── crosshair (per-player canvas HUD) ──
        // four ticks. each tick has a target rect (x,y,w,h) derived from the
        // trait's `crosshair` params, and a current rect that lerps toward it.
        // we redraw the canvas only when any current rect drifts past `REDRAW_EPS`
        // since the last paint — cheap idle (no draw when stable) but smooth
        // animation when params change.
        let crosshairCanvas: HTMLCanvasElement | null = null;
        let crosshairCtx2d: CanvasRenderingContext2D | null = null;
        let crosshairLastColor = '';
        let crosshairLastViewportW = 0;
        let crosshairLastViewportH = 0;
        // [top, bottom, left, right] × [x, y, w, h], current and last-drawn.
        const crosshairCurrent = new Float32Array(16);
        const crosshairLastDrawn = new Float32Array(16);
        let crosshairCurrentInit = false;

        const ensureCrosshair = (): boolean => {
            const viewport = ctx.client?.viewport;
            if (!viewport) return false;
            if (crosshairCanvas) return true;
            const canvas = document.createElement('canvas');
            canvas.style.cssText = [
                'position: absolute',
                'inset: 0',
                'width: 100%',
                'height: 100%',
                'pointer-events: none',
                `z-index: ${UILayer.crosshair}`,
            ].join('; ');
            viewport.appendChild(canvas);
            crosshairCanvas = canvas;
            crosshairCtx2d = canvas.getContext('2d');
            return crosshairCtx2d !== null;
        };

        const removeCrosshair = (): void => {
            if (crosshairCanvas) {
                crosshairCanvas.remove();
                crosshairCanvas = null;
                crosshairCtx2d = null;
                crosshairCurrentInit = false;
            }
        };

        const onCanvasClick = (): void => {
            if (!ctx.trait.controls.enabled) return;
            // pointer lock is the desktop mouse-look affordance; touch devices look via
            // canvasLook (drag), and locking the pointer on a tap breaks that — plus
            // pointer-lock + touch is undefined in browsers. so never lock on a touch
            // device. (the `click` event is a plain MouseEvent in Chromium, so we can't
            // tell touch from mouse per-event — gate on the device instead.)
            if (isTouchDevice(ctx)) return;
            if (!document.pointerLockElement) {
                ctx.client?.domElement.requestPointerLock();
            }
        };

        /* ── mobile HUD (reactive) ── */
        // Each piece reconciles per-tick against (controls.enabled && isTouchPrimary(ctx)
        // && controls.touch.<flag>). flipping any of those mounts or disposes
        // the corresponding DOM helper on the next sync, so pause menus and
        // settings UIs that toggle controls.* "just work".
        type HudHandle = { dispose(): void } | null;
        const hud: {
            joystick: HudHandle;
            jumpButton: HudHandle;
            sprintButton: HudHandle;
            crouchButton: HudHandle;
        } = { joystick: null, jumpButton: null, sprintButton: null, crouchButton: null };
        let prevControlsEnabled = false;

        function reconcileHud(key: keyof typeof hud, want: boolean, make: () => HudHandle): void {
            if (want && !hud[key]) {
                hud[key] = make();
            } else if (!want && hud[key]) {
                hud[key]!.dispose();
                hud[key] = null;
            }
        }

        function disposeAllHud(): void {
            for (const key of Object.keys(hud) as (keyof typeof hud)[]) {
                hud[key]?.dispose();
                hud[key] = null;
            }
        }

        const syncHud = (pc: PlayerControllerTrait): void => {
            const on = pc.controls.enabled;
            // edge: falling enabled — release pointer lock so whatever UI is
            // taking over (pause menu, dialog) gets a normal cursor back.
            if (prevControlsEnabled && !on && document.pointerLockElement) {
                document.exitPointerLock();
            }
            prevControlsEnabled = on;

            // touch controls show whenever touch is the primary input — viewport size
            // independent, so tablets and landscape phones get them too (a width gate
            // would wrongly drop them).
            const wantHud = on && isTouchPrimary(ctx);

            reconcileHud('joystick', wantHud && pc.controls.touch.joystick, () =>
                createJoystick(ctx, {
                    id: PlayerControllerTouchIds.moveJoystick,
                    left: 24,
                    bottom: 24,
                    size: 140,
                    deadzone: 0.12,
                }),
            );
            reconcileHud('jumpButton', wantHud && pc.controls.touch.jumpButton, () =>
                createTouchButton(ctx, {
                    id: PlayerControllerTouchIds.jumpButton,
                    right: 24,
                    bottom: 24,
                    width: 96,
                    height: 96,
                    label: '⤒',
                }),
            );
            reconcileHud('sprintButton', wantHud && pc.controls.touch.sprintButton, () =>
                createTouchButton(ctx, {
                    id: PlayerControllerTouchIds.sprintButton,
                    right: 24,
                    bottom: 132,
                    width: 88,
                    height: 88,
                    label: '⚡',
                }),
            );
            reconcileHud('crouchButton', wantHud && pc.controls.touch.crouchButton, () =>
                createTouchButton(ctx, {
                    id: PlayerControllerTouchIds.crouchButton,
                    right: 132,
                    bottom: 24,
                    width: 88,
                    height: 88,
                    label: '⤓',
                }),
            );
        };

        onInit(ctx, () => {
            if (!isOwner(ctx, ctx.node)) return;

            const cc = getTrait(ctx.node, CharacterControllerTrait);
            if (!cc) {
                warn(
                    ctx,
                    'PlayerControllerTrait requires CharacterControllerTrait on the same node; player input + camera will not function',
                );
                return;
            }

            const domElement = ctx.client?.domElement;
            if (domElement) domElement.addEventListener('click', onCanvasClick);

            // grab handles to the camera this controller drives. CameraRefTrait
            // on ctx.node is pre-installed at room init pointing at the room's
            // default camera; bespoke setups can re-point it before the
            // controller's onInit runs. fall back to client.camera defensively.
            const { camera: cam, node: camNode } = resolveCamera(ctx);
            cameraTrait = cam;
            cameraTransform = getTrait(camNode, TransformTrait)!;
        });

        onDispose(ctx, () => {
            if (!isOwner(ctx, ctx.node)) return;
            const domElement = ctx.client?.domElement;
            if (domElement) domElement.removeEventListener('click', onCanvasClick);
            if (document.pointerLockElement) document.exitPointerLock();
            clearDebugHelpers(ctx.client?.scene, debugHelpers);
            removeDebugPanel();
            removeCrosshair();
            disposeAllHud();
            cameraTransform = null;
            cameraTrait = null;
        });

        // crosshair: target → current lerp + canvas repaint when drift exceeds eps.
        const CROSSHAIR_REDRAW_EPS = 0.25;
        const updateCrosshair = (pc: PlayerControllerTrait, dt: number): void => {
            const cfg = pc.crosshair;
            if (!cfg.enabled) {
                removeCrosshair();
                return;
            }
            if (!ensureCrosshair()) return;
            const canvas = crosshairCanvas!;
            const ctx2d = crosshairCtx2d!;
            const dpr = window.devicePixelRatio || 1;
            const w = ctx.client?.state?.viewport.width ?? 0;
            const h = ctx.client?.state?.viewport.height ?? 0;

            // resize backing store to match viewport (when needed)
            const cssChanged = w !== crosshairLastViewportW || h !== crosshairLastViewportH;
            if (cssChanged) {
                canvas.width = Math.max(1, Math.floor(w * dpr));
                canvas.height = Math.max(1, Math.floor(h * dpr));
                crosshairLastViewportW = w;
                crosshairLastViewportH = h;
                // force redraw by zeroing last-drawn rects.
                crosshairLastDrawn.fill(0);
                // and snap current rects to the new targets — without this
                // the lerp would crawl from the old-viewport geometry to
                // the new one (most visible on edit→play, where the HUD
                // chrome resizes the viewport on the first play frame).
                crosshairCurrentInit = false;
            }

            const cx = (w * dpr) / 2;
            const cy = (h * dpr) / 2;
            const s = cfg.spread * dpr;
            const len = cfg.length * dpr;
            const th = cfg.thickness * dpr;

            // target rects: top, bottom, left, right
            const targets = [
                cx - th / 2,
                cy - s - len,
                th,
                len, // top
                cx - th / 2,
                cy + s,
                th,
                len, // bottom
                cx - s - len,
                cy - th / 2,
                len,
                th, // left
                cx + s,
                cy - th / 2,
                len,
                th, // right
            ];

            if (!crosshairCurrentInit) {
                for (let i = 0; i < 16; i++) crosshairCurrent[i] = targets[i]!;
                crosshairCurrentInit = true;
            } else {
                const alpha = 1 - Math.exp(-cfg.lerpSpeed * dt);
                for (let i = 0; i < 16; i++) {
                    crosshairCurrent[i] += (targets[i]! - crosshairCurrent[i]!) * alpha;
                }
            }

            // skip redraw if nothing meaningfully changed
            let dirty = cfg.color !== crosshairLastColor || cssChanged;
            if (!dirty) {
                for (let i = 0; i < 16; i++) {
                    if (Math.abs(crosshairCurrent[i]! - crosshairLastDrawn[i]!) > CROSSHAIR_REDRAW_EPS) {
                        dirty = true;
                        break;
                    }
                }
            }
            if (!dirty) return;

            ctx2d.clearRect(0, 0, canvas.width, canvas.height);
            ctx2d.fillStyle = cfg.color;
            for (let i = 0; i < 4; i++) {
                const o = i * 4;
                ctx2d.fillRect(
                    crosshairCurrent[o]!,
                    crosshairCurrent[o + 1]!,
                    crosshairCurrent[o + 2]!,
                    crosshairCurrent[o + 3]!,
                );
            }
            crosshairLastDrawn.set(crosshairCurrent);
            crosshairLastColor = cfg.color;
        };

        onUpdate(ctx, ({ delta }) => {
            // input + camera writes gate on control: when the POV has been
            // swapped to a different node (e.g. editor freecam), this player
            // stops reading mouse/keyboard and its CameraTrait stops being
            // touched. owner-only state (perspective, fov lerp) is implied —
            // control => owner, since only owners can hold control of their
            // own player node.
            if (getControlNode(ctx) !== ctx.node) return;
            const cc = getTrait(ctx.node, CharacterControllerTrait);
            if (!cc) return;

            const pc = ctx.trait;
            pc.state.elapsed += delta;
            const input = ctx.client?.input;
            syncHud(pc);
            if (input) {
                const viewportWidth = ctx.client?.state?.viewport.width ?? 0;
                pollInput(pc, cc, input, viewportWidth);

                // double-tap Space toggles noclip when enabled (editor character
                // mode; opt-in fly cheat in games). pure gesture — the noclip
                // movement itself lives on the CC.
                if (pc.controls.desktop.doubleTapNoclip && isKeyJustDown(input.mouseKeyboard, 'Space')) {
                    if (pc.state.lastJumpDownTime >= 0 && pc.state.elapsed - pc.state.lastJumpDownTime < DOUBLE_TAP_WINDOW) {
                        cc.input.noclip = !cc.input.noclip;
                        if (cc.input.noclip) vec3.set(cc.state.velocity, 0, 0, 0);
                        cc.input.jump = false;
                        pc.state.lastJumpDownTime = -1;
                    } else {
                        pc.state.lastJumpDownTime = pc.state.elapsed;
                    }
                }

                // 'C' cycles perspective (play mode only — keep the edit-mode
                // camera predictable while building).
                if (ctx.mode !== 'edit' && isKeyJustDown(input.mouseKeyboard, 'KeyC')) {
                    const idx = PERSPECTIVE_ORDER.indexOf(pc.config.perspective);
                    pc.config.perspective = PERSPECTIVE_ORDER[(idx + 1) % PERSPECTIVE_ORDER.length]!;
                }
            }

            // eye-height (incl. the crouch drop) is eased on CharacterControllerTrait
            // now — `state.eyeHeight`, which the camera reads above.
            const targetFov = (cc.input.sprint ? pc.config.fovSprint : pc.config.fov) * pc.state.fovScale;
            pc.state.currentFov += (targetFov - pc.state.currentFov) * (1 - Math.exp(-pc.config.fovLerpSpeed * delta));
        });

        onTick(ctx, ({ delta }) => {
            // noclip drives the player's transform from input (cc.move/jump).
            // gated on control so a non-control player can't keep flying
            // around after the POV moves elsewhere.
            if (getControlNode(ctx) !== ctx.node) return;
            const cc = getTrait(ctx.node, CharacterControllerTrait);
            if (!cc?.input.noclip) return;
            const transform = getTrait(ctx.node, TransformTrait);
            if (!transform) return;
            tickPlayerNoclip(ctx.trait, cc, transform, ctx.physics, delta);
        });

        onFrame(ctx, ({ delta }) => {
            const cc = getTrait(ctx.node, CharacterControllerTrait);
            const transform = getTrait(ctx.node, TransformTrait);
            if (!cc || !transform) return;

            const pc = ctx.trait;
            // camera + crosshair are control-gated: only the POV node writes
            // to its CameraTrait or paints the HUD overlay. when POV swaps
            // away, the crosshair is torn down so a stale tickmark doesn't
            // linger over whatever lens is now active.
            if (getControlNode(ctx) === ctx.node) {
                if (cameraTransform && cameraTrait) {
                    updateCamera(pc, cc, transform, ctx.physics, cameraTransform, cameraTrait, delta);
                }
                updateCrosshair(pc, delta);
            } else {
                removeCrosshair();
            }

            if (env.editor && ctx.mode === 'edit' && isOwner(ctx, ctx.node)) {
                const scene = ctx.client?.scene;
                clearDebugHelpers(scene, debugHelpers);
                if (scene && cc.state.vcc) {
                    const fp = getVisualWorldPosition(transform);
                    _center[0] = fp[0];
                    _center[1] = fp[1] + cc.state.vcc.halfExtents[1];
                    _center[2] = fp[2];
                    if (pc.config.debugContacts) renderContacts(scene, cc.state.vcc, debugHelpers);
                    if (pc.config.debugVelocity) renderCharacterVelocity(scene, cc, _center, debugHelpers);
                }
                if (pc.config.debugPanel) {
                    const panel = ensureDebugPanel();
                    if (panel) panel.textContent = formatVccState(cc);
                } else {
                    removeDebugPanel();
                }
            } else {
                clearDebugHelpers(ctx.client?.scene, debugHelpers);
                removeDebugPanel();
            }
        });
    },
    { editor: true },
);
