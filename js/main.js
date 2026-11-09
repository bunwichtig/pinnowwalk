import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Diorama von Am See 16: alle Formen aus Messdaten (ALKIS, DGM1, LoD2, nDOM) und den eigenen Fotos.
// Bewusst ohne Texturen: schlichte, einfarbige Flächen wie bei einem Architekturmodell.
const EYE = 1.7;
const WALK = 2.5, RUN = 6, FLY = 10;
const GRAVITY = 20, JUMP = 5;
const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');

const COLORS = {
  ground: 0xd9cfb8, plinth: 0x8f8574, water: 0x8fb3c4, wall: 0xf4f1ea, roof: 0x8a8f96,
  leaf: [0x9fb98a, 0x8aab76, 0x7a9c68, 0x6c8e5c], trunk: 0x8a7462, wood: 0xb79a78, concrete: 0xc8c6c0,
  boat: 0xffffff, bed: 0x8c6f55, stone: 0xb0aaa0, roofSheet: 0xa9b0b5,
  // Dorfstraße 2: Farben nach den Fotos bzw. Dachfarben aus dem Luftbild (vereinfacht)
  walls: { brick: 0xc27a60, plaster: 0xe3d8c2, timber: 0x6f5c4b },
  roofs: { grey: 0x8a8f96, tile: 0xbd6a4c, dark: 0x5d6166, moss: 0x7f7b5e },
  road: 0xaaa69e, walk: 0xbf9282, fence: 0x6b5442, metal: 0x9aa0a4, shelter: 0x3f8f7a, glass: 0xcfe3e6,
  sign: 0xd8c84a, parcel: 0xd0453a,
  // schönere Darstellung (Dorfstraße 2): Bodenarten, Hauswände der Nachbarn, Laub
  soil: [0x7ea35b, 0x9db06c, 0xb19a72, 0xbdb7aa], earth: 0x5c4a3b, edge: 0x3b342d,
  neighbours: [0xf3ede2, 0xe9e2d4, 0xf6f2ea, 0xe2dccf, 0xede3cf, 0xdfe3e2],
  crowns: [0x5f8f45, 0x6c9a4c, 0x4f7f3e, 0x77a352, 0x58884a], bush: [0x4f7a3c, 0x5d8744, 0x46703a],
};

// ---------- Renderer, Szene, Licht ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;     // alles steht still: Schatten nur einmal berechnen

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef0f2);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 500);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0xffffff, 0xb8b2a6, 1.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-30, 60, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 200 });
sun.shadow.normalBias = 0.05;
scene.add(sun);

const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const add = (mesh) => { mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); return mesh; };

let M;               // Modelldaten
const terrainTris = [];
const solids = [];   // Grundrisse, durch die man nicht laufen kann

// Welches Diorama: ?ort=16 (Standard), ?ort=89 oder ?ort=dorf2
const FILES = { 16: 'am-see-16', 89: 'am-see-89', dorf2: 'dorfstrasse-2' };
const ORT = new URLSearchParams(location.search).get('ort');
const SITE = ORT in FILES ? ORT : '16';
document.querySelectorAll('#sites button').forEach((b) => {
  b.classList.toggle('on', b.dataset.ort === SITE);
  b.onclick = () => { if (b.dataset.ort !== SITE) location.search = '?ort=' + b.dataset.ort; };
});

// Himmel mit Verlauf, Dunst, wärmeres Sonnenlicht (nur für die große, neue Darstellung)
let skyMesh = null;
function setupLook() {
  if (!M.radius) return;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const top = new THREE.Color(0x7fb2e5), horizon = new THREE.Color(0xe6eef3);
  const sky = new THREE.SphereGeometry(600, 24, 12);
  const col = [];
  const p = sky.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp(p.getY(i) / 500, 0, 1) ** 0.6;
    const c = horizon.clone().lerp(top, t);
    col.push(c.r, c.g, c.b);
  }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  skyMesh = new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
  scene.background = horizon;
  scene.fog = new THREE.Fog(horizon, 180, 700);
  hemi.color.set(0xd6e6ff); hemi.groundColor.set(0x6f7a52); hemi.intensity = 1.35;
  sun.color.set(0xfff0d8); sun.intensity = 2.9;
}

async function load() {
  M = await (await fetch(`data/${FILES[SITE]}.json`, { cache: 'no-cache' })).json();
  setupLook();
  const name = 'Pinnow · ' + M.title;
  $('title').textContent = $('site-title').textContent = document.title = name;
  $('site-sub').textContent = M.subtitle;
  $('btn-home').classList.toggle('hidden', !M.objects.terrasse && !M.objects.platten);
  if (M.attributionOsm) $('attribution').insertAdjacentText('beforeend', ' · ' + M.attributionOsm);
  fitShadow();
  buildGround();
  buildWater();
  buildHouses();
  buildVegetation();
  buildPhotoObjects();
  buildStreet();
  renderer.shadowMap.needsUpdate = true;
  $('loading').textContent = '';
  $('btn-start').disabled = false;
  overview();
}

// Schattenbereich an die Größe des Dioramas anpassen
function fitShadow() {
  const xs = M.area.map((p) => p[0]), zs = M.area.map((p) => p[1]);
  const r = Math.max(40, (Math.max(...xs) - Math.min(...xs)) / 2 + 5, (Math.max(...zs) - Math.min(...zs)) / 2 + 5);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, far: 200 + r * 2 });
  sun.position.set(cx - 30, 60 + r * 0.5, cz + 40);
  sun.target.position.set(cx, 0, cz);
  scene.add(sun.target);
  sun.shadow.camera.updateProjectionMatrix();
  if (r > 60) { sun.shadow.mapSize.set(isTouch ? 2048 : 4096, isTouch ? 2048 : 4096); camera.far = 900; camera.updateProjectionMatrix(); }
}

// ---------- Gelände mit Sockel ----------
function buildGround() {
  const { verts, tris, edge, bottom } = M.ground;
  const pos = [];
  for (const t of tris) for (const k of t) pos.push(...verts[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  if (M.ground.cls) {
    // Bodenart je Punkt (Rasen, Wiese, Erde, Pflaster) mit leichtem Rauschen, weich verlaufend
    const col = [], c = new THREE.Color();
    for (const t of tris) for (const k of t) {
      c.setHex(COLORS.soil[M.ground.cls[k]]);
      const n = (Math.sin(verts[k][0] * 12.9898 + verts[k][2] * 78.233) * 43758.5453) % 1;
      c.offsetHSL(0, 0, n * 0.03);
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const ground = add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    ground.castShadow = false;
  } else add(new THREE.Mesh(g, mat(COLORS.ground, { side: THREE.DoubleSide })));
  for (const t of tris) terrainTris.push(t.map((k) => verts[k]));
  indexTerrain();

  // Seitenwände des Dioramas entlang der Grundstücksgrenze
  const w = [];
  for (let k = 0; k < edge; k++) {
    const a = verts[k], b = verts[(k + 1) % edge];
    w.push(...a, ...b, b[0], bottom, b[2], ...a, b[0], bottom, b[2], a[0], bottom, a[2]);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(w, 3));
  wg.computeVertexNormals();
  add(new THREE.Mesh(wg, mat(M.radius ? COLORS.earth : COLORS.plinth, { side: THREE.DoubleSide })));
  // Bodenplatte
  const shape = new THREE.Shape(M.area.map(([x, z]) => new THREE.Vector2(x, -z)));
  const base = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), mat(M.radius ? COLORS.earth : COLORS.plinth, { side: THREE.DoubleSide }));
  base.position.y = bottom;
  scene.add(base);
}

function buildWater() {
  if (!M.waterArea.length) return;
  const shape = new THREE.Shape(M.waterArea.map(([x, z]) => new THREE.Vector2(x, -z)));
  const depth = M.water - M.ground.bottom;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: COLORS.water, transparent: true, opacity: 0.75 }));
  water.position.y = M.ground.bottom;
  water.receiveShadow = true;
  scene.add(water);
}

// ---------- Häuser aus LoD2 (je Farbe ein Netz, damit es flüssig bleibt) ----------
function buildHouses() {
  const buckets = new Map();
  const put = (color, arr) => { if (!buckets.has(color)) buckets.set(color, []); buckets.get(color).push(...arr); };
  let hash = 0;
  for (const b of M.buildings) {
    hash = (hash * 31 + b.foot.length + Math.round(b.foot[0][0] * 7)) >>> 0;
    const nb = M.radius ? COLORS.neighbours[hash % COLORS.neighbours.length] : COLORS.wall;
    put(b.wallTone ? COLORS.walls[b.wallTone] : nb, b.wall);
    put(b.roofTone && M.radius ? COLORS.roofs[b.roofTone] : COLORS.roof, b.roof);
    solids.push(b.foot);
  }
  for (const [color, pos] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    add(new THREE.Mesh(g, mat(color, { side: THREE.DoubleSide })));
    if (M.radius) {
      // feine dunkle Kanten wie bei einem Architekturmodell
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25),
        new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.45 }));
      scene.add(edges);
    }
  }
}

// ---------- Bewuchs aus dem nDOM ----------
function buildTrees() {
  // Einzelbäume aus dem nDOM: Krone als zwei weiche Klumpen, Stamm bis in die Krone; dazu Büsche und Hecken
  const m = new THREE.Matrix4(), c = new THREE.Color(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const rnd = (i, k) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat(0xffffff), M.trees.length * 2);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1, 1, 7), mat(COLORS.trunk), M.trees.length);
  M.trees.forEach(([x, z, g, bottom, top, r], i) => {
    const hh = Math.max(1.5, top - bottom);
    const cy = g + bottom + hh * 0.5;
    e.set(0, rnd(i, 1) * 6, 0); q.setFromEuler(e);
    m.compose(new THREE.Vector3(x, cy, z), q, new THREE.Vector3(r, hh * 0.62, r * 0.92));
    crown.setMatrixAt(2 * i, m);
    c.setHex(COLORS.crowns[Math.floor(rnd(i, 2) * COLORS.crowns.length)]);
    crown.setColorAt(2 * i, c);
    const a = rnd(i, 3) * 6.28;
    m.compose(new THREE.Vector3(x + Math.cos(a) * r * 0.35, cy + hh * 0.2, z + Math.sin(a) * r * 0.35), q,
      new THREE.Vector3(r * 0.7, hh * 0.42, r * 0.7));
    crown.setMatrixAt(2 * i + 1, m);
    c.offsetHSL(0, 0, 0.04);
    crown.setColorAt(2 * i + 1, c);
    const th = bottom + hh * 0.35, tr = 0.1 + top * 0.011;
    m.compose(new THREE.Vector3(x, g + th / 2 - 0.2, z), new THREE.Quaternion(), new THREE.Vector3(tr, th, tr));
    trunks.setMatrixAt(i, m);
  });
  add(crown); add(trunks);
  const bush = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), mat(0xffffff), M.bushes.length);
  M.bushes.forEach(([x, z, g, v], i) => {
    e.set(rnd(i, 4), rnd(i, 5) * 6, 0); q.setFromEuler(e);
    m.compose(new THREE.Vector3(x, g + v * 0.5, z), q, new THREE.Vector3(1.1, Math.max(0.55, v * 0.5), 1.1));
    bush.setMatrixAt(i, m);
    c.setHex(COLORS.bush[Math.floor(rnd(i, 6) * COLORS.bush.length)]);
    bush.setColorAt(i, c);
  });
  add(bush);
}

function buildVegetation() {
  if (M.trees) return buildTrees();
  const v = M.vegetation;
  const leaves = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), v.length);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  v.forEach(([x, z, y, thick, h, size = 1], k) => {
    m.makeScale(0.96 * size, thick, 0.96 * size).setPosition(x, y + thick / 2, z);
    leaves.setMatrixAt(k, m);
    c.setHex(COLORS.leaf[Math.min(3, Math.floor(h / 6))]);
    leaves.setColorAt(k, c);
  });
  add(leaves);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), mat(COLORS.trunk), M.trunks.length);
  M.trunks.forEach(([x, z, y0, y1, r], k) => {
    m.makeScale(r, y1 - y0, r).setPosition(x, (y0 + y1) / 2, z);
    trunks.setMatrixAt(k, m);
  });
  add(trunks);
}

// ---------- Dinge von den Fotos ----------
function buildPhotoObjects() {
  const o = M.objects;
  if (!o.steg) return;
  // Steg mit Badeleiter
  const { land, see, width, y } = o.steg;
  const len = Math.hypot(see[0] - land[0], see[1] - land[1]) + 1.5;
  const yaw = Math.atan2(see[0] - land[0], see[1] - land[1]);
  const deck = add(new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, len), mat(COLORS.wood)));
  deck.position.set((land[0] + see[0]) / 2, y, (land[1] + see[1]) / 2);
  deck.rotation.y = yaw;
  for (let d = -len / 2 + 0.3; d < len / 2; d += 2)
    for (const s of [-1, 1]) {
      const p = add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6), mat(COLORS.wood)));
      p.position.set(deck.position.x + Math.sin(yaw) * d + Math.cos(yaw) * s * (width / 2 - 0.1), y - 0.8,
        deck.position.z + Math.cos(yaw) * d - Math.sin(yaw) * s * (width / 2 - 0.1));
    }
  const ladder = new THREE.Group();
  for (const sx of [-0.22, 0.22]) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.8, 6), mat(COLORS.concrete));
    r.position.set(sx, -0.5, 0);
    ladder.add(r);
  }
  for (let k = 0; k < 3; k++) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.03, 0.05), mat(COLORS.concrete));
    r.position.set(0, -1.1 + k * 0.35, 0);
    ladder.add(r);
  }
  ladder.position.set(see[0] + Math.cos(yaw) * (width / 2 + 0.05), y + 0.3, see[1] - Math.sin(yaw) * (width / 2 + 0.05));
  ladder.rotation.y = yaw + Math.PI / 2;
  scene.add(ladder);
  decks.push({ x0: land[0], z0: land[1], x1: see[0], z1: see[1], width, y: y + 0.04 });

  // Betonstufen den Hang hinab
  for (const [x, z, h] of o.treppe.steps) {
    const s = add(new THREE.Mesh(new THREE.BoxGeometry(o.treppe.width, 0.18, 0.4), mat(COLORS.concrete)));
    s.position.set(x, h + 0.04, z);
    s.rotation.y = o.treppe.yaw;
  }

  if (o.terrasse) {
    // Terrasse aus Betonplatten (Fugen als einzelne Platten)
    const t = o.terrasse, grp = new THREE.Group();
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 4; j++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.06, 0.96), mat(COLORS.concrete));
        p.position.set(-t.w / 2 + 0.45 + i * 0.9, 0.03, -t.d / 2 + 0.5 + j * 1.0);
        p.receiveShadow = true;
        grp.add(p);
      }
    // Wellblech-Vordach auf vier Pfosten
    const v = o.vordach;
    const sheet = new THREE.Mesh(new THREE.BoxGeometry(t.w + 0.4, 0.05, t.d), mat(COLORS.roofSheet));
    sheet.position.set(0, v.h + 0.15, 0);
    sheet.rotation.x = -0.12;
    sheet.castShadow = true;
    grp.add(sheet);
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, v.h, 0.12), mat(COLORS.wood));
      post.position.set(px * (t.w / 2 - 0.1), v.h / 2, pz * (t.d / 2 - 0.1));
      post.castShadow = true;
      grp.add(post);
    }
    grp.position.set(t.x, t.y, t.z);
    grp.rotation.y = t.yaw;
    scene.add(grp);
  }

  // umgedrehtes Boot und Beet mit Steinen neben dem Steg
  const boat = add(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(COLORS.boat)));
  boat.scale.set(0.7, 0.35, 2.1);
  boat.position.set(o.boot.x, o.boot.y, o.boot.z);
  boat.rotation.y = o.boot.yaw;
  const bed = add(new THREE.Mesh(new THREE.CylinderGeometry(o.beet.r, o.beet.r, 0.15, 10), mat(COLORS.bed)));
  bed.position.set(o.beet.x, o.beet.y + 0.05, o.beet.z);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const st = add(new THREE.Mesh(new THREE.DodecahedronGeometry(0.18), mat(COLORS.stone)));
    st.position.set(o.beet.x + Math.cos(a) * o.beet.r, o.beet.y + 0.12, o.beet.z + Math.sin(a) * o.beet.r);
  }
}

// ---------- Straße und Garten (Dorfstraße 2) ----------
function meshFrom(d, color) {
  if (!d || !d.tris.length) return;
  const pos = [];
  for (const t of d.tris) for (const k of t) pos.push(...d.verts[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, mat(color, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function buildStreet() {
  const o = M.objects;
  if (!M.radius) return;
  meshFrom(M.roads, COLORS.road);
  meshFrom(M.walks, COLORS.walk);

  // Flurstück Dorfstraße 2 als rote Linie auf dem Boden
  const line = M.parcel.map(([x, z]) => new THREE.Vector3(x, (terrainHeight(x, z) ?? 0) + 0.15, z));
  const dense = [];
  line.forEach((a, k) => {
    const b = line[(k + 1) % line.length], n = Math.ceil(a.distanceTo(b) / 1.5);
    for (let i = 0; i < n; i++) {
      const p = a.clone().lerp(b, i / n);
      p.y = (terrainHeight(p.x, p.z) ?? p.y) + 0.15;
      dense.push(p);
    }
  });
  scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(dense), new THREE.LineBasicMaterial({ color: COLORS.parcel })));

  const parts = { fence: [], metal: [], shelter: [], glass: [], sign: [], wood: [], concrete: [] };
  const box = (kind, w, h, d, x, y, z, yaw = 0, pitch = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (pitch) g.rotateX(pitch);
    g.rotateY(yaw).translate(x, y, z);
    parts[kind].push(g);
  };
  const cyl = (kind, r, h, x, y, z) => parts[kind].push(new THREE.CylinderGeometry(r, r, h, 6).translate(x, y, z));

  // Holzlattenzaun an der Straße
  for (const f of o.zaun) {
    for (let k = 0; k + 1 < f.length; k++) {
      const [x0, z0, y0] = f[k], [x1, z1, y1] = f[k + 1];
      const len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.round(len / 0.12));
      for (let i = 0; i < n; i += 1) {
        const t = (i + 0.5) / n;
        box('fence', 0.07, 1.15, 0.02, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + 0.57, z0 + (z1 - z0) * t, yaw + Math.PI / 2);
        i++;      // Latte, Lücke, Latte …
      }
      box('fence', 0.05, 0.08, len, (x0 + x1) / 2, (y0 + y1) / 2 + 0.3, (z0 + z1) / 2, yaw);
      box('fence', 0.05, 0.08, len, (x0 + x1) / 2, (y0 + y1) / 2 + 0.9, (z0 + z1) / 2, yaw);
      box('fence', 0.1, 1.25, 0.1, x0, y0 + 0.6, z0);
    }
  }
  // Doppelkopf-Laternen
  for (const [x, z, y] of o.laternen) {
    cyl('metal', 0.07, 5.2, x, y + 2.6, z);
    for (const s of [-1, 1]) {
      box('metal', 0.7, 0.05, 0.05, x + s * 0.35, y + 5.15, z);
      parts.metal.push(new THREE.ConeGeometry(0.28, 0.3, 8).translate(x + s * 0.7, y + 4.95, z));
    }
  }
  // Wartehäuschen: grüner Rahmen, Glaswände, flaches Dach
  for (const [x, z, y, , away] of o.haeuschen) {
    const ca = Math.cos(away), sa = Math.sin(away);
    const at = (lx, lz) => [x + lx * ca + lz * sa, z - lx * sa + lz * ca];
    for (const [lx, lz] of [[-1.6, -0.7], [1.6, -0.7], [-1.6, 0.7], [1.6, 0.7]]) {
      const [px, pz] = at(lx, lz);
      box('shelter', 0.08, 2.3, 0.08, px, y + 1.15, pz, away);
    }
    const [rx, rz] = at(0, 0);
    box('shelter', 3.5, 0.1, 1.7, rx, y + 2.35, rz, away, -0.05);
    const [bx, bz] = at(0, 0.68);
    box('glass', 3.2, 2.0, 0.03, bx, y + 1.15, bz, away);
    for (const s of [-1, 1]) {
      const [sx, sz] = at(s * 1.58, 0);
      box('glass', 0.03, 2.0, 1.3, sx, y + 1.15, sz, away);
    }
    const [bnx, bnz] = at(0, 0.4);
    box('wood', 2.2, 0.06, 0.4, bnx, y + 0.45, bnz, away);
  }
  // Haltestellenschilder
  for (const [x, z, y] of o.haltestellen) {
    cyl('metal', 0.035, 2.6, x, y + 1.3, z);
    parts.sign.push(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 16).rotateX(Math.PI / 2).translate(x, y + 2.45, z));
  }
  // Terrasse aus großen hellen Platten vor dem Backsteingiebel
  if (o.platten) {
    const t = o.platten, ca = Math.cos(t.yaw), sa = Math.sin(t.yaw);
    for (let i = 0; i < Math.floor(t.w / 0.8); i++)
      for (let j = 0; j < Math.floor(t.d / 0.8); j++) {
        const lx = -t.w / 2 + 0.4 + i * 0.8, lz = -t.d / 2 + 0.4 + j * 0.8;
        box('concrete', 0.76, 0.12, 0.76, t.x + lx * ca + lz * sa, t.y + 0.06, t.z - lx * sa + lz * ca, t.yaw);
      }
    decks.push({ x0: t.x - sa * t.d / 2, z0: t.z - ca * t.d / 2, x1: t.x + sa * t.d / 2, z1: t.z + ca * t.d / 2, width: t.w, y: t.y + 0.12, flat: true });
  }
  // Holzbalkon im verputzten Giebel: Boden, Brüstung aus senkrechten Brettern, zwei Stützen
  if (o.balkon) {
    const t = o.balkon, ca = Math.cos(t.yaw), sa = Math.sin(t.yaw);
    const at = (lx, lz) => [t.x + lx * ca + lz * sa, t.z - lx * sa + lz * ca];
    box('fence', t.w, 0.12, t.d, t.x, t.y, t.z, t.yaw);
    const [fx, fz] = at(0, t.d / 2);
    box('fence', t.w, 0.08, 0.06, fx, t.y + 1.0, fz, t.yaw);
    for (let lx = -t.w / 2; lx <= t.w / 2 + 0.01; lx += 0.16) {
      const [px, pz] = at(lx, t.d / 2);
      box('fence', 0.1, 0.95, 0.03, px, t.y + 0.5, pz, t.yaw);
    }
    for (const s of [-1, 1]) {
      const [sx, sz] = at(s * (t.w / 2 - 0.1), 0);
      box('fence', 0.05, 1.0, t.d, sx, t.y + 0.5, sz, t.yaw);
    }
  }
  // Wäscheleine: zwei Holzpfosten mit Querholz, dazwischen vier Leinen
  if (o.waesche) {
    const { a, b, h } = o.waesche;
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
    for (const [x, z, y] of [a, b]) {
      box('wood', 0.12, h, 0.12, x, y + h / 2, z);
      box('wood', 0.08, 0.1, 1.0, x, y + h - 0.1, z, yaw + Math.PI / 2);
    }
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (const off of [-0.4, -0.13, 0.13, 0.4]) {
      const ox = Math.cos(yaw) * off, oz = -Math.sin(yaw) * off;
      box('metal', 0.015, 0.015, len, (a[0] + b[0]) / 2 + ox, (a[2] + b[2]) / 2 + h - 0.12, (a[1] + b[1]) / 2 + oz, yaw);
    }
  }
  const colors = { fence: COLORS.fence, metal: COLORS.metal, shelter: COLORS.shelter, sign: COLORS.sign, wood: COLORS.wood, concrete: COLORS.concrete };
  for (const [kind, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const g = mergeGeometries(list.map((x) => x.toNonIndexed()));
    const m = kind === 'glass'
      ? new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: COLORS.glass, transparent: true, opacity: 0.35 }))
      : add(new THREE.Mesh(g, mat(colors[kind])));
    if (kind === 'glass') scene.add(m);
  }
}

// ---------- Höhe, Grenzen ----------
const decks = [];
const down = new THREE.Raycaster(), tmpV = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0);

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, za] = poly[a], [xb, zb] = poly[b];
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
}

// Dreiecke nach 4-m-Feldern einsortieren, damit die Höhensuche auch bei großen Dioramen schnell ist
const CELL = 4, cells = new Map();
function indexTerrain() {
  for (const t of terrainTris) {
    const xs = t.map((p) => p[0]), zs = t.map((p) => p[2]);
    for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++)
      for (let j = Math.floor(Math.min(...zs) / CELL); j <= Math.floor(Math.max(...zs) / CELL); j++) {
        const key = i * 10000 + j;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(t);
      }
  }
}

function terrainHeight(x, z) {
  const list = cells.get(Math.floor(x / CELL) * 10000 + Math.floor(z / CELL)) || [];
  for (const [a, b, c] of list) {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * a[1] + l2 * b[1] + l3 * c[1];
  }
  return null;
}

function onDeck(x, z) {
  for (const j of decks) {
    const dx = j.x1 - j.x0, dz = j.z1 - j.z0, L2 = dx * dx + dz * dz;
    const t = ((x - j.x0) * dx + (z - j.z0) * dz) / L2;
    if (t < (j.flat ? 0 : -0.2) || t > (j.flat ? 1 : 1.1)) continue;
    if (Math.hypot(x - (j.x0 + t * dx), z - (j.z0 + t * dz)) < j.width / 2) return j.y;
  }
  return null;
}

function groundAt(x, z) {
  const d = onDeck(x, z);
  if (d != null) return d;
  return terrainHeight(x, z);
}

function walkable(x, z) {
  if (onDeck(x, z) != null) return true;
  if (!pointInPoly(x, z, M.area)) return false;
  const g = terrainHeight(x, z);
  if (g == null || g < M.water + 0.05) return false;      // nicht in den See laufen
  return !solids.some((f) => pointInPoly(x, z, f));
}

// ---------- Spieler und Steuerung ----------
const player = { pos: new THREE.Vector3(), vy: 0, yaw: 0, pitch: 0, fly: false, onGround: true };
const keys = new Set();
const joy = { x: 0, y: 0 };

function goHome() {
  // auf der Terrasse stehen und zum See schauen
  if (M.objects.platten) {
    // auf der Terrasse stehen und in den Garten schauen
    const p = M.objects.platten;
    return teleport(p.x, p.z, p.yaw + Math.PI, -6 * DEG);
  }
  const t = M.objects.terrasse;
  if (!t) return overview();
  const x = t.x, z = t.z;
  const [sx, sz] = M.objects.steg.see;
  teleport(x, z, Math.atan2(-(sx - x), -(sz - z)), -8 * DEG);
}

function overview() {
  // schräg von der Seite auf das ganze Diorama schauen
  const xs = M.area.map((p) => p[0]), zs = M.area.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  // kleine Grundstücke mit hohen Kiefern brauchen trotzdem Abstand
  const span = Math.max(40, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  player.fly = true;
  $('btn-fly').classList.add('on');
  if (M.radius) {
    // großer Umkreis: von Südosten über die Einmündung auf das Haus schauen
    const yaw = 0.75;
    player.pos.set(Math.sin(yaw) * 70, 55, Math.cos(yaw) * 70);
    player.yaw = yaw; player.pitch = -0.55;
    return;
  }
  const yaw = 1.15;                    // Blick von der Straße hinunter zum See (Nordwest)
  player.pos.set(cx + Math.sin(yaw + 0.35) * span * 1.05, 8 + span * 0.7, cz + Math.cos(yaw + 0.35) * span * 1.05);
  player.yaw = yaw + 0.05; player.pitch = -0.6;
}

function teleport(x, z, yaw, pitch) {
  player.pos.set(x, (groundAt(x, z) ?? 0) + EYE, z);
  player.yaw = yaw; player.pitch = pitch; player.vy = 0;
}

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyF') toggleFly();
  if (e.code === 'KeyH') goHome();
  if (e.code === 'KeyU') overview();
  if (e.code === 'Space' && !player.fly && player.onGround) { player.vy = JUMP; player.onGround = false; }
});
addEventListener('keyup', (e) => keys.delete(e.code));

function toggleFly() {
  player.fly = !player.fly;
  $('btn-fly').classList.toggle('on', player.fly);
  if (!player.fly) {
    const g = groundAt(player.pos.x, player.pos.z);
    if (g == null || !walkable(player.pos.x, player.pos.z)) goHome();
    player.vy = 0;
  }
}

const canvas = renderer.domElement;
let locked = false;
document.addEventListener('pointerlockchange', () => (locked = document.pointerLockElement === canvas));
document.addEventListener('mousemove', (e) => { if (locked) look(e.movementX * 0.0022, e.movementY * 0.0022); });
function look(dx, dy) {
  player.yaw -= dx;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy, -1.5, 1.5);
}
canvas.addEventListener('click', () => { if (!isTouch && !locked) canvas.requestPointerLock(); });

// Touch: linke Seite = gehen, rechte Seite = umsehen
const touches = new Map();
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touches.set(e.pointerId, { left: e.clientX < innerWidth * 0.4, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
});
canvas.addEventListener('pointermove', (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  if (t.left) {
    joy.x = THREE.MathUtils.clamp((e.clientX - t.x0) / 50, -1, 1);
    joy.y = THREE.MathUtils.clamp((e.clientY - t.y0) / 50, -1, 1);
    $('stick').style.transform = `translate(${joy.x * 35}px, ${joy.y * 35}px)`;
  } else look((e.clientX - t.x) * 0.005, (e.clientY - t.y) * 0.005);
  t.x = e.clientX; t.y = e.clientY;
});
const endTouch = (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  touches.delete(e.pointerId);
  if (t.left) { joy.x = joy.y = 0; $('stick').style.transform = ''; }
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function update(dt) {
  let mx = joy.x, mz = -joy.y;
  if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = player.fly ? FLY * (fast ? 3 : 1) : fast ? RUN : WALK;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(-fwd.z, 0, fwd.x);
  const dx = (fwd.x * mz + right.x * mx) * speed * dt, dz = (fwd.z * mz + right.z * mx) * speed * dt;
  const p = player.pos;
  if (player.fly) {
    p.x += dx; p.z += dz;
    if (keys.has('Space')) p.y += speed * dt;
    if (keys.has('KeyC')) p.y -= speed * dt;
    const g = groundAt(p.x, p.z);
    if (g != null) p.y = Math.max(p.y, g + 0.5);
  } else {
    if (walkable(p.x + dx, p.z + dz)) { p.x += dx; p.z += dz; }
    else if (walkable(p.x + dx, p.z)) p.x += dx;
    else if (walkable(p.x, p.z + dz)) p.z += dz;
    const g = groundAt(p.x, p.z) ?? p.y - EYE;
    player.vy -= GRAVITY * dt;
    p.y += player.vy * dt;
    if (p.y <= g + EYE) { p.y = g + EYE; player.vy = 0; player.onGround = true; }
  }
  camera.position.copy(p);
  if (skyMesh) skyMesh.position.set(p.x, 0, p.z);      // Himmel wandert mit, damit er nie abgeschnitten wird
  camera.rotation.set(player.pitch, player.yaw, 0);
  const heading = ((-player.yaw / DEG) % 360 + 360) % 360;
  $('pos').textContent = `${(p.y - EYE + M.base).toFixed(1)} m ü. NHN · Blick ${Math.round(heading)}°`;
}

// ---------- Übersichtskarte: Grundstück als Umriss ----------
const mini = $('minimap');
let mctx = mini.getContext('2d');
let mapView = null;
function drawMinimap() {
  const s = mini.width;
  if (!mapView) {
    const extra = M.objects.steg ? [M.objects.steg.see] : [];
    const xs = M.area.concat(extra).map((p) => p[0]);
    const zs = M.area.concat(extra).map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 1.15;
    mapView = { cx, cz, k: s / span };
  }
  const { cx, cz, k } = mapView;
  const tx = (x) => s / 2 + (x - cx) * k, tz = (z) => s / 2 + (z - cz) * k;
  if (mapView.bg) {
    mctx.drawImage(mapView.bg, 0, 0);
    drawPlayer(tx, tz);
    return;
  }
  // unbewegliche Teile nur einmal zeichnen und dann wiederverwenden
  const real = mctx;
  mapView.bg = document.createElement('canvas');
  mapView.bg.width = mapView.bg.height = s;
  mctx = mapView.bg.getContext('2d');
  mctx.fillStyle = '#eef0f2'; mctx.fillRect(0, 0, s, s);
  const poly = (pts, fill, stroke) => {
    mctx.beginPath();
    pts.forEach(([x, z], i) => (i ? mctx.lineTo(tx(x), tz(z)) : mctx.moveTo(tx(x), tz(z))));
    mctx.closePath();
    if (fill) { mctx.fillStyle = fill; mctx.fill(); }
    if (stroke) { mctx.strokeStyle = stroke; mctx.stroke(); }
  };
  if (M.waterArea.length) poly(M.waterArea, '#bcd3de');
  poly(M.area, '#ece6d6');
  if (M.radius) {
    mctx.lineWidth = 1;
    for (const [d, c] of [[M.roads, '#aaa69e'], [M.walks, '#c9a294']]) {
      mctx.fillStyle = c;
      for (const t of d.tris) {
        mctx.beginPath();
        t.forEach((k, i) => { const v = d.verts[k]; i ? mctx.lineTo(tx(v[0]), tz(v[2])) : mctx.moveTo(tx(v[0]), tz(v[2])); });
        mctx.fill();
      }
    }
    poly(M.parcel, null, '#d0453a');
  } else poly(M.parcel, '#e4dcc8', '#8f8574');
  M.buildings.forEach((b) => poly(b.foot, '#ffffff', '#666'));
  if (M.objects.steg) {
    const { land, see } = M.objects.steg;
    mctx.strokeStyle = '#b79a78'; mctx.lineWidth = 3;
    mctx.beginPath(); mctx.moveTo(tx(land[0]), tz(land[1])); mctx.lineTo(tx(see[0]), tz(see[1])); mctx.stroke();
  }
  mctx = real;
  mctx.drawImage(mapView.bg, 0, 0);
  drawPlayer(tx, tz);
}
function drawPlayer(tx, tz) {
  mctx.lineWidth = 1.5;
  mctx.save();
  mctx.translate(tx(player.pos.x), tz(player.pos.z));
  mctx.rotate(-player.yaw);
  mctx.fillStyle = '#222';
  mctx.beginPath(); mctx.moveTo(0, -7); mctx.lineTo(4.5, 5); mctx.lineTo(0, 2.5); mctx.lineTo(-4.5, 5); mctx.closePath();
  mctx.fill();
  mctx.restore();
}
mini.addEventListener('click', (e) => {
  if (!mapView) return;
  const r = mini.getBoundingClientRect();
  const x = mapView.cx + ((e.clientX - r.left) / r.width * mini.width - mini.width / 2) / mapView.k;
  const z = mapView.cz + ((e.clientY - r.top) / r.height * mini.width - mini.width / 2) / mapView.k;
  if (player.fly) player.pos.set(x, player.pos.y, z);
  else if (walkable(x, z)) teleport(x, z, player.yaw, player.pitch);
});

$('btn-fly').onclick = toggleFly;
$('btn-home').onclick = goHome;
$('btn-overview').onclick = overview;
$('btn-help').onclick = () => { $('start').classList.remove('hidden'); document.exitPointerLock?.(); };
$('btn-start').onclick = () => { $('start').classList.add('hidden'); if (!isTouch) canvas.requestPointerLock(); };

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const clock = new THREE.Clock();
let frame = 0;
renderer.setAnimationLoop(() => {
  if (!M) return;
  update(Math.min(clock.getDelta(), 0.1));
  renderer.render(scene, camera);
  if (frame++ % 4 === 0) drawMinimap();
});

window.pinnow = { player, teleport, goHome, overview, groundAt };

load().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Fehler beim Laden: ' + err.message;
});
