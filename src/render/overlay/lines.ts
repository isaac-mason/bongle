import {
    add,
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createIndexBuffer,
    createVertexBuffer,
    d,
    div,
    f32,
    Geometry,
    Material,
    Mesh,
    modelWorldMatrix,
    mul,
    type Node,
    normalize,
    type Scene,
    screenSize,
    sub,
    type UniformNode,
    uniform,
    varying,
    vec2f,
    vec4f,
} from 'gpucat';

export type LineBatch = {
    mesh: Mesh;
    geometry: Geometry;
    capacity: number;
    /** segments pushed since `begin`. */
    count: number;
    start: Float32Array;
    end: Float32Array;
    color: Float32Array;
    /** the shader's line width, in device pixels; `begin` rescales it from the CSS width for the current display. */
    widthUniform: UniformNode<d.f32>;
    widthCssPx: number;
};

function lineVertex(widthPx: Node<d.f32>): Node<d.vec4f> {
    const startAttr = attribute('instanceStart', d.vec3f);
    const endAttr = attribute('instanceEnd', d.vec3f);
    const sideAttr = attribute('side', d.f32);
    const uvAttr = attribute('uv', d.vec2f);

    const modelView = mul(cameraViewMatrix, modelWorldMatrix);
    const clipStart = mul(cameraProjectionMatrix, mul(modelView, vec4f(startAttr, 1))) as Node<d.vec4f>;
    const clipEnd = mul(cameraProjectionMatrix, mul(modelView, vec4f(endAttr, 1))) as Node<d.vec4f>;
    const atEnd = uvAttr.x.greaterThanEqual(f32(0.5));
    const clipPos = atEnd.select(clipEnd, clipStart) as unknown as Node<d.vec4f>;

    const ndcStart = div(clipStart.xy, clipStart.w);
    const ndcEnd = div(clipEnd.xy, clipEnd.w);
    const aspect = div(screenSize.x, screenSize.y);
    const rawDir = sub(ndcEnd, ndcStart);
    const dir = normalize(vec2f(mul(rawDir.x, aspect), rawDir.y));
    const perp = vec2f(div(dir.y.negate(), aspect), dir.x);
    const halfOffset = mul(perp, div(mul(widthPx, f32(0.5)), screenSize.y));
    const offsetClip = mul(halfOffset, clipPos.w as unknown as Node<d.f32>);
    const finalXY = add(clipPos.xy, mul(offsetClip, sideAttr));
    return vec4f(finalXY, clipPos.zw) as unknown as Node<d.vec4f>;
}

export function init(scene: Scene, capacity: number, widthPx: number): LineBatch {
    const vertexCount = capacity * 4;
    const start = new Float32Array(vertexCount * 3);
    const end = new Float32Array(vertexCount * 3);
    const color = new Float32Array(vertexCount * 4);
    const side = new Float32Array(vertexCount);
    const uv = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(capacity * 6);
    for (let s = 0; s < capacity; s++) {
        const vi = s * 4;
        side[vi] = -1;
        side[vi + 1] = -1;
        side[vi + 2] = 1;
        side[vi + 3] = 1;
        uv[(vi + 1) * 2] = 1;
        uv[(vi + 2) * 2 + 1] = 1;
        uv[(vi + 3) * 2] = 1;
        uv[(vi + 3) * 2 + 1] = 1;
        const ii = s * 6;
        indices[ii] = vi;
        indices[ii + 1] = vi + 1;
        indices[ii + 2] = vi + 2;
        indices[ii + 3] = vi + 1;
        indices[ii + 4] = vi + 3;
        indices[ii + 5] = vi + 2;
    }

    const geometry = new Geometry();
    geometry.setBuffer('instanceStart', createVertexBuffer(d.vec3f, start));
    geometry.setBuffer('instanceEnd', createVertexBuffer(d.vec3f, end));
    geometry.setBuffer('side', createVertexBuffer(d.f32, side));
    geometry.setBuffer('uv', createVertexBuffer(d.vec2f, uv));
    geometry.setBuffer('color', createVertexBuffer(d.vec4f, color));
    geometry.setIndex(createIndexBuffer(indices));
    geometry.drawRange = { start: 0, count: 0 };

    const colorVarying = varying(attribute('color', d.vec4f), 'ovLineColor');
    const widthUniform = uniform(f32(widthPx), 'ovLineWidth');
    const material = new Material({
        vertex: lineVertex(widthUniform),
        fragment: colorVarying,
        cullMode: 'none',
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });

    const mesh = new Mesh(geometry, material);
    mesh.name = 'overlay-lines';
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = Infinity;
    scene.add(mesh);

    return { mesh, geometry, capacity, count: 0, start, end, color, widthUniform, widthCssPx: widthPx };
}

export function dispose(batch: LineBatch, scene: Scene): void {
    scene.remove(batch.mesh);
    batch.geometry.dispose();
    batch.mesh.material.dispose();
}

/** `pixelRatio` is the display's device pixels per CSS pixel; the line keeps its CSS width whatever the panel. */
export function begin(batch: LineBatch, pixelRatio: number): void {
    batch.count = 0;
    batch.widthUniform.value = batch.widthCssPx * pixelRatio;
}

/** dropped past capacity. */
export function line(
    batch: LineBatch,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    if (batch.count >= batch.capacity) return;
    const vi = batch.count * 4;
    const { start, end, color } = batch;
    for (let v = 0; v < 4; v++) {
        const p = (vi + v) * 3;
        start[p] = ax;
        start[p + 1] = ay;
        start[p + 2] = az;
        end[p] = bx;
        end[p + 1] = by;
        end[p + 2] = bz;
        const c = (vi + v) * 4;
        color[c] = r;
        color[c + 1] = g;
        color[c + 2] = b;
        color[c + 3] = a;
    }
    batch.count++;
}

/** axis-aligned box outline, 12 segments. */
export function box(
    batch: LineBatch,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    line(batch, minX, minY, minZ, maxX, minY, minZ, r, g, b, a);
    line(batch, maxX, minY, minZ, maxX, minY, maxZ, r, g, b, a);
    line(batch, maxX, minY, maxZ, minX, minY, maxZ, r, g, b, a);
    line(batch, minX, minY, maxZ, minX, minY, minZ, r, g, b, a);
    line(batch, minX, maxY, minZ, maxX, maxY, minZ, r, g, b, a);
    line(batch, maxX, maxY, minZ, maxX, maxY, maxZ, r, g, b, a);
    line(batch, maxX, maxY, maxZ, minX, maxY, maxZ, r, g, b, a);
    line(batch, minX, maxY, maxZ, minX, maxY, minZ, r, g, b, a);
    line(batch, minX, minY, minZ, minX, maxY, minZ, r, g, b, a);
    line(batch, maxX, minY, minZ, maxX, maxY, minZ, r, g, b, a);
    line(batch, maxX, minY, maxZ, maxX, maxY, maxZ, r, g, b, a);
    line(batch, minX, minY, maxZ, minX, maxY, maxZ, r, g, b, a);
}

export function end(batch: LineBatch): void {
    const { geometry, count } = batch;
    if (count === 0) {
        geometry.drawRange.count = 0;
        batch.mesh.visible = false;
        return;
    }
    geometry.getBuffer('instanceStart')!.version++;
    geometry.getBuffer('instanceEnd')!.version++;
    geometry.getBuffer('color')!.version++;
    geometry.drawRange = { start: 0, count: count * 6 };
    batch.mesh.visible = true;
}
