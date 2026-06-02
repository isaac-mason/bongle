// camera-fit — derive an OrthographicCamera that frames an AABB from a
// fixed isometric angle. shared by all preview tasks (block-icons,
// prefab-icons, ...) so generated thumbnails compose visually.
//
// the angle (30° elevation, 45° azimuth) and CAM_DIST match block-icons.ts
// — keep them in sync if either is tuned.

import type { Vec3 } from 'mathcat';
import { OrthographicCamera } from 'gpucat';

const ISO_ELEV = Math.PI / 6; // 30°
const ISO_AZIM = Math.PI / 4; // 45°
const CAM_DIST = 64;

/**
 * Build an isometric OrthographicCamera that frames the given AABB.
 *
 * Projects the 8 AABB corners onto the camera's right/up vectors and sizes
 * the (square) frustum to the larger of the two extents × margin. Square
 * frustum keeps narrow content centered without anisotropic stretch.
 */
export function fitOrthoIsometric(
    aabbMin: Vec3,
    aabbMax: Vec3,
    opts?: { margin?: number; camDist?: number },
): OrthographicCamera {
    const margin = opts?.margin ?? 1.05;
    const camDist = opts?.camDist ?? CAM_DIST;

    const cx = (aabbMin[0] + aabbMax[0]) / 2;
    const cy = (aabbMin[1] + aabbMax[1]) / 2;
    const cz = (aabbMin[2] + aabbMax[2]) / 2;

    // forward = unit vector from camera position toward the center.
    // camera position offset = (sin(azim)cos(elev), sin(elev), cos(azim)cos(elev)) * dist
    // forward = -offset/dist.
    const fx = -Math.sin(ISO_AZIM) * Math.cos(ISO_ELEV);
    const fy = -Math.sin(ISO_ELEV);
    const fz = -Math.cos(ISO_AZIM) * Math.cos(ISO_ELEV);

    // right = normalize(cross(forward, world_up=(0,1,0)))
    const rx = fz * 1 - fy * 0; // fz*1 - fy*0
    const ry = fx * 0 - fz * 0; // 0
    const rz = fy * 0 - fx * 1; // -fx
    const rLen = Math.hypot(rx, ry, rz) || 1;
    const Rx = rx / rLen;
    const Ry = ry / rLen;
    const Rz = rz / rLen;

    // up = cross(right, forward)
    const Ux = Ry * fz - Rz * fy;
    const Uy = Rz * fx - Rx * fz;
    const Uz = Rx * fy - Ry * fx;

    let maxH = 0;
    let maxV = 0;
    for (let i = 0; i < 8; i++) {
        const x = (i & 1) ? aabbMax[0] : aabbMin[0];
        const y = (i & 2) ? aabbMax[1] : aabbMin[1];
        const z = (i & 4) ? aabbMax[2] : aabbMin[2];
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const h = Math.abs(dx * Rx + dy * Ry + dz * Rz);
        const v = Math.abs(dx * Ux + dy * Uy + dz * Uz);
        if (h > maxH) maxH = h;
        if (v > maxV) maxV = v;
    }

    // square frustum sized to the larger projected half-extent
    const half = Math.max(maxH, maxV, 0.5) * margin;

    const camera = new OrthographicCamera(-half, half, half, -half, 0.1, camDist * 2);
    camera.position[0] = cx + Math.sin(ISO_AZIM) * Math.cos(ISO_ELEV) * camDist;
    camera.position[1] = cy + Math.sin(ISO_ELEV) * camDist;
    camera.position[2] = cz + Math.cos(ISO_AZIM) * Math.cos(ISO_ELEV) * camDist;
    camera.lookAt([cx, cy, cz]);
    camera.updateProjectionMatrix();
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    return camera;
}
