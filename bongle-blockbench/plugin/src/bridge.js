/**
 * Bongle editor bridge — bundled into bongle.js next to the generic plugin.
 *
 * The bongle editor serves this Blockbench build same-origin at
 * /static/blockbench and embeds it as an <iframe> (its "blockbench" app). This
 * bridge wraps the generic plugin's `window.Bongle` API in a postMessage bridge
 * so the editor (this iframe's parent) can seed/open a project and pull authored
 * artefacts (glb + bbmodel) back out. Blockbench only computes bytes; the editor
 * owns the fs and, further out, the host owns session + upload.
 *
 * The bridge talks ONLY to its immediate parent (the editor). It is inert when
 * not framed, so the same bundle is still a standalone authoring tool.
 *
 * Protocol (parent = the embedding bongle editor, this = iframe):
 *   iframe → shell: { type: 'bongle:ready' }                        editor API live
 *   shell  → iframe: { type: 'bongle:hello' }                       re-request ready
 *   shell  → iframe: { type: 'bongle:load', bbmodel, name?, origin } open a seed
 *   shell  → iframe: { type: 'bongle:new', origin }                 fresh default character
 *   shell  → iframe: { type: 'bongle:save-request' }                ask for artefacts
 *   shell  → iframe: { type: 'bongle:clear-draft' }                 drop the autosave
 *   iframe → shell: { type: 'bongle:saved', glb, bbmodel, name, warnings }
 *   iframe → shell: { type: 'bongle:save-failed', errors }
 *   iframe → shell: { type: 'bongle:load-failed', error }
 *
 * Local persistence: the working project is autosaved to localStorage on every
 * edit (debounced), tagged with its "origin" (the seed slug, or 'scratch'). On
 * open, a matching-origin draft is restored — so a refresh keeps your work —
 * otherwise the seed / a new default character is opened. The draft is cleared
 * after a successful save-to-bongle.
 */
(() => {
	const IS_EMBEDDED = typeof window !== 'undefined' && window.parent && window.parent !== window;
	if (!IS_EMBEDDED) return;

	// Served same-origin from bongle.io, so the shell and this iframe share an
	// origin; scope every message to it in both directions.
	const ORIGIN = window.location.origin;
	const DRAFT_KEY = 'bongle:editor-draft';

	// The origin (seed slug or 'scratch') of the currently-open project, set when
	// we open one. Autosaves are tagged with it so a refresh restores the
	// matching draft rather than a stale one from a different avatar.
	let currentOrigin = null;

	function bongle() {
		return typeof window !== 'undefined' ? window.Bongle : undefined;
	}

	function post(msg, transfer) {
		window.parent.postMessage(msg, ORIGIN, transfer);
	}

	// ── draft persistence ──────────────────────────────────────────────────
	function readDraft() {
		try {
			return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
		} catch {
			return null;
		}
	}
	function writeDraft(bbmodel) {
		if (!currentOrigin || !bbmodel) return;
		try {
			localStorage.setItem(DRAFT_KEY, JSON.stringify({ origin: currentOrigin, bbmodel, ts: Date.now() }));
		} catch {
			/* quota / private mode — best effort */
		}
	}
	function clearDraft() {
		try {
			localStorage.removeItem(DRAFT_KEY);
		} catch {
			/* ignore */
		}
	}

	let saveTimer = null;
	function scheduleAutosave() {
		const B = bongle();
		if (!B) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try {
				writeDraft(B.serializeBbmodel());
			} catch {
				/* ignore transient serialize errors mid-edit */
			}
		}, 1200);
	}

	// ── open logic (matching draft > seed > new default) ────────────────────
	function openProject(origin, seedBbmodel, name) {
		const B = bongle();
		if (!B) return;
		currentOrigin = origin;
		const draft = readDraft();
		if (draft && draft.origin === origin && draft.bbmodel) {
			// Restore in-progress work for this origin (the refresh case).
			B.loadBbmodel(draft.bbmodel, name);
			return;
		}
		// Fresh open — drop any stale draft (a different avatar) and start clean.
		clearDraft();
		if (seedBbmodel) B.loadBbmodel(seedBbmodel, name);
		else B.newCharacter();
	}

	// ── message handling ────────────────────────────────────────────────────
	async function handle(event) {
		if (event.source !== window.parent || event.origin !== ORIGIN) return;
		const data = event.data;
		if (!data || typeof data !== 'object') return;

		if (data.type === 'bongle:hello') {
			announceWhenReady();
			return;
		}

		const B = bongle();
		// The shell only sends the commands below after 'bongle:ready', so a
		// not-ready state here is a race we simply ignore.
		if (!B || !B.ready) return;

		switch (data.type) {
			case 'bongle:load':
				try {
					openProject(data.origin || 'scratch', data.bbmodel, data.name);
				} catch (err) {
					post({ type: 'bongle:load-failed', error: String((err && err.message) || err) });
				}
				return;
			case 'bongle:new':
				try {
					openProject(data.origin || 'scratch', null, data.name);
				} catch (err) {
					post({ type: 'bongle:load-failed', error: String((err && err.message) || err) });
				}
				return;
			case 'bongle:clear-draft':
				clearDraft();
				return;
			case 'bongle:save-request': {
				// Characters must pass the rig gate before we hand bytes back;
				// models carry no canonical rig, so they're a straight compile.
				if (B.isCharacterFormat()) {
					const result = B.validateRig();
					if (!result.ok) {
						post({ type: 'bongle:save-failed', errors: result.errors });
						return;
					}
				}
				try {
					const { glb, bbmodel, name, warnings } = await B.compileArtifacts();
					post({ type: 'bongle:saved', glb, bbmodel, name, warnings }, [glb]);
				} catch (err) {
					post({ type: 'bongle:save-failed', errors: [String((err && err.message) || err)] });
				}
				return;
			}
		}
	}

	// ── readiness + wiring ──────────────────────────────────────────────────
	let wiredOnReady = false;
	function announceWhenReady() {
		const B = bongle();
		if (B && B.ready) {
			if (!wiredOnReady) {
				if (typeof Blockbench !== 'undefined' && Blockbench.on) {
					Blockbench.on('finish_edit', scheduleAutosave);
				}
				// Hide the standalone "Export Bongle glTF" (a file download). In
				// the embed, saving goes through the host, so a second export path
				// is just confusing — the generic plugin registers it under this id.
				if (typeof BarItems !== 'undefined' && BarItems.bongle_export_gltf && BarItems.bongle_export_gltf.delete) {
					BarItems.bongle_export_gltf.delete();
				}
				wiredOnReady = true;
			}
			post({ type: 'bongle:ready' });
			return;
		}
		// window.Bongle not live yet — poll briefly.
		setTimeout(announceWhenReady, 60);
	}

	window.addEventListener('message', (event) => {
		handle(event);
	});

	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', announceWhenReady);
	} else {
		announceWhenReady();
	}
})();
