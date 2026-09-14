import { debug, rigidBody } from 'crashcat';
import { OBJECT_LAYER_EDITOR_NODES, type Physics } from '../../core/physics/physics';
import * as Lines from '../../render/overlay/lines';
import * as Quads from '../../render/overlay/quads';

const COLLIDER_COLOR: [number, number, number, number] = [1, 0, 1, 1];
const CONTACT_POINT_COLOR: [number, number, number, number] = [1, 0.15, 0.15, 1];
const CONTACT_NORMAL_COLOR: [number, number, number, number] = [0.15, 1, 0.15, 1];
const CONTACT_POINT_PX = 6;
const CONTACT_NORMAL_LENGTH = 0.5;

export type DebugVisualsState = {
    bodyOpts: debug.BodyOptions;
};

export function init(): DebugVisualsState {
    return { bodyOpts: debug.createBodyOptions() };
}

export function update(
    state: DebugVisualsState,
    physics: Physics,
    showColliders: boolean,
    showContacts: boolean,
    lines: Lines.LineBatch,
    quads: Quads.QuadBatch,
): void {
    if (showColliders) drawColliders(state, physics, lines);
    if (showContacts) drawContacts(physics, lines, quads);
}

function drawColliders(state: DebugVisualsState, physics: Physics, lines: Lines.LineBatch): void {
    const [r, g, b, a] = COLLIDER_COLOR;
    for (const body of rigidBody.iterate(physics.rigid.world)) {
        if (body.objectLayer === OBJECT_LAYER_EDITOR_NODES) continue;
        const v = debug.body(body, state.bodyOpts).vertices;
        for (let i = 0; i + 5 < v.length; i += 6) {
            Lines.line(lines, v[i]!, v[i + 1]!, v[i + 2]!, v[i + 3]!, v[i + 4]!, v[i + 5]!, r, g, b, a);
        }
    }
}

function drawContacts(physics: Physics, lines: Lines.LineBatch, quads: Quads.QuadBatch): void {
    const [pr, pg, pb, pa] = CONTACT_POINT_COLOR;
    const [nr, ng, nb, na] = CONTACT_NORMAL_COLOR;
    for (const pair of physics.contacts.active) {
        const [x, y, z] = pair.point;
        const [nx, ny, nz] = pair.normal;
        Quads.dot(quads, x, y, z, CONTACT_POINT_PX, pr, pg, pb, pa);
        Lines.line(
            lines,
            x,
            y,
            z,
            x + nx * CONTACT_NORMAL_LENGTH,
            y + ny * CONTACT_NORMAL_LENGTH,
            z + nz * CONTACT_NORMAL_LENGTH,
            nr,
            ng,
            nb,
            na,
        );
    }
}
