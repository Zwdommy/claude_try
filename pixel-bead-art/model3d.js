// ── model3d.js ────────────────────────────────────────────────────────────────
// Generates per-pixel 3D pieces using manifold-3d for robust CSG.
//
// Rule (per box):
//   right  neighbor → PLUG (union)     on this box's +X face
//   left   neighbor → SLOT (subtract)  on this box's −X face
//   bottom neighbor → PLUG (union)     on this box's +Y face
//   top    neighbor → SLOT (subtract)  on this box's −Y face

import * as THREE from 'three';
import { STLLoader }     from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter }   from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import ManifoldModule    from 'manifold-3d';
import { zipSync, strToU8 } from 'fflate';

// ── Constants ─────────────────────────────────────────────────────────────────
const BOX_HW        = 8.063 / 2;   // 4.0315  half-width  (X)
const BOX_HD        = 8.062 / 2;   // 4.031   half-depth  (Y)
const BOX_H         = 37.625;      // full height (Z) — matches 初始长方体.stl
const WALL_T        = 1.0;         // hollow box wall thickness (mm)
const SLOT_HALF_PEN = 5.134 / 2;   // 2.567   penetration (Y natural, X after 90°Z rot)
const PLUG_HALF_PRO = 4.067 / 2;   // 2.0335  protrusion  (Y natural, X after 90°Z rot)
const EPSILON       = 0.5;         // overlap to avoid coplanar faces
const PRINT_GAP     = 0.3;         // physical gap between adjacent box faces (prevents fusing when printing)
// Plug cross-section geometry (centered coords after loadCenteredGeom):
const PLUG_NECK_HW  = 1.075;  // neck half-width (X)
const PLUG_HEAD_HW  = 2.132;  // head half-width (X, widest point)
const HEAD_THRESH   = (PLUG_NECK_HW + PLUG_HEAD_HW) / 2;  // ≈ 1.60 — boundary between neck & head verts

const ROT_90Z  = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
// For BOTTOM plug: rotate 180° around Z to flip which end (base vs tip) faces the box
const ROT_180Z = new THREE.Matrix4().makeRotationZ(Math.PI);

// ── Shared state ──────────────────────────────────────────────────────────────
let slotGeomTemplate = null;
let plugGeomTemplate = null;
let renderer = null;
let scene    = null;
let camera   = null;
let controls = null;
let animId   = null;

// ── Manifold WASM (lazy init) ─────────────────────────────────────────────────
let wasm       = null;
let MeshCls    = null;
let ManifoldCls = null;

async function initManifold() {
  if (wasm) return;
  wasm = await ManifoldModule();
  wasm.setup();
  MeshCls     = wasm.Mesh;
  ManifoldCls = wasm.Manifold;
}

// ── Geometry ↔ Manifold conversions ──────────────────────────────────────────
function geomToManifold(geom) {
  // Ensure indexed geometry
  const g    = geom.index ? geom : mergeVertices(geom);
  const verts = new Float32Array(g.attributes.position.array);
  let   tris  = new Uint32Array(g.index.array);

  const mesh = new MeshCls({ numProp: 3, vertProperties: verts, triVerts: tris });
  const m    = new ManifoldCls(mesh);

  // If volume is negative the mesh is inside-out (normals pointing inward).
  // subtract(inside-out) acts like add, so we flip winding order to fix it.
  if (m.volume() < 0) {
    tris = new Uint32Array(tris); // copy before mutating
    for (let i = 0; i < tris.length; i += 3) {
      const tmp  = tris[i + 1];
      tris[i + 1] = tris[i + 2];
      tris[i + 2] = tmp;
    }
    const flipped = new MeshCls({ numProp: 3, vertProperties: verts, triVerts: tris });
    return new ManifoldCls(flipped);
  }

  return m;
}

function manifoldToGeom(m) {
  const mesh = m.getMesh();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array(mesh.vertProperties), 3
  ));
  geom.setIndex(new THREE.BufferAttribute(
    new Uint32Array(mesh.triVerts), 1
  ));
  geom.computeVertexNormals();
  return geom;
}

// ── STL loader helper ─────────────────────────────────────────────────────────
async function loadCenteredGeom(url) {
  const loader = new STLLoader();
  const buf  = await fetch(url).then(r => r.arrayBuffer());
  const raw  = loader.parse(buf);
  // STL stores per-face normals: each triangle's 3 vertices all carry the same
  // face normal, so two vertices at the same position but belonging to different
  // faces have DIFFERENT normals and won't be merged by mergeVertices (which
  // compares all attributes).  Delete normals first so merging is position-only,
  // giving a fully closed (manifold) indexed mesh.
  raw.deleteAttribute('normal');
  const geom = mergeVertices(raw);
  geom.computeBoundingBox();
  const c = new THREE.Vector3();
  geom.boundingBox.getCenter(c);
  geom.translate(-c.x, -c.y, -c.z);
  geom.computeVertexNormals();   // recompute smooth normals after merging
  return geom;
}

// ── Scale only the head vertices of the plug (|x| > HEAD_THRESH), leave neck unchanged ──
// headScale = target head half-width / original head half-width
function shapePlugGeom(template, headScale) {
  const g = template.clone();
  if (headScale === 1) return g;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (Math.abs(x) > HEAD_THRESH) pos.setX(i, x * headScale);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ── Bake rotation + translation into a geometry clone ─────────────────────────
function positionedGeom(template, rotMatrix, tx, ty, tz, scale = 1, zScale = 1) {
  const g = template.clone();
  if (scale !== 1 || zScale !== 1) {
    g.applyMatrix4(new THREE.Matrix4().makeScale(scale, scale, zScale));
  }
  if (rotMatrix) g.applyMatrix4(rotMatrix);
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(tx, ty, tz));
  return g;
}

// ── Load slot + plug STL models (base box is now generated programmatically) ──
export async function loadModels() {
  [slotGeomTemplate, plugGeomTemplate] = await Promise.all([
    loadCenteredGeom('/material/小长方体.stl'),
    loadCenteredGeom('/material/插.stl'),
  ]);
}

// ── Hollow rectangular tube (open top + bottom) ────────────────────────────────
// Outer dimensions match the original 初始长方体.stl (8.063 × 8.062 × BOX_H*zScale).
// The interior cavity (BOX_W-2*WALL_T) × (BOX_D-2*WALL_T) is open in Z so that
// the arrow plug from an adjacent piece can slide in from the top.
//
//   Outer:  8.063 × 8.062
//   Inner:  4.463 × 4.462   (wall = 1.8 mm each side)
//   Plug bounding box after pScale: ~3.85 × ~3.67  → fits inside inner with ~0.3 mm/side gap
//
function makeHollowBase(cx, cy, cz, zScale) {
  const w  = BOX_HW * 2;               // 8.063
  const d  = BOX_HD * 2;               // 8.062
  const h  = BOX_H  * zScale;
  const iw = w - 2 * WALL_T;           // inner width  (6.063 @ 1mm wall)
  const id = d - 2 * WALL_T;           // inner depth  (6.062 @ 1mm wall)
  // Inner void is WALL_T shorter on each Z end → leaves a top & bottom cap of WALL_T thickness
  const ih = h - 2 * WALL_T;

  const outer = ManifoldCls.cube([w, d, h],  /*center=*/true).translate([cx, cy, cz]);
  const inner = ManifoldCls.cube([iw, id, ih], /*center=*/true).translate([cx, cy, cz]);

  return outer.subtract(inner);
}

// ── Generate all pieces ───────────────────────────────────────────────────────
// opts.zScale           — scale box + slot in Z (height). default 1
// opts.plugWidth        — uniform XY scale target for plug width (mm). default 4.263
// opts.headScale        — extra multiplier on head vertices only. default 1
// opts.plugHeight       — plug height in mm (Z). default 6.1
// opts.surfaceThickness — colored top layer thickness (mm). 0 = no split. default 0.8
// opts.bodyColor        — hex color for the body mesh. default '#cccccc'
//
// Each piece in the returned array has:
//   { mesh, surfaceMesh, row, col, color }
//   mesh        = body (bodyColor), surfaceMesh = top surface (pixel color)
//   surfaceMesh is null when surfaceThickness = 0
export async function generatePieces(pixelData, onProgress, opts = {}) {
  if (!slotGeomTemplate) await loadModels();
  await initManifold();

  const PLUG_ORIG_W = 4.263;
  const PLUG_ORIG_H = 6.1;

  const {
    zScale            = 1,
    plugWidth         = PLUG_ORIG_W,
    headScale         = 1,
    plugHeight        = PLUG_ORIG_H,
    surfaceThickness  = 0.8,
    bodyColor         = '#cccccc',
  } = opts;

  const pScale     = plugWidth  / PLUG_ORIG_W;
  const plugZScale = plugHeight / PLUG_ORIG_H;
  const fullH      = BOX_H * zScale;
  const doSplit    = surfaceThickness > 0 && surfaceThickness < fullH;

  const shapedPlug = shapePlugGeom(plugGeomTemplate, headScale);

  const { pixels, boxW, boxD } = pixelData;
  const pieces = [];

  for (let i = 0; i < pixels.length; i++) {
    const { row, col, color, neighbors } = pixels[i];

    if (i % 4 === 0) {
      onProgress?.(`正在生成零件 ${i + 1} / ${pixels.length}…`);
      await new Promise(r => setTimeout(r, 0));
    }

    const cx = col * (boxW + PRINT_GAP) + boxW / 2;
    const cy = row * (boxD + PRINT_GAP) + boxD / 2;
    const cz = 0;

    let m = makeHollowBase(cx, cy, cz, zScale);

    // ── RIGHT → PLUG (+X, rotate +90°Z)
    if (neighbors.right) {
      const px = cx + BOX_HW + PLUG_HALF_PRO - EPSILON;
      m = m.add(geomToManifold(positionedGeom(shapedPlug, ROT_90Z, px, cy, cz, pScale, plugZScale)));
    }
    // ── LEFT → SLOT (−X, rotate 90°Z)
    if (neighbors.left) {
      const sx = cx - BOX_HW + SLOT_HALF_PEN - EPSILON;
      m = m.subtract(geomToManifold(positionedGeom(slotGeomTemplate, ROT_90Z, sx, cy, cz, 1, zScale)));
    }
    // ── BOTTOM → PLUG (+Y, ROT_180Z)
    if (neighbors.bottom) {
      const py = cy + BOX_HD + PLUG_HALF_PRO - EPSILON;
      m = m.add(geomToManifold(positionedGeom(shapedPlug, ROT_180Z, cx, py, cz, pScale, plugZScale)));
    }
    // ── TOP → SLOT (−Y, no rotation)
    if (neighbors.top) {
      const sy = cy - BOX_HD + SLOT_HALF_PEN - EPSILON;
      m = m.subtract(geomToManifold(positionedGeom(slotGeomTemplate, null, cx, sy, cz, 1, zScale)));
    }

    let bodyManifold = m;
    let surfaceManifold = null;

    if (doSplit) {
      // Surface cap: thin box at the very top of the piece
      const capCZ = fullH / 2 - surfaceThickness / 2;  // center Z (geometry is centered at cz=0)
      const cap = ManifoldCls.cube([BOX_HW * 2, BOX_HD * 2, surfaceThickness], true)
        .translate([cx, cy, capCZ]);
      surfaceManifold = m.intersect(cap);
      bodyManifold    = m.subtract(cap);
    }

    // Body mesh
    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(bodyColor), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(manifoldToGeom(bodyManifold), bodyMat);

    // Surface mesh
    let surfaceMesh = null;
    if (surfaceManifold) {
      const surfMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color), roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide,
      });
      surfaceMesh = new THREE.Mesh(manifoldToGeom(surfaceManifold), surfMat);
    }

    pieces.push({ mesh, surfaceMesh, row, col, color });
  }

  onProgress?.('完成！');
  return pieces;
}

// ── Three.js viewer ───────────────────────────────────────────────────────────
// opts.theme: 'dark' (default) | 'light'
export function initViewer(canvas, opts = {}) {
  const light = opts.theme === 'light';

  if (animId !== null) { cancelAnimationFrame(animId); animId = null; }
  if (renderer) renderer.dispose();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.shadowMap.enabled = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(light ? 0xf0f2f5 : 0x1a1a2e);

  camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
  camera.position.set(40, -60, 80);
  camera.lookAt(0, 0, 0);

  // Lighting: brighter + neutral for light theme
  scene.add(new THREE.AmbientLight(0xffffff, light ? 1.0 : 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, light ? 1.5 : 1.2);
  dir.position.set(50, -80, 120);
  dir.castShadow = true;
  scene.add(dir);
  const fillLight = new THREE.DirectionalLight(light ? 0xffffff : 0x8888ff, light ? 0.6 : 0.3);
  fillLight.position.set(-50, 60, 20);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(200, 40,
    light ? 0xbbbbcc : 0x333355,
    light ? 0xddddee : 0x222244,
  );
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe(canvas);

  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

// ── Expose camera / controls for external animation ───────────────────────────
export function getCamera()   { return camera; }
export function getControls() { return controls; }
export function getScene()    { return scene; }

// ── Show pieces in viewer ─────────────────────────────────────────────────────
export function showPieces(pieces) {
  if (!scene) return;

  const toRemove = scene.children.filter(c => c.userData.isPiece);
  toRemove.forEach(c => { scene.remove(c); c.geometry?.dispose(); });

  let sumX = 0, sumY = 0, count = 0;
  pieces.forEach(({ mesh }) => {
    mesh.geometry.computeBoundingBox();
    const c = new THREE.Vector3();
    mesh.geometry.boundingBox.getCenter(c);
    sumX += c.x; sumY += c.y; count++;
  });
  const offsetX = count ? sumX / count : 0;
  const offsetY = count ? sumY / count : 0;

  pieces.forEach(({ mesh, surfaceMesh }) => {
    [mesh, surfaceMesh].forEach(m => {
      if (!m) return;
      m.userData.isPiece = true;
      m.castShadow    = true;
      m.receiveShadow = true;
      m.position.set(-offsetX, -offsetY, 0);
      scene.add(m);
    });
  });
}

// ── Export all pieces as individual STL files ─────────────────────────────────
export function exportAllSTL(pieces) {
  const exporter = new STLExporter();
  pieces.forEach(({ mesh, row, col }) => {
    const stl  = exporter.parse(mesh, { binary: true });
    const blob = new Blob([stl], { type: 'application/octet-stream' });
    const a    = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(blob),
      download: `piece_r${row}_c${col}.stl`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ── Export all pieces merged as one STL ───────────────────────────────────────
export function exportMergedSTL(pieces) {
  const exporter = new STLExporter();
  const tmpScene = new THREE.Scene();
  pieces.forEach(({ mesh }) => tmpScene.add(mesh.clone()));
  const stl  = exporter.parse(tmpScene, { binary: true });
  const blob = new Blob([stl], { type: 'application/octet-stream' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: 'model_merged.stl',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Export colored 3MF (body in bodyColor + pixel-colored top surface) ────────
// Requires pieces generated with surfaceThickness > 0.
export function export3MFColored(pieces, opts = {}) {
  const { filename = 'model_colored.3mf', bodyColor = '#cccccc' } = opts;

  // ── helpers ────────────────────────────────────────────────────────────────
  // Extract world-space vertices and indices from a Three.js mesh
  function meshArrays(mesh) {
    const geo = mesh.geometry.clone();
    mesh.updateMatrixWorld(true);
    geo.applyMatrix4(mesh.matrixWorld);
    if (!geo.index) geo = geo.toNonIndexed(); // ensure indexed
    const verts   = geo.attributes.position.array;  // Float32Array, x y z x y z ...
    const indices = geo.index ? geo.index.array : (() => {
      const a = new Uint32Array(geo.attributes.position.count);
      for (let i = 0; i < a.length; i++) a[i] = i;
      return a;
    })();
    geo.dispose();
    return { verts, indices };
  }

  // Write an <object> XML string with optional material reference
  function objectXML(id, verts, indices, pid, pindex, name) {
    const prec  = 5;
    const parts = [];
    parts.push(`  <object id="${id}" type="model" pid="${pid}" pindex="${pindex}"${name ? ` name="${name}"` : ''}>\n   <mesh>\n    <vertices>\n`);
    for (let i = 0; i < verts.length; i += 3)
      parts.push(`     <vertex x="${verts[i].toFixed(prec)}" y="${verts[i+1].toFixed(prec)}" z="${verts[i+2].toFixed(prec)}"/>\n`);
    parts.push('    </vertices>\n    <triangles>\n');
    for (let i = 0; i < indices.length; i += 3)
      parts.push(`     <triangle v1="${indices[i]}" v2="${indices[i+1]}" v3="${indices[i+2]}"/>\n`);
    parts.push('    </triangles>\n   </mesh>\n  </object>\n');
    return parts.join('');
  }

  // ── collect unique pixel colors ────────────────────────────────────────────
  const colorList = [bodyColor];   // index 0 = body color
  const colorIdx  = new Map([[bodyColor, 0]]);
  pieces.forEach(({ color }) => {
    if (!colorIdx.has(color)) { colorIdx.set(color, colorList.length); colorList.push(color); }
  });

  // ── build 3dmodel.model XML ────────────────────────────────────────────────
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  out.push(`<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n`);
  out.push(` <metadata name="Application">pixel-bead-art</metadata>\n`);
  out.push(` <resources>\n`);

  // basematerials
  out.push(`  <basematerials id="1">\n`);
  colorList.forEach(c => out.push(`   <base name="${c}" displaycolor="${c}"/>\n`));
  out.push(`  </basematerials>\n`);

  let objId = 2;
  const items = [];

  pieces.forEach(({ mesh, surfaceMesh, color }, pi) => {
    // body
    const { verts: bv, indices: bi } = meshArrays(mesh);
    out.push(objectXML(objId, bv, bi, 1, 0, `body_${pi}`));
    items.push(objId++);

    // surface (if present)
    if (surfaceMesh) {
      const { verts: sv, indices: si } = meshArrays(surfaceMesh);
      out.push(objectXML(objId, sv, si, 1, colorIdx.get(color), `surface_${pi}`));
      items.push(objId++);
    }
  });

  out.push(` </resources>\n`);
  out.push(` <build>\n`);
  items.forEach(id => out.push(`  <item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`));
  out.push(` </build>\n`);
  out.push(`</model>\n`);

  // ── pack into ZIP (.3mf) ───────────────────────────────────────────────────
  const modelXml = out.join('');
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels':         strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model':    strToU8(modelXml),
  });

  const blob = new Blob([zip], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}
