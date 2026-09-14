import {
    type Camera,
    createBoxGeometry,
    createCylinderGeometry,
    createIndexBuffer,
    createOctahedronGeometry,
    createPlaneGeometry,
    createSphereGeometry,
    createTorusGeometry,
    createVertexBuffer,
    d,
    Geometry,
    type Intersection,
    Material,
    Mesh,
    Object3D,
    type OrthographicCamera,
    positionClip,
    Raycaster,
    Uniform,
    uniform,
} from 'gpucat';
import { euler, type Mat4, mat4, type Quat, quat, type Vec3, vec3 } from 'math';
import { type Topic, topic } from '../core/utils/topic';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';

/** NDC; `button` is -1 for a move during a drag, 0 otherwise. */
export type GizmoPointer = { x: number; y: number; button: number };

type Rgba = [number, number, number, number];

type Handle = {
    mesh: Mesh;
    name: string;
    baseColor: Rgba;
};

type HandleSet = {
    root: Object3D;
    handles: Handle[];
};

export type TransformControls = {
    camera: Camera;
    object: Object3D | null;

    enabled: boolean;
    mode: TransformMode;
    space: TransformSpace;
    axis: string | null;
    dragging: boolean;
    size: number;
    /** picker meshes only; >1 widens the hit area for coarse pointers. */
    pickerScale: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;

    translationSnap: number | null;
    rotationSnap: number | null;
    scaleSnap: number | null;

    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;

    worldPosition: Vec3;
    worldQuaternion: Quat;
    worldScale: Vec3;
    worldQuaternionInv: Quat;
    parentPosition: Vec3;
    parentQuaternion: Quat;
    parentQuaternionInv: Quat;
    parentScale: Vec3;
    cameraPosition: Vec3;
    cameraQuaternion: Quat;
    cameraScale: Vec3;
    eye: Vec3;

    worldPositionStart: Vec3;
    worldQuaternionStart: Quat;
    worldScaleStart: Vec3;
    positionStart: Vec3;
    quaternionStart: Quat;
    scaleStart: Vec3;
    /** drag-plane hits relative to `worldPositionStart`. */
    pointStart: Vec3;
    pointEnd: Vec3;
    offset: Vec3;
    startNorm: Vec3;
    endNorm: Vec3;
    rotationAxis: Vec3;
    rotationAngle: number;

    onMouseDown: Topic<[{ mode: TransformMode }]>;
    onMouseUp: Topic<[{ mode: TransformMode }]>;
    onObjectChange: Topic<[]>;

    root: Object3D;
    gizmo: Record<TransformMode, HandleSet>;
    picker: Record<TransformMode, HandleSet>;
    plane: Mesh;
};

function createGizmoMaterial(color: [number, number, number], opacity = 1): Material {
    const material = new Material({
        vertex: positionClip,
        fragment: uniform('color', d.vec4f),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        cullMode: 'none',
        blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
    });
    material.uniforms.set('color', new Uniform(d.vec4f, [color[0], color[1], color[2], opacity]));
    return material;
}

function setHandleColor(handle: Handle, r: number, g: number, b: number, a: number): void {
    const colorUniform = handle.mesh.material.uniforms.get('color');
    if (colorUniform) colorUniform.value = [r, g, b, a];
}

function readColor(material: Material): Rgba {
    const value = material.uniforms.get('color')?.value as number[] | null | undefined;
    return value ? [value[0]!, value[1]!, value[2]!, value[3]!] : [1, 1, 1, 1];
}

function applyMatrix4ToGeometry(geometry: Geometry, matrix: Mat4): void {
    const positionBuffer = geometry.getBuffer('position');
    if (!positionBuffer?.array) return;
    const positions = positionBuffer.array as Float32Array;
    const normals = geometry.getBuffer('normal')?.array as Float32Array | undefined;

    const normalMatrix: Mat4 = mat4.create();
    mat4.invert(normalMatrix, matrix);
    mat4.transpose(normalMatrix, normalMatrix);

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    const v: Vec3 = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
        v[0] = positions[i]!;
        v[1] = positions[i + 1]!;
        v[2] = positions[i + 2]!;
        vec3.transformMat4(v, v, matrix);
        positions[i] = v[0];
        positions[i + 1] = v[1];
        positions[i + 2] = v[2];
        if (v[0] < minX) minX = v[0];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1];
        if (v[1] > maxY) maxY = v[1];
        if (v[2] < minZ) minZ = v[2];
        if (v[2] > maxZ) maxZ = v[2];
    }

    if (normals) {
        for (let i = 0; i < normals.length; i += 3) {
            const nx = normals[i]!;
            const ny = normals[i + 1]!;
            const nz = normals[i + 2]!;
            const x = normalMatrix[0] * nx + normalMatrix[4] * ny + normalMatrix[8] * nz;
            const y = normalMatrix[1] * nx + normalMatrix[5] * ny + normalMatrix[9] * nz;
            const z = normalMatrix[2] * nx + normalMatrix[6] * ny + normalMatrix[10] * nz;
            const len = Math.sqrt(x * x + y * y + z * z) || 1;
            normals[i] = x / len;
            normals[i + 1] = y / len;
            normals[i + 2] = z / len;
        }
    }

    if (positions.length >= 3) {
        geometry.boundingBox = [minX, minY, minZ, maxX, maxY, maxZ];
        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        let maxDistSq = 0;
        for (let i = 0; i < positions.length; i += 3) {
            const dx = positions[i]! - cx;
            const dy = positions[i + 1]! - cy;
            const dz = positions[i + 2]! - cz;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > maxDistSq) maxDistSq = distSq;
        }
        geometry.boundingSphere = { center: [cx, cy, cz], radius: Math.sqrt(maxDistSq) };
    }
}

function cloneGeometry(source: Geometry): Geometry {
    const cloned = new Geometry();
    for (const [name, buffer] of source.buffers) {
        if (buffer.array)
            cloned.setBuffer(name, createVertexBuffer(buffer.schema, new Float32Array(buffer.array as Float32Array)));
    }
    if (source.index?.array) {
        const index =
            source.index.array instanceof Uint32Array
                ? new Uint32Array(source.index.array)
                : new Uint16Array(source.index.array as Uint16Array);
        cloned.setIndex(createIndexBuffer(index as Uint16Array));
    }
    cloned.drawRange = { ...source.drawRange };
    if (source.boundingBox) cloned.boundingBox = [...source.boundingBox] as Geometry['boundingBox'];
    if (source.boundingSphere) {
        cloned.boundingSphere = { center: [...source.boundingSphere.center] as Vec3, radius: source.boundingSphere.radius };
    }
    return cloned;
}

/** template mesh, position, euler rotation, scale. */
type HandleSpec = [Mesh, Vec3 | null, Vec3 | null, Vec3 | null];
type HandleMap = Record<string, HandleSpec[]>;

function buildHandleSet(map: HandleMap, visible: boolean): HandleSet {
    const root = new Object3D();
    const handles: Handle[] = [];
    for (const name in map) {
        const specs = map[name]!;
        for (let i = specs.length - 1; i >= 0; i--) {
            const [template, position, rotation, scale] = specs[i]!;
            const sourceMaterial = template.material;
            const material = createGizmoMaterial([1, 1, 1]);
            material.uniforms.set('color', new Uniform(d.vec4f, readColor(sourceMaterial)));
            material.transparent = sourceMaterial.transparent;
            material.depthTest = sourceMaterial.depthTest;
            material.depthWrite = sourceMaterial.depthWrite;
            material.cullMode = sourceMaterial.cullMode;
            material.blend = sourceMaterial.blend;

            const mesh = new Mesh(cloneGeometry(template.geometry), material);
            mesh.name = name;
            if (position || rotation || scale) {
                const p: Vec3 = position ? [position[0], position[1], position[2]] : [0, 0, 0];
                const r: Quat = [0, 0, 0, 1];
                if (rotation) quat.fromEuler(r, euler.fromValues(rotation[0], rotation[1], rotation[2], 'xyz'));
                const s: Vec3 = scale ? [scale[0], scale[1], scale[2]] : [1, 1, 1];
                const bake = mat4.create();
                mat4.fromRotationTranslationScale(bake, r, p, s);
                applyMatrix4ToGeometry(mesh.geometry, bake);
            }
            mesh.renderOrder = Infinity;
            root.add(mesh);
            handles.push({ mesh, name, baseColor: readColor(material) });
        }
    }
    root.visible = visible;
    return { root, handles };
}

function circleGeometry(radius: number, arc: number): Geometry {
    const geometry = createTorusGeometry(radius, 0.0075, 3, 64, arc * Math.PI * 2);
    const m = mat4.create();
    mat4.rotateX(m, m, Math.PI / 2);
    mat4.rotateY(m, m, Math.PI / 2);
    applyMatrix4ToGeometry(geometry, m);
    return geometry;
}

function buildGizmo(): { gizmo: Record<TransformMode, HandleSet>; picker: Record<TransformMode, HandleSet> } {
    const red = createGizmoMaterial([1, 0, 0]);
    const green = createGizmoMaterial([0, 1, 0]);
    const blue = createGizmoMaterial([0, 0, 1]);
    const redTransparent = createGizmoMaterial([1, 0, 0], 0.5);
    const greenTransparent = createGizmoMaterial([0, 1, 0], 0.5);
    const blueTransparent = createGizmoMaterial([0, 0, 1], 0.5);
    const whiteTransparent = createGizmoMaterial([1, 1, 1], 0.25);
    const yellowTransparent = createGizmoMaterial([1, 1, 0], 0.25);
    const gray = createGizmoMaterial([0.47, 0.47, 0.47]);
    const invisible = createGizmoMaterial([1, 1, 1], 0.15);

    const arrow = createCylinderGeometry(0, 0.04, 0.1, 12);
    applyMatrix4ToGeometry(arrow, mat4.fromTranslation(mat4.create(), [0, 0.05, 0]));
    const scaleHandle = createBoxGeometry(0.08, 0.08, 0.08);
    applyMatrix4ToGeometry(scaleHandle, mat4.fromTranslation(mat4.create(), [0, 0.04, 0]));
    const line = createCylinderGeometry(0.0075, 0.0075, 0.5, 3);
    applyMatrix4ToGeometry(line, mat4.fromTranslation(mat4.create(), [0, 0.25, 0]));
    const planeSquare = (): Geometry => createBoxGeometry(0.15, 0.15, 0.01);
    const pickerCone = (): Geometry => createCylinderGeometry(0.2, 0, 0.6, 4);
    const pickerSquare = (): Geometry => createBoxGeometry(0.2, 0.2, 0.01);

    const gizmoTranslate: HandleMap = {
        X: [
            [new Mesh(arrow, red), [0.5, 0, 0], [0, 0, -Math.PI / 2], null],
            [new Mesh(arrow, red), [-0.5, 0, 0], [0, 0, Math.PI / 2], null],
            [new Mesh(line, red), [0, 0, 0], [0, 0, -Math.PI / 2], null],
        ],
        Y: [
            [new Mesh(arrow, green), [0, 0.5, 0], null, null],
            [new Mesh(arrow, green), [0, -0.5, 0], [Math.PI, 0, 0], null],
            [new Mesh(line, green), null, null, null],
        ],
        Z: [
            [new Mesh(arrow, blue), [0, 0, 0.5], [Math.PI / 2, 0, 0], null],
            [new Mesh(arrow, blue), [0, 0, -0.5], [-Math.PI / 2, 0, 0], null],
            [new Mesh(line, blue), null, [Math.PI / 2, 0, 0], null],
        ],
        XYZ: [[new Mesh(createOctahedronGeometry(0.1, 0), whiteTransparent), [0, 0, 0], null, null]],
        XY: [[new Mesh(planeSquare(), blueTransparent), [0.15, 0.15, 0], null, null]],
        YZ: [[new Mesh(planeSquare(), redTransparent), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null]],
        XZ: [[new Mesh(planeSquare(), greenTransparent), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null]],
    };

    const pickerTranslate: HandleMap = {
        X: [
            [new Mesh(pickerCone(), invisible), [0.3, 0, 0], [0, 0, -Math.PI / 2], null],
            [new Mesh(pickerCone(), invisible), [-0.3, 0, 0], [0, 0, Math.PI / 2], null],
        ],
        Y: [
            [new Mesh(pickerCone(), invisible), [0, 0.3, 0], null, null],
            [new Mesh(pickerCone(), invisible), [0, -0.3, 0], [0, 0, Math.PI], null],
        ],
        Z: [
            [new Mesh(pickerCone(), invisible), [0, 0, 0.3], [Math.PI / 2, 0, 0], null],
            [new Mesh(pickerCone(), invisible), [0, 0, -0.3], [-Math.PI / 2, 0, 0], null],
        ],
        XYZ: [[new Mesh(createOctahedronGeometry(0.2, 0), invisible), null, null, null]],
        XY: [[new Mesh(pickerSquare(), invisible), [0.15, 0.15, 0], null, null]],
        YZ: [[new Mesh(pickerSquare(), invisible), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null]],
        XZ: [[new Mesh(pickerSquare(), invisible), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null]],
    };

    const gizmoRotate: HandleMap = {
        XYZE: [[new Mesh(circleGeometry(0.5, 1), gray), null, [0, Math.PI / 2, 0], null]],
        X: [[new Mesh(circleGeometry(0.5, 0.5), red), null, null, null]],
        Y: [[new Mesh(circleGeometry(0.5, 0.5), green), null, [0, 0, -Math.PI / 2], null]],
        Z: [[new Mesh(circleGeometry(0.5, 0.5), blue), null, [0, Math.PI / 2, 0], null]],
        E: [[new Mesh(circleGeometry(0.75, 1), yellowTransparent), null, [0, Math.PI / 2, 0], null]],
    };

    const pickerRotate: HandleMap = {
        XYZE: [[new Mesh(createSphereGeometry(0.25, 10, 8), invisible), null, null, null]],
        X: [[new Mesh(createTorusGeometry(0.5, 0.1, 4, 24), invisible), [0, 0, 0], [0, -Math.PI / 2, -Math.PI / 2], null]],
        Y: [[new Mesh(createTorusGeometry(0.5, 0.1, 4, 24), invisible), [0, 0, 0], [Math.PI / 2, 0, 0], null]],
        Z: [[new Mesh(createTorusGeometry(0.5, 0.1, 4, 24), invisible), [0, 0, 0], [0, 0, -Math.PI / 2], null]],
        E: [[new Mesh(createTorusGeometry(0.75, 0.1, 2, 24), invisible), null, null, null]],
    };

    const gizmoScale: HandleMap = {
        X: [
            [new Mesh(scaleHandle, red), [0.5, 0, 0], [0, 0, -Math.PI / 2], null],
            [new Mesh(line, red), [0, 0, 0], [0, 0, -Math.PI / 2], null],
            [new Mesh(scaleHandle, red), [-0.5, 0, 0], [0, 0, Math.PI / 2], null],
        ],
        Y: [
            [new Mesh(scaleHandle, green), [0, 0.5, 0], null, null],
            [new Mesh(line, green), null, null, null],
            [new Mesh(scaleHandle, green), [0, -0.5, 0], [0, 0, Math.PI], null],
        ],
        Z: [
            [new Mesh(scaleHandle, blue), [0, 0, 0.5], [Math.PI / 2, 0, 0], null],
            [new Mesh(line, blue), [0, 0, 0], [Math.PI / 2, 0, 0], null],
            [new Mesh(scaleHandle, blue), [0, 0, -0.5], [-Math.PI / 2, 0, 0], null],
        ],
        XY: [[new Mesh(planeSquare(), blueTransparent), [0.15, 0.15, 0], null, null]],
        YZ: [[new Mesh(planeSquare(), redTransparent), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null]],
        XZ: [[new Mesh(planeSquare(), greenTransparent), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null]],
        XYZ: [[new Mesh(createBoxGeometry(0.1, 0.1, 0.1), whiteTransparent), null, null, null]],
    };

    const pickerScale: HandleMap = {
        X: [
            [new Mesh(pickerCone(), invisible), [0.3, 0, 0], [0, 0, -Math.PI / 2], null],
            [new Mesh(pickerCone(), invisible), [-0.3, 0, 0], [0, 0, Math.PI / 2], null],
        ],
        Y: [
            [new Mesh(pickerCone(), invisible), [0, 0.3, 0], null, null],
            [new Mesh(pickerCone(), invisible), [0, -0.3, 0], [0, 0, Math.PI], null],
        ],
        Z: [
            [new Mesh(pickerCone(), invisible), [0, 0, 0.3], [Math.PI / 2, 0, 0], null],
            [new Mesh(pickerCone(), invisible), [0, 0, -0.3], [-Math.PI / 2, 0, 0], null],
        ],
        XY: [[new Mesh(pickerSquare(), invisible), [0.15, 0.15, 0], null, null]],
        YZ: [[new Mesh(pickerSquare(), invisible), [0, 0.15, 0.15], [0, Math.PI / 2, 0], null]],
        XZ: [[new Mesh(pickerSquare(), invisible), [0.15, 0, 0.15], [-Math.PI / 2, 0, 0], null]],
        XYZ: [[new Mesh(createBoxGeometry(0.2, 0.2, 0.2), invisible), [0, 0, 0], null, null]],
    };

    // pickers are hidden but still raycast
    return {
        gizmo: {
            translate: buildHandleSet(gizmoTranslate, true),
            rotate: buildHandleSet(gizmoRotate, true),
            scale: buildHandleSet(gizmoScale, true),
        },
        picker: {
            translate: buildHandleSet(pickerTranslate, false),
            rotate: buildHandleSet(pickerRotate, false),
            scale: buildHandleSet(pickerScale, false),
        },
    };
}

function intersectObjectRecursive(object: Object3D, raycaster: Raycaster, intersects: Intersection[]): Intersection[] {
    object.raycast(raycaster, intersects);
    for (const child of object.children) intersectObjectRecursive(child, raycaster, intersects);
    return intersects;
}

function intersectObjectWithRay(object: Object3D, raycaster: Raycaster): Intersection | null {
    const intersects = intersectObjectRecursive(object, raycaster, []);
    if (intersects.length === 0) return null;
    intersects.sort((a, b) => a.distance - b.distance);
    return intersects[0]!;
}

const _raycaster = new Raycaster();
const _tempVec = vec3.create();
const _tempVec2 = vec3.create();
const _tempQuat = quat.create();
const _tempQuat2 = quat.create();
const _identityQuat: Quat = [0, 0, 0, 1];
const _tempMat = mat4.create();
const _unitX: Vec3 = [1, 0, 0];
const _unitY: Vec3 = [0, 1, 0];
const _unitZ: Vec3 = [0, 0, 1];
const _zeroVec: Vec3 = [0, 0, 0];
const _alignVector: Vec3 = [0, 1, 0];
const _dirVector: Vec3 = [0, 0, 0];
const _v1: Vec3 = [0, 0, 0];
const _v2: Vec3 = [0, 0, 0];
const _v3: Vec3 = [0, 0, 0];

const ACTIVE_COLOR: [number, number, number] = [1, 1, 0];
const AXIS_HIDE_THRESHOLD = 0.99;
const PLANE_HIDE_THRESHOLD = 0.2;

export function init(camera: Camera): TransformControls {
    const root = new Object3D();
    root.visible = false;
    const { gizmo, picker } = buildGizmo();
    for (const mode of ['translate', 'rotate', 'scale'] as const) {
        root.add(gizmo[mode].root);
        root.add(picker[mode].root);
    }
    const plane = new Mesh(createPlaneGeometry(100000, 100000, 2, 2), createGizmoMaterial([1, 1, 1], 0.1));
    plane.visible = false;
    root.add(plane);

    return {
        camera,
        object: null,
        enabled: true,
        mode: 'translate',
        space: 'world',
        axis: null,
        dragging: false,
        size: 1,
        pickerScale: 1,
        showX: true,
        showY: true,
        showZ: true,
        translationSnap: null,
        rotationSnap: null,
        scaleSnap: null,
        minX: -Infinity,
        maxX: Infinity,
        minY: -Infinity,
        maxY: Infinity,
        minZ: -Infinity,
        maxZ: Infinity,
        worldPosition: [0, 0, 0],
        worldQuaternion: [0, 0, 0, 1],
        worldScale: [1, 1, 1],
        worldQuaternionInv: [0, 0, 0, 1],
        parentPosition: [0, 0, 0],
        parentQuaternion: [0, 0, 0, 1],
        parentQuaternionInv: [0, 0, 0, 1],
        parentScale: [1, 1, 1],
        cameraPosition: [0, 0, 0],
        cameraQuaternion: [0, 0, 0, 1],
        cameraScale: [1, 1, 1],
        eye: [0, 0, 1],
        worldPositionStart: [0, 0, 0],
        worldQuaternionStart: [0, 0, 0, 1],
        worldScaleStart: [1, 1, 1],
        positionStart: [0, 0, 0],
        quaternionStart: [0, 0, 0, 1],
        scaleStart: [1, 1, 1],
        pointStart: [0, 0, 0],
        pointEnd: [0, 0, 0],
        offset: [0, 0, 0],
        startNorm: [0, 0, 0],
        endNorm: [0, 0, 0],
        rotationAxis: [0, 0, 0],
        rotationAngle: 0,
        onMouseDown: topic(),
        onMouseUp: topic(),
        onObjectChange: topic(),
        root,
        gizmo,
        picker,
        plane,
    };
}

export function dispose(controls: TransformControls): void {
    controls.root.traverse((child) => {
        if (child.isMesh) {
            const mesh = child as Mesh;
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
    });
}

export function attach(controls: TransformControls, object: Object3D): void {
    controls.object = object;
    controls.root.visible = true;
}

export function detach(controls: TransformControls): void {
    controls.object = null;
    controls.axis = null;
    controls.root.visible = false;
}

export function reset(controls: TransformControls): void {
    if (!controls.enabled || !controls.dragging || !controls.object) return;
    vec3.copy(controls.object.position, controls.positionStart);
    quat.copy(controls.object.quaternion, controls.quaternionStart);
    vec3.copy(controls.object.scale, controls.scaleStart);
    controls.onObjectChange.emit();
    vec3.copy(controls.pointStart, controls.pointEnd);
}

/** once per frame, after the object's pose is final. */
export function update(controls: TransformControls): void {
    const object = controls.object;
    if (object) {
        object.updateWorldMatrix();
        if (object.parent === null) {
            console.error('[bongle] TransformControls: the attached object must be in the scene graph');
        } else {
            mat4.decompose(controls.parentQuaternion, controls.parentPosition, controls.parentScale, object.parent.matrixWorld);
        }
        mat4.decompose(controls.worldQuaternion, controls.worldPosition, controls.worldScale, object.matrixWorld);
        quat.invert(controls.parentQuaternionInv, controls.parentQuaternion);
        quat.invert(controls.worldQuaternionInv, controls.worldQuaternion);
    }

    const camera = controls.camera;
    camera.updateWorldMatrix();
    mat4.decompose(controls.cameraQuaternion, controls.cameraPosition, controls.cameraScale, camera.matrixWorld);
    if (camera.isOrthographicCamera) {
        camera.getWorldDirection(controls.eye);
        vec3.negate(controls.eye, controls.eye);
    } else {
        vec3.subtract(controls.eye, controls.cameraPosition, controls.worldPosition);
        vec3.normalize(controls.eye, controls.eye);
    }

    layoutHandles(controls);
    layoutPlane(controls);
}

function screenScaleFactor(controls: TransformControls): number {
    const camera = controls.camera;
    if (camera.isOrthographicCamera) {
        const ortho = camera as OrthographicCamera;
        return (ortho.top - ortho.bottom) / ortho.zoom;
    }
    const perspective = camera as Camera & { fov?: number; zoom?: number };
    const fov = perspective.fov ?? Math.PI / 4;
    return (
        vec3.distance(controls.worldPosition, controls.cameraPosition) *
        Math.min((1.9 * Math.tan(fov / 2)) / (perspective.zoom ?? 1), 7)
    );
}

function hideHandle(handle: Handle): void {
    vec3.set(handle.mesh.scale, 1e-10, 1e-10, 1e-10);
    handle.mesh.visible = false;
}

function applyViewAngleVisibility(handle: Handle, quaternion: Quat, eye: Vec3): void {
    const name = handle.name;
    if (name === 'X' || name === 'Y' || name === 'Z') {
        const unit = name === 'X' ? _unitX : name === 'Y' ? _unitY : _unitZ;
        vec3.transformQuat(_alignVector, unit, quaternion);
        if (Math.abs(vec3.dot(_alignVector, eye)) > AXIS_HIDE_THRESHOLD) hideHandle(handle);
    } else if (name === 'XY' || name === 'YZ' || name === 'XZ') {
        const normal = name === 'XY' ? _unitZ : name === 'YZ' ? _unitX : _unitY;
        vec3.transformQuat(_alignVector, normal, quaternion);
        if (Math.abs(vec3.dot(_alignVector, eye)) < PLANE_HIDE_THRESHOLD) hideHandle(handle);
    }
}

function orientRotateHandle(handle: Handle, quaternion: Quat, eye: Vec3): void {
    const mesh = handle.mesh;
    quat.copy(_tempQuat2, quaternion);
    quat.invert(_tempQuat, quaternion);
    vec3.transformQuat(_alignVector, eye, _tempQuat);

    if (handle.name.indexOf('E') !== -1) {
        mat4.targetTo(_tempMat, eye, _zeroVec, _unitY);
        quat.fromMat4(mesh.quaternion, _tempMat);
    }
    if (handle.name === 'X') {
        quat.setAxisAngle(_tempQuat, _unitX, Math.atan2(-_alignVector[1], _alignVector[2]));
        quat.multiply(mesh.quaternion, _tempQuat2, _tempQuat);
    } else if (handle.name === 'Y') {
        quat.setAxisAngle(_tempQuat, _unitY, Math.atan2(_alignVector[0], _alignVector[2]));
        quat.multiply(mesh.quaternion, _tempQuat2, _tempQuat);
    } else if (handle.name === 'Z') {
        quat.setAxisAngle(_tempQuat, _unitZ, Math.atan2(_alignVector[1], _alignVector[0]));
        quat.multiply(mesh.quaternion, _tempQuat2, _tempQuat);
    }
}

function layoutHandleSet(controls: TransformControls, set: HandleSet, quaternion: Quat, scale: number): void {
    const { mode, eye, axis } = controls;
    for (const handle of set.handles) {
        const mesh = handle.mesh;
        mesh.visible = true;
        vec3.copy(mesh.position, controls.worldPosition);
        vec3.set(mesh.scale, scale, scale, scale);
        quat.copy(mesh.quaternion, quaternion);

        if (mode === 'translate' || mode === 'scale') {
            applyViewAngleVisibility(handle, quaternion, eye);
        } else {
            orientRotateHandle(handle, quaternion, eye);
        }

        const name = handle.name;
        mesh.visible = mesh.visible && (name.indexOf('X') === -1 || controls.showX);
        mesh.visible = mesh.visible && (name.indexOf('Y') === -1 || controls.showY);
        mesh.visible = mesh.visible && (name.indexOf('Z') === -1 || controls.showZ);
        mesh.visible = mesh.visible && (name.indexOf('E') === -1 || (controls.showX && controls.showY && controls.showZ));

        const base = handle.baseColor;
        const active = controls.enabled && axis !== null && (name === axis || axis.split('').some((a) => name === a));
        if (active) setHandleColor(handle, ACTIVE_COLOR[0], ACTIVE_COLOR[1], ACTIVE_COLOR[2], 1);
        else setHandleColor(handle, base[0], base[1], base[2], base[3]);
    }
}

function layoutHandles(controls: TransformControls): void {
    const mode = controls.mode;
    const space: TransformSpace = mode === 'scale' ? 'local' : controls.space;
    const quaternion = space === 'local' ? controls.worldQuaternion : _identityQuat;

    for (const m of ['translate', 'rotate', 'scale'] as const) controls.gizmo[m].root.visible = m === mode;

    const scale = (screenScaleFactor(controls) * controls.size) / 4;
    layoutHandleSet(controls, controls.picker[mode], quaternion, scale * controls.pickerScale);
    layoutHandleSet(controls, controls.gizmo[mode], quaternion, scale);
}

function layoutPlane(controls: TransformControls): void {
    const plane = controls.plane;
    const space: TransformSpace = controls.mode === 'scale' ? 'local' : controls.space;
    vec3.copy(plane.position, controls.worldPosition);

    const q = space === 'local' ? controls.worldQuaternion : _identityQuat;
    vec3.transformQuat(_v1, _unitX, q);
    vec3.transformQuat(_v2, _unitY, q);
    vec3.transformQuat(_v3, _unitZ, q);
    vec3.copy(_alignVector, _v2);

    const eye = controls.eye;
    switch (controls.mode) {
        case 'translate':
        case 'scale':
            switch (controls.axis) {
                case 'X':
                    vec3.cross(_alignVector, eye, _v1);
                    vec3.cross(_dirVector, _v1, _alignVector);
                    break;
                case 'Y':
                    vec3.cross(_alignVector, eye, _v2);
                    vec3.cross(_dirVector, _v2, _alignVector);
                    break;
                case 'Z':
                    vec3.cross(_alignVector, eye, _v3);
                    vec3.cross(_dirVector, _v3, _alignVector);
                    break;
                case 'XY':
                    vec3.copy(_dirVector, _v3);
                    break;
                case 'YZ':
                    vec3.copy(_dirVector, _v1);
                    break;
                case 'XZ':
                    vec3.copy(_alignVector, _v3);
                    vec3.copy(_dirVector, _v2);
                    break;
                default:
                    vec3.set(_dirVector, 0, 0, 0);
            }
            break;
        default:
            vec3.set(_dirVector, 0, 0, 0);
    }

    if (vec3.length(_dirVector) === 0) {
        quat.copy(plane.quaternion, controls.cameraQuaternion);
    } else {
        mat4.targetTo(_tempMat, _zeroVec, _dirVector, _alignVector);
        quat.fromMat4(plane.quaternion, _tempMat);
    }
}

export function pointerHover(controls: TransformControls, pointer: GizmoPointer): void {
    if (controls.object === null || controls.dragging) return;
    _raycaster.setFromCamera([pointer.x, pointer.y], controls.camera);
    const hit = intersectObjectWithRay(controls.picker[controls.mode].root, _raycaster);
    controls.axis = hit ? hit.object.name : null;
}

export function pointerDown(controls: TransformControls, pointer: GizmoPointer): void {
    if (controls.object === null || controls.dragging || pointer.button !== 0 || controls.axis === null) return;
    startDrag(controls, pointer);
}

/** start a drag on `axis` from the current pointer without a handle press; ends through `pointerUp` or `cancelDrag`. */
export function beginDrag(controls: TransformControls, pointer: GizmoPointer, axis: string): void {
    if (controls.object === null || controls.dragging) return;
    controls.axis = axis;
    layoutPlane(controls);
    startDrag(controls, pointer);
}

/** mid-drag axis lock: the object returns to its start pose and the drag re-anchors on the new plane. */
export function setDragAxis(controls: TransformControls, pointer: GizmoPointer, axis: string): void {
    const object = controls.object;
    if (object === null || !controls.dragging) return;
    vec3.copy(object.position, controls.positionStart);
    quat.copy(object.quaternion, controls.quaternionStart);
    vec3.copy(object.scale, controls.scaleStart);
    controls.axis = axis;
    update(controls);
    _raycaster.setFromCamera([pointer.x, pointer.y], controls.camera);
    const planeHit = intersectObjectWithRay(controls.plane, _raycaster);
    if (planeHit) vec3.subtract(controls.pointStart, planeHit.point, controls.worldPositionStart);
    controls.onObjectChange.emit();
}

/** abandon the drag: the object returns to its start pose, `onObjectChange` fires, `onMouseUp` does not. */
export function cancelDrag(controls: TransformControls): void {
    const object = controls.object;
    if (object === null || !controls.dragging) return;
    vec3.copy(object.position, controls.positionStart);
    quat.copy(object.quaternion, controls.quaternionStart);
    vec3.copy(object.scale, controls.scaleStart);
    controls.onObjectChange.emit();
    controls.dragging = false;
    controls.axis = null;
}

function startDrag(controls: TransformControls, pointer: GizmoPointer): void {
    const object = controls.object!;
    _raycaster.setFromCamera([pointer.x, pointer.y], controls.camera);
    const planeHit = intersectObjectWithRay(controls.plane, _raycaster);
    if (planeHit) {
        object.updateWorldMatrix();
        object.parent?.updateWorldMatrix();

        vec3.copy(controls.positionStart, object.position);
        quat.copy(controls.quaternionStart, object.quaternion);
        vec3.copy(controls.scaleStart, object.scale);
        mat4.decompose(controls.worldQuaternionStart, controls.worldPositionStart, controls.worldScaleStart, object.matrixWorld);
        vec3.subtract(controls.pointStart, planeHit.point, controls.worldPositionStart);
    }

    controls.dragging = true;
    controls.onMouseDown.emit({ mode: controls.mode });
}

export function pointerMove(controls: TransformControls, pointer: GizmoPointer): void {
    const { axis, mode, object } = controls;
    if (object === null || axis === null || !controls.dragging || pointer.button !== -1) return;

    let space: TransformSpace = controls.space;
    if (mode === 'scale') space = 'local';
    else if (axis === 'E' || axis === 'XYZE' || axis === 'XYZ') space = 'world';

    _raycaster.setFromCamera([pointer.x, pointer.y], controls.camera);
    const planeHit = intersectObjectWithRay(controls.plane, _raycaster);
    if (!planeHit) return;
    vec3.subtract(controls.pointEnd, planeHit.point, controls.worldPositionStart);

    if (mode === 'translate') dragTranslate(controls, object, axis, space);
    else if (mode === 'scale') dragScale(controls, object, axis);
    else dragRotate(controls, object, axis, space);

    controls.onObjectChange.emit();
}

export function pointerUp(controls: TransformControls, pointer: GizmoPointer): void {
    if (pointer.button !== 0) return;
    if (controls.dragging && controls.axis !== null) controls.onMouseUp.emit({ mode: controls.mode });
    controls.dragging = false;
    controls.axis = null;
}

function snapRound(value: number, snap: number): number {
    return Math.round(value / snap) * snap;
}

function dragTranslate(controls: TransformControls, object: Object3D, axis: string, space: TransformSpace): void {
    const offset = controls.offset;
    vec3.subtract(offset, controls.pointEnd, controls.pointStart);

    const localAxis = space === 'local' && axis !== 'XYZ';
    if (localAxis) vec3.transformQuat(offset, offset, controls.worldQuaternionInv);

    if (axis.indexOf('X') === -1) offset[0] = 0;
    if (axis.indexOf('Y') === -1) offset[1] = 0;
    if (axis.indexOf('Z') === -1) offset[2] = 0;

    if (localAxis) vec3.transformQuat(offset, offset, controls.quaternionStart);
    else vec3.transformQuat(offset, offset, controls.parentQuaternionInv);
    vec3.divide(offset, offset, controls.parentScale);

    const position = object.position;
    vec3.add(position, offset, controls.positionStart);

    const snap = controls.translationSnap;
    if (snap) {
        if (space === 'local') {
            quat.invert(_tempQuat, controls.quaternionStart);
            vec3.transformQuat(position, position, _tempQuat);
            if (axis.indexOf('X') !== -1) position[0] = snapRound(position[0], snap);
            if (axis.indexOf('Y') !== -1) position[1] = snapRound(position[1], snap);
            if (axis.indexOf('Z') !== -1) position[2] = snapRound(position[2], snap);
            vec3.transformQuat(position, position, controls.quaternionStart);
        } else {
            if (object.parent) {
                mat4.getTranslation(_tempVec, object.parent.matrixWorld);
                vec3.add(position, position, _tempVec);
            }
            if (axis.indexOf('X') !== -1) position[0] = snapRound(position[0], snap);
            if (axis.indexOf('Y') !== -1) position[1] = snapRound(position[1], snap);
            if (axis.indexOf('Z') !== -1) position[2] = snapRound(position[2], snap);
            if (object.parent) {
                mat4.getTranslation(_tempVec, object.parent.matrixWorld);
                vec3.subtract(position, position, _tempVec);
            }
        }
    }

    position[0] = Math.max(controls.minX, Math.min(controls.maxX, position[0]));
    position[1] = Math.max(controls.minY, Math.min(controls.maxY, position[1]));
    position[2] = Math.max(controls.minZ, Math.min(controls.maxZ, position[2]));
}

function dragScale(controls: TransformControls, object: Object3D, axis: string): void {
    if (axis.indexOf('XYZ') !== -1) {
        let ratio = vec3.length(controls.pointEnd) / vec3.length(controls.pointStart);
        if (vec3.dot(controls.pointEnd, controls.pointStart) < 0) ratio *= -1;
        vec3.set(_tempVec2, ratio, ratio, ratio);
    } else {
        vec3.copy(_tempVec, controls.pointStart);
        vec3.copy(_tempVec2, controls.pointEnd);
        vec3.transformQuat(_tempVec, _tempVec, controls.worldQuaternionInv);
        vec3.transformQuat(_tempVec2, _tempVec2, controls.worldQuaternionInv);
        vec3.divide(_tempVec2, _tempVec2, _tempVec);
        if (axis.indexOf('X') === -1) _tempVec2[0] = 1;
        if (axis.indexOf('Y') === -1) _tempVec2[1] = 1;
        if (axis.indexOf('Z') === -1) _tempVec2[2] = 1;
    }

    const scale = object.scale;
    vec3.multiply(scale, controls.scaleStart, _tempVec2);

    const snap = controls.scaleSnap;
    if (snap) {
        if (axis.indexOf('X') !== -1) scale[0] = snapRound(scale[0], snap) || snap;
        if (axis.indexOf('Y') !== -1) scale[1] = snapRound(scale[1], snap) || snap;
        if (axis.indexOf('Z') !== -1) scale[2] = snapRound(scale[2], snap) || snap;
    }
}

function dragRotate(controls: TransformControls, object: Object3D, axis: string, space: TransformSpace): void {
    const offset = controls.offset;
    const eye = controls.eye;
    const rotationAxis = controls.rotationAxis;
    vec3.subtract(offset, controls.pointEnd, controls.pointStart);

    mat4.getTranslation(_tempVec, controls.camera.matrixWorld);
    const rotationSpeed = 20 / vec3.distance(controls.worldPosition, _tempVec);

    let inPlaneRotation = false;
    if (axis === 'XYZE') {
        vec3.cross(rotationAxis, offset, eye);
        vec3.normalize(rotationAxis, rotationAxis);
        vec3.cross(_tempVec, rotationAxis, eye);
        controls.rotationAngle = vec3.dot(offset, _tempVec) * rotationSpeed;
    } else if (axis === 'X' || axis === 'Y' || axis === 'Z') {
        const unit = axis === 'X' ? _unitX : axis === 'Y' ? _unitY : _unitZ;
        vec3.copy(rotationAxis, unit);
        vec3.copy(_tempVec, unit);
        if (space === 'local') vec3.transformQuat(_tempVec, _tempVec, controls.worldQuaternion);
        vec3.cross(_tempVec, _tempVec, eye);
        if (vec3.length(_tempVec) === 0) {
            inPlaneRotation = true;
        } else {
            vec3.normalize(_tempVec, _tempVec);
            controls.rotationAngle = vec3.dot(offset, _tempVec) * rotationSpeed;
        }
    }

    if (axis === 'E' || inPlaneRotation) {
        vec3.copy(rotationAxis, eye);
        controls.rotationAngle = vec3.angle(controls.pointEnd, controls.pointStart);
        vec3.normalize(controls.startNorm, controls.pointStart);
        vec3.normalize(controls.endNorm, controls.pointEnd);
        vec3.cross(_tempVec, controls.endNorm, controls.startNorm);
        controls.rotationAngle *= vec3.dot(_tempVec, eye) < 0 ? 1 : -1;
    }

    const snap = controls.rotationSnap;
    if (snap) controls.rotationAngle = snapRound(controls.rotationAngle, snap);

    const quaternion = object.quaternion;
    if (space === 'local' && axis !== 'E' && axis !== 'XYZE') {
        quat.copy(quaternion, controls.quaternionStart);
        quat.setAxisAngle(_tempQuat, rotationAxis, controls.rotationAngle);
        quat.multiply(quaternion, quaternion, _tempQuat);
    } else {
        vec3.transformQuat(rotationAxis, rotationAxis, controls.parentQuaternionInv);
        quat.setAxisAngle(_tempQuat, rotationAxis, controls.rotationAngle);
        quat.multiply(quaternion, _tempQuat, controls.quaternionStart);
    }
    quat.normalize(quaternion, quaternion);
}
