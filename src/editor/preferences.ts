/**
 * editor preferences, anything we want to persist across editor sessions
 * (hotbar slots, inspector rotation mode, etc.).
 *
 * each project's editor runs on its own dev-server origin, so per-origin
 * localStorage already isolates per-project preferences, no extra
 * namespacing needed here.
 *
 * add a new pref by putting its key + load/save pair in this file.
 */

import type { EulerOrder } from 'mathcat';
import { emptyHotbar, HOTBAR_SIZE, type HotbarSlot } from './inventory';

// ── low-level helpers ────────────────────────────────────────────────

// Sandboxed iframes (the deployed game-client) expose `localStorage`
// as a property but throw SecurityError on actual access, so a
// `typeof` guard alone isn't enough; the read/write itself has to be
// wrapped. Same envelope handles disabled-storage / quota-exceeded.
function readString(key: string): string | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeString(key: string, value: string): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
    } catch {
        // sandboxed iframe / quota exceeded / storage disabled, drop
    }
}

function readJson<T>(key: string): T | null {
    const raw = readString(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        writeString(key, JSON.stringify(value));
    } catch {
        // can't even serialize, silently drop
    }
}

// ── hotbar slots ─────────────────────────────────────────────────────

const HOTBAR_KEY = 'blocks-editor-hotbar';

export function loadHotbar(): HotbarSlot[] {
    const parsed = readJson<unknown[]>(HOTBAR_KEY);
    if (!Array.isArray(parsed)) return emptyHotbar();
    const slots = emptyHotbar();
    for (let i = 0; i < HOTBAR_SIZE && i < parsed.length; i++) {
        const e = parsed[i] as { kind?: string; blockKey?: string; prefabId?: string } | null;
        if (!e) continue;
        if (e.kind === 'block' && typeof e.blockKey === 'string') {
            slots[i] = { kind: 'block', blockKey: e.blockKey };
        } else if (e.kind === 'prefab' && typeof e.prefabId === 'string') {
            slots[i] = { kind: 'prefab', prefabId: e.prefabId };
        }
    }
    return slots;
}

export function saveHotbar(slots: HotbarSlot[]): void {
    writeJson(HOTBAR_KEY, slots);
}

// ── inspector rotation mode ─────────────────────────────────────────

export type InspectorRotationMode = 'quat' | EulerOrder;

const INSPECTOR_ROTATION_MODE_KEY = 'inspector:rotation-mode';
const VALID_ROTATION_MODES: readonly InspectorRotationMode[] = ['quat', 'xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'];

export function loadInspectorRotationMode(): InspectorRotationMode {
    const stored = readString(INSPECTOR_ROTATION_MODE_KEY);
    return VALID_ROTATION_MODES.includes(stored as InspectorRotationMode) ? (stored as InspectorRotationMode) : 'yxz';
}

export function saveInspectorRotationMode(mode: InspectorRotationMode): void {
    writeString(INSPECTOR_ROTATION_MODE_KEY, mode);
}
