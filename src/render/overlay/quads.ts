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
    type Scene,
    screenSize,
    Texture,
    texture,
    varying,
    vec2f,
    vec4f,
} from 'gpucat';
import type { TextureNode } from 'gpucat/dist/nodes/nodes';
import type { SpriteResources } from '../sprites/sprite-resources';

export type QuadBatch = {
    mesh: Mesh;
    geometry: Geometry;
    capacity: number;
    count: number;
    center: Float32Array;
    offset: Float32Array;
    uv: Float32Array;
    color: Float32Array;
    /** bound to the sprite atlas by `bindAtlas`; a 1x1 white placeholder until then. */
    placeholder: Texture;
    atlasTexNode: TextureNode;
    atlasHash: string | null;
    /** a texel inside `kit:white`. */
    whiteU: number;
    whiteV: number;
};

const WHITE_SPRITE = 'kit:white';

function quadVertex(): Node<d.vec4f> {
    const centerAttr = attribute('center', d.vec3f);
    const offsetAttr = attribute('offsetPx', d.vec2f);
    const clip = mul(cameraProjectionMatrix, mul(mul(cameraViewMatrix, modelWorldMatrix), vec4f(centerAttr, 1))) as Node<d.vec4f>;
    // pixels to NDC
    const ndcOffset = vec2f(div(mul(offsetAttr.x, f32(2)), screenSize.x), div(mul(offsetAttr.y, f32(2)), screenSize.y));
    const finalXY = add(clip.xy, mul(ndcOffset, clip.w as unknown as Node<d.f32>));
    return vec4f(finalXY, clip.zw) as unknown as Node<d.vec4f>;
}

export function init(scene: Scene, capacity: number): QuadBatch {
    const vertexCount = capacity * 4;
    const center = new Float32Array(vertexCount * 3);
    const offset = new Float32Array(vertexCount * 2);
    const uv = new Float32Array(vertexCount * 2);
    const color = new Float32Array(vertexCount * 4);
    const indices = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
        const vi = q * 4;
        const ii = q * 6;
        indices[ii] = vi;
        indices[ii + 1] = vi + 1;
        indices[ii + 2] = vi + 2;
        indices[ii + 3] = vi + 1;
        indices[ii + 4] = vi + 3;
        indices[ii + 5] = vi + 2;
    }

    const placeholder = new Texture(
        { data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 },
        {
            format: 'rgba8unorm-srgb',
            magFilter: 'nearest',
            minFilter: 'nearest',
            wrapS: 'clamp-to-edge',
            wrapT: 'clamp-to-edge',
            generateMipmaps: false,
        },
    );

    const geometry = new Geometry();
    geometry.setBuffer('center', createVertexBuffer(d.vec3f, center));
    geometry.setBuffer('offsetPx', createVertexBuffer(d.vec2f, offset));
    geometry.setBuffer('uv', createVertexBuffer(d.vec2f, uv));
    geometry.setBuffer('color', createVertexBuffer(d.vec4f, color));
    geometry.setIndex(createIndexBuffer(indices));
    geometry.drawRange = { start: 0, count: 0 };

    const uvVarying = varying(attribute('uv', d.vec2f), 'ovQuadUv');
    const colorVarying = varying(attribute('color', d.vec4f), 'ovQuadColor');
    const atlasTexNode = texture(placeholder);
    const material = new Material({
        vertex: quadVertex(),
        fragment: mul(atlasTexNode.sample(uvVarying), colorVarying),
        cullMode: 'none',
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });

    const mesh = new Mesh(geometry, material);
    mesh.name = 'overlay-quads';
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = Infinity;
    scene.add(mesh);

    return {
        mesh,
        geometry,
        capacity,
        count: 0,
        center,
        offset,
        uv,
        color,
        placeholder,
        atlasTexNode,
        atlasHash: null,
        whiteU: 0.5,
        whiteV: 0.5,
    };
}

/** retargets the material at the sprite atlas when it (re)loads; true when it swapped. */
export function bindAtlas(batch: QuadBatch, sprite: SpriteResources): boolean {
    if (batch.atlasHash === sprite.atlasHash) return false;
    batch.atlasHash = sprite.atlasHash;
    const source = sprite.atlasHash === null ? batch.placeholder : sprite.atlas;
    batch.atlasTexNode.bindingNode.value = source._gpuTexture;
    batch.atlasTexNode.samplerNode!.value = source._gpuSampler;
    const white = sprite.frames.get(WHITE_SPRITE)?.frames[0];
    batch.whiteU = white ? white.u + white.w / 2 : 0.5;
    batch.whiteV = white ? white.v + white.h / 2 : 0.5;
    return true;
}

export function dispose(batch: QuadBatch, scene: Scene): void {
    scene.remove(batch.mesh);
    batch.geometry.dispose();
    batch.mesh.material.dispose();
    batch.placeholder.dispose();
}

export function begin(batch: QuadBatch): void {
    batch.count = 0;
}

/** `dx dy` pixel offset from the anchor, `hw hh` half size in pixels, `u0 v0 u1 v1` atlas rect; dropped past capacity. */
export function quad(
    batch: QuadBatch,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    hw: number,
    hh: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    if (batch.count >= batch.capacity) return;
    const vi = batch.count * 4;
    const { center, offset, uv, color } = batch;
    for (let v = 0; v < 4; v++) {
        const p = (vi + v) * 3;
        center[p] = x;
        center[p + 1] = y;
        center[p + 2] = z;
        const c = (vi + v) * 4;
        color[c] = r;
        color[c + 1] = g;
        color[c + 2] = b;
        color[c + 3] = a;
    }
    // 0 bottom-left, 1 bottom-right, 2 top-left, 3 top-right
    const o = vi * 2;
    offset[o] = dx - hw;
    offset[o + 1] = dy - hh;
    offset[o + 2] = dx + hw;
    offset[o + 3] = dy - hh;
    offset[o + 4] = dx - hw;
    offset[o + 5] = dy + hh;
    offset[o + 6] = dx + hw;
    offset[o + 7] = dy + hh;
    // atlas rows grow downward
    uv[o] = u0;
    uv[o + 1] = v1;
    uv[o + 2] = u1;
    uv[o + 3] = v1;
    uv[o + 4] = u0;
    uv[o + 5] = v0;
    uv[o + 6] = u1;
    uv[o + 7] = v0;
    batch.count++;
}

/** a solid rectangle, `dx dy` pixels from the anchor, `hw hh` half size in pixels. */
export function rect(
    batch: QuadBatch,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    hw: number,
    hh: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    const { whiteU, whiteV } = batch;
    quad(batch, x, y, z, dx, dy, hw, hh, whiteU, whiteV, whiteU, whiteV, r, g, b, a);
}

/** a solid square of `sizePx` centred on a world point. */
export function dot(
    batch: QuadBatch,
    x: number,
    y: number,
    z: number,
    sizePx: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    const half = sizePx * 0.5;
    const { whiteU, whiteV } = batch;
    quad(batch, x, y, z, 0, 0, half, half, whiteU, whiteV, whiteU, whiteV, r, g, b, a);
}

export function end(batch: QuadBatch): void {
    const { geometry, count } = batch;
    if (count === 0) {
        geometry.drawRange.count = 0;
        batch.mesh.visible = false;
        return;
    }
    geometry.getBuffer('center')!.version++;
    geometry.getBuffer('offsetPx')!.version++;
    geometry.getBuffer('uv')!.version++;
    geometry.getBuffer('color')!.version++;
    geometry.drawRange = { start: 0, count: count * 6 };
    batch.mesh.visible = true;
}
