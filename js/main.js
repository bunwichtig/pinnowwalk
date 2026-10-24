import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { readExif } from './exif.js';

const EYE = 1.7;          // Augenhöhe in m
const WALK = 4, RUN = 12, FLY = 25, FLY_FAST = 80;
const GRAVITY = 20, JUMP = 6;
const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');

proj4.defs('EPSG:25833', '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

// ---------- Renderer, Szene, Licht ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.65;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.2, 4000);
camera.rotation.order = 'YXZ';
const BASE_FOV = 70;

const sun = new THREE.Vector3().setFromSphericalCoords(1, (90 - 38) * DEG, 200 * DEG);
const sky = new Sky();
sky.scale.setScalar(3500);
Object.assign(sky.material.uniforms, {});
sky.material.uniforms.turbidity.value = 4;
sky.material.uniforms.rayleigh.value = 1.2;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.8;
sky.material.uniforms.sunPosition.value.copy(sun);
scene.add(sky);
scene.fog = new THREE.Fog(0xc9d8e6, 150, 900);

scene.add(new THREE.HemisphereLight(0xdfeeff, 0x6b6a4a, 1.6));
const sunLight = new THREE.DirectionalLight(0xfff3df, 2.6);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 1, far: 800 });
sunLight.shadow.bias = -0.0005;
sunLight.shadow.normalBias = 0.4;
scene.add(sunLight, sunLight.target);

// ---------- Daten laden ----------
let meta, H, N, STEP, HALF;
const footGrid = new Map();
let photos = [];
const markers = [];

async function load() {
  const status = (t) => ($('loading').textContent = t);
  status('Lade Geländedaten …');
  meta = await (await fetch('data/meta.json')).json();
  ({ n: N, step: STEP } = meta.terrain);
  HALF = meta.half;
  const tb = await (await fetch('data/terrain.bin')).arrayBuffer();
  const raw = new Uint16Array(tb);
  H = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) H[i] = raw[i] * meta.terrain.scale;

  status('Lade Luftbild …');
  const big = !isTouch && renderer.capabilities.maxTextureSize >= 4096;
  const dop = await new THREE.TextureLoader().loadAsync(big ? 'data/dop_4k.jpg' : 'data/dop_2k.jpg');
  dop.colorSpace = THREE.SRGBColorSpace;
  dop.anisotropy = renderer.capabilities.getMaxAnisotropy();
  buildTerrain(dop);

  status('Lade Gebäude …');
  const [bb, fp] = await Promise.all([
    fetch('data/buildings.bin').then((r) => r.arrayBuffer()),
    fetch('data/footprints.json').then((r) => r.json()),
  ]);
  buildBuildings(bb, dop);
  indexFootprints(fp);

  status('Lade Bäume …');
  buildTrees(await (await fetch('data/trees.bin')).arrayBuffer());
  buildHouseLabel();

  status('Lade Fotos …');
  try {
    photos = (await (await fetch('fotos/fotos.json', { cache: 'no-cache' })).json()).map((p) => ({ ...p, src: 'fotos/' + p.datei }));
  } catch { photos = []; }
  photos.forEach(addMarker);
  renderPhotoList();
  initMinimap();

  status('');
  $('btn-start').disabled = false;
  goHome();
}

// ---------- Gelände ----------
function buildTerrain(tex) {
  const size = 2 * HALF;
  const geo = new THREE.PlaneGeometry(size, size, N - 1, N - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, H[k]);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Wasserfläche des Pinnower Sees
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
    new THREE.MeshPhongMaterial({ color: 0x2d5a78, transparent: true, opacity: 0.55, shininess: 120, specular: 0x99aabb })
  );
  water.position.y = meta.water;
  scene.add(water);

  // Umgebung außerhalb des Ausschnitts: flache Ebene, mit einer Schürze an den Geländerand angeschlossen
  const outerY = meta.water + 0.2;
  const outer = new THREE.Mesh(
    new THREE.RingGeometry(size * 0.705, 4000, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x5f6b45 })
  );
  outer.position.y = outerY;
  scene.add(outer);
  const sp = [], suv = [], sidx = [];
  const edges = [
    (t) => [t, 0], (t) => [N - 1, t], (t) => [N - 1 - t, N - 1], (t) => [0, N - 1 - t],
  ];
  for (const edge of edges)
    for (let t = 0; t < N; t++) {
      const [j, i] = edge(t);
      const x = -HALF + j * STEP, z = -HALF + i * STEP, u = j / (N - 1), v = 1 - i / (N - 1);
      const k = sp.length / 3;
      sp.push(x, H[i * N + j], z, x, outerY - 0.5, z);
      suv.push(u, v, u, v);
      if (t < N - 1) sidx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  sg.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2));
  sg.setIndex(sidx);
  scene.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: 0x9a9a9a })));
}

function heightAt(x, z) {
  const fx = THREE.MathUtils.clamp((x + HALF) / STEP, 0, N - 1.001);
  const fz = THREE.MathUtils.clamp((z + HALF) / STEP, 0, N - 1.001);
  const j = Math.floor(fx), i = Math.floor(fz), dx = fx - j, dz = fz - i;
  const a = H[i * N + j], b = H[i * N + j + 1], c = H[(i + 1) * N + j], d = H[(i + 1) * N + j + 1];
  // gleiche Dreiecksaufteilung wie PlaneGeometry
  return dx + dz <= 1 ? a + (b - a) * dx + (c - a) * dz : d + (c - d) * (1 - dx) + (b - d) * (1 - dz);
}

// ---------- Gebäude (LoD2) ----------
function buildBuildings(buf, dop) {
  const [nr, nw] = new Uint32Array(buf, 0, 2);
  const roofs = new Float32Array(buf, 8, nr);
  const walls = new Float32Array(buf, 8 + nr * 4, nw);
  const make = (arr, mat, uvFromAbove) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    if (uvFromAbove) {
      const uv = new Float32Array((arr.length / 3) * 2);
      for (let k = 0, m = 0; k < arr.length; k += 3, m += 2) {
        uv[m] = (arr[k] + HALF) / (2 * HALF);
        uv[m + 1] = 1 - (arr[k + 2] + HALF) / (2 * HALF);
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  };
  // Dächer bekommen das Luftbild von oben, so sieht man echte Dachfarben
  make(roofs, new THREE.MeshLambertMaterial({ map: dop, side: THREE.DoubleSide }), true);
  make(walls, new THREE.MeshLambertMaterial({ color: 0xe6ddcc, side: THREE.DoubleSide }), false);
}

function indexFootprints(list) {
  for (const poly of list) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const item = { poly, x0, x1, z0, z1 };
    for (let cx = Math.floor(x0 / 20); cx <= Math.floor(x1 / 20); cx++)
      for (let cz = Math.floor(z0 / 20); cz <= Math.floor(z1 / 20); cz++) {
        const key = cx + ',' + cz;
        if (!footGrid.has(key)) footGrid.set(key, []);
        footGrid.get(key).push(item);
      }
  }
}

function insideBuilding(x, z) {
  const cell = footGrid.get(Math.floor(x / 20) + ',' + Math.floor(z / 20));
  if (!cell) return false;
  for (const { poly, x0, x1, z0, z1 } of cell) {
    if (x < x0 - 0.3 || x > x1 + 0.3 || z < z0 - 0.3 || z > z1 + 0.3) continue;
    let inside = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const [xa, za] = poly[a], [xb, zb] = poly[b];
      if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// ---------- Bäume aus dem nDOM ----------
function buildTrees(buf) {
  const d = new Int16Array(buf);
  const count = d.length / 4;
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6).translate(0, 0.5, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ flatShading: true }), count);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5a4632 }), count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  for (let t = 0; t < count; t++) {
    const x = d[t * 4] / 10, z = d[t * 4 + 1] / 10, h = d[t * 4 + 2] / 10, r = d[t * 4 + 3] / 10;
    const g = heightAt(x, z);
    const ry = Math.min(r * 1.2, h * 0.45);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (t * 2.399) % 6.283);
    m.compose(p.set(x, g + h - ry, z), q, s.set(r, ry, r));
    crowns.setMatrixAt(t, m);
    col.setHSL(0.24 + ((t * 0.137) % 0.08), 0.38, 0.2 + ((t * 0.071) % 0.1));
    crowns.setColorAt(t, col);
    const tw = 0.12 + h * 0.012;
    m.compose(p.set(x, g - 0.2, z), q, s.set(tw, h - ry + 0.2, tw));
    trunks.setMatrixAt(t, m);
  }
  for (const im of [crowns, trunks]) { im.castShadow = true; im.receiveShadow = true; scene.add(im); }
}

function makeLabel(text, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.strokeText(text, 256, 64);
  g.fillStyle = color; g.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, toneMapped: false }));
  sp.scale.set(8, 2, 1);
  return sp;
}

function buildHouseLabel() {
  const { x, z, top, label } = meta.house;
  const sp = makeLabel(label, '#ffcf8a');
  sp.position.set(x, Math.max(top, heightAt(x, z) + 6) + 3, z);
  scene.add(sp);
}

// ---------- Spieler und Steuerung ----------
const player = { pos: new THREE.Vector3(), vy: 0, yaw: 0, pitch: 0, fly: false, onGround: true };
const keys = new Set();
const joy = { x: 0, y: 0 };

function goHome() {
  const { x, z } = meta.house;
  // freien Platz in der Nähe des Hauses suchen und das Haus anschauen
  for (let d = 12; d < 60; d += 3)
    for (let a = 180; a < 540; a += 30) {
      const px = x + Math.sin(a * DEG) * d, pz = z + Math.cos(a * DEG) * d;
      if (!insideBuilding(px, pz) && heightAt(px, pz) > meta.water + 0.3) {
        teleport(px, pz, Math.atan2(-(x - px), -(z - pz)), -5 * DEG);
        return;
      }
    }
  teleport(x, z + 20, 0, 0);
}

function teleport(x, z, yaw, pitch, eye = EYE) {
  player.pos.set(x, heightAt(x, z) + eye, z);
  player.yaw = yaw; player.pitch = pitch; player.vy = 0;
}

function headingDeg() { return ((-player.yaw / DEG) % 360 + 360) % 360; }

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  keys.add(e.code);
  if (e.code === 'KeyF') toggleFly();
  if (e.code === 'KeyH') goHome();
  if (e.code === 'Space' && !player.fly && player.onGround) { player.vy = JUMP; player.onGround = false; }
});
addEventListener('keyup', (e) => keys.delete(e.code));

function toggleFly() {
  player.fly = !player.fly;
  $('btn-fly').classList.toggle('on', player.fly);
  if (!player.fly) player.vy = 0;
}

const canvas = renderer.domElement;
let locked = false;
document.addEventListener('pointerlockchange', () => (locked = document.pointerLockElement === canvas));
document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  look(e.movementX * 0.0022, e.movementY * 0.0022);
});
function look(dx, dy) {
  player.yaw -= dx;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy, -1.5, 1.5);
}

canvas.addEventListener('click', (e) => {
  if (isTouch) return;
  if (!locked) { canvas.requestPointerLock(); return; }
  pickMarker(0, 0);
});

// Touch: linke Hälfte = Joystick, rechte Hälfte = umsehen, kurzes Tippen = Marker wählen
const touches = new Map();
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const left = e.clientX < innerWidth * 0.4;
  touches.set(e.pointerId, { left, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: performance.now() });
});
canvas.addEventListener('pointermove', (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  if (t.left) {
    joy.x = THREE.MathUtils.clamp((e.clientX - t.x0) / 50, -1, 1);
    joy.y = THREE.MathUtils.clamp((e.clientY - t.y0) / 50, -1, 1);
    $('stick').style.transform = `translate(${joy.x * 35}px, ${joy.y * 35}px)`;
  } else {
    look((e.clientX - t.x) * 0.005, (e.clientY - t.y) * 0.005);
  }
  t.x = e.clientX; t.y = e.clientY;
});
const endTouch = (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  touches.delete(e.pointerId);
  if (t.left) { joy.x = joy.y = 0; $('stick').style.transform = ''; }
  if (Math.hypot(e.clientX - t.x0, e.clientY - t.y0) < 8 && performance.now() - t.t < 300)
    pickMarker((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
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
  const speed = player.fly ? (fast ? FLY_FAST : FLY) : fast ? RUN : WALK;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }

  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(-fwd.z, 0, fwd.x);
  const dx = (fwd.x * mz + right.x * mx) * speed * dt;
  const dz = (fwd.z * mz + right.z * mx) * speed * dt;
  const p = player.pos;
  const lim = HALF - 3;
  const ok = (x, z) => Math.abs(x) < lim && Math.abs(z) < lim && (player.fly || !insideBuilding(x, z));
  if (ok(p.x + dx, p.z + dz)) { p.x += dx; p.z += dz; }
  else if (ok(p.x + dx, p.z)) p.x += dx;
  else if (ok(p.x, p.z + dz)) p.z += dz;

  const ground = heightAt(p.x, p.z);
  if (player.fly) {
    if (keys.has('Space')) p.y += speed * dt;
    if (keys.has('KeyC')) p.y -= speed * dt;
    p.y = Math.max(p.y, ground + 0.5);
  } else {
    player.vy -= GRAVITY * dt;
    p.y += player.vy * dt;
    if (p.y <= ground + EYE) { p.y = ground + EYE; player.vy = 0; player.onGround = true; }
  }
  camera.position.copy(p);
  camera.rotation.set(player.pitch, player.yaw, 0);

  // Schattenbereich mit dem Spieler mitführen
  sunLight.position.copy(p).addScaledVector(sun, 400);
  sunLight.target.position.copy(p);

  $('pos').textContent = `${Math.round(meta.origin[0] + p.x)} O · ${Math.round(meta.origin[1] - p.z)} N · ` +
    `${(p.y - EYE + meta.base).toFixed(1)} m ü. NHN · Blick ${Math.round(headingDeg())}°`;
}

// ---------- Fotos ----------
const raycaster = new THREE.Raycaster();

function photoLocal(p) {
  if (p.ost != null && p.nord != null) return { x: p.ost - meta.origin[0], z: meta.origin[1] - p.nord };
  const [e, n] = proj4('EPSG:4326', 'EPSG:25833', [p.lon, p.lat]);
  return { x: e - meta.origin[0], z: meta.origin[1] - n };
}

function addMarker(p) {
  const { x, z } = photoLocal(p);
  p.x = x; p.z = z;
  const eye = p.hoehe_ueber_boden ?? 1.6;
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff9b3d });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, eye).translate(0, eye / 2, 0), mat);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.7),
    new THREE.MeshBasicMaterial({ color: 0xff9b3d, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  cone.position.y = eye;
  cone.rotation.x = (p.neigung ?? 0) * DEG;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), mat);
  ball.position.y = eye + 0.9;
  g.add(pole, cone, ball);
  g.position.set(x, heightAt(x, z), z);
  g.rotation.y = -(p.richtung ?? 0) * DEG;
  g.userData.photo = p;
  scene.add(g);
  markers.push(g);
  p.marker = g;
}

function removeMarker(p) {
  if (!p.marker) return;
  scene.remove(p.marker);
  markers.splice(markers.indexOf(p.marker), 1);
  p.marker = null;
}

function pickMarker(nx, ny) {
  raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
  const hit = raycaster.intersectObjects(markers, true)[0];
  if (!hit) return;
  let o = hit.object;
  while (!o.userData.photo) o = o.parent;
  showPhoto(o.userData.photo);
}

let activePhoto = null;
function showPhoto(p) {
  activePhoto = p;
  const eye = p.hoehe_ueber_boden ?? 1.6;
  if (player.fly) toggleFly();
  teleport(p.x, p.z, -(p.richtung ?? 0) * DEG, (p.neigung ?? 0) * DEG, eye);
  const img = $('overlay-img');
  img.onload = () => fitFov(p, img.naturalWidth, img.naturalHeight);
  img.src = p.src;
  $('overlay-title').textContent = p.titel || p.datei || 'Foto';
  $('overlay').classList.remove('hidden');
  if (p.marker) p.marker.visible = false;
}

// Kamera-Öffnungswinkel an das Foto anpassen (aus der Kleinbild-Brennweite)
function fitFov(p, w, h) {
  const f = p.brennweite;
  if (!f) return;
  const halfDiag = Math.atan(21.633 / f);
  const diag = Math.hypot(w, h);
  const vf = 2 * Math.atan(Math.tan(halfDiag) * h / diag);
  const hf = 2 * Math.atan(Math.tan(halfDiag) * w / diag);
  const view = innerWidth / innerHeight;
  camera.fov = (w / h > view ? 2 * Math.atan(Math.tan(hf / 2) / view) : vf) / DEG;
  camera.updateProjectionMatrix();
}

function closePhoto() {
  $('overlay').classList.add('hidden');
  if (activePhoto?.marker) activePhoto.marker.visible = true;
  activePhoto = null;
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
}
$('overlay-close').onclick = closePhoto;
$('overlay-opacity').oninput = (e) => ($('overlay-img').style.opacity = e.target.value);
addEventListener('keydown', (e) => { if (e.code === 'Escape' && activePhoto && !locked) closePhoto(); });

function renderPhotoList() {
  const ul = $('photo-list');
  ul.innerHTML = '';
  if (!photos.length) {
    ul.innerHTML = '<li class="empty">Noch keine Fotos in fotos/fotos.json.</li>';
    return;
  }
  for (const p of photos) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = p.src; img.alt = '';
    const span = document.createElement('span');
    span.textContent = `${p.titel || p.datei} · ${Math.round(p.richtung ?? 0)}°`;
    li.append(img, span);
    li.onclick = () => { $('photo-panel').classList.add('hidden'); showPhoto(p); };
    ul.append(li);
  }
}

$('btn-photos').onclick = () => $('photo-panel').classList.toggle('hidden');
$('btn-fly').onclick = toggleFly;
$('btn-home').onclick = goHome;
$('btn-help').onclick = () => { $('start').classList.remove('hidden'); document.exitPointerLock?.(); };
$('btn-start').onclick = () => {
  $('start').classList.add('hidden');
  if (!isTouch) canvas.requestPointerLock();
};

// Eigenes Foto ausprobieren: EXIF lesen, platzieren, Eintrag für fotos.json erzeugen
let draft = null;
$('photo-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ex = readExif(await file.arrayBuffer()) || {};
  if (draft) removeMarker(draft);
  draft = { datei: file.name, titel: file.name.replace(/\.[^.]+$/, ''), src: URL.createObjectURL(file) };
  $('pe-thumb').src = draft.src;
  $('pe-lat').value = ex.lat?.toFixed(6) ?? '';
  $('pe-lon').value = ex.lon?.toFixed(6) ?? '';
  $('pe-dir').value = ex.direction != null ? Math.round(ex.direction) : '';
  $('pe-focal').value = ex.focal35 ?? '';
  $('pe-pitch').value = 0;
  $('pe-title').value = draft.titel;
  if (ex.date) draft.datum = ex.date;
  const found = [ex.lat != null ? 'GPS-Position' : null, ex.direction != null ? `Blickrichtung (${ex.directionRef === 'M' ? 'magnetisch' : 'geografisch'} Nord)` : null,
    ex.focal35 ? 'Brennweite' : null, ex.date ? 'Datum ' + ex.date : null].filter(Boolean);
  $('pe-exif').textContent = found.length
    ? 'Aus dem Foto gelesen: ' + found.join(', ') + '.' + (ex.lat == null ? ' Keine GPS-Position: zum Aufnahmeort gehen und „Aktueller Standort“ drücken.' : '')
    : 'Keine Metadaten im Foto. Zum Aufnahmeort gehen, in Blickrichtung drehen und „Aktueller Standort“ drücken.';
  $('photo-panel').classList.add('hidden');
  $('photo-edit').classList.remove('hidden');
  document.exitPointerLock?.();
  if (ex.lat != null) applyDraft();
  else updateJson();
};

function readDraft() {
  Object.assign(draft, {
    titel: $('pe-title').value,
    lat: parseFloat($('pe-lat').value), lon: parseFloat($('pe-lon').value),
    richtung: parseFloat($('pe-dir').value) || 0,
    neigung: parseFloat($('pe-pitch').value) || 0,
  });
  const f = parseFloat($('pe-focal').value);
  if (f) draft.brennweite = f; else delete draft.brennweite;
}

function updateJson() {
  const { datei, titel, lat, lon, richtung, neigung, brennweite, datum } = draft;
  const entry = { datei, titel, lat: +(+lat).toFixed(6), lon: +(+lon).toFixed(6), richtung: Math.round(richtung ?? 0), neigung: Math.round(neigung ?? 0) };
  if (brennweite) entry.brennweite = brennweite;
  if (datum) entry.datum = datum;
  $('pe-json').value = JSON.stringify(entry, null, 2);
}

function applyDraft() {
  readDraft();
  if (!isFinite(draft.lat) || !isFinite(draft.lon)) { updateJson(); return; }
  removeMarker(draft);
  addMarker(draft);
  updateJson();
  showPhoto(draft);
}
$('pe-apply').onclick = applyDraft;
$('pe-here').onclick = () => {
  const p = player.pos;
  const [lon, lat] = proj4('EPSG:25833', 'EPSG:4326', [meta.origin[0] + p.x, meta.origin[1] - p.z]);
  $('pe-lat').value = lat.toFixed(6);
  $('pe-lon').value = lon.toFixed(6);
  $('pe-dir').value = Math.round(headingDeg());
  $('pe-pitch').value = Math.round(player.pitch / DEG);
  readDraft();
  removeMarker(draft);
  addMarker(draft);
  if (activePhoto === draft) draft.marker.visible = false;
  updateJson();
};
$('pe-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('pe-json').value); $('pe-copy').textContent = 'Kopiert ✓'; }
  catch { $('pe-json').select(); }
  setTimeout(() => ($('pe-copy').textContent = 'Eintrag kopieren'), 1500);
};
$('pe-close').onclick = () => $('photo-edit').classList.add('hidden');

// ---------- Übersichtskarte ----------
const mini = $('minimap'), mctx = mini.getContext('2d');
const miniImg = new Image();
function initMinimap() {
  miniImg.src = 'data/dop_2k.jpg';
  mini.addEventListener('click', (e) => {
    const r = mini.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 2 * HALF;
    const z = ((e.clientY - r.top) / r.height - 0.5) * 2 * HALF;
    if (player.fly) player.pos.set(x, Math.max(player.pos.y, heightAt(x, z) + 30), z);
    else teleport(x, z, player.yaw, player.pitch);
  });
}
function drawMinimap() {
  const s = mini.width;
  if (miniImg.complete && miniImg.naturalWidth) mctx.drawImage(miniImg, 0, 0, s, s);
  const k = s / (2 * HALF), toM = (v) => (v + HALF) * k;
  mctx.fillStyle = '#ff9b3d';
  for (const m of markers) { mctx.beginPath(); mctx.arc(toM(m.position.x), toM(m.position.z), 3, 0, 7); mctx.fill(); }
  const px = toM(player.pos.x), pz = toM(player.pos.z);
  mctx.save();
  mctx.translate(px, pz);
  mctx.rotate(-player.yaw);
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#000'; mctx.lineWidth = 1.5;
  mctx.beginPath(); mctx.moveTo(0, -8); mctx.lineTo(5, 6); mctx.lineTo(0, 3); mctx.lineTo(-5, 6); mctx.closePath();
  mctx.fill(); mctx.stroke();
  mctx.restore();
}

// ---------- Hauptschleife ----------
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (activePhoto) fitFov(activePhoto, $('overlay-img').naturalWidth, $('overlay-img').naturalHeight);
});

const clock = new THREE.Clock();
let frame = 0;
renderer.setAnimationLoop(() => {
  if (!meta || !H) return;
  update(Math.min(clock.getDelta(), 0.1));
  renderer.render(scene, camera);
  if (frame++ % 3 === 0) drawMinimap();
});

// für Tests und die Browser-Konsole
window.pinnow = { player, teleport, goHome, heightAt, showPhoto };

load().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Fehler beim Laden: ' + err.message;
});
