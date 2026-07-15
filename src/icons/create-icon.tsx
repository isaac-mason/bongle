import { createElement, type ForwardRefExoticComponent, forwardRef, type RefAttributes, type SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
    /** width + height in px (default 24). */
    size?: string | number;
    /** keep the stroke width constant regardless of `size`. */
    absoluteStrokeWidth?: boolean;
}

export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

const base = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
} as const;

// Build a 24×24 icon component from a string of inner SVG markup (the
// <path>/<circle>/… children). We keep the icons we use in icons.tsx as plain
// strings rather than depend on lucide-react: its ~1900-icon barrel can't
// tree-shake once bundled into one module for the in-browser build, so every
// game shipped all of them. Each icon carries /*@__PURE__*/ so the publish build
// drops the ones a given bundle never references.
//
// To add an icon: copy its inner markup (e.g. from lucide.dev — everything
// between <svg …> and </svg>) and paste a new createIcon('…') line.
export function createIcon(markup: string): IconComponent {
    return forwardRef<SVGSVGElement, IconProps>(({ size = 24, absoluteStrokeWidth, strokeWidth = 2, ...rest }, ref) =>
        createElement('svg', {
            ref,
            ...base,
            width: size,
            height: size,
            strokeWidth: absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth,
            ...rest,
            dangerouslySetInnerHTML: { __html: markup },
        }),
    );
}
