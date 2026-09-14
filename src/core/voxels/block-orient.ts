export type Facing4 = 'north' | 'east' | 'south' | 'west';
export type Facing6 = Facing4 | 'up' | 'down';
export type RotAxis = 'x' | 'y' | 'z';

/** does a single 90-degree rotation around `axis` flip the world Y axis upside-down? true for x and z. */
export function rotateFlipsY(axis: RotAxis): boolean {
    return axis !== 'y';
}
