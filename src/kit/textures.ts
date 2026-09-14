import { asset, texture } from 'bongle';

/**
 * A single opaque white pixel.
 *
 * The neutral base for anything tinted at runtime: a solid-colour billboard, a
 * flat particle, a bar or underlay that wants a colour rather than art. Tint
 * multiplies against it, so white is the identity.
 *
 * Computed rather than shipped as a PNG, a one-pixel file is more to lose track
 * of than the four lines that draw it.
 *
 * 1x1 is safe here specifically because the sprite atlas samples `nearest`
 * (`render/sprites/sprite-resources.ts`): every sample lands on the one texel.
 * The atlas does not edge-extend into its padding gutter, so under a linear
 * sampler this size would bleed to transparent at the quad edges.
 */
/** 5x7 glyphs on an 8x8 grid, 16 per row, printable ASCII in order from space; `sprites.glyphSprites` cuts it up. */
export const fontSheet = texture('kit:font-sheet', {
    src: asset('./assets/textures/font.png', import.meta.url),
});

export const white = texture('kit:white', {
    size: [1, 1],
    fn: (ctx) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 1, 1);
    },
});

/**
 * The harvested crop items: a bound wheat sheaf, one carrot, one tuber.
 *
 * Own artwork, not the crop's ripe frame. A crop tile is several thin plants
 * with air between them, which is unreadable at icon size, and neither the
 * carrot's root nor a whole potato is drawn by its crop tile at all.
 *
 * Declared here as `texture()` rather than `tile()` because an item is never a
 * block face: a tile goes in the voxel atlas and is only ever sampled by one.
 * `sprites.ts` builds the drawable sprite from each of these, so the picture is
 * declared once and both consumers share the entry, the way `white` does.
 */
export const wheatItem = texture('kit:wheat_item', {
    src: asset('./assets/textures/crop_wheat_item.png', import.meta.url),
});
export const carrotItem = texture('kit:carrot_item', {
    src: asset('./assets/textures/crop_carrot_item.png', import.meta.url),
});
export const potatoItem = texture('kit:potato_item', {
    src: asset('./assets/textures/crop_potato_item.png', import.meta.url),
});
export const beetrootItem = texture('kit:beetroot_item', {
    src: asset('./assets/textures/crop_beetroot_item.png', import.meta.url),
});
export const cabbageItem = texture('kit:cabbage_item', {
    src: asset('./assets/textures/crop_cabbage_item.png', import.meta.url),
});
export const cornItem = texture('kit:corn_item', {
    src: asset('./assets/textures/crop_corn_item.png', import.meta.url),
});
export const strawberryItem = texture('kit:strawberry_item', {
    src: asset('./assets/textures/crop_strawberry_item.png', import.meta.url),
});
// the lantern's three flicker frames, vanilla's 16x16 layout (see the preset).
export const lantern1 = texture('kit:lantern_1', { src: asset('./assets/textures/lantern_1.png', import.meta.url) });
export const lantern2 = texture('kit:lantern_2', { src: asset('./assets/textures/lantern_2.png', import.meta.url) });
export const lantern3 = texture('kit:lantern_3', { src: asset('./assets/textures/lantern_3.png', import.meta.url) });
export const lanternOff = texture('kit:lantern_off', { src: asset('./assets/textures/lantern_off.png', import.meta.url) });
// fire's eight flicker frames
export const fire1 = texture('kit:fire_1', { src: asset('./assets/textures/fire_1.png', import.meta.url) });
export const fire2 = texture('kit:fire_2', { src: asset('./assets/textures/fire_2.png', import.meta.url) });
export const fire3 = texture('kit:fire_3', { src: asset('./assets/textures/fire_3.png', import.meta.url) });
export const fire4 = texture('kit:fire_4', { src: asset('./assets/textures/fire_4.png', import.meta.url) });
export const fire5 = texture('kit:fire_5', { src: asset('./assets/textures/fire_5.png', import.meta.url) });
export const fire6 = texture('kit:fire_6', { src: asset('./assets/textures/fire_6.png', import.meta.url) });
export const fire7 = texture('kit:fire_7', { src: asset('./assets/textures/fire_7.png', import.meta.url) });
export const fire8 = texture('kit:fire_8', { src: asset('./assets/textures/fire_8.png', import.meta.url) });
export const blueberryItem = texture('kit:blueberry_item', {
    src: asset('./assets/textures/crop_blueberry_item.png', import.meta.url),
});

/** The pack's oak leaf texture, named so `leavesFluff` can derive from it. */
export const leaves = texture('kit:leaves', {
    src: asset('./assets/textures/leaves.png', import.meta.url),
});

/**
 * The leaf texture as a round, ragged blob on a 32x32 field, for the
 * overhanging planes `blockPreset.leaves({ fluff })` adds. Every plane
 * carries the whole blob, so the canopy reads as layers of clumps.
 *
 * Computed from `leaves` rather than drawn separately: change the leaf
 * palette and the blob follows. The 16px leaf is tiled 2x2 so the planes keep
 * the cube's own texel density.
 *
 * The mask matters more than it sounds. A plane carrying the square leaf tile
 * reads as a green card stuck through the block; the whole reason the
 * technique works is that each plane is a soft-edged clump with nothing at
 * its corners.
 *
 * Built per row as hard-edged spans, never as a filled arc: an antialiased
 * edge puts partial alpha into a cutout texture, where every pixel must be
 * fully on or fully off. One path filled once, a `destination-in` op
 * composites against the whole canvas, so filling row by row would keep only
 * the last row.
 */
export const leavesFluff = texture('kit:leaves_fluff', {
    size: [32, 32],
    inputs: { leaves },
    fn: (ctx, inputs) => {
        ctx.imageSmoothingEnabled = false;
        for (let ty = 0; ty < 2; ty++) {
            for (let tx = 0; tx < 2; tx++) ctx.drawImage(inputs.leaves, tx * 16, ty * 16, 16, 16);
        }
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        const R = 15.8;
        for (let y = 0; y < 32; y++) {
            const dy = y + 0.5 - 16;
            const halfWidth = Math.sqrt(Math.max(0, R * R - dy * dy));
            // ragged by a pure function of the row, so the silhouette is not a
            // clean circle and every rebuild is byte-identical.
            const ragged = halfWidth - ((y * 5 + 2) % 3);
            if (ragged <= 0) continue;
            const x0 = Math.round(16 - ragged);
            const x1 = Math.round(16 + ragged);
            ctx.rect(x0, y, x1 - x0, 1);
        }
        ctx.fill();
    },
});
