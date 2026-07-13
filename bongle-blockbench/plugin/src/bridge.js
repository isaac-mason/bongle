/**
 * Bongle editor bridge — bundled into bongle.js next to the generic plugin.
 *
 * The bongle editor serves this Blockbench build same-origin at
 * /static/blockbench and embeds it as ONE <iframe> (its "blockbench" app).
 * Blockbench keeps its native multi-project tabs + File menu; this bridge syncs
 * those projects with the editor's filesystem, which is the source of truth.
 *
 * Each open project is tagged with the editor-fs path it maps to
 * (`project.bongle_fs_path`). Saving (Ctrl+S / File > Save, both intercepted)
 * compiles the artefacts and hands them to the editor to write; an untitled
 * project asks the editor for a path first. The bridge talks ONLY to its
 * immediate parent (the editor), and is inert when not framed.
 *
 * Protocol (parent = the embedding bongle editor, this = iframe):
 *   iframe -> editor: { type: 'bongle:ready' }
 *   editor -> iframe: { type: 'bongle:hello' }                            re-request ready
 *   editor -> iframe: { type: 'bongle:open', path, bbmodel }             open (or focus) a file
 *   editor -> iframe: { type: 'bongle:save-active' }                     trigger a save of the active project
 *   editor -> iframe: { type: 'bongle:assign-path', uuid, path }         resolve a save-as
 *   iframe -> editor: { type: 'bongle:save', path, glb, bbmodel, name, warnings }
 *   iframe -> editor: { type: 'bongle:save-as', uuid, glb, bbmodel, name, warnings }
 *   iframe -> editor: { type: 'bongle:save-failed', errors }
 *   iframe -> editor: { type: 'bongle:dirty', path, saved }
 *   iframe -> editor: { type: 'bongle:open-failed', path, error }
 */
(() => {
	const IS_EMBEDDED = typeof window !== 'undefined' && window.parent && window.parent !== window;
	if (!IS_EMBEDDED) return;

	const ORIGIN = window.location.origin;
	const post = (msg, transfer) => window.parent.postMessage(msg, ORIGIN, transfer);
	const api = () => (typeof window !== 'undefined' ? window.Bongle : undefined);
	const projects = () => (typeof ModelProject !== 'undefined' ? ModelProject.all : []);

	function projectForPath(path) {
		return projects().find((p) => p.bongle_fs_path === path);
	}
	function projectByUuid(uuid) {
		return projects().find((p) => p.uuid === uuid);
	}

	// compile the ACTIVE project -> { glb, bbmodel, name, warnings } or { errors }.
	// save the ACTIVE project: to its mapped path, or ask the editor for one.
	// The .bbmodel source is the source of truth and ALWAYS saves; the glb is a
	// best-effort derived artefact (an empty/WIP model can't export one, and that
	// must not block saving the source).
	async function saveActive() {
		const project = typeof Project !== 'undefined' ? Project : null;
		if (!project) return;
		const B = api();
		let glb = null;
		let bbmodel;
		let name;
		let warnings = [];
		try {
			const art = await B.compileArtifacts(); // { glb, bbmodel, name, warnings }
			glb = art.glb;
			bbmodel = art.bbmodel;
			name = art.name;
			warnings = art.warnings || [];
		} catch (err) {
			// glb export failed (e.g. no geometry yet) — save the source anyway.
			bbmodel = B.serializeBbmodel();
			name = project.name || 'model';
			warnings = [`glb export skipped: ${String((err && err.message) || err)}`];
		}
		const path = project.bongle_fs_path;
		const transfer = glb ? [glb] : [];
		if (path) {
			post({ type: 'bongle:save', path, glb, bbmodel, name, warnings }, transfer);
			project.saved = true; // optimistic — the editor's OPFS write is reliable
		} else {
			// untitled: the editor picks a path, then replies bongle:assign-path.
			post({ type: 'bongle:save-as', uuid: project.uuid, glb, bbmodel, name, warnings }, transfer);
		}
	}

	function openFile(path, bbmodel) {
		const existing = projectForPath(path);
		if (existing) {
			existing.select();
			return;
		}
		const name = path.split('/').pop();
		api().loadBbmodel(bbmodel, name); // creates + selects a new project (tab)
		if (typeof Project !== 'undefined' && Project) {
			Project.bongle_fs_path = path;
			Project.name = name;
			Project.saved = true;
		}
	}

	function handle(event) {
		if (event.source !== window.parent || event.origin !== ORIGIN) return;
		const data = event.data;
		if (!data || typeof data !== 'object') return;
		if (data.type === 'bongle:hello') {
			announceWhenReady();
			return;
		}
		const B = api();
		if (!B || !B.ready) return; // pre-ready commands are a race we ignore
		switch (data.type) {
			case 'bongle:open':
				try {
					openFile(data.path, data.bbmodel);
				} catch (err) {
					post({ type: 'bongle:open-failed', path: data.path, error: String((err && err.message) || err) });
				}
				return;
			case 'bongle:save-active':
				void saveActive();
				return;
			case 'bongle:assign-path': {
				const p = projectByUuid(data.uuid);
				if (p) {
					p.bongle_fs_path = data.path;
					p.name = data.path.split('/').pop();
					p.saved = true;
				}
				return;
			}
		}
	}

	// ── save interception + dirty tracking ──────────────────────────────────
	let wired = false;
	function wire() {
		if (wired) return;
		// Ctrl+S (export_over) and File > Save (save_project) both route to us.
		if (typeof BarItems !== 'undefined') {
			for (const id of ['export_over', 'save_project']) {
				if (BarItems[id]) BarItems[id].click = () => void saveActive();
			}
			// The standalone "Export Bongle glTF" file-download is confusing in the
			// embed (saving goes through the editor) — the generic plugin adds it.
			if (BarItems.bongle_export_gltf && BarItems.bongle_export_gltf.delete) BarItems.bongle_export_gltf.delete();
		}
		if (typeof Blockbench !== 'undefined' && Blockbench.on) {
			Blockbench.on('saved_state_changed', ({ project, saved }) => {
				if (project && project.bongle_fs_path) post({ type: 'bongle:dirty', path: project.bongle_fs_path, saved });
			});
		}
		wired = true;
	}

	function announceWhenReady() {
		const B = api();
		if (B && B.ready) {
			wire();
			post({ type: 'bongle:ready' });
			return;
		}
		setTimeout(announceWhenReady, 60); // window.Bongle not live yet — poll briefly
	}

	window.addEventListener('message', handle);
	if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', announceWhenReady);
	else announceWhenReady();
})();
