// editor/ui/components/TopBar.tsx — the persistent editor top bar. A thin, full-
// width strip that is NOT a window: it can't be focused-away, minimized, or buried,
// so the primary save/publish actions are always in the same spot. It replaces the
// old floating PlatformWindow. The save/publish buttons still route through the
// platform bridge (runSave / runBuild / saveAvatar), so they only do anything when
// embedded under a platform; standalone the bar just shows the wordmark. Local,
// file-on-your-computer tools stay on the taskbar's Advanced fold-out.

import { ChevronDown, Loader2 } from '../../../icons';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../backend';
import type { Filesystem } from '../../fs';
import { backToBongle, runBuild, runSave, saveAvatar } from '../../platform/actions';
import { isSourcePath, SAVE_MAX_BYTES, SAVE_WARN_BYTES, saveSizeBytes } from '../../project-save';
import { useAutosave } from '../../stores/autosave';
import { usePlatform } from '../../stores/platform';

/** the bar's height, reserved at the top of the window-manager coordinate space
 *  (see stores/windows.ts) so no window title bar can hide under it. */
export const TOPBAR_H = 32;

const BTN =
    'inline-flex h-[22px] cursor-pointer items-center gap-1 border border-border bg-surface px-2 text-[11px] leading-none hover:bg-hover disabled:cursor-default disabled:opacity-50';

export function TopBar({ fs }: { fs: Filesystem }) {
    const embedded = usePlatform((s) => s.embedded);
    const intent = usePlatform((s) => s.intent);
    // build/publish + save are host-only (they need the pipeline + platform
    // identity); a guest edits the host's project and persists via the host.
    const host = useSession((s) => s.host);
    // a build publishes to a project that exists on bongle — you can't publish a
    // never-saved draft, so Build waits until the first save (the centered CTA).
    const savedToBongle = usePlatform((s) => s.savedToBongle);

    const label = intent ? (intent.kind === 'avatar' ? (intent.name ?? 'avatar') : 'project') : null;

    return (
        <div
            className="absolute top-0 right-0 left-0 z-[1000000] flex items-center gap-2 border-b border-border bg-surface px-2"
            style={{ height: TOPBAR_H }}
        >
            {/* left: what you're editing, or the plain wordmark when standalone. */}
            <span className="select-none font-mono text-[11px] text-fg-muted">
                {label ? `editing ${label}` : 'bongle'}
            </span>

            {/* the "never saved to bongle" CTA — absolutely centered in the bar so it
                reads as the primary nudge, independent of the left/right clusters. */}
            <SaveCta fs={fs} />

            {/* right cluster — only meaningful when embedded under a platform. */}
            {embedded && intent && (
                <div className="ml-auto flex items-center gap-2">
                    {intent.kind === 'avatar' ? (
                        <button
                            type="button"
                            className={BTN}
                            onClick={() => void saveAvatar(fs, intent.name ?? 'avatar', intent.canEdit)}
                        >
                            Save avatar to bongle
                        </button>
                    ) : host ? (
                        <>
                            <SaveStatusChip />
                            <DiskMeter fs={fs} />
                            <SaveMenu fs={fs} />
                            <button
                                type="button"
                                className={BTN}
                                disabled={!savedToBongle}
                                title={savedToBongle ? undefined : 'Save to bongle before publishing a build'}
                                onClick={() => void runBuild(fs)}
                            >
                                Build
                            </button>
                        </>
                    ) : (
                        <span className="text-[10px] text-fg-muted">
                            Editing as a guest — changes save to the host's project live.
                        </span>
                    )}
                    <button type="button" className={`${BTN} text-fg-muted`} onClick={backToBongle}>
                        Exit ↗
                    </button>
                </div>
            )}
        </div>
    );
}

/** the centered "never saved to bongle" CTA — the loud onboarding nudge migrated
 *  here from the old platform banner. Only for a brand-new project draft (host,
 *  embedded, no base version yet); a brand-new avatar has its own "Save avatar to
 *  bongle" button. "Save to bongle" runs the version save, which for an anonymous
 *  draft prompts sign-up + a name before it uploads. Absolutely positioned so it
 *  sits dead-center regardless of the surrounding clusters. */
function SaveCta({ fs }: { fs: Filesystem }) {
    const embedded = usePlatform((s) => s.embedded);
    const intent = usePlatform((s) => s.intent);
    const savedToBongle = usePlatform((s) => s.savedToBongle);
    const status = usePlatform((s) => s.saveStatus);
    const host = useSession((s) => s.host);

    if (!embedded || !host || intent?.kind !== 'project' || savedToBongle) return null;

    const saving = status === 'saving';
    const label = saving ? 'Saving…' : status === 'error' ? 'Save failed — retry' : 'Save project to bongle';
    return (
        <button
            type="button"
            disabled={saving}
            className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 inline-flex h-[22px] cursor-pointer items-center gap-1 whitespace-nowrap border border-amber-500 bg-amber-500 px-2 font-semibold text-[11px] text-black leading-none hover:bg-amber-400 disabled:cursor-default disabled:opacity-70"
            onClick={() => void runSave(fs)}
        >
            {saving && <Loader2 size={11} className="animate-spin" />}
            {label}
        </button>
    );
}

/** a spinner + label, for the in-progress save states. */
function Working({ children }: { children: string }) {
    return (
        <span className="flex items-center gap-1 text-[10px] text-fg-muted">
            <Loader2 size={11} className="animate-spin" /> {children}
        </span>
    );
}

/** the compact save-state indicator: live WIP for both save actions (a spinner +
 *  "Saving draft…" / "Saving…"), then a transient tick, then falls back to the amber
 *  "unsaved on this device" once a saved-to-bongle project has fresh local edits. The
 *  never-saved version state is owned by the centered SaveCta instead; drafts show
 *  their feedback here in every case (the CTA doesn't cover them). */
function SaveStatusChip() {
    const status = usePlatform((s) => s.saveStatus);
    const draft = usePlatform((s) => s.draftStatus);
    const message = usePlatform((s) => s.saveMessage);
    const dirty = usePlatform((s) => s.dirty);
    const savedToBongle = usePlatform((s) => s.savedToBongle);
    const resetSave = usePlatform((s) => s.resetSave);
    const setDraftStatus = usePlatform((s) => s.setDraftStatus);

    // clear the transient "Saved" ticks after a moment; a version error stays until
    // the next save.
    useEffect(() => {
        if (status !== 'saved') return;
        const t = setTimeout(resetSave, 2500);
        return () => clearTimeout(t);
    }, [status, resetSave]);
    useEffect(() => {
        if (draft !== 'saved') return;
        const t = setTimeout(() => setDraftStatus('idle'), 2500);
        return () => clearTimeout(t);
    }, [draft, setDraftStatus]);

    // draft feedback shows regardless of savedToBongle — a draft flush works before
    // the first bongle save, and the CTA never surfaces it.
    if (draft === 'saving') return <Working>Saving draft…</Working>;
    if (draft === 'saved') return <span className="text-[10px] text-green-500">Draft saved ✓</span>;
    // version-save feedback + the persistent dirty flag only apply once it's a real
    // bongle project (before that the centered SaveCta owns those states).
    if (!savedToBongle) return null;
    if (status === 'saving') return <Working>Saving…</Working>;
    if (status === 'saved') return <span className="text-[10px] text-green-500">Saved ✓</span>;
    if (status === 'error') return <span className="text-[10px] text-red-500">{message ?? 'Save failed'}</span>;
    if (dirty)
        return (
            <span className="flex items-center gap-1 text-[10px] text-amber-500">
                <span aria-hidden>●</span> Unsaved · on device
            </span>
        );
    return null;
}

/** the Save ▾ dropdown: a quick on-device draft snapshot (crash-net) vs minting an
 *  immutable version (enters history, is what builds come from). */
function SaveMenu({ fs }: { fs: Filesystem }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    // the draft flush is armed only while the autosave driver runs (embedded +
    // project intent); null → hide the draft entry.
    const flush = useAutosave((s) => s.flush);

    useEffect(() => {
        if (!open) return;
        // dismiss on outside pointerdown / Escape (same pattern as AdvancedMenu). The
        // click that opened the menu already fired, so it can't self-close — no timers.
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

    // draft feedback (Saving draft… → Draft saved ✓) is surfaced by SaveStatusChip
    // off the shared store, same place as the version-save feedback.
    const saveDraft = async () => {
        setOpen(false);
        if (!flush) return;
        const { setDraftStatus } = usePlatform.getState();
        setDraftStatus('saving');
        try {
            await flush();
            setDraftStatus('saved');
        } catch {
            setDraftStatus('idle');
        }
    };

    return (
        <div ref={ref} className="relative flex items-center gap-1">
            <button type="button" className={BTN} onClick={() => setOpen((v) => !v)}>
                Save
                <ChevronDown size={12} />
            </button>
            {open && (
                <div className="absolute top-full right-0 z-[2000000] mt-1 w-52 border border-border bg-surface p-1 shadow-[2px_2px_0_rgba(0,0,0,0.5)]">
                    {flush && (
                        <button
                            type="button"
                            className="mb-1 w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-[11px] hover:bg-hover"
                            onClick={() => void saveDraft()}
                        >
                            Save Draft
                            <span className="mt-0.5 block text-[9px] leading-tight text-fg-muted">
                                Quick on-device snapshot of the working copy.
                            </span>
                        </button>
                    )}
                    <button
                        type="button"
                        className="w-full cursor-pointer border border-border bg-surface px-2 py-1.5 text-left text-[11px] hover:bg-hover"
                        onClick={() => {
                            setOpen(false);
                            void runSave(fs);
                        }}
                    >
                        Save As New Version
                        <span className="mt-0.5 block text-[9px] leading-tight text-fg-muted">
                            Mints a version — enters history, what builds come from.
                        </span>
                    </button>
                </div>
            )}
        </div>
    );
}

/** compact live estimate of the save size, amber past the warn threshold and red
 *  over the hard cap (a save over the cap is refused). Recomputes only on SOURCE-file
 *  changes (not derived bake writes), and marks the working copy dirty as it does. */
function DiskMeter({ fs }: { fs: Filesystem }) {
    const [bytes, setBytes] = useState<number | null>(null);
    const markDirty = usePlatform((s) => s.markDirty);
    useEffect(() => {
        let live = true;
        const recompute = () =>
            void saveSizeBytes(fs).then((b) => {
                if (live) setBytes(b);
            });
        recompute();
        const handle = fs.watch((changes) => {
            if (changes.some((c) => isSourcePath(c.path))) {
                markDirty();
                recompute();
            }
        });
        return () => {
            live = false;
            handle.close();
        };
    }, [fs, markDirty]);

    if (bytes === null) return null;
    const capMb = Math.round(SAVE_MAX_BYTES / (1024 * 1024));
    const mb = bytes / (1024 * 1024);
    const over = bytes > SAVE_MAX_BYTES;
    const warn = bytes > SAVE_WARN_BYTES;
    const pct = Math.min(100, (bytes / SAVE_MAX_BYTES) * 100);
    const textColor = over ? 'text-red-500' : warn ? 'text-amber-500' : 'text-fg-muted';
    const barColor = over ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-fg-muted';
    return (
        <div
            className="flex items-center gap-1.5"
            title={over ? `Over the ${capMb} MB limit — trim assets to save.` : `${mb.toFixed(1)} of ${capMb} MB used`}
        >
            <div className="h-1.5 w-14 border border-border bg-surface">
                <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <span className={`text-[10px] ${textColor}`}>
                {mb.toFixed(1)}/{capMb}MB
            </span>
        </div>
    );
}
