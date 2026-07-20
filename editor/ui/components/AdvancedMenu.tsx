// editor/ui/components/AdvancedMenu.tsx — a taskbar footer button that folds out
// LOCAL, file-on-your-computer tools: back up the project as a .zip, load one back,
// or build a prod bundle .zip you keep yourself. These are deliberately grouped
// away from the platform's Save / "Build & publish" so a local download is never
// confused with uploading to bongle. Shown in every mode.

import { Wrench } from "../../../icons";
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../backend';
import type { Filesystem } from '../../fs';
import { downloadProdBundle } from '../../platform/actions';
import { downloadProjectSave, pickAndImportProjectSave } from '../../project-save';

const BTN = 'w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-xs hover:bg-hover';

export function AdvancedMenu({ fs }: { fs: Filesystem }) {
    const [open, setOpen] = useState(false);
    // guests can download (a local backup) but not load-over/build — those need the
    // host's project authority + pipeline. See backend.ts.
    const host = useSession((s) => s.host);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        // dismiss on outside pointerdown / Escape (same pattern as ContextMenu). The
        // click that OPENED the panel already fired before this effect ran, so it
        // can't self-close — no timers.
        const onDown = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
        window.addEventListener('pointerdown', onDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                aria-label="Advanced"
                className={`group relative grid h-8 w-8 cursor-pointer place-items-center border border-border font-mono text-[15px] leading-none ${
                    open ? 'taskbar-active' : 'bg-surface text-fg'
                }`}
                onClick={() => setOpen((v) => !v)}
            >
                <Wrench size={18} />
                {/* hover label, matching the other taskbar icons (hidden while open). */}
                {!open && (
                    <span className="pointer-events-none absolute top-1/2 left-full z-[1] ml-2 hidden -translate-y-1/2 whitespace-nowrap border border-border bg-surface px-2 py-1 font-mono text-xs text-fg shadow-[2px_2px_0_rgba(0,0,0,0.4)] group-hover:block">
                        Advanced
                    </span>
                )}
            </button>
            {open && (
                // anchored to the right of the button, bottom-aligned so it grows
                // upward — it sits at the bottom-left of the screen.
                <div className="absolute bottom-0 left-full z-[2000000] ml-2 w-64 border border-border bg-surface p-2 shadow-[2px_2px_0_rgba(0,0,0,0.5)]">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">Advanced</span>
                        <p className="text-[10px] leading-snug text-fg-muted">
                            For keeping your work on your own computer, separate from bongle. Download the project to back it
                            up{host ? ', load one back to restore it, or build a bundle .zip you can host yourself.' : '.'}
                        </p>
                        <button
                            type="button"
                            className={BTN}
                            onClick={() => {
                                setOpen(false);
                                void downloadProjectSave(fs);
                            }}
                        >
                            Download project (.zip)
                        </button>
                        {host && (
                            <>
                                <button
                                    type="button"
                                    className={BTN}
                                    onClick={() => {
                                        setOpen(false);
                                        pickAndImportProjectSave(fs);
                                    }}
                                >
                                    Load project (.zip)…
                                </button>
                                <button
                                    type="button"
                                    className={BTN}
                                    onClick={() => {
                                        setOpen(false);
                                        void downloadProdBundle();
                                    }}
                                >
                                    Build bundle (.zip)
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
