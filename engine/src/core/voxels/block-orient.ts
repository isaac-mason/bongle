// block orientation primitives — facing / axis enum types shared by the
// preset rotate/flip impls (block-presets.ts) and the rotate/flip hook
// signatures.
//
// world-axis convention: north = -Z, south = +Z, east = +X, west = -X,
// up = +Y, down = -Y. cw = looking down the +axis (matches the position
// rotation in voxel-rotate.ts and editor/blueprint.ts).

export type Facing4 = 'north' | 'east' | 'south' | 'west';
export type Facing6 = Facing4 | 'up' | 'down';
export type RotAxis = 'x' | 'y' | 'z';

/** does a single 90° rotation around `axis` flip the world Y axis upside-down?
 *  true for x and z (rotating about a horizontal axis tips top/bottom). */
export function rotateFlipsY(axis: RotAxis): boolean {
    return axis !== 'y';
}
