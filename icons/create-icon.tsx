import { createElement, type ForwardRefExoticComponent, forwardRef, type RefAttributes, type SVGProps } from 'react';

/**
 * The glyphs are 24x24 pixel art, so a block is only a whole number of device
 * pixels when `size x devicePixelRatio` is a multiple of 24. Off that ladder the
 * renderer rounds each edge on its own and strokes come out 1px here, 2px there.
 * 24 is exact at every dpr; 12 is exact from 2x up, which is the compact tier.
 */
export type IconSize = 12 | 24 | 36 | 48;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'width' | 'height'> {
    /** width + height in px (default 24). Pixel-grid sizes only, see IconSize. */
    size?: IconSize;
}

export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

const base = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    // the glyphs are axis-aligned rects on a 24x24 grid; crispEdges keeps every
    // block a hard-edged square at any size, instead of antialiasing the rect
    // borders into grey when `size` is not a multiple of 24.
    shapeRendering: 'crispEdges',
} as const;

// Build a 24x24 icon component from a string of inner SVG markup (the
// <path>s). We keep the icons we use in strings.ts as plain strings rather than
// depend on an icon package: a big barrel can't tree-shake once bundled into one
// module for the in-browser build, so every game shipped all of them. Each icon
// carries /*@__PURE__*/ so the publish build drops the ones a given bundle never
// references.
//
// To add an icon: copy its inner markup (everything between <svg ...> and
// </svg>) into strings.ts and paste a new createIcon('...') line in index.tsx.
export function createIcon(markup: string): IconComponent {
    return forwardRef<SVGSVGElement, IconProps>(({ size = 24, ...rest }, ref) =>
        createElement('svg', {
            ref,
            ...base,
            width: size,
            height: size,
            ...rest,
            dangerouslySetInnerHTML: { __html: markup },
        }),
    );
}
