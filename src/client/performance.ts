import type { RenderDeviceCaps } from '../render/backend';
import type { VoxelArenaBudget } from '../render/voxels/voxel-arena';

const TIER_ORDER = ['low', 'standard'] as const;
export type Tier = (typeof TIER_ORDER)[number];

// every numeric knob the active tier controls; sized so a radius-12 terrain map stays
// well under the light-tile and arena budget (voxel debug panels report live figures).

export type Settings = {
    /** upper bound on device pixel ratio; 1 = native resolution. UI renders
     *  in a separate full-res overlay pass, so text stays crisp regardless. */
    maxPixelRatio: number;
    /** how far from the camera (in chunks) voxel chunks stay visible; cullCPU
     *  drops chunks past this, meshing/eviction is unaffected. */
    voxelViewChunkRadius: number;
    /** desired megabytes for the voxel quad+order arenas, clamped to 25% of
     *  `limits.maxArenaBytes` at allocation time. */
    voxelArenaDesiredMB: number;
    /** max chunk x pass slots per voxel SectionTable. */
    voxelMaxSections: number;
    /** light-volume tiles, one per resident chunk; sized independently of
     *  `voxelMaxSections`, which counts chunk x pass slots per table. */
    voxelMaxLightTiles: number;
    /** max simultaneous SegmentArena allocations (OffsetAllocator node-pool
     *  size); target voxelMaxSections x 3 x 2 rounded to a power of two. */
    voxelArenaMaxAllocs: number;
    /** size of the mesh worker pool; 0 runs every remesh on the main thread
     *  synchronously, used by tests and the asset-pipeline path. */
    voxelWorkerCount: number;
    /** per-worker FIFO queue depth; total in-flight cap is
     *  `voxelWorkerCount x voxelWorkerQueueDepth`. */
    voxelWorkerQueueDepth: number;
};

const SETTINGS_BY_TIER: Record<Tier, Settings> = {
    low: {
        maxPixelRatio: 1,
        voxelViewChunkRadius: 6,
        voxelArenaDesiredMB: 48,
        voxelMaxSections: 768,
        voxelMaxLightTiles: 1024,
        voxelArenaMaxAllocs: 4096, // 768 x 3 x 2 ~ 4608, rounded down; allocs run well under slots
        // single worker: low-end (<=4 cores, Chromebook) keeps memory down;
        // the urgent tier still covers edit latency.
        voxelWorkerCount: 1,
        voxelWorkerQueueDepth: 3,
    },
    standard: {
        maxPixelRatio: 2,
        voxelViewChunkRadius: 8,
        voxelArenaDesiredMB: 64,
        voxelMaxSections: 1280,
        voxelMaxLightTiles: 1792,
        voxelArenaMaxAllocs: 8192, // 1280 x 3 x 2 ~ 7680, rounded up
        // 2 workers: past this, postMessage + per-worker chunk-cache overhead
        // outweighs the parallelism, so this doesn't scale with core count.
        voxelWorkerCount: 2,
        voxelWorkerQueueDepth: 3,
    },
};

export function settingsForTier(profile: Profile): Settings {
    return SETTINGS_BY_TIER[profile.active];
}

/** per-room voxel arena/section sizing for the active tier, clamped to 25% of
 *  the device's max arena size. every VoxelResources.init reads this so rooms
 *  allocate identically regardless of who creates them. */
export function voxelArenaBudgetForTier(profile: Profile): VoxelArenaBudget {
    const s = settingsForTier(profile);
    const cap = Math.floor(profile.limits.maxArenaBytes * 0.25);
    const total = Math.min(s.voxelArenaDesiredMB * 1024 * 1024, cap);
    return {
        quadArenaBytes: total,
        maxSections: s.voxelMaxSections,
        maxAllocs: s.voxelArenaMaxAllocs,
        // one tile per resident chunk; sizing this off maxSections (which
        // counts chunk x pass slots across three tables) undersizes the pool.
        maxLightTiles: s.voxelMaxLightTiles,
        lightGridChunkRadius: s.voxelViewChunkRadius + STREAM_APRON,
    };
}

/** chunks of loaded-but-not-drawn apron kept beyond the visual radius, for
 *  the mesher's 26-neighbour apron and a small pop-in buffer. */
const STREAM_APRON = 2;

/** stream radius (in chunks) this client requests from the server: visual
 *  radius plus apron. pushed via the owner-authoritative PlayerTrait.viewRadius
 *  sync; the server clamps it. */
export function streamChunkRadius(profile: Profile): number {
    return settingsForTier(profile).voxelViewChunkRadius + STREAM_APRON;
}

/** effective device pixel ratio for the active tier: the display's own ratio,
 *  clamped by the tier's `maxPixelRatio`. */
export function cappedPixelRatio(profile: Profile): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Math.min(dpr, settingsForTier(profile).maxPixelRatio);
}

export type Source = 'auto' | 'user';

export type Platform = 'ios' | 'android' | 'desktop';

export type Limits = {
    /** min(maxStorageBufferBindingSize, maxBufferSize); every subsystem's
     *  arena budget derives from this cap. */
    maxArenaBytes: number;
    maxStorageBufferBindingSize: number;
    maxBufferSize: number;
    maxComputeWorkgroupsPerDimension: number;
};

export type Profile = {
    active: Tier;
    /** what `detect()` chose; preserved across user overrides for a
     *  "reset to auto" control. */
    autoDetected: Tier;
    source: Source;
    limits: Limits;
    /** kept for telemetry, not currently used in dispatch. */
    adapterInfo: { vendor: string; architecture: string; description: string };
    platform: Platform;
};

const STORAGE_KEY = 'bongle.performance.tier';

function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'desktop';
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
}

function detectAutoTier(): Tier {
    if (typeof navigator === 'undefined') return 'standard';

    // Chrome-only; undefined on Firefox/Safari, treated as standard.
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (memory !== undefined && memory <= 4) return 'low';

    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return 'low';

    // ChromeOS: overwhelmingly integrated Intel/ARM GPUs on entry-level hardware.
    if (typeof navigator.userAgent === 'string' && /CrOS/.test(navigator.userAgent)) return 'low';

    return 'standard';
}

// sandboxed iframes expose `localStorage` as a property whose getter throws
// SecurityError, so `typeof` alone trips it; same catch handles quota-exceeded.
function readStoredTier(): Tier | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw && (TIER_ORDER as readonly string[]).includes(raw) ? (raw as Tier) : null;
    } catch {
        return null;
    }
}

export function detect(caps: RenderDeviceCaps): Profile {
    const platform = detectPlatform();
    const autoDetected = detectAutoTier();
    const stored = readStoredTier();

    const limits: Limits = {
        maxArenaBytes: Math.min(caps.maxStorageBufferBindingSize, caps.maxBufferSize),
        maxStorageBufferBindingSize: caps.maxStorageBufferBindingSize,
        maxBufferSize: caps.maxBufferSize,
        maxComputeWorkgroupsPerDimension: caps.maxComputeWorkgroupsPerDimension,
    };

    return {
        active: stored ?? autoDetected,
        autoDetected,
        source: stored ? 'user' : 'auto',
        limits,
        adapterInfo: caps.adapterInfo,
        platform,
    };
}

/** full performance state derived once at boot; tier is fixed per session
 *  (no live switch wired), so subsystems read these fields instead of
 *  recomputing. */
export type Resolved = {
    profile: Profile;
    settings: Settings;
    voxelBudget: VoxelArenaBudget;
};

export function resolve(caps: RenderDeviceCaps): Resolved {
    const profile = detect(caps);
    return { profile, settings: settingsForTier(profile), voxelBudget: voxelArenaBudgetForTier(profile) };
}

export function log(r: Resolved): void {
    const MB = (n: number) => `${(n / 1024 / 1024).toFixed(0)}MB`;
    console.log(
        `[performance] tier=${r.profile.active} (auto=${r.profile.autoDetected}, source=${r.profile.source}) ` +
            `platform=${r.profile.platform} arch="${r.profile.adapterInfo.architecture}" ` +
            `voxelArena=${MB(r.voxelBudget.quadArenaBytes)} sections=${r.voxelBudget.maxSections} ` +
            `viewRadius=${r.settings.voxelViewChunkRadius}ch`,
    );
    const L = r.profile.limits;
    console.log(
        `[performance] adapter limits: maxBufferSize=${MB(L.maxBufferSize)} ` +
            `maxStorageBufferBindingSize=${MB(L.maxStorageBufferBindingSize)} ` +
            `maxComputeWorkgroupsPerDimension=${L.maxComputeWorkgroupsPerDimension}`,
    );
}

export function setActive(profile: Profile, tier: Tier, source: Source): void {
    profile.active = tier;
    profile.source = source;
    if (source === 'user') {
        try {
            localStorage.setItem(STORAGE_KEY, tier);
        } catch {
            // sandboxed iframe / quota exceeded / storage disabled, drop
        }
    }
}
