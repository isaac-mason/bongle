/**
 * Bongle Blockbench plugin
 *
 * Turns a stock Blockbench build into the Bongle authoring tool:
 *
 *  1. Two Bongle formats in the New screen: "Bongle Character" (rigged) and
 *     "Bongle Model" (static).
 *  2. Live, format-scoped rig validation against the engine's canonical 6-bone
 *     contract (shown in Blockbench's validator panel).
 *  3. A one-click "Export Bongle glTF" that exports an engine-ready .glb (fixed
 *     options, no dialog) with a tidy scene name written into the glb.
 *  4. Additive Bongle branding (never removes Blockbench's own).
 *
 * Bundled to bongle.js (esbuild, iife) with the starter model embedded, so the
 * single file works two ways:
 *   - injected into the hosted build by ../../build.sh, and
 *   - loaded into the desktop app via File > Plugins > Load Plugin from URL.
 * It self-registers once the Blockbench bundle (a deferred ES module, in the
 * hosted case) has defined the plugin API.
 *
 * Engine source of truth for the rig contract:
 *   lib/src/core/avatar/rig.ts        (validateRig6Bone, canonical hierarchy)
 *   lib/src/builtins/character.ts     (mountRig, optional sockets)
 *   lib/src/core/models/model-glb.ts  (.glb subset the loader accepts)
 */

// Starter character, inlined at build time (esbuild --loader:.bbmodel=json) so
// the plugin is a single self-contained file.
import starterCharacter from '../../starter/character.bbmodel';

const PLUGIN_ID = 'bongle';

const FORMAT_IDS = {
	character: 'bongle_character',
	model: 'bongle_model',
};

// Canonical 6-bone rig. All of these must exist by exact name. The engine
// matches bones by name and re-parents to its own hierarchy, so the parent
// chain in the authored model is not enforced for these (only presence is).
const REQUIRED_BONES = [
	'waist',
	'body',
	'head',
	'arm_left',
	'arm_right',
	'leg_left',
	'leg_right',
];

// Canonical parent for each required bone (null = at the root). The engine
// re-parents by name, so a wrong parent is a warning (confusing), not an error.
const REQUIRED_PARENT = {
	waist: null,
	body: 'waist',
	head: 'waist',
	arm_left: 'waist',
	arm_right: 'waist',
	leg_left: null,
	leg_right: null,
};

// Optional attachment sockets -> the bone they must be parented under when
// authored. If absent, the engine derives them from the parent bone geometry.
const OPTIONAL_SOCKETS = {
	hand_left: 'arm_left',
	hand_right: 'arm_right',
	back: 'body',
};

// Wrap the top-level bones under a single named root node. Off: the engine
// re-parents canonical bones by name and wants no wrapper.
const WRAP_IN_ROOT = false;

// Fixed glTF export options for Bongle. These replace Blockbench's "Export
// Options" dialog so the export is one click. compile() merges these over the
// codec's saved defaults.
const BONGLE_EXPORT_OPTIONS = {
	encoding: 'binary', // .glb is what the engine loader reads (model-glb.ts)
	embed_textures: true, // single embedded buffer, images in BIN
	armature: false, // rigid bones, no skinning
	animations: true,
	scale: 16, // TODO: confirm the canonical Bongle export scale
};

// ---------------------------------------------------------------------------
// Rig validation
// ---------------------------------------------------------------------------

/** Flat list of every group (bone) in the open project. */
function allBones() {
	return typeof Group !== 'undefined' && Group.all ? Group.all : [];
}

function boneByName(name) {
	return allBones().find((g) => g.name === name) || null;
}

function parentBoneName(node) {
	return node && node.parent && typeof Group !== 'undefined' && node.parent instanceof Group
		? node.parent.name
		: null;
}

/**
 * Validate the current project's rig against the engine contract.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateRig() {
	const errors = [];
	const warnings = [];

	const byName = new Map();
	for (const group of allBones()) {
		const list = byName.get(group.name) || [];
		list.push(group);
		byName.set(group.name, list);
	}

	for (const bone of REQUIRED_BONES) {
		const matches = byName.get(bone) || [];
		const expectedParent = REQUIRED_PARENT[bone] || null;

		if (matches.length === 0) {
			errors.push(
				expectedParent
					? `Missing required bone "${bone}" (must be a child of "${expectedParent}").`
					: `Missing required bone "${bone}" (must be at the root).`,
			);
			continue;
		}
		if (matches.length > 1) {
			warnings.push(
				`There are ${matches.length} bones named "${bone}". Bone names must be unique.`,
			);
		}

		const actualParent = parentBoneName(matches[0]);
		if (expectedParent !== actualParent) {
			warnings.push(
				`Bone "${bone}" should be ${expectedParent ? `a child of "${expectedParent}"` : 'at the root'}, ` +
					`but it is ${actualParent ? `under "${actualParent}"` : 'at the root'}.`,
			);
		}
	}

	for (const [socket, expectedParent] of Object.entries(OPTIONAL_SOCKETS)) {
		const node = boneByName(socket);
		if (!node) continue; // optional
		const actualParent = parentBoneName(node);
		if (actualParent !== expectedParent) {
			warnings.push(
				`Optional socket "${socket}" should be a child of "${expectedParent}", ` +
					`but it is ${actualParent ? `under "${actualParent}"` : 'at the root'}.`,
			);
		}
	}

	return { ok: errors.length === 0, errors, warnings };
}

/** The required character hierarchy, as an indented text tree. */
function requiredHierarchyText() {
	const childrenOf = (parent) => [
		...REQUIRED_BONES.filter((bone) => (REQUIRED_PARENT[bone] || null) === parent).map((name) => ({
			name,
			optional: false,
		})),
		...Object.keys(OPTIONAL_SOCKETS)
			.filter((socket) => OPTIONAL_SOCKETS[socket] === parent)
			.map((name) => ({ name, optional: true })),
	];
	const lines = [];
	const walk = (parent, depth) => {
		for (const node of childrenOf(parent)) {
			lines.push('  '.repeat(depth) + node.name + (node.optional ? '  (optional)' : ''));
			walk(node.name, depth + 1);
		}
	};
	walk(null, 0);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// glTF post-processing
// ---------------------------------------------------------------------------

/**
 * Mutate a parsed glTF JSON document in place before it is written.
 * Kept minimal on purpose: the engine matches bones by name and re-parents,
 * so most "format" concerns are just naming + metadata. Applied to both the
 * ASCII (.gltf) and binary (.glb) export paths via the helpers below.
 */
function postProcessGltf(gltf, sceneName) {
	gltf.asset = gltf.asset || {};
	gltf.asset.extras = Object.assign({}, gltf.asset.extras, {
		bongle: { plugin: PLUGIN_ID, scene: sceneName },
	});

	// Replace Blockbench's hardcoded "blockbench_export" scene name (the node
	// viewers and the engine treat as the root) with a tidy Bongle name.
	const sceneIndex = typeof gltf.scene === 'number' ? gltf.scene : 0;
	const scene = gltf.scenes && gltf.scenes[sceneIndex];
	if (scene) {
		scene.name = sceneName;

		// Optional: collapse the multiple top-level bones under one named root
		// node. The engine matches bones by name and needs no avatar-root
		// wrapper, so this is purely cosmetic. Off by default.
		if (WRAP_IN_ROOT && Array.isArray(scene.nodes) && scene.nodes.length > 1) {
			gltf.nodes = gltf.nodes || [];
			const rootIndex =
				gltf.nodes.push({ name: sceneName, children: scene.nodes.slice() }) - 1;
			scene.nodes = [rootIndex];
		}
	}

	// TODO: facing (-Z) / feet-at-y=0 normalisation, if the engine ever needs it.
	return gltf;
}

function postProcessGltfString(str, sceneName) {
	try {
		const gltf = JSON.parse(str);
		postProcessGltf(gltf, sceneName);
		return JSON.stringify(gltf);
	} catch (err) {
		console.warn('[bongle] could not post-process glTF JSON', err);
		return str;
	}
}

// glb (glTF 2.0 binary) container constants.
const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"

/** Pad a byte array up to a 4-byte boundary with `padValue`. */
function padTo4(bytes, padValue) {
	const remainder = bytes.length % 4;
	if (remainder === 0) return bytes;
	const out = new Uint8Array(bytes.length + (4 - remainder));
	out.set(bytes, 0);
	out.fill(padValue, bytes.length);
	return out;
}

/**
 * Rewrite only the JSON chunk of a .glb produced by the codec. The BIN chunk
 * (geometry/animation/textures) is copied through byte-for-byte, so this is a
 * cheap, lossless container edit, not a re-export.
 */
function postProcessGlb(buffer, sceneName) {
	// THREE's GLTFExporter hands back an ArrayBuffer for binary, but coerce a
	// typed-array view defensively. Anything else (e.g. an empty export that
	// yields no binary) can't be post-processed — let the DataView throw so the
	// caller can fall back (still saving the .bbmodel source).
	if (ArrayBuffer.isView(buffer)) {
		buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}
	const view = new DataView(buffer);
	if (view.getUint32(0, true) !== GLB_MAGIC) {
		console.warn('[bongle] export is not a .glb, skipping post-process');
		return buffer;
	}
	const version = view.getUint32(4, true);
	const totalLength = view.getUint32(8, true);

	let offset = 12;
	let jsonBytes = null;
	const trailingChunks = []; // BIN and any others, preserved verbatim
	while (offset + 8 <= totalLength) {
		const chunkLength = view.getUint32(offset, true);
		const chunkType = view.getUint32(offset + 4, true);
		const dataStart = offset + 8;
		const bytes = new Uint8Array(buffer, dataStart, chunkLength);
		if (chunkType === GLB_CHUNK_JSON && !jsonBytes) {
			jsonBytes = bytes;
		} else {
			trailingChunks.push({ type: chunkType, bytes });
		}
		offset = dataStart + chunkLength;
	}
	if (!jsonBytes) {
		console.warn('[bongle] .glb has no JSON chunk, skipping post-process');
		return buffer;
	}

	const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
	postProcessGltf(gltf, sceneName);
	const newJson = padTo4(new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
	const trailing = trailingChunks.map((c) => ({ type: c.type, bytes: padTo4(c.bytes, 0x00) }));

	let size = 12 + 8 + newJson.length;
	for (const c of trailing) size += 8 + c.bytes.length;

	const out = new ArrayBuffer(size);
	const outView = new DataView(out);
	const outBytes = new Uint8Array(out);
	outView.setUint32(0, GLB_MAGIC, true);
	outView.setUint32(4, version, true);
	outView.setUint32(8, size, true);

	let o = 12;
	outView.setUint32(o, newJson.length, true);
	outView.setUint32(o + 4, GLB_CHUNK_JSON, true);
	outBytes.set(newJson, o + 8);
	o += 8 + newJson.length;
	for (const c of trailing) {
		outView.setUint32(o, c.bytes.length, true);
		outView.setUint32(o + 4, c.type, true);
		outBytes.set(c.bytes, o + 8);
		o += 8 + c.bytes.length;
	}
	return out;
}

/** Scene name written into the export, by active format. */
function sceneNameForActiveFormat() {
	return typeof Format !== 'undefined' && Format && Format.id === FORMAT_IDS.model
		? 'model'
		: 'character';
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportBongleGltf() {
	const result = validateRig();
	if (!result.ok) {
		Blockbench.showMessageBox({
			title: 'Bongle rig validation failed',
			message:
				result.errors.map((e) => `- ${e}`).join('\n') +
				'\n\nA Bongle Character needs this bone hierarchy:\n\n```\n' +
				requiredHierarchyText() +
				'\n```',
		});
		return;
	}
	if (result.warnings.length) {
		Blockbench.showQuickMessage(result.warnings.join('  |  '), 4000);
	}

	// Mirror Codecs.gltf.export() but skip promptExportOptions(); compile()
	// merges BONGLE_EXPORT_OPTIONS over the codec defaults, then we post-process
	// the result and save.
	const codec = Codecs.gltf;
	const sceneName = sceneNameForActiveFormat();
	const isBinary = BONGLE_EXPORT_OPTIONS.encoding === 'binary';
	let content = await codec.compile(BONGLE_EXPORT_OPTIONS);
	content = isBinary
		? postProcessGlb(content, sceneName)
		: postProcessGltfString(content, sceneName);

	Blockbench.export(
		{
			resource_id: 'gltf',
			type: codec.name,
			extensions: [isBinary ? 'glb' : 'gltf'],
			name: codec.fileName(),
			startpath: codec.startPath(),
			content,
			custom_writer:
				typeof isApp !== 'undefined' && isApp ? (a, b) => codec.write(a, b) : null,
		},
		(path) => codec.afterDownload && codec.afterDownload(path),
	);
}

function isBongleFormat() {
	return (
		typeof Format !== 'undefined' &&
		Format &&
		(Format.id === FORMAT_IDS.character || Format.id === FORMAT_IDS.model)
	);
}

function isCharacterFormat() {
	return typeof Format !== 'undefined' && Format && Format.id === FORMAT_IDS.character;
}

// ---------------------------------------------------------------------------
// Bongle API surface (window.Bongle)
//
// Generic authoring capabilities for embedders. The bongle.io platform build
// wraps these in a postMessage bridge; this plugin stays platform-agnostic —
// it knows how to load a .bbmodel and how to compile the engine artefacts, and
// nothing about how they're transported.
// ---------------------------------------------------------------------------

/** Load a .bbmodel (string or object) into a fresh project. Respects the
 *  authored Bongle format; defaults to character when the payload carries no
 *  (or a non-Bongle) model_format. Generalises loadStarterCharacter. */
function loadBbmodelIntoProject(bbmodel, name) {
	const data = typeof bbmodel === 'string' ? JSON.parse(bbmodel) : JSON.parse(JSON.stringify(bbmodel));
	data.meta = data.meta || {};
	if (data.meta.model_format !== FORMAT_IDS.character && data.meta.model_format !== FORMAT_IDS.model) {
		data.meta.model_format = FORMAT_IDS.character;
	}
	Codecs.project.load(data, { path: '', name: name || 'character', no_file: true });
	if (typeof Project !== 'undefined' && Project && name) Project.name = name;
}

/** Compile both artefacts an embedder uploads: the engine-ready .glb (same
 *  fixed options + post-process as the menu export) and the .bbmodel source.
 *  Returns the current rig warnings (characters only) and a display name. */
async function compileBongleArtifacts() {
	const sceneName = sceneNameForActiveFormat();
	const glb = postProcessGlb(await Codecs.gltf.compile(BONGLE_EXPORT_OPTIONS), sceneName);
	let bbmodel = Codecs.project.compile();
	if (typeof bbmodel !== 'string') bbmodel = JSON.stringify(bbmodel);
	const warnings = isCharacterFormat() ? validateRig().warnings : [];
	const name = (typeof Project !== 'undefined' && Project && Project.name) || sceneName;
	return { glb, bbmodel, name, warnings };
}

/** The current project serialized as a .bbmodel string — the cheap path for
 *  embedder autosave (no glb compile). */
function serializeProjectBbmodel() {
	const s = Codecs.project.compile();
	return typeof s === 'string' ? s : JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Starter model
// ---------------------------------------------------------------------------

function loadStarterCharacter() {
	const data = JSON.parse(JSON.stringify(starterCharacter));
	data.meta = data.meta || {};
	// Load it as a Bongle Character regardless of how the starter was authored.
	data.meta.model_format = FORMAT_IDS.character;
	Codecs.project.load(data, { path: '', name: 'character', no_file: true });
	if (typeof Project !== 'undefined' && Project && !Project.name) Project.name = 'character';
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

let bongleFormats = [];

function registerFormats() {
	const character = new ModelFormat(FORMAT_IDS.character, {
		name: 'Bongle Character',
		description: 'Rigged Bongle character with the canonical 6-bone rig.',
		icon: 'person',
		category: 'bongle',
		target: ['Bongle'],
		// Rigged + animated. forward_direction defaults to '-z', which matches
		// Bongle's facing, so it is left at the default.
		bone_rig: true,
		meshes: true,
		rotate_cubes: true,
		optional_box_uv: true,
		centered_grid: true,
		animation_mode: true,
		pbr: false,
	});

	// New > Bongle Character starts from the canonical rig instead of empty.
	character.new = function () {
		if (starterCharacter) {
			loadStarterCharacter();
			return true;
		}
		return ModelFormat.prototype.new.call(this);
	};

	const model = new ModelFormat(FORMAT_IDS.model, {
		name: 'Bongle Model',
		description: "Static Bongle model (props, creatures, anything that isn't a character).",
		icon: 'view_in_ar',
		category: 'bongle',
		target: ['Bongle'],
		bone_rig: true,
		meshes: true,
		rotate_cubes: true,
		optional_box_uv: true,
		centered_grid: true,
		animation_mode: false,
	});

	// Label the custom category and float the Bongle formats to the top of the
	// New screen (the start screen iterates Formats in insertion order).
	if (typeof Language !== 'undefined' && Language.data) {
		Language.data['format_category.bongle'] = 'Bongle';
	}
	bongleFormats = [character, model];
	raiseBongleFormatsToTop();
}

// Reorder the global Formats registry so the Bongle formats come first. The
// New screen groups by category in registry insertion order, so this puts the
// "Bongle" category at the top. Values are untouched; only key order changes.
function raiseBongleFormatsToTop() {
	const ids = Object.keys(Formats);
	const bongleIds = ids.filter((id) => id === FORMAT_IDS.character || id === FORMAT_IDS.model);
	if (bongleIds.length === 0) return;
	const ordered = bongleIds.concat(ids.filter((id) => !bongleIds.includes(id)));
	const snapshot = {};
	for (const id of ordered) snapshot[id] = Formats[id];
	for (const id of ids) delete Formats[id];
	for (const id of ordered) Formats[id] = snapshot[id];
}

function unregisterFormats() {
	bongleFormats.forEach((format) => format.delete && format.delete());
	bongleFormats = [];
}

// ---------------------------------------------------------------------------
// Live rig validation (Blockbench validator panel)
// ---------------------------------------------------------------------------

let rigValidatorCheck = null;

function registerValidator() {
	rigValidatorCheck = new ValidatorCheck('bongle_rig', {
		// Only the character format requires the rig.
		condition: () => typeof Format !== 'undefined' && Format && Format.id === FORMAT_IDS.character,
		update_triggers: ['update_selection', 'finish_edit', 'add_group', 'update_group'],
		run() {
			const result = validateRig();
			result.errors.forEach((message) => this.fail({ message }));
			result.warnings.forEach((message) => this.warn({ message }));
			if (!result.ok || result.warnings.length) {
				this.warn({
					message:
						'A Bongle Character needs this bone hierarchy (bones are matched by name):\n\n```\n' +
						requiredHierarchyText() +
						'\n```',
				});
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Branding (additive: never removes Blockbench's own branding)
// ---------------------------------------------------------------------------

const BADGE_ID = 'bongle_badge';
let startScreenSection = null;

// GitHub mark (octicon), inlined so the start-screen buttons can show it.
const GITHUB_SVG =
	'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>';

function openExternal(url) {
	if (typeof Blockbench !== 'undefined' && typeof Blockbench.openLink === 'function') {
		Blockbench.openLink(url);
	} else {
		window.open(url, '_blank', 'noopener');
	}
}

function addHeaderBadge() {
	if (document.getElementById(BADGE_ID)) return;
	const badge = document.createElement('div');
	badge.id = BADGE_ID;
	badge.textContent = 'Bongle';
	badge.title = 'Bongle build of Blockbench';
	// Sit next to the Blockbench wordmark so it reads "Blockbench · Bongle".
	const logo = document.getElementById('corner_logo');
	if (logo && logo.parentNode) {
		logo.parentNode.insertBefore(badge, logo.nextSibling);
	} else {
		const header = document.querySelector('header');
		if (header) header.appendChild(badge);
	}
}

function installBranding() {
	addHeaderBadge();

	if (typeof addStartScreenSection === 'function') {
		startScreenSection = addStartScreenSection('bongle', {
			color: 'var(--color-accent)',
			text_color: '#ffffff',
			text: [
				{ type: 'h2', text: 'Make a bongle avatar or model' },
				{
					type: 'p',
					text: 'Blockbench with the bongle plugin built in, for making avatars and models for bongle games. Click **New**, pick **Bongle Character** (or **Bongle Model**), build it, then export with **File > Export > Export Bongle glTF** and upload the file on bongle.io to wear it in-game.',
				},
				{
					type: 'button',
					text: 'Start here',
					click: () => openExternal('https://github.com/isaac-mason/bongle-blockbench#readme'),
				},
				{
					type: 'button',
					text: 'What is bongle?',
					click: () => openExternal('https://bongle.io'),
				},
				{ type: 'button', text: 'bongle on GitHub', click: () => openExternal('https://github.com/isaac-mason/bongle') },
			],
		});
		decorateBongleButtons();
	}

	// Initial tab title. Blockbench overwrites this once a project is open.
	try {
		document.title = 'Bongle · Blockbench';
	} catch (e) {
		/* ignore */
	}
}

// Prepend a GitHub icon to each link button in the Bongle start-screen card.
function decorateBongleButtons() {
	const section = document.querySelector(
		'#start_screen .start_screen_section[section_id="bongle"]',
	);
	if (!section) return;
	section.querySelectorAll('button').forEach((button) => {
		if (button.querySelector('.bongle-gh-icon')) return;
		const icon = document.createElement('span');
		icon.className = 'bongle-gh-icon';
		icon.innerHTML = GITHUB_SVG;
		button.insertBefore(icon, button.firstChild);
	});
}

function removeBranding() {
	const badge = document.getElementById(BADGE_ID);
	if (badge) badge.remove();
	if (startScreenSection && startScreenSection.delete) startScreenSection.delete();
	startScreenSection = null;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

let exportAction = null;

function registerBonglePlugin() {
	const options = {
		title: 'Bongle',
		author: 'Bongle',
		description: 'Bongle character/model formats, rig validation, and glTF export.',
		icon: 'person',
		version: '0.1.0',
		variant: 'both',
		tags: ['Bongle'],
		onload() {
			registerFormats();
			registerValidator();

			exportAction = new Action('bongle_export_gltf', {
				name: 'Export Bongle glTF',
				description: 'Validate the rig and export an engine-ready Bongle .glb.',
				icon: 'download',
				category: 'file',
				condition: () => isBongleFormat(),
				click() {
					exportBongleGltf();
				},
			});
			MenuBar.addAction(exportAction, 'file.export.0');

			installBranding();
			// Signal the API is live so embedders can drive load/new/serialize.
			if (typeof window !== 'undefined' && window.Bongle) window.Bongle.ready = true;
		},
		onunload() {
			if (exportAction) exportAction.delete();
			if (rigValidatorCheck && rigValidatorCheck.delete) rigValidatorCheck.delete();
			unregisterFormats();
			removeBranding();
		},
	};

	// Blockbench's loader seeds Plugins.registered[id] before evaluating a plugin
	// file, so Plugin.register(id) can adopt that entry. We are injected directly
	// (not through the loader), so seed it ourselves the same way loadFromFile
	// does, then register. Without this, register() falls through to the
	// "failed to load plugin" path. source 'store' keeps it out of the local/url
	// install persistence paths (no StateMemory entry, survives reloads cleanly).
	if (!Plugins.registered[PLUGIN_ID]) {
		const plugin = new Plugin(PLUGIN_ID);
		plugin.source = 'store';
		plugin.installed = true;
		Plugins.registered[PLUGIN_ID] = plugin;
	}
	Plugin.register(PLUGIN_ID, options);
}

// The Blockbench bundle is a deferred ES module, so the plugin API may not be
// defined yet when this classic script runs. Wait for it, then self-register.
function pluginApiReady() {
	return (
		typeof Plugin !== 'undefined' &&
		Plugin.register &&
		typeof Plugins !== 'undefined' &&
		Plugins.registered &&
		typeof ModelFormat !== 'undefined' &&
		typeof ValidatorCheck !== 'undefined'
	);
}

function whenBlockbenchReady(cb) {
	if (pluginApiReady()) return cb();
	let tries = 0;
	const timer = setInterval(() => {
		if (pluginApiReady()) {
			clearInterval(timer);
			cb();
		} else if (++tries > 600) {
			clearInterval(timer); // ~30s; give up rather than spin forever
			console.error('[bongle] Blockbench plugin API never became available');
		}
	}, 50);
}

whenBlockbenchReady(registerBonglePlugin);

// Public API surface for embedders (the bongle.io platform build wraps these
// in a postMessage bridge) — also handy from the devtools console.
if (typeof window !== 'undefined') {
	window.Bongle = {
		// Flipped true in the plugin's onload, once the Blockbench API (Codecs,
		// formats) is live — embedders should wait for this before driving.
		ready: false,
		validateRig,
		compileArtifacts: compileBongleArtifacts,
		serializeBbmodel: serializeProjectBbmodel,
		loadBbmodel: loadBbmodelIntoProject,
		newCharacter: loadStarterCharacter,
		isCharacterFormat,
		isBongleFormat,
		FORMAT_IDS,
		REQUIRED_BONES,
		OPTIONAL_SOCKETS,
	};
}
