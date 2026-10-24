import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

const EYE = 1.7;          // Augenhöhe in m
const WALK = 4, RUN = 12, FLY = 25, FLY_FAST = 80;
const GRAVITY = 20, JUMP = 6;
const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');

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

canvas.addEventListener('click', () => {
  if (!isTouch && !locked) canvas.requestPointerLock();
});

// Touch: linke Hälfte = Joystick, rechte Hälfte = umsehen
const touches = new Map();
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const left = e.clientX < innerWidth * 0.4;
  touches.set(e.pointerId, { left, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
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

$('btn-fly').onclick = toggleFly;
$('btn-home').onclick = goHome;
$('btn-help').onclick = () => { $('start').classList.remove('hidden'); document.exitPointerLock?.(); };
$('btn-start').onclick = () => {
  $('start').classList.add('hidden');
  if (!isTouch) canvas.requestPointerLock();
};

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
window.pinnow = { player, teleport, goHome, heightAt };

load().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Fehler beim Laden: ' + err.message;
});
