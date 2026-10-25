import * as THREE from 'three';

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

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b2a6, 1.9));
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

// Welches Grundstück: ?ort=16 (Standard) oder ?ort=89
const SITE = new URLSearchParams(location.search).get('ort') === '89' ? '89' : '16';
document.querySelectorAll('#sites button').forEach((b) => {
  b.classList.toggle('on', b.dataset.ort === SITE);
  b.onclick = () => { if (b.dataset.ort !== SITE) location.search = '?ort=' + b.dataset.ort; };
});

async function load() {
  M = await (await fetch(`data/am-see-${SITE}.json`, { cache: 'no-cache' })).json();
  const name = 'Pinnow · ' + M.title;
  $('title').textContent = $('site-title').textContent = document.title = name;
  $('site-sub').textContent = M.subtitle;
  $('btn-home').classList.toggle('hidden', !M.objects.terrasse);
  buildGround();
  buildWater();
  M.buildings.forEach(buildHouse);
  buildVegetation();
  buildPhotoObjects();
  renderer.shadowMap.needsUpdate = true;
  $('loading').textContent = '';
  $('btn-start').disabled = false;
  overview();
}

// ---------- Gelände mit Sockel ----------
function buildGround() {
  const { verts, tris, edge, bottom } = M.ground;
  const pos = [];
  for (const t of tris) for (const k of t) pos.push(...verts[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  add(new THREE.Mesh(g, mat(COLORS.ground, { side: THREE.DoubleSide })));
  for (const t of tris) terrainTris.push(t.map((k) => verts[k]));

  // Seitenwände des Dioramas entlang der Grundstücksgrenze
  const w = [];
  for (let k = 0; k < edge; k++) {
    const a = verts[k], b = verts[(k + 1) % edge];
    w.push(...a, ...b, b[0], bottom, b[2], ...a, b[0], bottom, b[2], a[0], bottom, a[2]);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(w, 3));
  wg.computeVertexNormals();
  add(new THREE.Mesh(wg, mat(COLORS.plinth, { side: THREE.DoubleSide })));
  // Bodenplatte
  const shape = new THREE.Shape(M.area.map(([x, z]) => new THREE.Vector2(x, -z)));
  const base = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), mat(COLORS.plinth, { side: THREE.DoubleSide }));
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

// ---------- Haus aus LoD2 ----------
function buildHouse(b) {
  for (const [key, color] of [['wall', COLORS.wall], ['roof', COLORS.roof]]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b[key], 3));
    g.computeVertexNormals();
    add(new THREE.Mesh(g, mat(color, { side: THREE.DoubleSide })));
  }
  solids.push(b.foot);
}

// ---------- Bewuchs aus dem nDOM ----------
function buildVegetation() {
  const v = M.vegetation;
  const leaves = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), v.length);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  v.forEach(([x, z, y, thick, h], k) => {
    m.makeScale(0.96, thick, 0.96).setPosition(x, y + thick / 2, z);
    leaves.setMatrixAt(k, m);
    c.setHex(COLORS.leaf[Math.min(3, Math.floor(h / 6))]);
    leaves.setColorAt(k, c);
  });
  add(leaves);
  const tg = new THREE.CylinderGeometry(1, 1, 1, 6);
  for (const [x, z, y0, y1, r] of M.trunks) {
    const t = add(new THREE.Mesh(tg, mat(COLORS.trunk)));
    t.scale.set(r, y1 - y0, r);
    t.position.set(x, (y0 + y1) / 2, z);
  }
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

function terrainHeight(x, z) {
  for (const [a, b, c] of terrainTris) {
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
    if (t < -0.2 || t > 1.1) continue;
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
  camera.rotation.set(player.pitch, player.yaw, 0);
  const heading = ((-player.yaw / DEG) % 360 + 360) % 360;
  $('pos').textContent = `${(p.y - EYE + M.base).toFixed(1)} m ü. NHN · Blick ${Math.round(heading)}°`;
}

// ---------- Übersichtskarte: Grundstück als Umriss ----------
const mini = $('minimap'), mctx = mini.getContext('2d');
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
  poly(M.parcel, '#e4dcc8', '#8f8574');
  M.buildings.forEach((b) => poly(b.foot, '#ffffff', '#666'));
  if (M.objects.steg) {
    const { land, see } = M.objects.steg;
    mctx.strokeStyle = '#b79a78'; mctx.lineWidth = 3;
    mctx.beginPath(); mctx.moveTo(tx(land[0]), tz(land[1])); mctx.lineTo(tx(see[0]), tz(see[1])); mctx.stroke();
  }
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
