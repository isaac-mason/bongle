// ── performance profile ─────────────────────────────────────────────
//
// engine-wide quality tier. picked once at boot from navigator hints
// (deviceMemory / hardwareConcurrency / UA), persisted to localStorage,
// optionally overridden by the user. subsystems read `settingsForTier`
// for the actual numeric knobs (view radius, arena sizes, ...) so the
// settings UI has a single source of truth.
//
// the tier ladder is intentionally coarse: each step roughly doubles
// the per-subsystem resource budget. detection picks the first ladder
// rung the device is *expected* to handle; users can flip up or down
// from the settings UI without re-detecting.
//
// usage:
//   const profile = detect(state.renderer.renderer._adapter);
//   setActive(profile, 'standard', 'user');   // user override
//   const s = settingsForTier(profile);       // read tier knobs here

const TIER_ORDER = ['fallback', 'low', 'standard'] as const;
export type Tier = (typeof TIER_ORDER)[number];

// ── tier-keyed settings ─────────────────────────────────────────────
//
// every numeric knob the active tier controls. keep additions here so a
// future settings menu can iterate one struct instead of grepping the
// codebase for `profile.active`.

export type Settings = {
    /** how far from the camera (in chunks) voxel chunks remain visible.
     *  cullCPU drops chunks past this — meshing/eviction is unaffected. */
    voxelViewChunkRadius: number;
    /** desired megabytes for the voxel quad+order arenas, clamped to
     *  25 % of `limits.maxArenaBytes` at allocation time. */
    voxelArenaDesiredMB: number;
    /** max chunk×pass slots per voxel SectionTable. */
    voxelMaxSections: number;
    /** max simultaneous SegmentArena allocations (node-pool size for the
     *  OffsetAllocator). target: live + free-node headroom across all 3
     *  passes — voxelMaxSections × 3 × 2 rounded to a power of two. */
    voxelArenaMaxAllocs: number;
    // ── remesh dispatch ─────────────────────────────────────────────
    // Two paths share the dirty-chunk queue every frame:
    //   1. main-thread sync — camera-prioritised, capped by
    //      `voxelMainThreadRemeshBudget`. Lowest latency, blocks the
    //      frame, so the cap stays tiny.
    //   2. worker pool — absorbs the rest off-thread. The pool can hold
    //      `voxelWorkerCount × voxelWorkerQueueDepth` jobs in flight at
    //      once; results land in `pendingMeshResults` and are drained
    //      at the top of the next `voxel-visuals.update` call.
    //
    // Per-frame *new* dispatch is implicitly bounded by free pool slots
    // (pool capacity − currently in flight). No explicit per-frame cap.

    /** sync remeshes per frame on the main thread (the camera-prioritised
     *  fast-path inside `voxel-visuals.update`). Keep small — every one
     *  of these blocks the frame. */
    voxelMainThreadRemeshBudget: number;
    /** size of the mesh worker pool. 0 disables workers entirely (every
     *  remesh runs on the main thread synchronously — useful for tests and
     *  the asset-pipeline path). */
    voxelWorkerCount: number;
    /** per-worker FIFO queue depth. Worker drains its queue with no
     *  postMessage round-trip between jobs. Total worker-pool in-flight
     *  cap = `voxelWorkerCount × voxelWorkerQueueDepth`. */
    voxelWorkerQueueDepth: number;
};

const SETTINGS_BY_TIER: Record<Tier, Settings> = {
    fallback: {
        voxelViewChunkRadius: 4,
        voxelArenaDesiredMB: 16,
        voxelMaxSections: 256,
        voxelArenaMaxAllocs: 2048, // 256 × 3 passes × 2 ≈ 1536 → 2048
        voxelMainThreadRemeshBudget: 1,
        voxelWorkerCount: 1,
        voxelWorkerQueueDepth: 4,
    },
    low: {
        voxelViewChunkRadius: 6,
        voxelArenaDesiredMB: 64,
        voxelMaxSections: 1024,
        voxelArenaMaxAllocs: 8192, // 1024 × 3 × 2 ≈ 6144 → 8192
        voxelMainThreadRemeshBudget: 1,
        voxelWorkerCount: 2,
        voxelWorkerQueueDepth: 3,
    },
    standard: {
        voxelViewChunkRadius: 12,
        voxelArenaDesiredMB: 96,
        voxelMaxSections: 2048,
        voxelArenaMaxAllocs: 16384, // 2048 × 3 × 2 ≈ 12288 → 16384
        voxelMainThreadRemeshBudget: 1,
        voxelWorkerCount:
            typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 4,
        voxelWorkerQueueDepth: 3,
    },
};

export function settingsForTier(profile: Profile): Settings {
    return SETTINGS_BY_TIER[profile.active];
}

export type Source = 'auto' | 'user';

export type Platform = 'ios' | 'android' | 'desktop';

export type Limits = {
    /** min(maxStorageBufferBindingSize, maxBufferSize) — every subsystem
     *  derives its arena budget against this cap, never above it. */
    maxArenaBytes: number;
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxComputeWorkgroupsPerDimension: number;
};

export type Profile = {
    active: Tier;
    /** what `detect()` chose. preserved across user overrides so the
     *  settings UI can show "reset to auto". */
    autoDetected: Tier;
    source: Source;
    limits: Limits;
    /** kept for telemetry — not currently used in dispatch. */
    adapterInfo: { vendor: string; architecture: string; description: string };
    platform: Platform;
};

const STORAGE_KEY = 'bongle.performance.tier';

// ── detection ───────────────────────────────────────────────────────

function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'desktop';
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
}

function detectAutoTier(_adapter: GPUAdapter, _platform: Platform): Tier {
    if (typeof navigator === 'undefined') return 'standard';

    // Chrome-only; undefined on Firefox/Safari → falsy, treated as standard.
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (memory !== undefined && memory <= 4) return 'low';

    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return 'low';

    // ChromeOS — overwhelmingly integrated Intel/ARM GPUs on entry-level hw.
    if (typeof navigator.userAgent === 'string' && /CrOS/.test(navigator.userAgent)) return 'low';

    return 'standard';
}

// Sandboxed iframes (deployed game-client) expose `localStorage` as a
// property whose getter throws SecurityError — `typeof` alone trips it.
// Same envelope handles disabled-storage / quota-exceeded.
function readStoredTier(): Tier | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw && (TIER_ORDER as readonly string[]).includes(raw) ? (raw as Tier) : null;
    } catch {
        return null;
    }
}

export function detect(adapter: GPUAdapter): Profile {
    const platform = detectPlatform();
    const autoDetected = detectAutoTier(adapter, platform);
    const stored = readStoredTier();

    const limits: Limits = {
        maxArenaBytes: Math.min(adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize),
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    };

    const info = adapter.info;
    const adapterInfo = {
        vendor: (info?.vendor as string) ?? '',
        architecture: (info?.architecture as string) ?? '',
        description: (info?.description as string) ?? '',
    };

    return {
        active: stored ?? autoDetected,
        autoDetected,
        source: stored ? 'user' : 'auto',
        limits,
        adapterInfo,
        platform,
    };
}

// ── override ────────────────────────────────────────────────────────

export function setActive(profile: Profile, tier: Tier, source: Source): void {
    profile.active = tier;
    profile.source = source;
    if (source === 'user') {
        try {
            localStorage.setItem(STORAGE_KEY, tier);
        } catch {
            // sandboxed iframe / quota exceeded / storage disabled — drop
        }
    }
}
