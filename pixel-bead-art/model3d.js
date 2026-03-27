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

// ── Constants ─────────────────────────────────────────────────────────────────
const BOX_HW        = 8.063 / 2;   // 4.0315  half-width  (X)
const BOX_HD        = 8.062 / 2;   // 4.031   half-depth  (Y)
const SLOT_HALF_PEN = 5.134 / 2;   // 2.567   penetration (Y natural, X after 90°Z rot)
const PLUG_HALF_PRO = 4.067 / 2;   // 2.0335  protrusion  (Y natural, X after 90°Z rot)
const EPSILON       = 0.5;         // overlap to avoid coplanar faces
const PRINT_GAP     = 0.3;         // physical gap between adjacent box faces (prevents fusing when printing)
const PLUG_CLEARANCE = 0.2;        // mm reduction per side on plug (print tolerance for plug-slot fit)
// Uniform scale derived from protrusion dimension (4.067mm) → reduces all sides by ~PLUG_CLEARANCE
const PLUG_SCALE    = (4.067 - 2 * PLUG_CLEARANCE) / 4.067;  // ≈ 0.902

const ROT_90Z  = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
// For BOTTOM plug: rotate 180° around Z to flip which end (base vs tip) faces the box
const ROT_180Z = new THREE.Matrix4().makeRotationZ(Math.PI);

// ── Shared state ──────────────────────────────────────────────────────────────
let baseGeomTemplate = null;
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

// ── Bake rotation + translation into a geometry clone ─────────────────────────
function positionedGeom(template, rotMatrix, tx, ty, tz, scale = 1, zScale = 1) {
  const g = template.clone();
  if (scale !== 1 || zScale !== 1) {
    g.applyMatrix4(new THREE.Matrix4().makeScale(scale, scale, scale * zScale));
  }
  if (rotMatrix) g.applyMatrix4(rotMatrix);
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(tx, ty, tz));
  return g;
}

// ── Load all three STL models (cached) ────────────────────────────────────────
export async function loadModels() {
  [baseGeomTemplate, slotGeomTemplate, plugGeomTemplate] = await Promise.all([
    loadCenteredGeom('/material/初始长方体.stl'),
    loadCenteredGeom('/material/小长方体.stl'),
    loadCenteredGeom('/material/插.stl'),
  ]);
}

// ── Generate all pieces ───────────────────────────────────────────────────────
// opts.zScale       — scale box/slot/plug in Z (height). default 1
// opts.plugClearance — mm reduction per side on plug cross-section. default PLUG_CLEARANCE
export async function generatePieces(pixelData, onProgress, opts = {}) {
  if (!baseGeomTemplate) await loadModels();
  await initManifold();

  const {
    zScale       = 1,
    plugClearance = PLUG_CLEARANCE,
  } = opts;

  // Recompute plug scale from the provided clearance value
  const pScale = (4.067 - 2 * plugClearance) / 4.067;

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

    // Start with base box as Manifold solid
    let m = geomToManifold(positionedGeom(baseGeomTemplate, null, cx, cy, cz, 1, zScale));

    // ── RIGHT → PLUG (+X, rotate +90°Z: Y+base→X− at box face, Y−tip→X+ out)
    if (neighbors.right) {
      const px = cx + BOX_HW + PLUG_HALF_PRO - EPSILON;
      const pm = geomToManifold(positionedGeom(plugGeomTemplate, ROT_90Z, px, cy, cz, pScale, zScale));
      m = m.add(pm);
    }

    // ── LEFT → SLOT (−X, rotate 90°Z) ─────────────────────────────────────
    if (neighbors.left) {
      const sx = cx - BOX_HW + SLOT_HALF_PEN - EPSILON;
      const sm = geomToManifold(positionedGeom(slotGeomTemplate, ROT_90Z, sx, cy, cz, 1, zScale));
      m = m.subtract(sm);
    }

    // ── BOTTOM → PLUG (+Y, ROT_180Z: Y+base→Y− at box face, Y−tip→Y+ out)
    if (neighbors.bottom) {
      const py = cy + BOX_HD + PLUG_HALF_PRO - EPSILON;
      const pm = geomToManifold(positionedGeom(plugGeomTemplate, ROT_180Z, cx, py, cz, pScale, zScale));
      m = m.add(pm);
    }

    // ── TOP → SLOT (−Y, no rotation) ──────────────────────────────────────
    if (neighbors.top) {
      const sy = cy - BOX_HD + SLOT_HALF_PEN - EPSILON;
      const sm = geomToManifold(positionedGeom(slotGeomTemplate, null, cx, sy, cz, 1, zScale));
      m = m.subtract(sm);
    }

    const geom = manifoldToGeom(m);
    const mat  = new THREE.MeshStandardMaterial({
      color:     new THREE.Color(color),
      roughness: 0.6,
      metalness: 0.05,
      side:      THREE.DoubleSide,
    });
    pieces.push({ mesh: new THREE.Mesh(geom, mat), row, col, color });
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

  pieces.forEach(({ mesh }) => {
    mesh.userData.isPiece = true;
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.position.set(-offsetX, -offsetY, 0);
    scene.add(mesh);
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
