type Props = {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
    /** 'sm' (w-12) is the default; 'md' (w-20) for wider fields (e.g. /set limit). */
    width?: 'sm' | 'md';
};

// omitting max lets the user type values beyond a paired <Range> slider's range.
export function NumberInput({ value, onChange, min, max, step = 1, width = 'sm' }: Props) {
    const w = width === 'md' ? 'w-20' : 'w-12';
    return (
        <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => {
                let n = Number(e.target.value);
                if (!Number.isFinite(n)) n = min ?? 0;
                if (min !== undefined) n = Math.max(min, n);
                if (max !== undefined) n = Math.min(max, n);
                onChange(n);
            }}
            className={`${w} bg-surface-muted text-fg text-[10px] font-mono px-1 py-0.5 border border-border`}
        />
    );
}
