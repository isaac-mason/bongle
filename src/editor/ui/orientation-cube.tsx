import { useEffect, useRef } from 'react';
import { getPovCamera } from '../../client/rooms';
import { useEditor } from '../editor-store';

const CUBE_PX = 165;
const GIZMO_PX = 145;
const TOTAL_H = CUBE_PX + GIZMO_PX;
const H = 0.5;
const CUBE_SCALE = 76;
const GIZMO_LEN = 60;

type Face = {
    nx: number;
    ny: number;
    nz: number;
    label: string;
    color: string;
    verts: [number, number, number][];
    // face-local "right" and "up" axes in world space, used as a basis to
    // transform the label so it sticks to the face surface.
    rx: number;
    ry: number;
    rz: number;
    ux: number;
    uy: number;
    uz: number;
};

const FACES: Face[] = [
    {
        nx: 1,
        ny: 0,
        nz: 0,
        label: 'RIGHT',
        color: '#c0392b',
        verts: [
            [H, -H, -H],
            [H, H, -H],
            [H, H, H],
            [H, -H, H],
        ],
        rx: 0,
        ry: 0,
        rz: -1,
        ux: 0,
        uy: 1,
        uz: 0,
    },
    {
        nx: -1,
        ny: 0,
        nz: 0,
        label: 'LEFT',
        color: '#c0392b',
        verts: [
            [-H, -H, H],
            [-H, H, H],
            [-H, H, -H],
            [-H, -H, -H],
        ],
        rx: 0,
        ry: 0,
        rz: 1,
        ux: 0,
        uy: 1,
        uz: 0,
    },
    {
        nx: 0,
        ny: 1,
        nz: 0,
        label: 'TOP',
        color: '#27ae60',
        verts: [
            [-H, H, -H],
            [H, H, -H],
            [H, H, H],
            [-H, H, H],
        ],
        rx: 1,
        ry: 0,
        rz: 0,
        ux: 0,
        uy: 0,
        uz: -1,
    },
    {
        nx: 0,
        ny: -1,
        nz: 0,
        label: 'BOTTOM',
        color: '#27ae60',
        verts: [
            [-H, -H, H],
            [H, -H, H],
            [H, -H, -H],
            [-H, -H, -H],
        ],
        rx: 1,
        ry: 0,
        rz: 0,
        ux: 0,
        uy: 0,
        uz: 1,
    },
    {
        nx: 0,
        ny: 0,
        nz: 1,
        label: 'FRONT',
        color: '#2980b9',
        verts: [
            [H, -H, H],
            [H, H, H],
            [-H, H, H],
            [-H, -H, H],
        ],
        rx: 1,
        ry: 0,
        rz: 0,
        ux: 0,
        uy: 1,
        uz: 0,
    },
    {
        nx: 0,
        ny: 0,
        nz: -1,
        label: 'BACK',
        color: '#2980b9',
        verts: [
            [-H, -H, -H],
            [-H, H, -H],
            [H, H, -H],
            [H, -H, -H],
        ],
        rx: -1,
        ry: 0,
        rz: 0,
        ux: 0,
        uy: 1,
        uz: 0,
    },
];

type Axis = { x: number; y: number; z: number; label: string; color: string };

const AXES: Axis[] = [
    { x: 1, y: 0, z: 0, label: 'X', color: '#c0392b' },
    { x: 0, y: 1, z: 0, label: 'Y', color: '#27ae60' },
    { x: 0, y: 0, z: 1, label: 'Z', color: '#2980b9' },
];

export function OrientationCube() {
    const room = useEditor((s) => s.room);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const roomRef = useRef(room);
    roomRef.current = room;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = CUBE_PX * dpr;
        canvas.height = TOTAL_H * dpr;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);

        const last = new Float64Array(9).fill(NaN);
        let raf = 0;

        const tick = () => {
            const r = roomRef.current;
            const camera = r ? getPovCamera(r) : null;
            if (camera) {
                const m = camera.matrixWorldInverse;
                const a0 = m[0],
                    a1 = m[1],
                    a2 = m[2];
                const a3 = m[4],
                    a4 = m[5],
                    a5 = m[6];
                const a6 = m[8],
                    a7 = m[9],
                    a8 = m[10];
                if (
                    a0 !== last[0] ||
                    a1 !== last[1] ||
                    a2 !== last[2] ||
                    a3 !== last[3] ||
                    a4 !== last[4] ||
                    a5 !== last[5] ||
                    a6 !== last[6] ||
                    a7 !== last[7] ||
                    a8 !== last[8]
                ) {
                    last[0] = a0;
                    last[1] = a1;
                    last[2] = a2;
                    last[3] = a3;
                    last[4] = a4;
                    last[5] = a5;
                    last[6] = a6;
                    last[7] = a7;
                    last[8] = a8;
                    draw(ctx, a0, a1, a2, a3, a4, a5, a6, a7, a8);
                }
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    return (
        <div className="absolute bottom-2 left-2 pointer-events-none" style={{ width: CUBE_PX, height: TOTAL_H }}>
            <canvas ref={canvasRef} style={{ width: CUBE_PX, height: TOTAL_H, display: 'block' }} />
        </div>
    );
}

// project a world-space point through the 3x3 view rotation onto the canvas.
// returns [screenX, screenY, viewZ]. viewZ < 0 = in front of camera.
function project(
    a0: number,
    a1: number,
    a2: number,
    a3: number,
    a4: number,
    a5: number,
    a6: number,
    a7: number,
    a8: number,
    vx: number,
    vy: number,
    vz: number,
    scale: number,
    cx: number,
    cy: number,
): [number, number, number] {
    const px = a0 * vx + a3 * vy + a6 * vz;
    const py = a1 * vx + a4 * vy + a7 * vz;
    const pz = a2 * vx + a5 * vy + a8 * vz;
    return [px * scale + cx, -py * scale + cy, pz];
}

// project a free vector (rotation only, no translation). returns screen-space delta per unit.
function projectVec(
    a0: number,
    a1: number,
    _a2: number,
    a3: number,
    a4: number,
    _a5: number,
    a6: number,
    a7: number,
    _a8: number,
    vx: number,
    vy: number,
    vz: number,
    scale: number,
): [number, number] {
    const px = a0 * vx + a3 * vy + a6 * vz;
    const py = a1 * vx + a4 * vy + a7 * vz;
    return [px * scale, -py * scale];
}

function draw(
    ctx: CanvasRenderingContext2D,
    a0: number,
    a1: number,
    a2: number,
    a3: number,
    a4: number,
    a5: number,
    a6: number,
    a7: number,
    a8: number,
) {
    ctx.clearRect(0, 0, CUBE_PX, TOTAL_H);
    drawGizmo(ctx, a0, a1, a2, a3, a4, a5, a6, a7, a8);
    drawCube(ctx, a0, a1, a2, a3, a4, a5, a6, a7, a8);
}

function drawCube(
    ctx: CanvasRenderingContext2D,
    a0: number,
    a1: number,
    a2: number,
    a3: number,
    a4: number,
    a5: number,
    a6: number,
    a7: number,
    a8: number,
) {
    const cx = CUBE_PX / 2;
    const cy = GIZMO_PX + CUBE_PX / 2;

    type Drawn = {
        face: Face;
        pts: [number, number][];
        depth: number;
        lx: number;
        ly: number;
        rdx: number;
        rdy: number;
        udx: number;
        udy: number;
    };
    const drawn: Drawn[] = [];
    for (const f of FACES) {
        // OpenGL view space: camera at origin looking down -Z (gpucat / mathcat
        // convention). a2,a5,a8 are the view-matrix back-axis row, so view-nz
        // = dot(camera_back, world_normal). a face is camera-facing when its
        // outward normal aligns with camera_back → nz > 0.
        const nz = a2 * f.nx + a5 * f.ny + a8 * f.nz;
        if (nz <= 0) continue;

        const pts: [number, number][] = [];
        let lx = 0,
            ly = 0,
            depth = 0;
        for (const v of f.verts) {
            const [sx, sy, sz] = project(a0, a1, a2, a3, a4, a5, a6, a7, a8, v[0], v[1], v[2], CUBE_SCALE, cx, cy);
            pts.push([sx, sy]);
            lx += sx;
            ly += sy;
            depth += sz;
        }
        lx /= 4;
        ly /= 4;
        depth /= 4;

        const [rdx, rdy] = projectVec(a0, a1, a2, a3, a4, a5, a6, a7, a8, f.rx, f.ry, f.rz, CUBE_SCALE);
        const [udx, udy] = projectVec(a0, a1, a2, a3, a4, a5, a6, a7, a8, f.ux, f.uy, f.uz, CUBE_SCALE);

        drawn.push({ face: f, pts, depth, lx, ly, rdx, rdy, udx, udy });
    }

    // painter's algorithm: visible-face center z = H * nz > 0. higher z = more
    // directly facing camera. sort ascending so the most-facing face is drawn
    // last (on top), edges of side faces tuck under it.
    drawn.sort((p, q) => p.depth - q.depth);

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000000';

    for (const d of drawn) {
        ctx.beginPath();
        ctx.moveTo(d.pts[0][0], d.pts[0][1]);
        for (let i = 1; i < d.pts.length; i++) ctx.lineTo(d.pts[i][0], d.pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.stroke();

        // text transform: project the face's local right/up basis into screen
        // space and use as the canvas transform basis, the label sits on the
        // face surface and foreshortens with the cube rotation. canvas y grows
        // downward, so flip the up basis.
        ctx.save();
        ctx.transform(d.rdx, d.rdy, -d.udx, -d.udy, d.lx, d.ly);
        ctx.fillStyle = d.face.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // font size is in face-local units (cube edge = 1.0). transform
        // basis has magnitude CUBE_SCALE, so 0.26 → ~11.4 head-on pixels.
        ctx.font = '600 0.26px Helvetica, Arial, sans-serif';
        ctx.fillText(d.face.label, 0, 0);
        ctx.restore();
    }
}

function drawGizmo(
    ctx: CanvasRenderingContext2D,
    a0: number,
    a1: number,
    a2: number,
    a3: number,
    a4: number,
    a5: number,
    a6: number,
    a7: number,
    a8: number,
) {
    const cx = CUBE_PX / 2;
    const cy = GIZMO_PX / 2;

    type DrawnAxis = {
        sx: number;
        sy: number;
        depth: number;
        label: string;
        color: string;
    };
    const drawn: DrawnAxis[] = [];
    for (const ax of AXES) {
        const [sx, sy, sz] = project(a0, a1, a2, a3, a4, a5, a6, a7, a8, ax.x, ax.y, ax.z, GIZMO_LEN, cx, cy);
        drawn.push({ sx, sy, depth: sz, label: ax.label, color: ax.color });
    }
    // draw far axes first so near-axis tips sit on top
    drawn.sort((p, q) => p.depth - q.depth);

    ctx.lineWidth = 2;
    ctx.font = '600 11px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const ax of drawn) {
        ctx.strokeStyle = ax.color;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax.sx, ax.sy);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ax.sx, ax.sy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ax.color;
        ctx.stroke();

        ctx.fillStyle = ax.color;
        ctx.fillText(ax.label, ax.sx, ax.sy);
    }
}
