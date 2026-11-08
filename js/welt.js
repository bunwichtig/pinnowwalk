import * as THREE from 'three';

// Weltkarte rund um Pinnow: 14 x 14 km in 1-km-Kacheln, nur der Umkreis von 3 km wird geladen.
// Grobe Pixelgrafik: das Bild wird in niedriger Auflösung gerechnet und ohne Glättung hochskaliert.
const LOAD_R = 3000, DROP_R = 3500, TREE_R = 1500;
const EYE = 1.7, WALK = 4, RUN = 14, FLY = 30, FLY_FAST = 150, GRAVITY = 20, JUMP = 5;
const DEG = Math.PI / 180;
const PIX = [{ name: 'grob', h: 200 }, { name: 'mittel', h: 320 }, { name: 'fein', h: 540 }];
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');
const V = '?v=1';

// ---------- Renderer, Szene ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: false, powerPreference: 'high-performance' });
let pixLevel = 0;
try { pixLevel = Math.min(2, +localStorage.getItem('welt-pix') || 0); } catch { /* ohne Speicher */ }
function resize() {
  renderer.setPixelRatio(PIX[pixLevel].h / innerHeight);
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  $('btn-pix').textContent = '▦ ' + PIX[pixLevel].name;
}
const SKY = 0xb9d6ea;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 1400, LOAD_R - 100);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.5, LOAD_R + 500);
camera.rotation.order = 'YXZ';
resize();
addEventListener('resize', resize);

scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x56663c, 1.7));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.9);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

const groundMat = new Map();   // Kachel -> Material mit Pixeltextur
const buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

let META;
const tiles = new Map();       // "i_j" -> { state, data, group, lod, trees }

// ---------- Kachel laden und bauen ----------
function tileOrigin(i, j) {    // lokale Koordinaten der Nordwest-Ecke
  return [META.nw[0] + i * 1000 - META.origin[0], META.origin[1] - (META.nw[1] - j * 1000)];
}

async function fetchTile(key) {
  const [buf, img] = await Promise.all([
    fetch(`data/welt/${key}.bin${V}`).then((r) => r.arrayBuffer()),
    new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = `data/welt/${key}.png${V}`; }),
  ]);
  const [n, nTrees, nVerts] = new Uint32Array(buf, 0, 4);
  let o = 16;
  const heights = new Uint16Array(buf, o, n * n); o += n * n * 2;
  const trees = new Int16Array(buf, o, nTrees * 3); o += nTrees * 6;
  const verts = new Int16Array(buf, o, nVerts * 3); o += nVerts * 6;
  const cols = new Uint8Array(buf, o, nVerts / 3);
  const tex = new THREE.Texture(img);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { n, heights, trees, verts, cols, tex };
}

function buildTerrain(t, lod) {
  const { n, heights } = t.data;
  const [x0, z0] = t.origin;
  const m = (n - 1) / lod + 1;
  const pos = new Float32Array(m * m * 3), uv = new Float32Array(m * m * 2);
  for (let r = 0; r < m; r++)
    for (let c = 0; c < m; c++) {
      const k = r * m + c, R = r * lod, C = c * lod;
      pos[k * 3] = x0 + C * 10; pos[k * 3 + 1] = heights[R * n + C] / 10; pos[k * 3 + 2] = z0 + R * 10;
      uv[k * 2] = C / (n - 1); uv[k * 2 + 1] = 1 - R / (n - 1);
    }
  const idx = [];
  for (let r = 0; r < m - 1; r++)
    for (let c = 0; c < m - 1; c++) {
      const a = r * m + c, b = a + 1, d = a + m, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  // Schürzen an den Rändern verdecken Spalten zwischen Kacheln mit verschiedener Auflösung
  const edge = [];
  for (let c = 0; c < m; c++) edge.push(c);
  for (let r = 1; r < m; r++) edge.push(r * m + m - 1);
  for (let c = m - 2; c >= 0; c--) edge.push((m - 1) * m + c);
  for (let r = m - 2; r >= 0; r--) edge.push(r * m);
  const base = m * m, P = Array.from(pos), U = Array.from(uv);
  edge.forEach((k) => { P.push(pos[k * 3], pos[k * 3 + 1] - 25, pos[k * 3 + 2]); U.push(uv[k * 2], uv[k * 2 + 1]); });
  for (let q = 0; q < edge.length - 1; q++) idx.push(edge[q], base + q, edge[q + 1], edge[q + 1], base + q, base + q + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, t.mat);
}

function buildBuildings(t) {
  const { verts, cols } = t.data;
  if (!verts.length) return null;
  const [x0, z0] = t.origin;
  const pos = new Float32Array(verts.length), col = new Float32Array(verts.length);
  const c = new THREE.Color();
  for (let k = 0; k < verts.length; k += 3) {
    pos[k] = x0 + verts[k] / 10; pos[k + 1] = verts[k + 1] / 10; pos[k + 2] = z0 + verts[k + 2] / 10;
  }
  for (let f = 0; f < cols.length; f++) {
    const ci = cols[f], rgb = ci >= 10 ? META.walls[ci - 10] : META.roofs[ci];
    c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], (f * 3 + v) * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, buildingMat);
}

// Baum-Grundformen (Höhe 1): Kiefer = Kegel, Laubbaum = Klotzkrone; Stamm braun, Krone weiß (wird eingefärbt)
function treeGeo(kind) {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.4, 4).translate(0, 0.2, 0);
  const crown = kind === 0
    ? new THREE.ConeGeometry(0.2, 0.7, 5).translate(0, 0.62, 0)
    : new THREE.IcosahedronGeometry(0.3, 0).translate(0, 0.62, 0);
  const parts = [[trunk, [0.55, 0.42, 0.32]], [crown, [1, 1, 1]]];
  const pos = [], col = [];
  for (const [g0, rgb] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.attributes.position.array;
    pos.push(...p);
    for (let k = 0; k < p.length / 3; k++) col.push(...rgb);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
const TREE_GEO = [treeGeo(0), treeGeo(1)];
const LEAF = [[0x2e5a2c, 0x3a6b35, 0x2a4f2e], [0x4f7f3a, 0x5d8a40, 0x6b9446]].map((a) => a.map((h) => new THREE.Color(h)));

function buildTrees(t) {
  const tr = t.data.trees, nT = tr.length / 3;
  if (!nT) return null;
  const [x0, z0] = t.origin;
  // auf dem Handy jeden zweiten Baum weglassen
  const step = isTouch ? 2 : 1;
  const lists = [[], []];
  for (let k = 0; k < nT; k += step) {
    const x = x0 + tr[k * 3] / 10, z = z0 + tr[k * 3 + 1] / 10, h = tr[k * 3 + 2] / 10;
    const hash = (tr[k * 3] * 73856093) ^ (tr[k * 3 + 1] * 19349663);
    lists[(hash & 7) < 5 ? 0 : 1].push([x, z, h, hash]);
  }
  const grp = new THREE.Group(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  lists.forEach((list, kind) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(TREE_GEO[kind], treeMat, list.length);
    list.forEach(([x, z, h, hash], k) => {
      const w = h * (kind === 0 ? 0.9 : 1.1);
      const g = heightAt(x, z) ?? 0;
      m.compose(p.set(x, g, z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, (hash & 255) / 40), s.set(w, h, w));
      im.setMatrixAt(k, m);
      im.setColorAt(k, LEAF[kind][(hash >>> 3) % 3]);
    });
    im.computeBoundingSphere();
    grp.add(im);
  });
  return grp;
}

function lodFor(d) { return d < 900 ? 1 : d < 1900 ? 2 : 4; }

function distToTile(i, j, x, z) {
  const [x0, z0] = tileOrigin(i, j);
  const dx = Math.max(x0 - x, 0, x - (x0 + 1000)), dz = Math.max(z0 - z, 0, z - (z0 + 1000));
  return Math.hypot(dx, dz);
}

let inflight = 0;
function updateTiles() {
  const { x, z } = player.pos;
  const want = [];
  for (let i = 0; i < META.tiles; i++)
    for (let j = 0; j < META.tiles; j++) {
      const key = `${i}_${j}`, d = distToTile(i, j, x, z), t = tiles.get(key);
      if (d <= LOAD_R) {
        if (!t) want.push([d, i, j, key]);
        else if (t.state === 'ready') refreshTile(t, d);
      } else if (t && d > DROP_R && t.state === 'ready') dropTile(key, t);
    }
  want.sort((a, b) => a[0] - b[0]);
  for (const [, i, j, key] of want) {
    if (inflight >= 4) break;
    const t = { state: 'loading', origin: tileOrigin(i, j), group: new THREE.Group(), lod: 0, i, j };
    tiles.set(key, t);
    inflight++;
    fetchTile(key).then((data) => {
      t.data = data;
      t.mat = new THREE.MeshLambertMaterial({ map: data.tex, flatShading: true });
      const b = buildBuildings(t);
      if (b) t.group.add(b);
      scene.add(t.group);
      t.state = 'ready';
      refreshTile(t, distToTile(i, j, player.pos.x, player.pos.z));
    }).catch((e) => { console.warn('Kachel', key, e); t.state = 'failed'; })
      .finally(() => { inflight--; });
  }
}

function refreshTile(t, d) {
  const lod = lodFor(d);
  if (lod !== t.lod) {
    if (t.terrain) { t.group.remove(t.terrain); t.terrain.geometry.dispose(); }
    t.terrain = buildTerrain(t, lod);
    t.group.add(t.terrain);
    t.lod = lod;
  }
  const wantTrees = d < TREE_R;
  if (wantTrees && !t.trees) { t.trees = buildTrees(t); if (t.trees) t.group.add(t.trees); }
  if (!wantTrees && t.trees) { t.group.remove(t.trees); t.trees.children.forEach((c) => c.dispose()); t.trees = null; }
}

function dropTile(key, t) {
  scene.remove(t.group);
  t.group.traverse((o) => { if (o.isMesh && o.geometry !== TREE_GEO[0] && o.geometry !== TREE_GEO[1]) o.geometry.dispose(); });
  t.trees?.children.forEach((c) => c.dispose());
  t.mat.dispose(); t.data.tex.dispose();
  tiles.delete(key);
}

// Geländehöhe (bilinear im 10-m-Raster der Kachel)
function heightAt(x, z) {
  const E = x + META.origin[0], N = META.origin[1] - z;
  const i = Math.floor((E - META.nw[0]) / 1000), j = Math.floor((META.nw[1] - N) / 1000);
  const t = tiles.get(`${i}_${j}`);
  if (!t || !t.data) return null;
  const [x0, z0] = t.origin, n = t.data.n, h = t.data.heights;
  const fc = Math.min((x - x0) / 10, n - 1.001), fr = Math.min((z - z0) / 10, n - 1.001);
  const c = Math.floor(fc), r = Math.floor(fr), u = fc - c, v = fr - r;
  const at = (rr, cc) => h[rr * n + cc] / 10;
  return (at(r, c) * (1 - u) + at(r, c + 1) * u) * (1 - v) + (at(r + 1, c) * (1 - u) + at(r + 1, c + 1) * u) * v;
}

// ---------- Orte (Dioramen) ----------
const places = [];
function buildPlaces() {
  for (const p of META.places) {
    const x = p.e - META.origin[0], z = META.origin[1] - p.n;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(2, 60, 2),
      new THREE.MeshBasicMaterial({ color: 0xff9b3d, transparent: true, opacity: 0.7, fog: false }));
    pillar.position.set(x, 0, z);
    scene.add(pillar);
    places.push({ ...p, x, z, pillar });
  }
}
function updatePlaces() {
  let near = null;
  places.forEach((p, k) => {
    const g = heightAt(p.x, p.z);
    if (g != null) p.pillar.position.y = g + 30 + k * 8;
    const d = Math.hypot(player.pos.x - p.x, player.pos.z - p.z);
    if (d < 45 && (!near || d < near.d)) near = { p, d };
  });
  $('place').classList.toggle('hidden', !near);
  if (near) { $('place-name').textContent = near.p.name; $('place-link').href = near.p.link; nearPlace = near.p; }
  else nearPlace = null;
}
let nearPlace = null;

// ---------- Spieler und Steuerung ----------
const player = { pos: new THREE.Vector3(0, 80, 0), vy: 0, yaw: 0.6, pitch: -0.3, fly: true, onGround: false };
const keys = new Set();
const joy = { x: 0, y: 0 };
const touchBtn = { up: false, down: false, fast: false };

function goHome() {
  const p = places[0];
  player.fly = true; setFly();
  player.pos.set(p.x + 60, (heightAt(p.x, p.z) ?? 28) + 45, p.z + 60);
  player.yaw = Math.PI / 4 + 0.1; player.pitch = -0.45;
}

function setFly() {
  $('btn-fly').classList.toggle('on', player.fly);
  document.body.classList.toggle('flying', player.fly);
}
function toggleFly() { player.fly = !player.fly; player.vy = 0; setFly(); }

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyF') toggleFly();
  if (e.code === 'KeyH') goHome();
  if (e.code === 'KeyP') cyclePix();
  if (e.code === 'KeyE' && nearPlace) location.href = nearPlace.link;
  if (e.code === 'Space' && !player.fly && player.onGround) { player.vy = JUMP; player.onGround = false; }
});
addEventListener('keyup', (e) => keys.delete(e.code));
function cyclePix() {
  pixLevel = (pixLevel + 1) % PIX.length;
  try { localStorage.setItem('welt-pix', pixLevel); } catch { /* egal */ }
  resize();
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
for (const [id, k] of [['btn-up', 'up'], ['btn-down', 'down']]) {
  $(id).addEventListener('pointerdown', () => (touchBtn[k] = true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $(id).addEventListener(ev, () => (touchBtn[k] = false));
}
$('btn-fast').onclick = () => { touchBtn.fast = !touchBtn.fast; $('btn-fast').classList.toggle('on', touchBtn.fast); };

const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function update(dt) {
  let mx = joy.x, mz = -joy.y;
  if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') || touchBtn.fast;
  const speed = player.fly ? (fast ? FLY_FAST : FLY) : fast ? RUN : WALK;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(-fwd.z, 0, fwd.x);
  const p = player.pos;
  const nx = p.x + (fwd.x * mz + right.x * mx) * speed * dt, nz = p.z + (fwd.z * mz + right.z * mx) * speed * dt;
  // nicht aus der Welt hinaus
  const [wx0, wz0] = tileOrigin(0, 0), wx1 = wx0 + META.tiles * 1000, wz1 = wz0 + META.tiles * 1000;
  p.x = THREE.MathUtils.clamp(nx, wx0 + 5, wx1 - 5);
  p.z = THREE.MathUtils.clamp(nz, wz0 + 5, wz1 - 5);
  const g = heightAt(p.x, p.z);
  if (player.fly) {
    if (keys.has('Space') || touchBtn.up) p.y += speed * dt;
    if (keys.has('KeyC') || touchBtn.down) p.y -= speed * dt;
    p.y = Math.min(p.y, 1500);
    if (g != null) p.y = Math.max(p.y, g + 1);
  } else if (g != null) {
    player.vy -= GRAVITY * dt;
    p.y += player.vy * dt;
    if (p.y <= g + EYE) { p.y = g + EYE; player.vy = 0; player.onGround = true; }
  }
  camera.position.copy(p);
  camera.rotation.set(player.pitch, player.yaw, 0);
  const heading = ((-player.yaw / DEG) % 360 + 360) % 360;
  const above = g != null ? ` · ${Math.round(p.y - g)} m über Grund` : '';
  $('pos').textContent = `${Math.round(p.y)} m ü. NHN${above} · Blick ${Math.round(heading)}°`;
}

// ---------- Karte unten rechts ----------
const mini = $('minimap'), mctx = mini.getContext('2d');
mctx.imageSmoothingEnabled = false;
const ov = new Image();
ov.src = `data/welt/overview.png${V}`;
const MAP_SPAN = 8000;               // Kartenausschnitt in m
function drawMinimap() {
  const s = mini.width, k = s / MAP_SPAN;            // Pixel je m
  const ovk = ov.width / (META.tiles * 1000);       // Übersichtspixel je m
  const E = player.pos.x + META.origin[0], N = META.origin[1] - player.pos.z;
  mctx.fillStyle = '#20302a'; mctx.fillRect(0, 0, s, s);
  if (ov.complete && ov.width) {
    const sx = (E - META.nw[0] - MAP_SPAN / 2) * ovk, sy = (META.nw[1] - N - MAP_SPAN / 2) * ovk;
    mctx.drawImage(ov, sx, sy, MAP_SPAN * ovk, MAP_SPAN * ovk, 0, 0, s, s);
  }
  mctx.strokeStyle = 'rgba(255,255,255,.5)'; mctx.setLineDash([4, 4]);
  mctx.beginPath(); mctx.arc(s / 2, s / 2, LOAD_R * k, 0, Math.PI * 2); mctx.stroke();
  mctx.setLineDash([]);
  for (const p of places) {
    mctx.fillStyle = '#ff9b3d';
    mctx.fillRect(s / 2 + (p.x - player.pos.x) * k - 2, s / 2 + (p.z - player.pos.z) * k - 2, 4, 4);
  }
  mctx.save();
  mctx.translate(s / 2, s / 2);
  mctx.rotate(-player.yaw);
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#222';
  mctx.beginPath(); mctx.moveTo(0, -8); mctx.lineTo(5, 6); mctx.lineTo(0, 3); mctx.lineTo(-5, 6); mctx.closePath();
  mctx.fill(); mctx.stroke();
  mctx.restore();
}
mini.addEventListener('click', (e) => {
  const r = mini.getBoundingClientRect();
  const k = mini.width / MAP_SPAN;
  player.pos.x += ((e.clientX - r.left) / r.width * mini.width - mini.width / 2) / k;
  player.pos.z += ((e.clientY - r.top) / r.height * mini.width - mini.width / 2) / k;
  if (!player.fly) { player.fly = true; setFly(); player.pos.y += 60; }
});

$('btn-fly').onclick = toggleFly;
$('btn-home').onclick = goHome;
$('btn-pix').onclick = cyclePix;
$('btn-help').onclick = () => { $('start').classList.remove('hidden'); document.exitPointerLock?.(); };
$('btn-start').onclick = () => { $('start').classList.add('hidden'); if (!isTouch) canvas.requestPointerLock(); };

// ---------- Start ----------
async function load() {
  META = await (await fetch(`data/welt/meta.json${V}`, { cache: 'no-cache' })).json();
  buildPlaces();
  const p = places[0];
  // schräg über Am See 16, Blick nach Nordwesten über den Pinnower See
  player.pos.set(p.x + 90, 90, p.z + 110);
  player.yaw = 0.6; player.pitch = -0.32;
  setFly();
  updateTiles();
  const wait = () => {
    const ready = [...tiles.values()].filter((t) => t.state === 'ready').length;
    $('loading').textContent = `Lade Karte … ${ready} Kacheln`;
    if (heightAt(p.x, p.z) != null && ready >= 9) {
      player.pos.y = heightAt(p.x, p.z) + 70;
      $('loading').textContent = '';
      $('btn-start').disabled = false;
    } else setTimeout(wait, 200);
  };
  wait();
}

const clock = new THREE.Clock();
let frame = 0;
renderer.setAnimationLoop(() => {
  if (!META) return;
  update(Math.min(clock.getDelta(), 0.1));
  if (frame % 15 === 0) updateTiles();
  if (frame % 5 === 0) { updatePlaces(); drawMinimap(); }
  frame++;
  renderer.render(scene, camera);
});

window.welt = { player, tiles, heightAt, goHome, renderer };

load().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Fehler beim Laden: ' + err.message;
});
