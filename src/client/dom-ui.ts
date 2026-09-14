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
    screenUV,
    texture,
    textureDimensions,
    varying,
    vec2f,
    vec2i,
    vec4f,
} from 'gpucat';
import { type Quat, quat, type Vec3, vec3 } from 'math';
import { CanvasTrait } from '../builtins/canvas';
import { HtmlTrait } from '../builtins/html';
import { getVisualWorldMatrix, TransformTrait } from '../builtins/transform';
import type { SceneTree } from '../core/scene/scene-tree';
import { onQueryExit, query } from '../core/scene/scene-tree';
import type { Unsubscribe } from '../core/utils/topic';
import { UILayer } from './ui/util/ui-layers';
import type { Viewport } from './viewport';

type CanvasQuadState = {
    mesh: Mesh;
    texture: CanvasTexture;
    canvas: OffscreenCanvas;
    /** trait's `_version` observed at last config refresh (size, mode, etc). */
    versionAtRefresh: number;
    width: number;
    height: number;
};

type CanvasState = CanvasQuadState & {
    trait: CanvasTrait;
};

type HtmlState = {
    trait: HtmlTrait;
    /** same ref as `trait.element`. */
    element: HTMLDivElement;
    /** last-applied transform string, skips redundant style writes. */
    lastTransform: string;
    lastZIndex: string;
    lastDisplay: string;
    lastPointerEvents: string;
};

// `scene` is the overlay scene CanvasTrait quads render into (crisp in the
// post-fxaa pass); HtmlTrait panels are DOM, mounted on `htmlOverlay` instead.
// `sceneDepthNode` is the main pass's depth, sampled to occlude canvas quads
// behind world geometry.
export function init(scene: Scene, viewport: HTMLDivElement, nodes: SceneTree, sceneDepthNode: DepthTextureNode) {
    const htmlOverlay = document.createElement('div');
    htmlOverlay.className = 'engine-html-layer';
    htmlOverlay.style.position = 'absolute';
    htmlOverlay.style.inset = '0';
    htmlOverlay.style.pointerEvents = 'none';
    htmlOverlay.style.transformStyle = 'preserve-3d';
    // explicit z-index makes this a stacking context, confining the trait
    // panels' per-frame depth z-indices (see UILayer) below the HUD.
    htmlOverlay.style.zIndex = String(UILayer.worldOverlay);
    viewport.appendChild(htmlOverlay);

    const domUi = {
        scene,
        sceneDepthNode,
        viewport,
        htmlOverlay,
        htmlStates: new Map<HtmlTrait, HtmlState>(),
        canvasStates: new Map<CanvasTrait, CanvasState>(),
        htmlQuery: query(nodes, [HtmlTrait, TransformTrait]),
        canvasQuery: query(nodes, [CanvasTrait, TransformTrait]),
        _unsubscribes: [] as Unsubscribe[],
    };

    // edge-driven teardown: a panel is torn down the moment its node stops
    // matching, rather than a frame later by a sweep.
    domUi._unsubscribes.push(
        onQueryExit(domUi.htmlQuery, (trait) => {
            const state = domUi.htmlStates.get(trait);
            if (state) disposeHtml(domUi, state);
        }),
        onQueryExit(domUi.canvasQuery, (trait) => {
            const state = domUi.canvasStates.get(trait);
            if (state) disposeCanvas(domUi, state);
        }),
    );

    return domUi;
}

export type DomUi = ReturnType<typeof init>;

export function update(domUi: DomUi, camera: Camera, viewport: Viewport): void {
    updateHtml(domUi, camera, viewport);
    updateCanvas(domUi, camera);
}

const _scratchClip: [number, number, number, number] = [0, 0, 0, 0];

function updateHtml(domUi: DomUi, camera: Camera, viewport: Viewport): void {
    const vw = viewport.width;
    const vh = viewport.height;
    const halfW = vw / 2;
    const halfH = vh / 2;

    for (const [trait, transform] of domUi.htmlQuery) {
        let state = domUi.htmlStates.get(trait);
        if (!state) state = installHtml(domUi, trait);

        if (trait.mode !== 'screen') {
            warnHtml3DMode(trait.mode);
            setStyle(state, 'lastDisplay', state.element.style, 'display', 'none');
            continue;
        }

        // project node world position: clip, then NDC, then CSS px.
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

        // no hard clip: a panel can still partially overlap once its anchor
        // leaves NDC, so let CSS handle overflow.
        const cssX = halfW + ndcX * halfW;
        const cssY = halfH - ndcY * halfH;

        let scaleStr = '';
        if (trait.distanceFactor !== null) {
            // drei-style: scale = distanceFactor / distance-to-camera.
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

        // lerp projected depth into a discrete z-index range so overlapping
        // panels sort without DOM reorder. ndcZ is [0,1] in WebGPU; clamp.
        const depthT = Math.max(0, Math.min(1, ndcZ));
        const [zNear, zFar] = trait.zIndexRange;
        const zIndex = Math.round(zNear + (zFar - zNear) * depthT);
        setStyle(state, 'lastZIndex', state.element.style, 'zIndex', String(zIndex));

        setStyle(state, 'lastDisplay', state.element.style, 'display', '');
        setStyle(state, 'lastPointerEvents', state.element.style, 'pointerEvents', trait.pointerEvents ? 'auto' : 'none');
    }
}

function installHtml(domUi: DomUi, trait: HtmlTrait): HtmlState {
    // trait.element is created by the trait factory; this only mounts it and
    // sets the engine-managed style bits (positioning + pointer-events).
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
        lastTransform: '',
        lastZIndex: '',
        lastDisplay: '',
        lastPointerEvents: '',
    };
    domUi.htmlStates.set(trait, state);
    return state;
}

function disposeHtml(domUi: DomUi, state: HtmlState): void {
    // trait.element stays intact, the trait owns the div.
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

function updateCanvas(domUi: DomUi, camera: Camera): void {
    for (const [trait, transform] of domUi.canvasQuery) {
        let state = domUi.canvasStates.get(trait);
        if (!state) state = installCanvas(domUi, trait);

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
    // trait.canvas is created by the trait factory; this only resizes it (if
    // width/height differ from the factory default) and wraps it in a texture.
    const canvas = trait.canvas!;
    if (canvas.width !== trait.width) canvas.width = trait.width;
    if (canvas.height !== trait.height) canvas.height = trait.height;
    // copyExternalImageToTexture rejects an OffscreenCanvas with no bound
    // rendering context, so bind one eagerly in case the user hasn't yet.
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    const tex = new CanvasTexture(canvas);
    // nearest magnification (matches voxel-textures/mesh-atlas/sprite-resources);
    // linear minification + anisotropy stays sharper than a mip chain at the
    // ~2-3x minification these label quads typically sit at. Past ~4x this
    // aliases; fix by raising worldScale or lowering width/height, not the filter.
    tex.magFilter = 'nearest';
    tex.minFilter = 'linear';
    tex.anisotropy = 16;
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
        // user code keeps the same OffscreenCanvas ref, sees a new size.
        state.texture.needsUpdate = true;
    }
    state.versionAtRefresh = trait._version;
}

function disposeCanvas(domUi: DomUi, state: CanvasState): void {
    // trait.canvas stays, userland may still hold the ref/context.
    domUi.scene.remove(state.mesh);
    state.mesh.geometry.dispose();
    state.mesh.material.dispose();
    domUi.canvasStates.delete(state.trait);
}

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

    if (mode === 'billboard') {
        // camera local +Z is "behind camera" in world, so copying camera
        // world rotation points the plane's +Z normal back at the camera.
        quat.fromMat4(mesh.quaternion as Quat, camera.matrixWorld);
    } else if (mode === 'y-billboard') {
        const camPos = camera.position;
        const dx = camPos[0] - _meshPos[0];
        const dz = camPos[2] - _meshPos[2];
        const yaw = Math.atan2(dx, dz);
        // quaternion for a rotation around world-Y by yaw.
        const half = yaw * 0.5;
        const s = Math.sin(half);
        const c = Math.cos(half);
        mesh.quaternion[0] = 0;
        mesh.quaternion[1] = s;
        mesh.quaternion[2] = 0;
        mesh.quaternion[3] = c;
    } else {
        quat.fromMat4(mesh.quaternion as Quat, worldMat);
    }

    mesh.scale[0] = width * worldScale;
    mesh.scale[1] = height * worldScale;
    mesh.scale[2] = 1;

    // top-left anchor: offset the mesh (+w/2, -h/2) in panel local frame so
    // the panel's center lands there instead of the anchor point.
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

// discards fragments occluded by world geometry: `sceneZ` is the main pass's
// stored NDC depth at this pixel, `sceneZ == 1` (far plane) never occludes.
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
    const aPosition = attribute('position', d.vec3f);
    const aUv = attribute('uv', d.vec2f);

    const worldPos = mul(modelWorldMatrix, vec4f(aPosition, f32(1.0)));
    const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));

    // attributes are vertex-stage only; pass uv through a varying for the
    // fragment shader's interpolated coords.
    const vUv = varying(aUv, 'domUiUv');

    const texNode = texture(tex);
    const sampled = texNode.sample(vUv);

    // same camera as the scene pass, so sceneZ is directly comparable to
    // fragCoord.z. index by screenUV scaled to the depth texture's own
    // dimensions rather than raw fragCoord pixels: the overlay pass and the
    // scene-depth attachment can differ in pixel space under a devicePixelRatio
    // mismatch (WebGL/HiDPI), which would otherwise index out of bounds.
    const depthTexel = vec2i(mul(screenUV, vec2f(textureDimensions(sceneDepthNode.bindingNode))));
    const sceneZ = sceneDepthNode.load(depthTexel);
    const fragment = canvasDepthOcclude(sampled, fragCoord.z, sceneZ);
    return new Material({
        name: 'dom-ui-quad',
        vertex: clipPos,
        fragment,
        cullMode: 'none',
        // occlusion is handled in-shader above; transparent panels sort back-to-front.
        depthTest: false,
        depthWrite: false,
        transparent: true,
    });
}

function projectPoint(out: [number, number, number, number], x: number, y: number, z: number, camera: Camera): void {
    const view = camera.matrixWorldInverse;
    const proj = camera.projectionMatrix;

    const vx = view[0]! * x + view[4]! * y + view[8]! * z + view[12]!;
    const vy = view[1]! * x + view[5]! * y + view[9]! * z + view[13]!;
    const vz = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!;
    const vw = view[3]! * x + view[7]! * y + view[11]! * z + view[15]!;

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

export function dispose(domUi: DomUi): void {
    // unsubscribing is itself an exit: each handler fires once more per node
    // still matching, which does the whole teardown.
    for (const unsubscribe of domUi._unsubscribes) unsubscribe();
    domUi._unsubscribes.length = 0;
    domUi.htmlOverlay.remove();
}
