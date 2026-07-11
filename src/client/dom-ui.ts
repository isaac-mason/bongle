// dom-ui, per-room visuals for the two UI traits (HtmlTrait, CanvasTrait).
//
// One init/update/dispose handles both kinds. They share enough
// concerns (mount under `room.viewport`, CSS-px projection, 3D
// orientation modes, lazy install with `lastSeenFrame` cleanup) that a
// single module is more honest than two peer dirs.
//
// Per-trait responsibilities:
// - HtmlTrait: positions a `<div>` on a DOM overlay layer over the
//   canvas. `screen` mode projects the node to CSS px; `world` /
//   `billboard` / `y-billboard` modes are stubbed for v1 (warn-once).
// - CanvasTrait: per-instance Mesh + `OffscreenCanvas` quad. User
//   scripts paint directly and flip `needsUpdate`. DOM-in-canvas (the
//   former HtmlCanvasTrait use case) is a userland recipe on top,
//   user mounts an off-screen div themselves and `drawElement`s into
//   the canvas. See plan-ui-traits.md appendix.
//
// Canvas uses one Mesh per instance for v1, readable and shippable.
// GPU-batched instancing (à la model-visuals) is a later optimisation
// if perf bites.

import {
    attribute,
    type Camera,
    CanvasTexture,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createPlaneGeometry,
    type DepthTextureNode,
    Discard,
    d,
    Fn,
    f32,
    fragCoord,
    If,
    Material,
    Mesh,
    modelWorldMatrix,
    mul,
    type Scene,
    screenCoordinate,
    texture,
    varying,
    vec2i,
    vec4f,
} from 'gpucat';
import { type Quat, quat, type Vec3, vec3 } from 'mathcat';
import { CanvasTrait } from '../builtins/canvas';
import { HtmlTrait } from '../builtins/html';
import { getVisualWorldMatrix, TransformTrait } from '../builtins/transform';
import type { SceneTree } from '../core/scene/scene-tree';
import { query } from '../core/scene/scene-tree';
import { UILayer } from './ui-layers';
import type { Viewport } from './viewport';

// ── shared per-instance state ──────────────────────────────────────

type CanvasQuadState = {
    /** The Mesh added to the scene; per-instance for v1. */
    mesh: Mesh;
    texture: CanvasTexture;
    canvas: OffscreenCanvas;
    /** The trait's `_version` observed at last config refresh (size, mode, …). */
    versionAtRefresh: number;
    /** Frame counter, used to detect stale states for cleanup. */
    lastSeenFrame: number;
    width: number;
    height: number;
};

type CanvasState = CanvasQuadState & {
    trait: CanvasTrait;
};

type HtmlState = {
    trait: HtmlTrait;
    /** The `<div>` mounted on the overlay layer. Same ref as `trait.element`. */
    element: HTMLDivElement;
    lastSeenFrame: number;
    /** Cache last-applied transform string to skip redundant style writes. */
    lastTransform: string;
    lastZIndex: string;
    lastDisplay: string;
    lastPointerEvents: string;
};

// ── init ───────────────────────────────────────────────────────────

// `scene` is the room's overlay scene: CanvasTrait quads are added here so they
// render crisp in the post-fxaa overlay pass. HtmlTrait panels are DOM (mounted
// on `htmlOverlay`) and ignore this scene. `sceneDepthNode` is the main scene
// pass's depth, sampled by canvas materials to discard fragments occluded by
// world geometry.
export function init(scene: Scene, viewport: HTMLDivElement, nodes: SceneTree, sceneDepthNode: DepthTextureNode) {
    const htmlOverlay = document.createElement('div');
    htmlOverlay.className = 'engine-html-layer';
    htmlOverlay.style.position = 'absolute';
    htmlOverlay.style.inset = '0';
    htmlOverlay.style.pointerEvents = 'none';
    htmlOverlay.style.transformStyle = 'preserve-3d';
    // explicit z-index makes this a stacking context, confining the huge
    // per-frame depth z-indices the trait panels get (see UILayer) so they
    // sort among themselves but never paint over the HUD above.
    htmlOverlay.style.zIndex = String(UILayer.worldOverlay);
    viewport.appendChild(htmlOverlay);

    return {
        scene,
        sceneDepthNode,
        viewport,
        htmlOverlay,
        htmlStates: new Map<HtmlTrait, HtmlState>(),
        canvasStates: new Map<CanvasTrait, CanvasState>(),
        htmlQuery: query(nodes, [HtmlTrait, TransformTrait]),
        canvasQuery: query(nodes, [CanvasTrait, TransformTrait]),
        frameId: 0,
    };
}

export type DomUi = ReturnType<typeof init>;

// ── update ─────────────────────────────────────────────────────────

export function update(domUi: DomUi, camera: Camera, viewport: Viewport): void {
    const frameId = ++domUi.frameId;

    updateHtml(domUi, camera, viewport, frameId);
    updateCanvas(domUi, camera, frameId);

    cleanup(domUi, frameId);
}

// ── HtmlTrait ──────────────────────────────────────────────────────

const _scratchClip: [number, number, number, number] = [0, 0, 0, 0];

function updateHtml(domUi: DomUi, camera: Camera, viewport: Viewport, frameId: number): void {
    const vw = viewport.width;
    const vh = viewport.height;
    const halfW = vw / 2;
    const halfH = vh / 2;

    for (const [trait, transform] of domUi.htmlQuery) {
        let state = domUi.htmlStates.get(trait);
        if (!state) state = installHtml(domUi, trait);
        state.lastSeenFrame = frameId;

        if (trait.mode !== 'screen') {
            warnHtml3DMode(trait.mode);
            setStyle(state, 'lastDisplay', state.element.style, 'display', 'none');
            continue;
        }

        // project node world position to clip → NDC → CSS px.
        const worldMat = getVisualWorldMatrix(transform);
        const wx = worldMat[12]!;
        const wy = worldMat[13]!;
        const wz = worldMat[14]!;
        projectPoint(_scratchClip, wx, wy, wz, camera);
        const cw = _scratchClip[3];

        if (cw <= 0) {
            setStyle(state, 'lastDisplay', state.element.style, 'display', 'none');
            continue;
        }

        const ndcX = _scratchClip[0] / cw;
        const ndcY = _scratchClip[1] / cw;
        const ndcZ = _scratchClip[2] / cw;

        // off-screen slack: a panel still partially overlaps when its
        // anchor leaves NDC, so don't hard-clip here. CSS handles overflow.
        const cssX = halfW + ndcX * halfW;
        const cssY = halfH - ndcY * halfH;

        let scaleStr = '';
        if (trait.distanceFactor !== null) {
            // distance from camera to the anchor (any positive scalar works,
            // drei uses cameraDistance and the scale = factor / dist).
            const cam = camera.position;
            const dx = wx - cam[0];
            const dy = wy - cam[1];
            const dz = wz - cam[2];
            const dist = Math.hypot(dx, dy, dz);
            const s = dist > 0 ? trait.distanceFactor / dist : 1;
            scaleStr = ` scale(${s})`;
        }

        const centerStr = trait.center ? ' translate(-50%,-50%)' : '';
        const transformStr = `translate(${cssX}px,${cssY}px)${centerStr}${scaleStr}`;
        setStyle(state, 'lastTransform', state.element.style, 'transform', transformStr);

        // drei trick: lerp the projected depth into a discrete z-index
        // range so overlapping panels sort by depth without DOM reorder.
        // ndcZ is [0,1] in WebGPU; clamp for safety.
        const depthT = Math.max(0, Math.min(1, ndcZ));
        const [zNear, zFar] = trait.zIndexRange;
        const zIndex = Math.round(zNear + (zFar - zNear) * depthT);
        setStyle(state, 'lastZIndex', state.element.style, 'zIndex', String(zIndex));

        setStyle(state, 'lastDisplay', state.element.style, 'display', '');
        setStyle(state, 'lastPointerEvents', state.element.style, 'pointerEvents', trait.pointerEvents ? 'auto' : 'none');
    }
}

function installHtml(domUi: DomUi, trait: HtmlTrait): HtmlState {
    // trait.element is created by the trait factory on the client. The
    // visuals layer just mounts it into the overlay and configures the
    // engine-managed style bits (positioning + pointer-events).
    const element = trait.element!;
    element.style.position = 'absolute';
    element.style.left = '0';
    element.style.top = '0';
    element.style.transformOrigin = '0 0';
    element.style.willChange = 'transform';
    element.style.pointerEvents = trait.pointerEvents ? 'auto' : 'none';
    domUi.htmlOverlay.appendChild(element);

    const state: HtmlState = {
        trait,
        element,
        lastSeenFrame: 0,
        lastTransform: '',
        lastZIndex: '',
        lastDisplay: '',
        lastPointerEvents: '',
    };
    domUi.htmlStates.set(trait, state);
    return state;
}

function disposeHtml(domUi: DomUi, state: HtmlState): void {
    // Detach from the overlay but leave trait.element intact, the trait
    // owns the div. Userland keeps any references it stashed.
    state.element.remove();
    domUi.htmlStates.delete(state.trait);
}

const _warnedHtml3D = new Set<string>();
function warnHtml3DMode(mode: string): void {
    if (_warnedHtml3D.has(mode)) return;
    _warnedHtml3D.add(mode);
    console.warn(
        `[dom-ui] HtmlTrait mode '${mode}' is not implemented yet — only 'screen' is supported. Falling back to display:none.`,
    );
}

// ── CanvasTrait ────────────────────────────────────────────────────

function updateCanvas(domUi: DomUi, camera: Camera, frameId: number): void {
    for (const [trait, transform] of domUi.canvasQuery) {
        let state = domUi.canvasStates.get(trait);
        if (!state) state = installCanvas(domUi, trait);
        state.lastSeenFrame = frameId;

        if (trait._version !== state.versionAtRefresh) {
            refreshCanvasConfig(state, trait);
        }

        applyQuadPose(state.mesh, transform, camera, trait.mode, trait.center, trait.width, trait.height, trait.worldScale);

        if (trait.needsUpdate) {
            state.texture.needsUpdate = true;
            trait.needsUpdate = false;
        }
    }
}

function installCanvas(domUi: DomUi, trait: CanvasTrait): CanvasState {
    // trait.canvas is created by the trait factory on the client. The
    // visuals layer just resizes it (if width/height defaults differ
    // from the factory size) and wraps it in a texture.
    const canvas = trait.canvas!;
    if (canvas.width !== trait.width) canvas.width = trait.width;
    if (canvas.height !== trait.height) canvas.height = trait.height;
    // WebGPU's copyExternalImageToTexture rejects an OffscreenCanvas with
    // no rendering context bound. Eagerly bind one so first upload works
    // even if the user hasn't called getContext yet.
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    const tex = new CanvasTexture(canvas);
    const mesh = new Mesh(createPlaneGeometry(1, 1), createTexturedQuadMaterial(tex, domUi.sceneDepthNode));
    mesh.name = 'dom-ui-canvas';
    mesh.frustumCulled = false;
    domUi.scene.add(mesh);

    const state: CanvasState = {
        trait,
        mesh,
        texture: tex,
        canvas,
        width: trait.width,
        height: trait.height,
        versionAtRefresh: trait._version,
        lastSeenFrame: 0,
    };
    domUi.canvasStates.set(trait, state);
    return state;
}

function refreshCanvasConfig(state: CanvasState, trait: CanvasTrait): void {
    if (state.width !== trait.width || state.height !== trait.height) {
        state.canvas.width = trait.width;
        state.canvas.height = trait.height;
        state.width = trait.width;
        state.height = trait.height;
        // user code keeps the same OffscreenCanvas ref, just sees a new size.
        state.texture.needsUpdate = true;
    }
    state.versionAtRefresh = trait._version;
}

function disposeCanvas(domUi: DomUi, state: CanvasState): void {
    // trait.canvas stays, userland may still hold the ref / context.
    domUi.scene.remove(state.mesh);
    state.mesh.geometry.dispose();
    state.mesh.material.dispose();
    domUi.canvasStates.delete(state.trait);
}

// ── shared: textured quad pose + material ──────────────────────────

const _meshPos: Vec3 = [0, 0, 0];
const _meshOffset: Vec3 = [0, 0, 0];

function applyQuadPose(
    mesh: Mesh,
    transform: TransformTrait,
    camera: Camera,
    mode: 'world' | 'billboard' | 'y-billboard',
    center: boolean,
    width: number,
    height: number,
    worldScale: number,
): void {
    const worldMat = getVisualWorldMatrix(transform);
    _meshPos[0] = worldMat[12]!;
    _meshPos[1] = worldMat[13]!;
    _meshPos[2] = worldMat[14]!;

    // orientation
    if (mode === 'billboard') {
        // copy camera world rotation. plane +Z normal then points back
        // toward the camera (camera local +Z is "behind camera" in world).
        quat.fromMat4(mesh.quaternion as Quat, camera.matrixWorld);
    } else if (mode === 'y-billboard') {
        const camPos = camera.position;
        const dx = camPos[0] - _meshPos[0];
        const dz = camPos[2] - _meshPos[2];
        const yaw = Math.atan2(dx, dz);
        // rotation around world-Y by yaw.
        const half = yaw * 0.5;
        const s = Math.sin(half);
        const c = Math.cos(half);
        mesh.quaternion[0] = 0;
        mesh.quaternion[1] = s;
        mesh.quaternion[2] = 0;
        mesh.quaternion[3] = c;
    } else {
        // 'world', copy node world rotation.
        quat.fromMat4(mesh.quaternion as Quat, worldMat);
    }

    mesh.scale[0] = width * worldScale;
    mesh.scale[1] = height * worldScale;
    mesh.scale[2] = 1;

    // center vs top-left anchor: offset by (+w/2, -h/2) in panel local frame
    // when anchoring at top-left (so the panel center lands +w/2,-h/2 from
    // the anchor).
    if (!center) {
        _meshOffset[0] = width * worldScale * 0.5;
        _meshOffset[1] = -(height * worldScale) * 0.5;
        _meshOffset[2] = 0;
        vec3.transformQuat(_meshOffset, _meshOffset, mesh.quaternion as Quat);
        _meshPos[0] += _meshOffset[0];
        _meshPos[1] += _meshOffset[1];
        _meshPos[2] += _meshOffset[2];
    }

    mesh.position[0] = _meshPos[0];
    mesh.position[1] = _meshPos[1];
    mesh.position[2] = _meshPos[2];
}

// occlusion by world geometry, done in-shader (the overlay pass has no shared
// depth attachment). `sceneZ` is the main scene pass's stored NDC depth at this
// pixel; discard when this fragment's `fragZ` is behind it. `sceneZ == 1` (no
// geometry / far plane) never occludes.
const canvasDepthOcclude = Fn(
    (color, fragZ, sceneZ) => {
        If(fragZ.greaterThan(sceneZ), () => {
            Discard();
        });
        return color;
    },
    {
        name: 'canvasDepthOcclude',
        params: [
            { name: 'color', type: d.vec4f },
            { name: 'fragZ', type: d.f32 },
            { name: 'sceneZ', type: d.f32 },
        ],
    },
);

function createTexturedQuadMaterial(tex: CanvasTexture, sceneDepthNode: DepthTextureNode): Material {
    // simple textured quad: clip = projection * view * model * vec4(pos,1),
    // fragment = sample(uv), discarded where occluded by world geometry.
    const aPosition = attribute('position', d.vec3f);
    const aUv = attribute('uv', d.vec2f);

    const worldPos = mul(modelWorldMatrix, vec4f(aPosition, f32(1.0)));
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

    // attributes can only be read in the vertex stage; pass uv through a
    // varying so the fragment shader gets interpolated coords.
    const vUv = varying(aUv, 'domUiUv');

    const texNode = texture(tex);
    const sampled = texNode.sample(vUv);

    // sample the scene pass's depth at this fragment's pixel and discard if we're
    // behind world geometry. same camera as the scene → same NDC-z space as
    // `fragCoord.z`, so a direct compare is correct.
    const sceneZ = sceneDepthNode.load(vec2i(screenCoordinate));
    const fragment = canvasDepthOcclude(sampled, fragCoord.z, sceneZ);

    return new Material({
        name: 'dom-ui-quad',
        vertex: clipPos,
        fragment,
        cullMode: 'none',
        // occlusion is handled in-shader (above); the overlay pass owns no depth
        // we test/write against, and transparent panels sort back-to-front.
        depthTest: false,
        depthWrite: false,
        transparent: true,
    });
}

// ── shared utilities ───────────────────────────────────────────────

function projectPoint(out: [number, number, number, number], x: number, y: number, z: number, camera: Camera): void {
    // clip = projection * view * vec4(pos, 1)
    const view = camera.matrixWorldInverse;
    const proj = camera.projectionMatrix;

    // vp = view * pos
    const vx = view[0]! * x + view[4]! * y + view[8]! * z + view[12]!;
    const vy = view[1]! * x + view[5]! * y + view[9]! * z + view[13]!;
    const vz = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!;
    const vw = view[3]! * x + view[7]! * y + view[11]! * z + view[15]!;

    // clip = projection * vp
    out[0] = proj[0]! * vx + proj[4]! * vy + proj[8]! * vz + proj[12]! * vw;
    out[1] = proj[1]! * vx + proj[5]! * vy + proj[9]! * vz + proj[13]! * vw;
    out[2] = proj[2]! * vx + proj[6]! * vy + proj[10]! * vz + proj[14]! * vw;
    out[3] = proj[3]! * vx + proj[7]! * vy + proj[11]! * vz + proj[15]! * vw;
}

function setStyle<S extends { [K in T]: string }, T extends keyof S>(
    state: S,
    cacheKey: T,
    style: CSSStyleDeclaration,
    prop: string,
    value: string,
): void {
    if (state[cacheKey] === value) return;
    style.setProperty(prop, value);
    state[cacheKey] = value as S[T];
}

// ── cleanup ────────────────────────────────────────────────────────

function cleanup(domUi: DomUi, frameId: number): void {
    for (const state of domUi.htmlStates.values()) {
        if (state.lastSeenFrame !== frameId) disposeHtml(domUi, state);
    }
    for (const state of domUi.canvasStates.values()) {
        if (state.lastSeenFrame !== frameId) disposeCanvas(domUi, state);
    }
}

// ── dispose ────────────────────────────────────────────────────────

export function dispose(domUi: DomUi): void {
    for (const state of [...domUi.htmlStates.values()]) disposeHtml(domUi, state);
    for (const state of [...domUi.canvasStates.values()]) disposeCanvas(domUi, state);
    domUi.htmlOverlay.remove();
}
