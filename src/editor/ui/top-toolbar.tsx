import * as Icons from "../../../icons";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setEditorEnabledForRoom, setRoomView } from '../../client/editor';
import type { RoomView, RoomViewId } from '../../client/rooms';
import type { PlayerMode, RoomInfo } from '../../core/protocol';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';

/* ── Room tabs ──────────────────────────────────────────────────── */

type TabContextMenu = {
    info: RoomInfo;
    tabMode: PlayerMode;
    x: number;
    y: number;
};

function MenuItem({
    label,
    onClick,
    onClose,
    danger,
    disabled,
}: {
    label: string;
    onClick: () => void;
    onClose: () => void;
    danger?: boolean;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={() => {
                if (disabled) return;
                onClick();
                onClose();
            }}
            className={`block w-full text-left px-3 py-1 text-[11px] font-mono ${
                disabled
                    ? 'text-fg-muted opacity-50 cursor-not-allowed'
                    : danger
                      ? 'text-danger hover:bg-danger/15 cursor-pointer'
                      : 'text-fg hover:bg-surface-muted cursor-pointer'
            }`}
        >
            {label}
        </button>
    );
}

function RoomTabContextMenu({ menu, onClose }: { menu: TabContextMenu; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const switchRoom = useEditor((s) => s.switchRoom);
    const joinRoom = useEditor((s) => s.joinRoom);
    const leaveRoom = useEditor((s) => s.leaveRoom);
    const stopRoom = useEditor((s) => s.stopRoom);
    const joinedPlayers = useEditor((s) => s.joinedPlayers);
    const playerToView = useEditor((s) => s.playerToView);

    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [onClose]);

    const { info, tabMode } = menu;
    const isJoinedThisMode = joinedPlayers.some((p) => p.roomId === info.id && p.mode === tabMode);
    const isJoinedEdit = joinedPlayers.some((p) => p.roomId === info.id && p.mode === 'edit');
    const playPlayer = joinedPlayers.find((p) => p.roomId === info.id && p.mode === 'play');
    const isJoinedPlay = !!playPlayer;
    const isMainEdit = tabMode === 'edit' && info.sceneId === 'main' && info.namespace === 'main';
    // inspect modes only apply to play rooms (the user must have a play-mode
    // player to inspect). edit-authoritative rooms don't expose these.
    const supportsDebug = info.roomMode === 'play' && isJoinedPlay;
    const inspectClientOn = playPlayer ? playerToView.has(playPlayer.playerId) : false;
    const inspectServerOn = isJoinedEdit;

    return (
        <div
            ref={ref}
            className="fixed z-50 bg-surface border border-border shadow min-w-[160px]"
            style={{ left: menu.x, top: menu.y }}
        >
            <MenuItem
                label="Activate"
                disabled={!isJoinedThisMode}
                onClose={onClose}
                onClick={() => switchRoom?.(info.id, tabMode)}
            />
            {tabMode === 'edit' && (
                <MenuItem
                    label="Save"
                    onClose={onClose}
                    onClick={() => {
                        const { room, playerEditStores } = useEditor.getState();
                        if (room) playerEditStores[room.playerId]?.getState().save(info.sceneId);
                    }}
                />
            )}
            {supportsDebug && (
                <>
                    <div className="border-t border-border-subtle" />
                    <MenuItem
                        label={inspectClientOn ? 'Stop inspecting client' : 'Inspect client'}
                        onClose={onClose}
                        onClick={() => {
                            const clientRoom = useEditor
                                .getState()
                                .allRooms.find((r) => r.roomId === info.id && r.playerMode === 'play');
                            if (clientRoom) setEditorEnabledForRoom(clientRoom, !inspectClientOn);
                        }}
                    />
                    <MenuItem
                        label={inspectServerOn ? 'Stop inspecting server' : 'Inspect server'}
                        onClose={onClose}
                        onClick={() => {
                            if (inspectServerOn) leaveRoom?.(info.id, 'edit');
                            else joinRoom?.(info.id, 'edit');
                        }}
                    />
                </>
            )}
            <div className="border-t border-border-subtle" />
            <MenuItem
                label={isMainEdit ? 'Leave' : 'Leave room'}
                danger
                disabled={!isJoinedThisMode || isMainEdit}
                onClose={onClose}
                onClick={() => leaveRoom?.(info.id, tabMode)}
            />
            <MenuItem label="Stop room" danger disabled={isMainEdit} onClose={onClose} onClick={() => stopRoom?.(info.id)} />
        </div>
    );
}

/* ── Tab model ──────────────────────────────────────────────────── */

type TabId = string;

/**
 * One renderable tab. `view` is null for ghost (server room known, no
 * ClientRoom joined yet); otherwise it's the addressable RoomView for
 * either the player POV or, when `view.room.editor?.id === view.id`,
 * the editor POV layered on a play room.
 *
 * `info` is always populated. For ghosts it's the only source of metadata;
 * for joined views it mirrors what `view.room` already exposes.
 */
type Tab = {
    id: TabId;
    view: RoomView | null;
    info: RoomInfo;
    /** true when another tab in the same group is bound to the same underlying
     *  ClientRoom, e.g. play POV + editor lens, or sibling edit ClientRoom on
     *  a play session. drives the pill collapse; shared namespace alone (all
     *  solo edit rooms share 'editor') does not count. */
    hasRoomSibling: boolean;
};

function isEditorLens(view: RoomView): boolean {
    return view.room.editor?.id === view.id;
}

function orderRank(v: RoomView): number {
    // play POV first, then editor lens on play, then sibling edit ClientRoom
    if (v.mode === 'play') return 0;
    if (isEditorLens(v)) return 1;
    return 2;
}

/* ── RoomTab ────────────────────────────────────────────────────── */

function RoomTab({
    tab,
    inGroup,
    onOpenMenu,
}: {
    tab: Tab;
    inGroup: boolean;
    onOpenMenu: (info: RoomInfo, tabMode: PlayerMode, x: number, y: number) => void;
}) {
    const { view, info } = tab;
    const activeRoomId = useEditor((s) => s.roomId);
    const activeMode = useEditor((s) => s.mode);
    const playerToView = useEditor((s) => s.playerToView);
    const switchRoom = useEditor((s) => s.switchRoom);
    const joinRoom = useEditor((s) => s.joinRoom);
    const leaveRoom = useEditor((s) => s.leaveRoom);
    const stopRoom = useEditor((s) => s.stopRoom);

    const lensBacked = view !== null && isEditorLens(view);
    const tabMode: PlayerMode = view ? view.mode : info.roomMode;
    const isPlay = tabMode === 'play';
    const showAsPill = view !== null && view.mode === 'edit' && inGroup;
    const isMainEdit = !inGroup && tabMode === 'edit' && info.sceneId === 'main' && info.namespace === 'main';

    const isActive = (() => {
        if (!view) return false;
        if (view.room.roomId !== activeRoomId) return false;
        if (lensBacked) return activeMode === 'play' && playerToView.get(view.room.playerId) === 'edit';
        if (view.mode === 'play') return activeMode === 'play' && playerToView.get(view.room.playerId) !== 'edit';
        // sibling edit ClientRoom
        return activeMode === 'edit';
    })();

    // close visibility:
    //   solo main-edit → no close (the protected default edit room)
    //   ghost          → stop (server-side teardown of the room)
    //   joined         → leave (edit POV) or stop (play POV)
    const canClose = !isMainEdit;

    const onActivate = (): void => {
        if (!view) {
            joinRoom?.(info.id, info.roomMode);
            return;
        }
        if (lensBacked) {
            // editor POV on a play room: ensure play active + lens up + view=edit
            if (view.room.roomId !== activeRoomId || activeMode !== 'play') {
                switchRoom?.(view.room.roomId, 'play');
            }
            setEditorEnabledForRoom(view.room, true);
            setRoomView(view.room, 'edit');
            return;
        }
        if (view.mode === 'play') {
            if (view.room.roomId !== activeRoomId || activeMode !== 'play') {
                switchRoom?.(view.room.roomId, 'play');
            }
            // if lens was up, swap POV back to player and hide editor (but
            // keep the lens alive, full teardown lives on the lens pill's X).
            if (playerToView.get(view.room.playerId) === 'edit') {
                setRoomView(view.room, 'play');
            }
            return;
        }
        // sibling edit ClientRoom
        if (view.room.roomId !== activeRoomId || activeMode !== 'edit') {
            switchRoom?.(view.room.roomId, 'edit');
        }
    };

    const onClose = (e: React.MouseEvent): void => {
        e.stopPropagation();
        if (!view) {
            // ghost, only server-side stop applies.
            stopRoom?.(info.id);
            return;
        }
        if (lensBacked) {
            setEditorEnabledForRoom(view.room, false);
            return;
        }
        if (view.mode === 'play') {
            stopRoom?.(view.room.roomId);
            return;
        }
        leaveRoom?.(view.room.roomId, 'edit');
    };

    const onContextMenu = (e: React.MouseEvent): void => {
        e.preventDefault();
        onOpenMenu(info, tabMode, e.clientX, e.clientY);
    };

    const pillLabel = lensBacked ? 'inspect client' : 'inspect server';

    // active background tracks the tab's role: red for play, blue for the
    // editor lens (inspect client), near-black for any other edit POV
    // (solo edit or sibling edit ClientRoom / inspect server).
    const activeBg = lensBacked
        ? 'bg-tab-lens text-white border-tab-lens'
        : isPlay
          ? 'bg-tab-play text-white border-tab-play'
          : 'bg-tab-edit text-white border-tab-edit';

    return (
        <div className="flex items-stretch h-6">
            {showAsPill ? (
                <button
                    type="button"
                    onClick={onActivate}
                    onContextMenu={onContextMenu}
                    title={`${info.sceneId} · ${pillLabel}`}
                    className={`flex items-center px-1.5 text-[10px] font-mono cursor-pointer border border-r-0 rounded-l ${
                        isActive
                            ? activeBg
                            : 'bg-surface text-fg-muted border-border hover:bg-surface-muted hover:text-fg'
                    }`}
                >
                    {pillLabel}
                </button>
            ) : (
                <button
                    type="button"
                    onClick={onActivate}
                    onContextMenu={onContextMenu}
                    title={`${info.sceneId} [${tabMode}] (namespace '${info.namespace}')`}
                    className={`flex items-center gap-1 text-[11px] font-mono cursor-pointer border border-l-2 ${
                        isPlay ? 'border-l-tab-play' : 'border-l-tab-edit'
                    } ${
                        isActive
                            ? activeBg
                            : view
                              ? 'bg-surface text-fg-muted border-border hover:bg-surface-muted'
                              : 'bg-surface text-fg-muted border-dashed border-border hover:text-fg hover:bg-surface-muted'
                    } ${canClose ? 'pl-2 pr-1.5 rounded-l border-r-0' : 'px-2 rounded'}`}
                >
                    {isPlay ? <Icons.Play size={10} /> : <Icons.Wrench size={10} />}
                    {`${isPlay ? 'play' : 'edit'}: ${info.sceneId}`}
                </button>
            )}

            {canClose && (
                <button
                    type="button"
                    onClick={onClose}
                    onContextMenu={onContextMenu}
                    className={`flex items-center px-1 text-[11px] rounded-r border border-l-0 cursor-pointer ${
                        isActive
                            ? `${activeBg} hover:opacity-80`
                            : isPlay
                              ? 'bg-surface text-fg-muted border-border hover:text-danger hover:bg-danger/15'
                              : 'bg-surface text-fg-muted border-border hover:text-fg hover:bg-surface-muted'
                    }`}
                    title={
                        !view
                            ? 'stop room'
                            : lensBacked
                              ? 'stop inspecting client'
                              : view.mode === 'edit'
                                ? 'leave edit player'
                                : 'stop room'
                    }
                >
                    {view && !isPlay ? <Icons.X size={10} /> : <Icons.Square size={10} />}
                </button>
            )}
        </div>
    );
}

/* ── RoomTabs ───────────────────────────────────────────────────── */

function buildGroups(roomList: RoomInfo[], roomViews: Map<RoomViewId, RoomView>): { namespace: string; tabs: Tab[] }[] {
    // index views by their underlying ClientRoom.roomId so we can join
    // each RoomInfo against the views on the same room.
    const viewsByRoomId = new Map<string, RoomView[]>();
    for (const view of roomViews.values()) {
        const list = viewsByRoomId.get(view.room.roomId);
        if (list) list.push(view);
        else viewsByRoomId.set(view.room.roomId, [view]);
    }

    const out: { namespace: string; tabs: Tab[] }[] = [];
    const byNs = new Map<string, Tab[]>();

    for (const info of roomList) {
        const ns = info.namespace ?? 'main';
        let bucket = byNs.get(ns);
        if (!bucket) {
            bucket = [];
            byNs.set(ns, bucket);
            out.push({ namespace: ns, tabs: bucket });
        }
        const views = viewsByRoomId.get(info.id);
        // multi-view rooms are the only source of room-siblings (play POV +
        // editor lens, sibling edit ClientRoom). solo edit rooms share the
        // 'editor' namespace bucket but never share a roomId.
        const hasRoomSibling = (views?.length ?? 0) > 1;
        if (!views || views.length === 0) {
            bucket.push({ id: `ghost:${info.id}`, view: null, info, hasRoomSibling: false });
        } else {
            views.sort((a, b) => orderRank(a) - orderRank(b));
            for (const view of views) {
                bucket.push({ id: view.id, view, info, hasRoomSibling });
            }
        }
    }
    return out;
}

function RoomTabs() {
    const roomList = useEditor((s) => s.roomList);
    const roomViews = useEditor((s) => s.roomViews);

    const [menu, setMenu] = useState<TabContextMenu | null>(null);
    const closeMenu = useCallback(() => setMenu(null), []);
    const openMenu = useCallback(
        (info: RoomInfo, tabMode: PlayerMode, x: number, y: number) => setMenu({ info, tabMode, x, y }),
        [],
    );

    const groups = useMemo(() => buildGroups(roomList, roomViews), [roomList, roomViews]);

    return (
        <div className="flex items-center gap-4">
            {groups.map((group, gi) => (
                <div key={group.namespace} className="flex items-center gap-1">
                    {gi > 0 && <div className="h-4 w-px bg-border mx-2" />}
                    {group.tabs.map((tab) => (
                        <RoomTab key={tab.id} tab={tab} inGroup={tab.hasRoomSibling} onOpenMenu={openMenu} />
                    ))}
                </div>
            ))}
            {menu && <RoomTabContextMenu menu={menu} onClose={closeMenu} />}
        </div>
    );
}

/* ── Play / Stop buttons ────────────────────────────────────────── */

function PlaySection() {
    const roomMode = useEditor((s) => s.roomMode);
    const stopRoom = useEditor((s) => s.stopRoom);
    const roomId = useEditor((s) => s.roomId);
    const play = useEditRoom((s) => s.play);

    // Show Stop whenever the active room is a play session, regardless of
    // the user's playerMode within it. A play room joined as edit is still
    // a session that needs stopping, not a place to start a new one.
    if (roomMode === 'play') {
        return (
            <button
                type="button"
                onClick={() => {
                    if (roomId) stopRoom?.(roomId);
                }}
                className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25 cursor-pointer"
            >
                <Icons.Square size={12} />
                Stop session
            </button>
        );
    }

    return (
        <button
            type="button"
            onClick={() => play?.()}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded border border-success/40 bg-success/15 text-success hover:bg-success/25 cursor-pointer"
        >
            <Icons.Play size={12} />
            Play
        </button>
    );
}

/* ── Mode pill + editor visibility toggle ───────────────────────── */

function ModePill() {
    const mode = useEditor((s) => s.mode);
    const editorEnabled = useEditor((s) => {
        if (!s.room) return false;
        if (!s.playerEditStores[s.room.playerId]) return false;
        if (!s.room.editor) return true;
        return s.playerToView.get(s.room.playerId) === 'edit';
    });

    // mode is the player's camera/control mode; editorEnabled is the UI flag.
    // suffix surfaces the off-default combinations (play+editor, edit-hidden)
    // so the user can tell at a glance when they're in a non-typical mix.
    const isEdit = mode === 'edit';
    let suffix: string | null = null;
    if (mode === 'play' && editorEnabled) suffix = 'editor';
    else if (mode === 'edit' && !editorEnabled) suffix = 'hidden';

    return (
        <span
            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide border ${
                isEdit ? 'bg-tab-edit/15 text-tab-edit border-tab-edit/40' : 'bg-tab-play/15 text-tab-play border-tab-play/40'
            }`}
        >
            {mode}
            {suffix && <span className="text-fg-muted">· {suffix}</span>}
        </span>
    );
}

/* ── Top toolbar ────────────────────────────────────────────────── */

export function TopToolbar() {
    return (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border-b border-border">
            {/* room tabs */}
            <div className="flex-1 flex items-center gap-2">
                <RoomTabs />
            </div>

            {/* mode + play/stop. editor UI visibility lives on the inspect-client
                sub-tab now, no global toggle here. */}
            <div className="flex items-center gap-2">
                <ModePill />
                <PlaySection />
            </div>
        </div>
    );
}
