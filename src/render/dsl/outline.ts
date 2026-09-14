import {
    cameraProjectionMatrix,
    cameraViewMatrix,
    type d,
    f32,
    Material,
    max,
    mix,
    mul,
    type Node,
    screenSize,
    select,
    u32,
    varying,
    vec2f,
    vec4f,
} from 'gpucat';
import { ditherDiscard } from './dither';

/** what a render path supplies to draw its instances a second time as an outline shell. */
export type OutlineShell = {
    name: string;
    /** the vertex's world position, after any vertex animation. */
    worldPos: Node<d.vec3f>;
    /** world-space grow direction; unit length per axis the caller wants the width applied on. */
    worldGrow: Node<d.vec3f>;
    /** instance outlineWidth; 0 drops the triangle. */
    width: Node<d.f32>;
    /** instance outlineSpace; 1 = screen pixels, 0 = world units. */
    space: Node<d.f32>;
    /** instance outlineColor, vertex stage. */
    color: Node<d.vec4f>;
    /** instance dither, vertex stage; the shell fades in step with the mesh's own screen-door. */
    dither: Node<d.f32>;
    /** the mesh's own texture alpha at this fragment, so cutouts outline their silhouette. */
    alpha: Node<d.f32>;
};

/** the outline shell: back faces of an expanded copy, depth-masked to the rim by the mesh's own front faces. */
export function createOutlineShellMaterial(shell: OutlineShell): Material {
    const { worldPos, worldGrow, width, space } = shell;

    // screen mode scales the world distance by view depth so one pixel stays one pixel at any range.
    const viewPos = mul(cameraViewMatrix, vec4f(worldPos, f32(1.0))).toVar('olViewPos');
    const viewDepth = max(viewPos.z.mul(f32(-1)), f32(0.001)).toVar('olViewDepth');
    const screen = max(screenSize, vec2f(f32(1), f32(1))).toVar('olScreen');
    const projYY = max(cameraProjectionMatrix.element(u32(1)).y, f32(0.001)).toVar('olProjYY');
    const worldPerPixel = f32(2).div(projYY.mul(screen.y)).mul(viewDepth).toVar('olWorldPerPixel');
    const perUnit = mix(f32(1), worldPerPixel, space).toVar('olPerUnit');

    const grownWorld = worldPos.add(worldGrow.mul(width).mul(perUnit)).toVar('olGrownWorld');
    const viewProj = mul(cameraProjectionMatrix, cameraViewMatrix).toVar('olViewProj');
    const grown = mul(viewProj, vec4f(grownWorld, f32(1.0))).toVar('olGrown');
    // width 0: push the whole triangle outside the frustum instead of relying on a zero-size shell.
    const OFF = vec4f(f32(2), f32(2), f32(2), f32(1));
    const vertex = select(OFF, grown, width.greaterThan(f32(0))).toVar('olVertex');

    const vColor = varying(shell.color, 'olColor');
    const vDither = varying(shell.dither, 'olDither').setInterpolation('flat');
    const fragment = ditherDiscard(vColor, shell.alpha, vDither).toVar('olFragment');

    return new Material({
        name: shell.name,
        vertex,
        fragment,
        cullMode: 'front', // shell's back faces, occluded by the mesh's own front faces
        depthTest: true,
        // writing depth makes overlapping outlines resolve by distance rather than draw order.
        depthWrite: true,
        // transparent would sort into the no-depth-write bucket and paint over water behind it.
        transparent: false,
    });
}
