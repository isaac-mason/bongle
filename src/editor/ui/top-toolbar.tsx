import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from '../../../icons';
import { type ClientRoom, LOCAL_ROOM_PREFIX } from '../../client/rooms';
import { Button } from '../../client/ui/components';
import { useClient } from '../../client/ui/stores/client-store';
import type { PlayerMode, RoomInfo } from '../../core/protocol';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { setEditorEnabledForRoom, setRoomView } from '../lens';
import { joinRoom, leaveRoom, stopRoom, switchRoom } from '../session';
import { useEngineClient } from './engine-client-context';

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
    const engine = useEngineClient();
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
                onClick={() => switchRoom(engine, info.id, tabMode)}
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
                            const clientRoom = [...useClient.getState().rooms.values()].find(
                                (r) => r.roomId === info.id && r.playerMode === 'play',
                            );
                            if (clientRoom) setEditorEnabledForRoom(clientRoom, !inspectClientOn);
                        }}
                    />
                    <MenuItem
                        label={inspectServerOn ? 'Stop inspecting server' : 'Inspect server'}
                        onClose={onClose}
                        onClick={() => {
                            if (inspectServerOn) leaveRoom(engine, info.id, 'edit');
                            else joinRoom(engine, info.id, 'edit');
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
                onClick={() => leaveRoom(engine, info.id, tabMode)}
            />
            <MenuItem
                label="Stop room"
                danger
                disabled={isMainEdit}
                onClose={onClose}
                onClick={() => stopRoom(engine, info.id)}
            />
        </div>
    );
}

/* ── Tab model ──────────────────────────────────────────────────── */

type TabId = string;

/**
 * One renderable tab. `room` is null for a ghost (server room known, no
 * ClientRoom joined yet); otherwise the tab is one POV on that room: the
 * player POV, or (`lens`) the editor POV layered on a play room.
 *
 * `info` is always populated. For ghosts it's the only source of metadata;
 * for joined rooms it mirrors what `room` already exposes.
 */
type Tab = {
    id: TabId;
    room: ClientRoom | null;
    /** the POV's mode; a ghost takes the room's authoritative mode. */
    mode: PlayerMode;
    /** the editor lens (Shift+backtick) layered on a play room. */
    lens: boolean;
    info: RoomInfo;
    /** true when another tab in the same group is bound to the same underlying
     *  ClientRoom, e.g. play POV + editor lens, or sibling edit ClientRoom on
     *  a play session. drives the pill collapse; shared namespace alone (all
     *  solo edit rooms share 'editor') does not count. */
    hasRoomSibling: boolean;
};

function orderRank(t: Tab): number {
    // play POV first, then editor lens on play, then sibling edit ClientRoom
    if (t.mode === 'play') return 0;
    if (t.lens) return 1;
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
    const { room, info, lens: lensBacked, mode: tabMode } = tab;
    const activeRoomId = useEditor((s) => s.roomId);
    const activeMode = useEditor((s) => s.mode);
    const playerToView = useEditor((s) => s.playerToView);
    const engine = useEngineClient();

    const isPlay = tabMode === 'play';
    // a local (client-only, in-tab) room vs a server-backed remote room. local room
    // ids are prefixed; see LOCAL_ROOM_PREFIX / startLocalRoom.
    const isLocal = info.id.startsWith(LOCAL_ROOM_PREFIX);
    const showAsPill = room !== null && tabMode === 'edit' && inGroup;
    const isMainEdit = !inGroup && tabMode === 'edit' && info.sceneId === 'main' && info.namespace === 'main';

    const isActive = (() => {
        if (!room) return false;
        if (room.roomId !== activeRoomId) return false;
        if (lensBacked) return activeMode === 'play' && playerToView.get(room.playerId) === 'edit';
        if (tabMode === 'play') return activeMode === 'play' && playerToView.get(room.playerId) !== 'edit';
        // sibling edit ClientRoom
        return activeMode === 'edit';
    })();

    // close visibility:
    //   solo main-edit → no close (the protected default edit room)
    //   ghost          → stop (server-side teardown of the room)
    //   joined         → leave (edit POV) or stop (play POV)
    const canClose = !isMainEdit;

    const onActivate = (): void => {
        if (!room) {
            joinRoom(engine, info.id, info.roomMode);
            return;
        }
        if (lensBacked) {
            // editor POV on a play room: ensure play active + lens up + POV=edit
            if (room.roomId !== activeRoomId || activeMode !== 'play') {
                switchRoom(engine, room.roomId, 'play');
            }
            setEditorEnabledForRoom(room, true);
            setRoomView(room, 'edit');
            return;
        }
        if (tabMode === 'play') {
            if (room.roomId !== activeRoomId || activeMode !== 'play') {
                switchRoom(engine, room.roomId, 'play');
            }
            // if lens was up, swap POV back to player and hide editor (but
            // keep the lens alive, full teardown lives on the lens pill's X).
            if (playerToView.get(room.playerId) === 'edit') {
                setRoomView(room, 'play');
            }
            return;
        }
        // sibling edit ClientRoom
        if (room.roomId !== activeRoomId || activeMode !== 'edit') {
            switchRoom(engine, room.roomId, 'edit');
        }
    };

    const onClose = (e: React.MouseEvent): void => {
        e.stopPropagation();
        if (!room) {
            // ghost, only server-side stop applies.
            stopRoom(engine, info.id);
            return;
        }
        if (lensBacked) {
            setEditorEnabledForRoom(room, false);
            return;
        }
        if (tabMode === 'play') {
            stopRoom(engine, room.roomId);
            return;
        }
        leaveRoom(engine, room.roomId, 'edit');
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
                    className={`flex items-center px-1.5 text-[10px] font-mono cursor-pointer border border-r-0 ${
                        isActive ? activeBg : 'bg-surface text-fg-muted border-border hover:bg-surface-muted hover:text-fg'
                    }`}
                >
                    {pillLabel}
                </button>
            ) : (
                <button
                    type="button"
                    onClick={onActivate}
                    onContextMenu={onContextMenu}
                    title={`${info.sceneId} [${tabMode}] · ${isLocal ? 'local (in-tab, no server)' : 'remote (server-backed)'} (namespace '${info.namespace}')`}
                    className={`flex items-center gap-1 text-[11px] font-mono cursor-pointer border border-l-2 ${
                        isPlay ? 'border-l-tab-play' : 'border-l-tab-edit'
                    } ${
                        isActive
                            ? activeBg
                            : room
                              ? 'bg-surface text-fg-muted border-border hover:bg-surface-muted'
                              : 'bg-surface text-fg-muted border-dashed border-border hover:text-fg hover:bg-surface-muted'
                    } ${canClose ? 'pl-2 pr-1.5 border-r-0' : 'px-2'}`}
                >
                    {isPlay ? <Icons.Play size={10} /> : <Icons.Wrench size={10} />}
                    {`${isPlay ? 'play' : 'edit'}: ${info.sceneId}`}
                    {isLocal && <span className="opacity-60">(local)</span>}
                </button>
            )}

            {canClose && (
                <button
                    type="button"
                    onClick={onClose}
                    onContextMenu={onContextMenu}
                    className={`flex items-center px-1 text-[11px] border border-l-0 cursor-pointer ${
                        isActive
                            ? `${activeBg} hover:opacity-80`
                            : isPlay
                              ? 'bg-surface text-fg-muted border-border hover:text-danger hover:bg-danger/15'
                              : 'bg-surface text-fg-muted border-border hover:text-fg hover:bg-surface-muted'
                    }`}
                    title={
                        !room
                            ? 'stop room'
                            : lensBacked
                              ? 'stop inspecting client'
                              : tabMode === 'edit'
                                ? 'leave edit player'
                                : 'stop room'
                    }
                >
                    {room && !isPlay ? <Icons.X size={10} /> : <Icons.Square size={10} />}
                </button>
            )}
        </div>
    );
}

/* ── RoomTabs ───────────────────────────────────────────────────── */

type Pov = Pick<Tab, 'id' | 'room' | 'mode' | 'lens'>;

function buildGroups(roomList: RoomInfo[], rooms: Iterable<ClientRoom>): { namespace: string; tabs: Tab[] }[] {
    // one POV per ClientRoom, indexed by roomId so each RoomInfo joins against
    // the POVs on the same room. a play room with the editor lens up yields a
    // second POV for the editor.
    const povsByRoomId = new Map<string, Pov[]>();
    for (const room of rooms) {
        let list = povsByRoomId.get(room.roomId);
        if (!list) {
            list = [];
            povsByRoomId.set(room.roomId, list);
        }
        list.push({ id: String(room.playerId), room, mode: room.playerMode, lens: false });
        if (room.editor) list.push({ id: room.editor.id, room, mode: 'edit', lens: true });
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
        const povs = povsByRoomId.get(info.id);
        // multi-POV rooms are the only source of room-siblings (play POV +
        // editor lens, sibling edit ClientRoom). solo edit rooms share the
        // 'editor' namespace bucket but never share a roomId.
        const hasRoomSibling = (povs?.length ?? 0) > 1;
        if (!povs || povs.length === 0) {
            bucket.push({ id: `ghost:${info.id}`, room: null, mode: info.roomMode, lens: false, info, hasRoomSibling: false });
        } else {
            const tabs = povs.map((pov) => ({ ...pov, info, hasRoomSibling }));
            tabs.sort((a, b) => orderRank(a) - orderRank(b));
            bucket.push(...tabs);
        }
    }
    return out;
}

function RoomTabs() {
    const roomList = useClient((s) => s.roomList);
    const rooms = useClient((s) => s.rooms);
    // a lens coming up or down sets `room.editor` in place (no `rooms` identity
    // change); the same path writes `playerToView`, so that is the re-render key.
    const playerToView = useEditor((s) => s.playerToView);

    const [menu, setMenu] = useState<TabContextMenu | null>(null);
    const closeMenu = useCallback(() => setMenu(null), []);
    const openMenu = useCallback(
        (info: RoomInfo, tabMode: PlayerMode, x: number, y: number) => setMenu({ info, tabMode, x, y }),
        [],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: playerToView keys the lens enter/exit recompute
    const groups = useMemo(() => buildGroups(roomList, rooms.values()), [roomList, rooms, playerToView]);

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
    const engine = useEngineClient();
    const roomId = useEditor((s) => s.roomId);
    const playPending = useEditor((s) => s.playPending);
    const play = useEditRoom((s) => s.play);

    // Show Stop whenever the active room is a play session, regardless of
    // the user's playerMode within it. A play room joined as edit is still
    // a session that needs stopping, not a place to start a new one.
    if (roomMode === 'play') {
        return (
            <Button
                tone="danger"
                onClick={() => {
                    if (roomId) stopRoom(engine, roomId);
                }}
            >
                <Icons.Square size={12} />
                Stop session
            </Button>
        );
    }

    return (
        <Button
            tone="success"
            onClick={() => play?.()}
            disabled={playPending}
            // starting isn't unavailable, it's busy: keep the fill legible and show a wait cursor.
            className="disabled:cursor-wait disabled:opacity-70"
        >
            {playPending ? <Icons.Loader2 size={12} className="animate-spin" /> : <Icons.Play size={12} />}
            {playPending ? 'Starting' : 'Play'}
        </Button>
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

            {/* play/stop. mode + editor UI visibility read off the room tabs. */}
            <PlaySection />
        </div>
    );
}
