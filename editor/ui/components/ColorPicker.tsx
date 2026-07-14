// editor/ui/components/ColorPicker.tsx — the paint app's color control: a
// graphical picker (react-colorful, alpha-capable), a hex text field, and a
// palette grid. Value is a #rrggbb or #rrggbbaa hex string; onChange fires the
// same. The picker is squared to the bongle look via global CSS in index.html.

import { useEffect, useState } from 'react';
import { HexAlphaColorPicker } from 'react-colorful';

export const TRANSPARENT = '#00000000';

// transparency checkerboard, tinted to the dark surface.
const CHECKER = 'repeating-conic-gradient(#2a2e35 0% 25%, #202329 0% 50%) 50% / 8px 8px';

const PALETTE = [
    '#000000',
    '#1d2b53',
    '#7e2553',
    '#008751',
    '#ab5236',
    '#5f574f',
    '#c2c3c7',
    '#fff1e8',
    '#ff004d',
    '#ffa300',
    '#ffec27',
    '#00e436',
    '#29adff',
    '#83769c',
    '#ff77a8',
    '#ffccaa',
    '#ffffff',
    '#e03c3c',
    '#f07f28',
    '#f0c020',
    '#3cb45a',
    '#2aa0a8',
    '#4670e6',
    '#8040c0',
    '#222222',
    '#444444',
    '#666666',
    '#888888',
    '#aaaaaa',
    '#cccccc',
    '#eeeeee',
    TRANSPARENT,
];

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
    const [hexText, setHexText] = useState(value);

    // mirror external changes (palette, eyedropper, picker drag) into the field.
    useEffect(() => setHexText(value), [value]);

    const onHex = (raw: string) => {
        setHexText(raw);
        const m = raw.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(m) || /^[0-9a-fA-F]{8}$/.test(m)) onChange(`#${m.toLowerCase()}`);
    };

    const transparent = value.length >= 9 && value.slice(7, 9) === '00';

    return (
        // horizontal gutter fits react-colorful's edge pointers (they sit half
        // outside the strips at 0%/100%); see the .bongle-picker overrides in editor.css.
        <div className="bongle-picker flex flex-col gap-2 px-3 py-2 font-mono text-xs text-fg">
            <HexAlphaColorPicker color={value} onChange={onChange} />
            <div className="flex items-center gap-2">
                <div
                    className="h-[30px] w-[30px] shrink-0 border border-border"
                    style={{ background: transparent ? CHECKER : value.slice(0, 7) }}
                />
                <input
                    value={hexText}
                    spellCheck={false}
                    onChange={(e) => onHex(e.target.value)}
                    className="min-w-0 flex-1 border border-border bg-surface px-1.5 py-[5px] font-mono text-xs text-fg"
                    aria-label="hex color"
                />
            </div>
            <div className="grid grid-cols-8 gap-[3px]">
                {PALETTE.map((c) => (
                    <button
                        key={c}
                        type="button"
                        title={c === TRANSPARENT ? 'transparent' : c}
                        onClick={() => onChange(c)}
                        className={`aspect-square w-full cursor-pointer border border-border-subtle p-0 ${
                            value === c ? 'outline outline-2 outline-fg' : ''
                        }`}
                        style={{ background: c === TRANSPARENT ? CHECKER : c }}
                    />
                ))}
            </div>
        </div>
    );
}
