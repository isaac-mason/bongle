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
import type { Mat4, Quat, Vec3 } from 'math';
import { degreesToRadians, mat4, quat, vec3 } from 'math';
import { drone as flyIcon, arrowUp as jumpIcon, footprints as walkIcon } from '../../icons/strings';
import {
    addCrosshair,
    type Crosshair,
    type CrosshairConfig,
    createCrosshair,
    defaultCrosshairConfig,
    removeCrosshair,
    updateCrosshair,
} from '../api/crosshair';
import { warn } from '../api/debug';
import {
    consumeTouchButtonLookDrag,
    getCanvasTouches,
    getJoystick,
    type Input,
    isKeyDown,
    isKeyJustDown,
    isTouchButtonDown,
    isTouchButtonJustDown,
} from '../api/input';
import { isTouchPrimary } from '../api/mobile';
import type { Physics } from '../api/physics';
import { setPointerLock } from '../api/pointer-lock';
import { prop } from '../api/prop';
import { getTrait } from '../api/scene-tree';
import { isOwner, onDispose, onFrame, onInit, onTick, onUpdate } from '../api/scripts';
import { getCamera, getSubject } from '../api/subject';
import { createTouchButton, createTouchJoystick } from '../api/touch-controls';
import type { TraitType } from '../api/traits';
import { getVisualWorldPosition, setWorldPosition, setWorldQuaternion } from '../api/transforms';
import { UILayer } from '../client/ui/util/ui-layers';
import type * as vcc from '../core/physics/vcc/vcc';
import { control, script, trait } from '../core/registry';
import { BLOCK_FLAG_COLLISION } from '../core/voxels/block-registry';
import { createVoxelRaycastResult, raycastVoxels } from '../core/voxels/voxel-raycast';
import { env } from '../env';
import { CameraTrait } from './camera';
import { applyNoclipDisplacement, CharacterControllerTrait } from './character-controller';
import { TransformTrait } from './transform';

export type Perspective = 'first' | 'third-back' | 'third-front';
const PERSPECTIVE_ORDER: Perspective[] = ['first', 'third-back', 'third-front'];

/** input + HUD wiring for the player controller: one master switch plus grouped sub-knobs for desktop and touch behaviours.
 *  Fields are mutated live: flip `enabled` for pause menus/cutscenes, individual sub-flags for settings UIs. */
export type ControlsConfig = {
    /** master switch. false = trait wires no input and mounts no HUD. */
    enabled: boolean;

    desktop: {
        /** double-tap W activates sprint until W releases. off for games
         *  where sprint is RMB-held or always-on. */
        doubleTapSprint: boolean;
        /** double-tap Space toggles noclip (free-fly), off by default; the noclip movement itself lives on the CC.
         *  the editor flips this on for its character mode. */
        doubleTapNoclip: boolean;
    };

    touch: {
        /** auto-mount the default 'move' joystick on mobile; the joystick id is read into cc.move regardless.
         *  set false to suppress only the default mount, e.g. to mount your own at a custom position. */
        joystick: boolean;
        /** auto-mount default 'jump' button on mobile. */
        jumpButton: boolean;
        /** auto-mount 'sprint' button on mobile (off by default, joystick
         *  magnitude drives sprint instead). always-read regardless. */
        sprintButton: boolean;
        /** auto-mount 'crouch' button on mobile (off by default). */
        crouchButton: boolean;
        /** while noclip is active, mount a vertical up/down joystick in place of the jump button. on by default. */
        noclipVerticalJoystick: boolean;
        /** mount a fly/walk toggle button that flips noclip on tap, off by default; the touch counterpart to `doubleTapNoclip`.
         *  opt in where free-fly is allowed, same as the editor. */
        flyToggleButton: boolean;
        /** right-half canvas drag maps to cc.look on touch devices. */
        canvasLook: boolean;
    };
};

/** touch control ids that PlayerControllerTrait reads from `TouchInput` when `controls.enabled` is true. */
export const PlayerControllerTouchIds = {
    moveJoystick: 'move',
    jumpButton: 'jump',
    sprintButton: 'sprint',
    crouchButton: 'crouch',
    /** y-locked stick shown in place of the jump button while noclip flying. */
    verticalJoystick: 'vertical',
    /** tap toggles noclip (free-fly) on/off. touch stand-in for double-tap Space. */
    flyToggle: 'fly-toggle',
} as const;

// look direction lives on CharacterControllerTrait (`cc.input.look`); PC has no `input` bucket of its own, only config/state.

type PlayerControllerConfig = {
    perspective: Perspective;
    thirdPersonDistance: number;
    cameraCollisionMargin: number;
    /** ease rate (1/s) for the sprint FOV transition. */
    fovLerpSpeed: number;
    fov: number;
    fovSprint: number;
    /** game-set multiplier on the target FOV, folded in before the ease; < 1 zooms in, > 1 widens. reset to 1 to clear. */
    fovScale: number;
    debugContacts: boolean;
    debugVelocity: boolean;
    debugPanel: boolean;
};

type PlayerControllerState = {
    currentFov: number;
    currentCameraDistance: number;
    elapsed: number;
    lastJumpDownTime: number;
    lastWDownTime: number;
    sprintActive: boolean;
    wantsCrouch: boolean;
    lastTeleportId: number;
    /** analog vertical fly input while noclip: +1 = ascend, -1 = descend. */
    noclipVertical: number;
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
            fovScale: 1,
            debugContacts: false,
            debugVelocity: false,
            debugPanel: false,
        }),

        state: (): PlayerControllerState => ({
            currentFov: degreesToRadians(75),
            currentCameraDistance: 0,
            elapsed: 0,
            lastJumpDownTime: -1,
            lastWDownTime: -1,
            sprintActive: false,
            wantsCrouch: false,
            lastTeleportId: 0,
            noclipVertical: 0,
        }),

        // four ticks (top/bottom/left/right); game code can mutate these at runtime and they animate via `lerpSpeed`.
        crosshair: (): CrosshairConfig => defaultCrosshairConfig(),

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
                noclipVerticalJoystick: true,
                flyToggleButton: false,
                canvasLook: true,
            },
        }),
    },
    { icon: 'kit:icon:controller', persist: false },
);

export type PlayerControllerTrait = TraitType<typeof PlayerControllerTrait>;

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

function pollInput(pc: PlayerControllerTrait, cc: CharacterControllerTrait, input: Input, viewportWidth: number): void {
    if (!pc.controls.enabled) return;
    const mk = input.mouseKeyboard;
    const t = input.touch;

    if (document.pointerLockElement) {
        cc.input.look[1] -= mk._dx * LOOK_SENSITIVITY;
        cc.input.look[2] -= mk._dy * LOOK_SENSITIVITY;
    }
    if (pc.controls.touch.canvasLook && viewportWidth > 0) {
        // right-half canvas drag = look; left half is reserved for the joystick area.
        const halfW = viewportWidth / 2;
        for (const touch of getCanvasTouches(t).values()) {
            if (touch.startX <= halfW) continue;
            cc.input.look[1] -= touch.dx * TOUCH_LOOK_SENSITIVITY;
            cc.input.look[2] -= touch.dy * TOUCH_LOOK_SENSITIVITY;
        }
    }
    // `look:true` touch buttons feed the same look channel, position-independent; additive with the above.
    const buttonLook = consumeTouchButtonLookDrag(t);
    cc.input.look[1] -= buttonLook.dx * TOUCH_LOOK_SENSITIVITY;
    cc.input.look[2] -= buttonLook.dy * TOUCH_LOOK_SENSITIVITY;
    cc.input.look[2] = Math.max(CHARACTER_PHI_MIN, Math.min(CHARACTER_PHI_MAX, cc.input.look[2]));

    // move, keyboard + joystick additive, clamp to [-1, 1].
    const stick = getJoystick(t, PlayerControllerTouchIds.moveJoystick);
    const mx = (isKeyDown(mk, 'KeyA') ? -1 : 0) + (isKeyDown(mk, 'KeyD') ? 1 : 0) + stick.x;
    const mz = (isKeyDown(mk, 'KeyW') ? 1 : 0) + (isKeyDown(mk, 'KeyS') ? -1 : 0) + -stick.y;
    cc.input.move[0] = Math.max(-1, Math.min(1, mx));
    cc.input.move[1] = Math.max(-1, Math.min(1, mz));

    cc.input.jump = isKeyDown(mk, 'Space') || isTouchButtonDown(t, PlayerControllerTouchIds.jumpButton);

    if (cc.input.noclip) {
        // vertical fly is analog; the stick's y is positive-down, so negate it (push up = ascend).
        const vstick = getJoystick(t, PlayerControllerTouchIds.verticalJoystick);
        const keyUp = isKeyDown(mk, 'Space') ? 1 : 0;
        const keyDown = isKeyDown(mk, 'ShiftLeft') || isKeyDown(mk, 'ShiftRight') ? 1 : 0;
        pc.state.noclipVertical = Math.max(-1, Math.min(1, keyUp - keyDown - vstick.y));
        cc.input.sprint = false;
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
        if (!isKeyDown(mk, 'KeyW')) {
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

function tickPlayerNoclip(
    playerController: PlayerControllerTrait,
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
    const vertical = playerController.state.noclipVertical;

    _noclipMove[0] = (fwdX * fwd + rgtX * strafe) * NOCLIP_SPEED;
    _noclipMove[1] = fwdY * fwd + vertical * NOCLIP_SPEED;
    _noclipMove[2] = (fwdZ * fwd + rgtZ * strafe) * NOCLIP_SPEED;

    applyNoclipDisplacement(characterController, transform, physics, _noclipMove, dt);
}

// raycast from `headPos` along `dir` for `maxDist`, returning the nearest hit distance considering both voxels and rigid bodies.
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

    // body raycast, reuse vcc bodyFilter (excludes voxels + inner body)
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
    // decay step-smooth offset toward zero, camera rises smoothly to match physics position after a stair step-up.
    if (transform.teleport !== playerController.state.lastTeleportId) {
        playerController.state.lastTeleportId = transform.teleport;
        characterController.state.stepSmoothOffset = 0;
    } else if (characterController.state.stepSmoothOffset !== 0) {
        characterController.state.stepSmoothOffset *= Math.exp(-23 * dt);
        if (Math.abs(characterController.state.stepSmoothOffset) < 1e-3) characterController.state.stepSmoothOffset = 0;
    }

    const pos = getVisualWorldPosition(transform);
    // when step-smoothing, base camera Y on the authoritative position so the offset doesn't fight the interpolated lerp.
    const baseY = characterController.state.stepSmoothOffset !== 0 ? transform.position[1] : pos[1];
    const headX = pos[0];
    const headY = baseY + characterController.state.eyeHeight + characterController.state.stepSmoothOffset;
    const headZ = pos[2];

    const theta = characterController.input.look[1];
    const phi = characterController.input.look[2];

    // world-space look direction from spherical; theta=0, phi=pi/2 gives fwd=-Z, matching glTF.
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const fwdX = -sinTheta * sinPhi;
    const fwdY = -cosPhi;
    const fwdZ = -cosTheta * sinPhi;

    // pick eye + target by perspective, then derive the camera quaternion via mat4.targetTo, same as the orbit-controller.
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
        // Target the head, view direction = -fwd (camera faces player).
        targetX = headX;
        targetY = headY;
        targetZ = headZ;
    } else {
        playerController.state.currentCameraDistance = 0;

        // first-person camera bob: shift eye and target by the same offset so the look direction is preserved.
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

script(
    PlayerControllerTrait,
    'controller',
    (ctx) => {
        const debugHelpers = createDebugHelpers();
        let debugPanelEl: HTMLDivElement | null = null;

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

        // config lives on the trait (`pc.crosshair`); the DOM widget is created lazily on the first subject-held frame.
        let crosshair: Crosshair | null = null;

        // each HUD piece reconciles per-tick against controls.enabled && isTouchPrimary(ctx) && controls.touch.<flag>.
        type HudHandle = { dispose(): void } | null;
        const hud: {
            joystick: HudHandle;
            jumpButton: HudHandle;
            sprintButton: HudHandle;
            crouchButton: HudHandle;
            verticalJoystick: HudHandle;
            flyToggle: HudHandle;
        } = {
            joystick: null,
            jumpButton: null,
            sprintButton: null,
            crouchButton: null,
            verticalJoystick: null,
            flyToggle: null,
        };
        // which glyph the fly toggle currently shows, so it remounts only when the mode actually flips.
        let flyToggleShowsBoot: boolean | null = null;

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
            // pointer lock is derived each frame from the room's intent + UI releases, not released here.

            // touch controls show whenever touch is the primary input, independent of viewport size.
            const wantHud = on && isTouchPrimary(ctx);
            // noclip swaps the jump button for a vertical up/down joystick so the flyer can descend too.
            const noclip = !!getTrait(ctx.node, CharacterControllerTrait)?.input.noclip;

            reconcileHud('joystick', wantHud && pc.controls.touch.joystick, () =>
                createTouchJoystick(ctx, {
                    id: PlayerControllerTouchIds.moveJoystick,
                    // dynamic: appears where you touch in the lower-left; a dimmed hint sits at this anchor until first touch.
                    dynamic: true,
                    left: 24,
                    bottom: 24,
                    size: 104,
                    deadzone: 0.12,
                }),
            );
            reconcileHud('jumpButton', wantHud && pc.controls.touch.jumpButton && !noclip, () =>
                createTouchButton(ctx, {
                    id: PlayerControllerTouchIds.jumpButton,
                    right: 24,
                    bottom: 24,
                    width: 96,
                    height: 96,
                    icon: jumpIcon,
                }),
            );
            reconcileHud('verticalJoystick', wantHud && pc.controls.touch.noclipVerticalJoystick && noclip, () =>
                createTouchJoystick(ctx, {
                    id: PlayerControllerTouchIds.verticalJoystick,
                    // sits where the jump button was; y-locked to ascend/descend.
                    right: 24,
                    bottom: 24,
                    size: 104,
                    deadzone: 0.12,
                    axis: 'y',
                }),
            );
            // fly/walk toggle: the glyph reflects the destination, so it remounts when the mode flips; driven directly.
            const wantFlyToggle = wantHud && pc.controls.touch.flyToggleButton;
            if (!wantFlyToggle) {
                if (hud.flyToggle) {
                    hud.flyToggle.dispose();
                    hud.flyToggle = null;
                }
                flyToggleShowsBoot = null;
            } else if (!hud.flyToggle || flyToggleShowsBoot !== noclip) {
                hud.flyToggle?.dispose();
                flyToggleShowsBoot = noclip;
                hud.flyToggle = createTouchButton(ctx, {
                    id: PlayerControllerTouchIds.flyToggle,
                    // above the ascend/jump control in the bottom-right cluster.
                    right: 24,
                    bottom: 132,
                    width: 52,
                    height: 52,
                    // glyph shows the destination: footprints while flying, a drone while walking.
                    icon: noclip ? walkIcon : flyIcon,
                });
            }
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

            // cleared symmetrically in onDispose; the lock is reconciled once at end-of-frame.
            setPointerLock(ctx, true);
        });

        onDispose(ctx, () => {
            if (!isOwner(ctx, ctx.node)) return;
            setPointerLock(ctx, false);
            clearDebugHelpers(ctx.client?.render.scene, debugHelpers);
            removeDebugPanel();
            if (crosshair) removeCrosshair(crosshair);
            disposeAllHud();
        });

        onUpdate(ctx, ({ delta }) => {
            // input + camera writes gate on control: when the POV swaps to a different node, this player stops reading input.
            if (getSubject(ctx) !== ctx.node) return;
            const cc = getTrait(ctx.node, CharacterControllerTrait);
            if (!cc) return;

            const pc = ctx.trait;
            pc.state.elapsed += delta;
            const input = ctx.client?.input;
            syncHud(pc);
            if (input) {
                const viewportWidth = ctx.client?.state?.viewport.width ?? 0;
                pollInput(pc, cc, input, viewportWidth);

                // double-tap Space toggles noclip when enabled; pure gesture, the noclip movement itself lives on the CC.
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

                // touch fly/walk toggle button: flips noclip and kills momentum on entry so you don't rocket off.
                if (pc.controls.touch.flyToggleButton && isTouchButtonJustDown(input.touch, PlayerControllerTouchIds.flyToggle)) {
                    cc.input.noclip = !cc.input.noclip;
                    if (cc.input.noclip) vec3.set(cc.state.velocity, 0, 0, 0);
                    cc.input.jump = false;
                }

                // 'C' cycles perspective, play mode only, to keep the edit-mode camera predictable while building.
                if (ctx.mode !== 'edit' && isKeyJustDown(input.mouseKeyboard, 'KeyC')) {
                    const idx = PERSPECTIVE_ORDER.indexOf(pc.config.perspective);
                    pc.config.perspective = PERSPECTIVE_ORDER[(idx + 1) % PERSPECTIVE_ORDER.length]!;
                }
            }

            const targetFov = (cc.input.sprint ? pc.config.fovSprint : pc.config.fov) * pc.config.fovScale;
            pc.state.currentFov += (targetFov - pc.state.currentFov) * (1 - Math.exp(-pc.config.fovLerpSpeed * delta));
        });

        onTick(ctx, ({ step }) => {
            // noclip drives the player's transform from input; gated on control so a non-control player can't keep flying.
            if (getSubject(ctx) !== ctx.node) return;
            const cc = getTrait(ctx.node, CharacterControllerTrait);
            if (!cc?.input.noclip) return;
            const transform = getTrait(ctx.node, TransformTrait);
            if (!transform) return;
            tickPlayerNoclip(ctx.trait, cc, transform, ctx.physics, step);
        });

        onFrame(ctx, ({ delta }) => {
            const cc = getTrait(ctx.node, CharacterControllerTrait);
            const transform = getTrait(ctx.node, TransformTrait);
            if (!cc || !transform) return;

            const pc = ctx.trait;
            // camera + crosshair are control-gated: only the POV node writes to its CameraTrait or paints the HUD overlay.
            if (getSubject(ctx) === ctx.node) {
                // resolve the active camera each frame so it stays correct across editor lens swaps.
                const cameraNode = getCamera(ctx)!;
                const cameraTransform = getTrait(cameraNode, TransformTrait)!;
                const cameraTrait = getTrait(cameraNode, CameraTrait)!;
                updateCamera(pc, cc, transform, ctx.physics, cameraTransform, cameraTrait, delta);
                crosshair ??= createCrosshair(ctx);
                if (crosshair) {
                    if (pc.crosshair.enabled) {
                        addCrosshair(crosshair);
                        updateCrosshair(crosshair, pc.crosshair, delta);
                    } else {
                        removeCrosshair(crosshair);
                    }
                }
            } else if (crosshair) {
                removeCrosshair(crosshair);
            }

            if (env.editor && ctx.mode === 'edit' && isOwner(ctx, ctx.node)) {
                const scene = ctx.client?.render.scene;
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
                clearDebugHelpers(ctx.client?.render.scene, debugHelpers);
                removeDebugPanel();
            }
        });
    },
    { editor: true },
);
