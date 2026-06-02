// convention-based directional placement for the build tool. used as the
// fallback path when a block doesn't supply a `place` hook — recognises
// `axis` (x/y/z) and `facing` (4-dir or 6-dir) enum schemas by name.
//
// when right-click places a block, mutate the key's `axis` / `facing` props
// to match the surface and viewer.
//
// rules:
//   axis (3-value enum 'x'|'y'|'z'):   dominant axis of the hit normal.
//   facing 4-dir (no up/down):         lateral hit-normal when the clicked
//                                      face is a wall; opposite of camera-
//                                      forward (snapped to cardinal) when
//                                      the clicked face is a floor/ceiling.
//                                      block's front sits against the
//                                      clicked surface (ladders, stairs,
//                                      wall signs).
//   facing 6-dir (incl. up/down):      hit-normal direction. block points
//                                      away from the clicked surface (like
//                                      pistons / observers).
//
// unknown prop schemas, or new keys missing from the registry, fall back to
// the original key unchanged.
//
// the world-axis convention matches blueprint.ts / block-presets.ts:
//   north = -Z, south = +Z, east = +X, west = -X, up = +Y, down = -Y

import type { Quat, Vec3 } from 'mathcat';
import type { BlockRegistry } from '../core/voxels/block-registry';
import { parseKey } from '../core/voxels/block-registry';
import { snapCardinal, yawFromQuat } from './camera';

const FACING_4 = ['north', 'east', 'south', 'west'] as const;
const FACING_6 = ['north', 'east', 'south', 'west', 'up', 'down'] as const;
const AXIS_VALUES = ['x', 'y', 'z'] as const;

function axisFromNormal(nx: number, ny: number, nz: number): 'x' | 'y' | 'z' {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ay >= ax && ay >= az) return 'y';
    if (ax >= az) return 'x';
    return 'z';
}

function facing6FromNormal(nx: number, ny: number, nz: number): (typeof FACING_6)[number] {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ay >= ax && ay >= az) return ny >= 0 ? 'up' : 'down';
    if (ax >= az) return nx >= 0 ? 'east' : 'west';
    return nz >= 0 ? 'south' : 'north';
}

function facing4FromCamera(cameraQuat: Quat): (typeof FACING_4)[number] {
    // snapCardinal returns the cardinal opposite of camera forward — i.e. the
    // direction from the block toward the player. that's the facing direction
    // (block's front side points at the player).
    const yaw = yawFromQuat(cameraQuat[0], cameraQuat[1], cameraQuat[2], cameraQuat[3]);
    const [fx, fz] = snapCardinal(yaw);
    if (fx === 1) return 'east';
    if (fx === -1) return 'west';
    if (fz === 1) return 'south';
    return 'north';
}

function facing4FromHitOrCamera(
    nx: number,
    ny: number,
    nz: number,
    cameraQuat: Quat,
): (typeof FACING_4)[number] {
    // wall click → mount against clicked face; texture/front points back
    // toward the player along the hit normal (away from the clicked surface).
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ax >= ay || az >= ay) {
        if (ax >= az) return nx >= 0 ? 'east' : 'west';
        return nz >= 0 ? 'south' : 'north';
    }
    // floor/ceiling click → no lateral info, fall back to camera.
    return facing4FromCamera(cameraQuat);
}

function isEnumWithValues(values: readonly string[], required: readonly string[]): boolean {
    for (const v of required) if (!values.includes(v)) return false;
    return true;
}

/**
 * apply convention-based directional props to a placement key. returns the
 * original key if the block has no recognized directional props, or if the
 * mutated key isn't registered.
 */
export function applyDirectionalProps(
    key: string,
    hitNormal: Vec3,
    cameraQuat: Quat,
    registry: BlockRegistry,
): string {
    const parsed = parseKey(key);
    if (!parsed) return key;

    const def = registry.idToDef.get(parsed.blockId);
    if (!def) return key;

    const props = def.states.props;
    const newProps = { ...parsed.props };
    let changed = false;

    // axis prop: 3-value enum x/y/z
    const axisProp = props['axis'];
    if (axisProp && axisProp.type === 'enum' && isEnumWithValues(axisProp.values, AXIS_VALUES)) {
        const a = axisFromNormal(hitNormal[0], hitNormal[1], hitNormal[2]);
        if (axisProp.values.includes(a) && newProps['axis'] !== a) {
            newProps['axis'] = a;
            changed = true;
        }
    }

    // facing prop: 4-dir or 6-dir enum
    const facingProp = props['facing'];
    if (facingProp && facingProp.type === 'enum') {
        const values = facingProp.values;
        if (isEnumWithValues(values, FACING_6)) {
            const f = facing6FromNormal(hitNormal[0], hitNormal[1], hitNormal[2]);
            if (newProps['facing'] !== f) {
                newProps['facing'] = f;
                changed = true;
            }
        } else if (isEnumWithValues(values, FACING_4)) {
            const f = facing4FromHitOrCamera(hitNormal[0], hitNormal[1], hitNormal[2], cameraQuat);
            if (newProps['facing'] !== f) {
                newProps['facing'] = f;
                changed = true;
            }
        }
    }

    if (!changed) return key;

    const propsStr = Object.entries(newProps)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    const newKey = propsStr.length > 0 ? `${parsed.blockId}[${propsStr}]` : parsed.blockId;

    if (!registry.keyToState.has(newKey)) return key;
    return newKey;
}
