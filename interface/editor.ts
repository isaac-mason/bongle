// interface/editor.ts — the editor⇄platform boundary contract. A peer of
// client.ts / server.ts (the engine⇄host boundary): the postMessage protocol
// between the editor (mounted in an iframe) and its embedding platform (the
// parent window). The editor is a purpose-agnostic shell — the platform declares
// what it's FOR via an `intent`, and the editor hands finished payloads back for
// the platform to persist/upload. The platform owns auth + storage; the editor
// never holds a token.
//
// STABILITY CONTRACT (this is what lets one latest-wins platform drive many
// pinned editor bundle versions — see plan-in-browser-editor):
//   1. Evolve ADDITIVELY. Add new intent `kind`s / message `type`s / OPTIONAL
//      fields; never remove or repurpose. Major bumps only for genuine breaks,
//      and then the platform carries both majors through a transition window.
//   2. Payloads stay OPAQUE to the platform. Every payload is `Uint8Array` — the
//      platform stores/forwards bytes tagged with a version, it never parses a
//      save/build's internals. The churny stuff (engine api, scene format,
//      bundler, pipeline) lives BELOW this line, inside the versioned artifact.
//   3. No editor internals leak across the boundary (no engine version, scene
//      format, bundler flags). Keep the verbs coarse + capability-shaped.

/** Semver of THIS editor⇄platform contract (distinct from the engine⇄game
 *  INTERFACE_VERSION — they evolve independently). The editor announces its
 *  value in `bongle:ready`; the platform announces its own in `bongle:init`, so
 *  either side can warn / degrade when the peer's major differs. */
export const EDITOR_INTERFACE_VERSION = '1.2.0';

/** whether two EDITOR_INTERFACE_VERSION values can bridge. The contract has
 *  stabilised to same-major-compatible per rule #1: minor/patch changes are
 *  additive (new intent kinds, new message types, optional fields), so a peer on
 *  the same major can always be driven — a newer minor just carries fields an
 *  older peer ignores. Only a major bump signals a genuine break. A missing
 *  version, or a version we can't parse a major out of, is treated as compatible
 *  (best effort — a bundle predating the handshake, don't warn). */
export function editorInterfaceCompatible(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return true;
    const majorA = major(a);
    const majorB = major(b);
    if (majorA === undefined || majorB === undefined) return true;
    return majorA === majorB;
}

/** parse the major component of a semver ("1.2.3" → 1). Returns undefined for a
 *  malformed value so the caller can fall back to best-effort compatible. */
function major(version: string): number | undefined {
    const n = Number.parseInt(version.split('.', 1)[0] ?? '', 10);
    return Number.isNaN(n) ? undefined : n;
}

/** what the platform mounted the editor to do. */
export type PlatformIntent =
    | {
          kind: 'project';
          /** the project-save source zip to open into OPFS (absent = new/empty project). */
          save?: Uint8Array;
          /** a project file to open in the code editor on boot. */
          openPath?: string;
          /** our account avatar's glb URL, so we play/edit the project as ourselves
           *  (the local player wears it). Absent → a random sample avatar. */
          avatarUrl?: string;
          /** the project_version id `save` was taken from — echoed back on
           *  autosave/save so the platform knows which slot a draft descends from.
           *  An OPAQUE round-trip token: the editor never interprets version
           *  semantics (rule #3), it just carries it back out. Absent = new/anonymous. */
          baseVersion?: string;
          /** the draft rev `save` represents, so the editor resumes its monotonic
           *  counter above it (restore continuity across the local ring + server).
           *  OPAQUE like baseVersion — a round-trip token, not interpreted. Absent = fresh. */
          rev?: number;
      }
    | {
          kind: 'avatar';
          /** the .bbmodel source (JSON text) to edit in Blockbench (absent = new). */
          bbmodel?: string;
          /** display name / id for the avatar being edited. */
          name?: string;
          /** the user may edit this existing avatar (save a new version of it): the
           *  platform resolved `?edit=<slug>` AND confirmed the user is on its team
           *  (the editor can't check team membership — it's platform auth). When
           *  set, Save prompts for a version name prefilled "new version of <name>".
           *  Absent for a brand-new avatar or a non-member. */
          canEdit?: boolean;
      }
    | {
          /** join someone else's live edit session as a guest. The platform
           *  resolved the invite (/api/edit/join) and hands over the relay ws
           *  url (token baked in); the editor connects to it as a remote client. */
          kind: 'joinEdit';
          url: string;
      };

/** editor → platform. */
export type EditorMessage =
    /** editor booted + listening. `version` is EDITOR_INTERFACE_VERSION of the
     *  editor bundle (optional until every live bundle announces it). */
    | { type: 'bongle:ready'; version?: string }
    /** mint a manual version: hand back the source zip for the platform to persist
     *  as an immutable snapshot (origin='manual'). Deliberate, enters history. */
    | { type: 'bongle:version'; payload: Uint8Array }
    /** high-frequency working snapshot for the platform to persist as a DRAFT
     *  (autosave snapshot: local ring always; server if owned + dirty). Distinct
     *  from bongle:version so the platform keeps it quiet — no version minted, no
     *  toast. `baseVersion`/`rev` are the opaque tokens from bongle:init, `rev`
     *  incremented per edit. */
    | { type: 'bongle:draft'; payload: Uint8Array; baseVersion: string | null; rev: number }
    /** hand back the built project-build bundle.zip for the platform to upload.
     *  `source` is the project source zip (same as bongle:version) so the platform
     *  can snapshot it as a project_version + record the build's provenance. */
    | { type: 'bongle:build'; payload: Uint8Array; source?: Uint8Array }
    /** hand back the exported avatar (compiled .glb + .bbmodel source) for the
     *  platform to upload (editor-initiated from the "editing X" window). */
    | { type: 'bongle:avatar-export'; glb: Uint8Array; bbmodel: string; name: string }
    /** the host asks the platform to open this session to multiplayer. The
     *  platform calls /api/edit/host (it owns the session) and replies with a
     *  multiplayer-opened. `region` is the host's picked region. */
    | { type: 'bongle:open-multiplayer'; region?: string }
    /** the user asked to leave the editor. The editor never navigates itself
     *  (it may be a cross-origin iframe); the platform routes back to bongle.io. */
    | { type: 'bongle:exit' };

/** platform → editor. */
export type PlatformMessage =
    /** configure the editor for its purpose. `version` is the platform's
     *  EDITOR_INTERFACE_VERSION (optional until wired). */
    | { type: 'bongle:init'; version?: string; intent: PlatformIntent }
    /** a cheap "hold on" ack, sent the moment the platform sees `bongle:ready` and
     *  BEFORE it has resolved the intent — resolving it can need a network fetch (an
     *  avatar remix downloads its .bbmodel source first), which may outlast the
     *  editor's standalone-fallback timeout. It tells the editor a real platform IS
     *  answering, so the editor stops that timer and waits for the (possibly slow)
     *  `bongle:init` rather than booting standalone. Optional: an editor bundle that
     *  predates it just ignores it and keeps the timeout. */
    | { type: 'bongle:init-pending' }
    /** outcome of the editor's last hand-back (version/build/avatar-export). A save
     *  (`of: 'version'`) AND a build (`of: 'build'`) both mint a manual version and
     *  carry its `versionId`/`rev`, so the editor rebases its draft to
     *  `draft@versionId` with a fresh `rev` baseline. Load-bearing, not cosmetic:
     *  without them the editor keeps autosaving into the stale pre-save slot. */
    | {
          type: 'bongle:result';
          of: 'version' | 'build' | 'avatar-export';
          ok: boolean;
          message?: string;
          versionId?: string;
          rev?: number;
          /** On a successful `of: 'build'`: the minted build's id + an absolute link to
           *  the platform's builds dashboard, so the editor confirms the publish with
           *  ids + a "view builds" link instead of a bare "downloaded". */
          buildId?: string;
          dashboardUrl?: string;
      }
    /** deliver an avatar's source AFTER a `bongle:init { kind:'avatar' }`, so the editor
     *  can boot Blockbench immediately and load the model when it arrives (resolving the
     *  source can need a download — a remixed/edited version). `bbmodel` null = there's
     *  no source, use the editor's bundled starter rig. `name` is the avatar's display
     *  name, used to seed the Save dialog. Sent exactly once per avatar session. */
    | { type: 'bongle:source'; bbmodel: string | null; name?: string }
    /** ask the editor to run its Save-version action now (export the source → hand it
     *  back as `bongle:version`). Lets the platform drive a prominent "save this to
     *  bongle" CTA from outside the iframe (e.g. on an anonymous local-only draft). */
    | { type: 'bongle:request-save' }
    /** answer to open-multiplayer: the relay ws url the host connects to + the
     *  ready-to-share invite link. */
    | { type: 'bongle:multiplayer-opened'; url: string; shareUrl: string }
    | { type: 'bongle:multiplayer-failed'; message: string };

/** the result payload the editor surfaces to the user. Mirrors bongle:result:
 *  `versionId`/`rev` populated on a successful `of: 'version'` OR `of: 'build'` so the
 *  editor rebases its draft to `draft@versionId` with a fresh `rev` baseline. */
export type PlatformResult = {
    of: 'version' | 'build' | 'avatar-export';
    ok: boolean;
    message?: string;
    versionId?: string;
    rev?: number;
    /** Successful `of: 'build'`: minted build id + builds-dashboard link (see above). */
    buildId?: string;
    dashboardUrl?: string;
};
