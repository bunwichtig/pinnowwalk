import * as THREE from 'three';

// Am See 16 mit 100 m Umgebung: alles aus Messdaten (DGM1, LoD2, nDOM, ALKIS, OSM) und den eigenen Fotos.
// Stil: Architekturmodell ohne Fototexturen, aber mit weichem Licht, Himmel, Schatten und lebendigen Farben.
const EYE = 1.7;
const WALK = 2.5, RUN = 6, FLY = 14;
const GRAVITY = 20, JUMP = 5;
const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');

const COLORS = {
  plinth: 0x6e5a46, plinthDark: 0x4a3c30, water: 0x4d7f9c, trunk: 0x6b5a4c, trunkPine: 0xb8693c,
  wood: 0x9b958a, concrete: 0xc9c6bf, boat: 0xffffff, bed: 0x7d5f45, stone: 0xb0aaa0, roofSheet: 0xa3a596,
  // Wände nach den Fotos: eigenes Haus und Schuppen dunkelbraune Bretter, Wohnhäuser cremegelbe Holzverschalung
  walls: { ownwood: 0x5e4633, shed: 0x4f3b2c, cream: 0xe4cf98, creamlight: 0xeee0b6, salmon: 0xe6c09d, white: 0xece8de },
  bush: [0x6f9a4c, 0x7ba657, 0x5f8a44],
  reed: 0xffffff, reeds: [0x7d8a45, 0x6f7f3e, 0x8f9450],
  fencePost: 0x7d6a55, lattice: 0x8e7a63, plank: 0xb0703f,
};
// Bodenfarben je Bodenart aus build_area.py
const COVER = { g: [0.40, 0.56, 0.25], d: [0.58, 0.60, 0.36], f: [0.38, 0.35, 0.22], b: [0.50, 0.38, 0.27],
  s: [0.74, 0.66, 0.47], r: [0.68, 0.53, 0.41], w: [0.36, 0.42, 0.30] };

// ---------- Renderer, Szene, Licht ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;     // alles steht still: Schatten nur einmal berechnen

const scene = new THREE.Scene();
const SKY_TOP = new THREE.Color(0x5d93cf), SKY_HORIZON = new THREE.Color(0xdfe8ee);
scene.background = SKY_HORIZON;
scene.fog = new THREE.Fog(0xdfe8ee, 220, 520);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1500);
camera.rotation.order = 'YXZ';

// Himmel als Farbverlauf
{
  const g = new THREE.SphereGeometry(900, 32, 16);
  const c = [], p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, p.getY(i) / 900);
    const col = SKY_HORIZON.clone().lerp(SKY_TOP, Math.pow(t, 0.6));
    c.push(col.r, col.g, col.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
}

scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x8a7a5c, 1.45));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
sun.position.set(-90, 120, 110);          // Nachmittagssonne aus Südwest
sun.castShadow = true;
sun.shadow.mapSize.set(isTouch ? 2048 : 4096, isTouch ? 2048 : 4096);
Object.assign(sun.shadow.camera, { left: -115, right: 115, top: 115, bottom: -115, near: 10, far: 400 });
sun.shadow.normalBias = 0.08;
sun.shadow.bias = -0.0005;
scene.add(sun);

const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const add = (mesh) => { mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); return mesh; };
const rnd = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

let M;               // Modelldaten
let N, R;            // Rastergröße, Radius
let H;               // Höhen (Float32Array, N*N)
const solids = [];   // Grundrisse, durch die man nicht laufen kann

// Startpunkt: ?ort=16 (Standard) oder ?ort=89
let SITE = new URLSearchParams(location.search).get('ort') === '89' ? '89' : '16';
document.querySelectorAll('#sites button').forEach((b) => {
  b.classList.toggle('on', b.dataset.ort === SITE);
  if (b.dataset.ort === SITE && SITE === '89') $('site-title').textContent = 'Pinnow · Flurstück 89';
  b.onclick = () => {
    SITE = b.dataset.ort;
    document.querySelectorAll('#sites button').forEach((x) => x.classList.toggle('on', x === b));
    history.replaceState(null, '', '?ort=' + SITE);
    $('site-title').textContent = SITE === '89' ? 'Pinnow · Flurstück 89' : 'Pinnow · Am See 16';
  };
});

async function load() {
  M = await (await fetch('data/umgebung.json', { cache: 'no-cache' })).json();
  R = M.radius; N = 2 * R + 1;
  H = Float32Array.from(M.heights, (v) => v / 100);
  buildGround();
  buildWater();
  M.buildings.forEach((b) => buildHouse(b));
  buildVegetation();
  buildFences();
  buildPhotoObjects();
  buildParcels();
  renderer.shadowMap.needsUpdate = true;
  $('loading').textContent = '';
  $('btn-start').disabled = false;
  overview();
}

// ---------- Gelände aus dem 1-m-Raster, mit Sockel ----------
const idx = (i, j) => j * N + i;         // i = Spalte (x), j = Zeile (z)
const inCircle = (i, j) => (i - R) ** 2 + (j - R) ** 2 <= (R + 1.45) ** 2;
function buildGround() {
  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
  const cv = M.cover;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = idx(i, j);
      let x = i - R, z = j - R, y = H[k];
      const d = Math.hypot(x, z);
      if (d > R) { x *= R / d; z *= R / d; y = terrainHeight(x, z); }   // Rand genau auf den Kreis legen
      pos.set([x, y, z], k * 3);
      const c = COVER[cv[k]] || COVER.g;
      // leichte Unruhe in der Farbe, Hänge etwas dunkler
      const slope = Math.min(1, Math.abs((H[idx(Math.min(i + 1, N - 1), j)] - H[idx(Math.max(i - 1, 0), j)])) +
        Math.abs((H[idx(i, Math.min(j + 1, N - 1))] - H[idx(i, Math.max(j - 1, 0))])));
      const n = 0.92 + rnd(k) * 0.14 - slope * 0.12;
      col.set([c[0] * n, c[1] * n, c[2] * n], k * 3);
    }
  const index = [];
  for (let j = 0; j < N - 1; j++)
    for (let i = 0; i < N - 1; i++) {
      if (!inCircle(i, j) || !inCircle(i + 1, j) || !inCircle(i, j + 1) || !inCircle(i + 1, j + 1)) continue;
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i, j + 1), d = idx(i + 1, j + 1);
      index.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  scene.add(ground);

  // Rand des Kreises: Erdschichten bis zum Boden, darüber wo nötig Wasser
  const bottom = Math.min(...H) - 4;
  M.bottom = bottom;
  const rim = [];
  for (let a = 0; a < 360; a += 1) {
    const t = a * DEG, x = Math.cos(t) * R, z = Math.sin(t) * R;
    rim.push([x, z, terrainHeight(x, z) ?? bottom]);
  }
  const w = [], wc = [], ww = [];
  const top = new THREE.Color(0x5e4b3a), mid = new THREE.Color(COLORS.plinth), low = new THREE.Color(0x8b765c);
  for (let k = 0; k < rim.length; k++) {
    const [x1, z1, h1] = rim[k], [x2, z2, h2] = rim[(k + 1) % rim.length];
    // drei Schichten: Mutterboden, Lehm, Sand
    const layers = [[h1, h2, top], [h1 - 0.6, h2 - 0.6, mid], [(h1 + bottom) / 2, (h2 + bottom) / 2, low]];
    const ends = [[h1 - 0.6, h2 - 0.6], [(h1 + bottom) / 2, (h2 + bottom) / 2], [bottom, bottom]];
    layers.forEach(([a1, a2, c], L) => {
      const [b1, b2] = ends[L];
      w.push(x1, a1, z1, x2, a2, z2, x2, b2, z2, x1, a1, z1, x2, b2, z2, x1, b1, z1);
      for (let q = 0; q < 6; q++) wc.push(c.r, c.g, c.b);
    });
    if (h1 < M.water || h2 < M.water) {
      const t1 = Math.min(h1, M.water), t2 = Math.min(h2, M.water);
      ww.push(x1, M.water, z1, x2, M.water, z2, x2, t2, z2, x1, M.water, z1, x2, t2, z2, x1, t1, z1);
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(w, 3));
  wg.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3));
  wg.computeVertexNormals();
  scene.add(new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(ww, 3));
  sg.computeVertexNormals();
  scene.add(new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ color: COLORS.water, transparent: true, opacity: 0.7, side: THREE.DoubleSide })));
  const base = new THREE.Mesh(new THREE.CircleGeometry(R, 120).rotateX(-Math.PI / 2), mat(COLORS.plinthDark, { side: THREE.DoubleSide }));
  base.position.y = bottom;
  scene.add(base);
}

let waterMat;
function buildWater() {
  waterMat = new THREE.MeshPhongMaterial({ color: COLORS.water, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.82 });
  const water = new THREE.Mesh(new THREE.CircleGeometry(R, 120).rotateX(-Math.PI / 2), waterMat);
  water.position.y = M.water;
  water.receiveShadow = true;
  scene.add(water);
}

// ---------- Häuser aus LoD2: Dach in der Farbe aus dem Luftbild, Wände nach den Fotos ----------
function buildHouse(b) {
  for (const [color, key] of [[COLORS.walls[b.wallTone] ?? COLORS.walls.cream, 'wall'], [new THREE.Color(b.roofRGB), 'roof']]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b[key], 3));
    g.computeVertexNormals();
    add(new THREE.Mesh(g, mat(color, { side: THREE.DoubleSide })));
  }
  solids.push(b.foot);
}

// ---------- Bewuchs aus dem nDOM: Blöcke an der gemessenen Kronenoberfläche, je Baum eine Farbe ----------
function buildVegetation() {
  const m = new THREE.Matrix4(), c = new THREE.Color();
  const blocks = add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(0xffffff), M.blocks.length));
  M.blocks.forEach(([x, z, y, thick, size, t], k) => {
    const s = size * 0.97;
    m.makeScale(s, thick, s).setPosition(x, y + thick / 2, z);
    blocks.setMatrixAt(k, m);
    c.set(t ? M.treeColors[t] : COLORS.bush[k % COLORS.bush.length]);
    c.offsetHSL(0, 0, (rnd(k) - 0.5) * 0.05);
    blocks.setColorAt(k, c);
  });
  // Kiefernstämme: unten graubraune Borke, oben die orange Spiegelrinde (Fotos)
  const geo = new THREE.CylinderGeometry(0.8, 1, 1, 7);
  const low = add(new THREE.InstancedMesh(geo, mat(COLORS.trunk), M.trunks.length));
  const high = add(new THREE.InstancedMesh(geo, mat(COLORS.trunkPine), M.trunks.length));
  M.trunks.forEach(([x, z, y0, y1, r], k) => {
    const split = y0 + (y1 - y0) * 0.55;
    m.makeScale(r, split - y0, r).setPosition(x, (y0 + split) / 2, z);
    low.setMatrixAt(k, m);
    m.makeScale(r * 0.8, y1 - split, r * 0.8).setPosition(x, (split + y1) / 2, z);
    high.setMatrixAt(k, m);
  });
  // Schilf am Ufer
  const reeds = new THREE.InstancedMesh(new THREE.ConeGeometry(0.22, 1, 5, 1, true), mat(COLORS.reed, { side: THREE.DoubleSide }), M.reeds.length);
  M.reeds.forEach(([x, z], k) => {
    const g = Math.max(terrainHeight(x, z) ?? M.water, M.water - 0.1), h = 1.3 + rnd(k * 3) * 0.8;
    m.makeScale(0.7 + rnd(k) * 0.5, h, 0.7 + rnd(k + 9) * 0.5).setPosition(x + rnd(k * 7) - 0.5, g + h / 2, z + rnd(k * 5) - 0.5);
    reeds.setMatrixAt(k, m);
    reeds.setColorAt(k, c.setHex(COLORS.reeds[k % COLORS.reeds.length]));
  });
  reeds.castShadow = true;
  scene.add(reeds);
}

// ---------- Zäune nach den Fotos ----------
function buildFences() {
  const posts = [], slats = [], panels = [];
  for (const f of M.fences) {
    const pts = f.pts;
    for (let k = 0; k < pts.length; k++) {
      posts.push(pts[k]);
      if (k === pts.length - 1) continue;
      const [x1, z1, y1] = pts[k], [x2, z2, y2] = pts[k + 1];
      const L = Math.hypot(x2 - x1, z2 - z1), yaw = Math.atan2(x2 - x1, z2 - z1);
      if (f.kind === 'brett') panels.push([(x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2, L, yaw]);
      else for (let s = 0.25; s < L; s += 0.35) for (const dir of [1, -1]) slats.push([x1 + (x2 - x1) * s / L, (y1 + y2) / 2, z1 + (z2 - z1) * s / L, yaw, dir]);
    }
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  const P = add(new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 1.4, 0.09), mat(COLORS.fencePost), posts.length));
  posts.forEach(([x, z, y], k) => P.setMatrixAt(k, m.makeTranslation(x, y + 0.6, z)));
  const S = add(new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 1.35, 0.05), mat(COLORS.lattice), slats.length));
  slats.forEach(([x, y, z, yaw, dir], k) => {
    q.setFromEuler(e.set(dir * 0.75, yaw, 0, 'YXZ'));
    S.setMatrixAt(k, m.compose(new THREE.Vector3(x, y + 0.65, z), q, one));
  });
  const B = add(new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 1.6, 1), mat(COLORS.plank), panels.length));
  panels.forEach(([x, y, z, L, yaw], k) => {
    q.setFromEuler(e.set(0, yaw, 0));
    B.setMatrixAt(k, m.compose(new THREE.Vector3(x, y + 0.75, z), q, new THREE.Vector3(1, 1, L)));
  });
}

// ---------- Grundstücksgrenzen als feine Linie auf dem Gelände ----------
function buildParcels() {
  for (const [nr, pts] of Object.entries(M.parcels)) {
    const line = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const [x1, z1] = pts[k], [x2, z2] = pts[k + 1];
      const L = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.ceil(L / 0.5));
      for (let s = 0; s <= n; s++) {
        const x = x1 + (x2 - x1) * s / n, z = z1 + (z2 - z1) * s / n;
        line.push(x, (terrainHeight(x, z) ?? 0) + 0.12, z);
      }
    }
    // schmales Band statt Linie, damit es auch von weit oben sichtbar ist
    const band = [], w = 0.25;
    for (let k = 0; k < line.length / 3 - 1; k++) {
      const [x1, y1, z1] = line.slice(k * 3, k * 3 + 3), [x2, y2, z2] = line.slice(k * 3 + 3, k * 3 + 6);
      const L = Math.hypot(x2 - x1, z2 - z1) || 1, nx = -(z2 - z1) / L * w, nz = (x2 - x1) / L * w;
      band.push(x1 - nx, y1, z1 - nz, x2 - nx, y2, z2 - nz, x2 + nx, y2, z2 + nz, x1 - nx, y1, z1 - nz, x2 + nx, y2, z2 + nz, x1 + nx, y1, z1 + nz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(band, 3));
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: nr === '16' ? 0xff9b3d : 0xffffff, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2 })));
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

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, za] = poly[a], [xb, zb] = poly[b];
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
}

function terrainHeight(x, z) {
  const fi = x + R, fj = z + R;
  const i = Math.floor(fi), j = Math.floor(fj);
  if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return null;
  const u = fi - i, v = fj - j;
  // gleiche Dreiecksteilung wie das Netz
  const a = H[idx(i, j)], b = H[idx(i + 1, j)], c = H[idx(i, j + 1)], d = H[idx(i + 1, j + 1)];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
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
  if (x * x + z * z > (R - 1.5) ** 2) return false;
  const g = terrainHeight(x, z);
  if (g == null || g < M.water + 0.05) return false;      // nicht in den See laufen
  return !solids.some((f) => pointInPoly(x, z, f));
}

// ---------- Spieler und Steuerung ----------
const player = { pos: new THREE.Vector3(), vy: 0, yaw: 0, pitch: 0, fly: false, onGround: true };
const keys = new Set();
const joy = { x: 0, y: 0 };

function goHome() {
  player.fly = false;
  $('btn-fly').classList.remove('on');
  const [sx, sz] = M.objects.steg.see;
  if (SITE === '89') {
    // Mitte von Flurstück 89, Blick hinüber zur 16
    const p = M.parcels['89'], x = p.reduce((s, q) => s + q[0], 0) / p.length, z = p.reduce((s, q) => s + q[1], 0) / p.length;
    return teleport(x, z, Math.atan2(-(0 - x), -(0 - z)), -6 * DEG);
  }
  // auf der Terrasse stehen und zum See schauen
  const t = M.objects.terrasse;
  teleport(t.x, t.z, Math.atan2(-(sx - t.x), -(sz - t.z)), -8 * DEG);
}

function overview() {
  // schräg von Südosten über die Straße auf Haus und See
  player.fly = true;
  $('btn-fly').classList.add('on');
  const yaw = 0.95;
  player.pos.set(Math.sin(yaw) * 150, 105, Math.cos(yaw) * 150);
  player.yaw = yaw; player.pitch = -0.6;
}

function topView() {
  player.fly = true;
  $('btn-fly').classList.add('on');
  player.pos.set(0, 260, 0.01);
  player.yaw = 0; player.pitch = -Math.PI / 2 + 0.001;
}
function sideView() {
  player.fly = true;
  $('btn-fly').classList.add('on');
  const yaw = -2.35;                      // vom See her auf Ufer, Steg und Häuser
  player.pos.set(Math.sin(yaw) * 170, 28, Math.cos(yaw) * 170);
  player.yaw = yaw; player.pitch = -0.1;
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

// ---------- Übersichtskarte: Bodenarten, Häuser, Grundstücke ----------
const mini = $('minimap'), mctx = mini.getContext('2d');
let mapImg = null;
function drawMinimap() {
  const s = mini.width, k = s / N;
  const tx = (x) => (x + R) * k, tz = (z) => (z + R) * k;
  if (!mapImg) {
    mapImg = document.createElement('canvas');
    mapImg.width = mapImg.height = s;
    const c = mapImg.getContext('2d'), img = c.createImageData(N, N);
    const MAP = { g: [130, 165, 95], d: [170, 172, 115], f: [120, 112, 80], b: [150, 115, 85], s: [210, 192, 150], r: [190, 150, 120], w: [120, 168, 196], '-': [238, 240, 242] };
    for (let q = 0; q < N * N; q++) img.data.set([...(MAP[M.cover[q]] || MAP['-']), 255], q * 4);
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = N;
    tmp.getContext('2d').putImageData(img, 0, 0);
    c.drawImage(tmp, 0, 0, s, s);
    c.fillStyle = 'rgba(60,90,50,0.55)';
    for (const [x, z, , , size] of M.blocks) c.fillRect(tx(x - size / 2), tz(z - size / 2), size * k, size * k);
    const poly = (pts, fill, stroke) => {
      c.beginPath();
      pts.forEach(([x, z], i) => (i ? c.lineTo(tx(x), tz(z)) : c.moveTo(tx(x), tz(z))));
      c.closePath();
      if (fill) { c.fillStyle = fill; c.fill(); }
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke(); }
    };
    M.buildings.forEach((b) => poly(b.foot, '#ffffff', '#666'));
    poly(M.parcels['16'], null, '#ff9b3d');
    poly(M.parcels['89'], null, '#ffffff');
  }
  mctx.clearRect(0, 0, s, s);
  mctx.save();
  mctx.beginPath(); mctx.arc(s / 2, s / 2, s / 2, 0, 7); mctx.clip();
  mctx.drawImage(mapImg, 0, 0);
  mctx.restore();
  mctx.save();
  mctx.translate(tx(player.pos.x), tz(player.pos.z));
  mctx.rotate(-player.yaw);
  mctx.fillStyle = '#222';
  mctx.beginPath(); mctx.moveTo(0, -7); mctx.lineTo(4.5, 5); mctx.lineTo(0, 2.5); mctx.lineTo(-4.5, 5); mctx.closePath();
  mctx.fill();
  mctx.restore();
}
mini.addEventListener('click', (e) => {
  const r = mini.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * N - R, z = (e.clientY - r.top) / r.height * N - R;
  if (player.fly) player.pos.set(x, player.pos.y, z);
  else if (walkable(x, z)) teleport(x, z, player.yaw, player.pitch);
});

$('btn-fly').onclick = toggleFly;
$('btn-home').onclick = goHome;
$('btn-overview').onclick = overview;
$('btn-help').onclick = () => { $('start').classList.remove('hidden'); document.exitPointerLock?.(); };
$('btn-start').onclick = () => { $('start').classList.add('hidden'); goHome(); if (!isTouch) canvas.requestPointerLock(); };

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
  waterMat.opacity = 0.8 + Math.sin(clock.elapsedTime * 0.8) * 0.02;
  renderer.render(scene, camera);
  if (frame++ % 4 === 0) drawMinimap();
});

window.pinnow = { player, teleport, goHome, overview, topView, sideView, groundAt };

load().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Fehler beim Laden: ' + err.message;
});
