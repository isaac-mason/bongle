import { ChevronDown } from 'lucide-react';
import { type ComponentProps, forwardRef, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * an item in a SearchableSelect.
 *
 * `id` is what's passed to onSelect. `label` is what the user types against
 * and what's shown in the row. `sublabel` (optional) renders on a second line
 * underneath the label in a smaller, dimmer mono font, for displaying the
 * stable id beneath a human-readable name. `leading` is an optional
 * thumbnail/icon shown before the label. `badge` is an optional trailing label
 * (e.g. "(missing)").
 */
export type SearchableSelectItem<T extends string | number = string> = {
    id: T;
    label: string;
    sublabel?: string;
    leading?: ReactNode;
    badge?: ReactNode;
    disabled?: boolean;
};

export type SearchableSelectProps<T extends string | number = string> = {
    items: SearchableSelectItem<T>[];
    /** Currently-selected id. Omit for "add" semantics (no current value). */
    value?: T;
    onSelect: (id: T) => void;
    /** Search input placeholder (e.g. "search traits…"). */
    placeholder?: string;
    /**
     * Custom trigger element. Rendered inside `<PopoverTrigger asChild>` so
     * it must forward refs / spread props. If omitted, a default native-Select-
     * style trigger button is rendered showing the current selection's label.
     */
    trigger?: ReactNode;
    /** Class merged onto the default trigger. Ignored when `trigger` is set. */
    triggerClassName?: string;
    /** Class merged onto the popover content. */
    contentClassName?: string;
    /** Label shown by the default trigger when nothing matches `value`. */
    emptyLabel?: string;
};

/**
 * a popover-driven select with a searchable, keyboard-navigable list.
 * arrow keys move highlight, Enter chooses, Escape closes.
 *
 * shape covers two patterns:
 *   - "select" (pass `value`): default trigger renders like a native <select>
 *     showing the current label + chevron.
 *   - "add" (omit `value`, pass `trigger`): caller supplies a custom trigger
 *     such as a "+" icon button.
 */
export function SearchableSelect<T extends string | number = string>({
    items,
    value,
    onSelect,
    placeholder = 'search…',
    trigger,
    triggerClassName,
    contentClassName,
    emptyLabel = '—',
}: SearchableSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter((it) => it.label.toLowerCase().includes(q));
    }, [items, query]);

    useEffect(() => {
        if (!open) {
            setQuery('');
            setActiveIndex(0);
        }
    }, [open]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight only when the query changes; setActiveIndex is a stable setter
    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const choose = (id: T) => {
        onSelect(id);
        setOpen(false);
    };

    const current = value !== undefined ? items.find((it) => it.id === value) : undefined;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                {trigger ?? <DefaultSelectTrigger label={current?.label ?? emptyLabel} className={triggerClassName} />}
            </PopoverTrigger>
            <PopoverContent className={`flex flex-col min-w-[180px] p-1 ${contentClassName ?? ''}`}>
                <input
                    // biome-ignore lint/a11y/noAutofocus: intentionally focus the search field when the popover opens
                    autoFocus
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            e.stopPropagation();
                            setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            e.stopPropagation();
                            setActiveIndex((i) => Math.max(0, i - 1));
                        } else if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            const pick = filtered[activeIndex];
                            if (pick && !pick.disabled) choose(pick.id);
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            setOpen(false);
                        }
                    }}
                    placeholder={placeholder}
                    className="shrink-0 w-full mb-1 bg-neutral-50 border border-neutral-200 rounded px-1.5 py-0.5 text-[11px] font-mono text-neutral-700 outline-none focus:border-neutral-400"
                />
                <div className="max-h-40 overflow-y-auto">
                    {filtered.length === 0 ? (
                        <div className="px-2 py-1 text-[10px] font-mono text-neutral-400 italic">no matches</div>
                    ) : (
                        filtered.map((it, i) => {
                            const isActive = i === activeIndex;
                            const isSelected = value !== undefined && it.id === value;
                            return (
                                <button
                                    type="button"
                                    key={String(it.id)}
                                    disabled={it.disabled}
                                    onClick={() => !it.disabled && choose(it.id)}
                                    onMouseEnter={() => setActiveIndex(i)}
                                    className={`flex items-center gap-2 w-full text-left px-2 py-1 text-[11px] font-mono cursor-pointer ${
                                        it.disabled ? 'text-neutral-300 cursor-not-allowed' : 'text-neutral-700'
                                    } ${isActive ? 'bg-neutral-100' : 'hover:bg-neutral-100'} ${isSelected ? 'font-semibold' : ''}`}
                                >
                                    {it.leading}
                                    <span className="flex flex-col min-w-0 flex-1">
                                        <span className="truncate">{it.label}</span>
                                        {it.sublabel && (
                                            <span className="truncate text-[9px] text-neutral-400">{it.sublabel}</span>
                                        )}
                                    </span>
                                    {it.badge && <span className="ml-auto text-[10px] text-neutral-400">{it.badge}</span>}
                                </button>
                            );
                        })
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

const DefaultSelectTrigger = forwardRef<HTMLButtonElement, ComponentProps<'button'> & { label: ReactNode }>(
    ({ label, className, ...props }, ref) => (
        <button
            ref={ref}
            type="button"
            {...props}
            className={`flex items-center justify-between gap-1 w-full bg-neutral-50 border border-neutral-200 rounded px-1.5 py-0.5 text-[10px] font-mono text-neutral-700 outline-none hover:border-neutral-400 cursor-pointer ${className ?? ''}`}
        >
            <span className="truncate">{label}</span>
            <ChevronDown size={10} className="shrink-0 text-neutral-400" />
        </button>
    ),
);
DefaultSelectTrigger.displayName = 'DefaultSelectTrigger';
