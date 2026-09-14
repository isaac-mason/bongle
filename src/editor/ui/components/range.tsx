type Props = {
    value: number;
    onChange: (n: number) => void;
    min: number;
    max: number;
    step?: number;
    /** appended to the default `flex-1` for one-off layout tweaks. */
    className?: string;
};

export function Range({ value, onChange, min, max, step = 1, className }: Props) {
    // pegs the thumb at the end when a paired number input pushes value past max; value itself is preserved.
    const visible = Math.min(max, Math.max(min, value));
    return (
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={visible}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`flex-1${className ? ` ${className}` : ''}`}
        />
    );
}
