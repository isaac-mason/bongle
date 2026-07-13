// editor/ui/components/ColorPicker.tsx — the paint app's color control: a
// graphical picker (react-colorful, alpha-capable), a hex text field, and a
// palette grid. Value is a #rrggbb or #rrggbbaa hex string; onChange fires the
// same. The picker is squared to the bongle look via global CSS in index.html.

import { type CSSProperties, useEffect, useState } from 'react';
import { HexAlphaColorPicker } from 'react-colorful';

export const TRANSPARENT = '#00000000';

const CHECKER = 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 8px 8px';

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
        <div style={panel} className="bongle-picker">
            <HexAlphaColorPicker color={value} onChange={onChange} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ ...swatch, background: transparent ? CHECKER : value.slice(0, 7) }} />
                <input
                    value={hexText}
                    spellCheck={false}
                    onChange={(e) => onHex(e.target.value)}
                    style={hexInput}
                    aria-label="hex color"
                />
            </div>
            <div style={grid}>
                {PALETTE.map((c) => (
                    <button
                        key={c}
                        type="button"
                        title={c === TRANSPARENT ? 'transparent' : c}
                        onClick={() => onChange(c)}
                        style={{
                            ...cell,
                            outline: value === c ? '2px solid #000' : 'none',
                            background: c === TRANSPARENT ? CHECKER : c,
                        }}
                    />
                ))}
            </div>
        </div>
    );
}

const panel: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    // horizontal gutter fits react-colorful's edge pointers (they sit half
    // outside the strips at 0%/100%); see the overrides in index.html.
    padding: '8px 12px',
    font: '12px/1 ui-monospace, monospace',
};
const swatch: CSSProperties = { width: 30, height: 30, border: '1px solid #000', flexShrink: 0 };
const hexInput: CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid #000',
    padding: '5px 6px',
    font: '12px/1 ui-monospace, monospace',
};
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 3 };
const cell: CSSProperties = { width: '100%', aspectRatio: '1', padding: 0, border: '1px solid #999', cursor: 'pointer' };
