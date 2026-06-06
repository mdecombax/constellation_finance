// Celestial Market — rendu de la voûte boursière.
// Charge data/snapshot.json et place 4000 étoiles encodées sur une voûte sphérique.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const R = 100;            // rayon de la voûte
const SECTOR_SPREAD = 0.55; // étalement des étoiles autour du centre de leur secteur
const HORIZON_Y = 0.06;   // hauteur min des étoiles (au-dessus de l'horizon = dôme hémisphérique)
const GROUND_Y = -2.7;    // niveau du sol (juste sous l'observateur allongé)

const $ = (s) => document.querySelector(s);
const loaderP = $('#loader-p');

// ---------------------------------------------------------------------------
// 1. Scène / caméra / contrôles
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x02030a, 0.0016);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0.2, -2.4, 0.95); // allongé au sol, regard tourné vers le ciel (zénith)

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.rotateSpeed = -0.25;      // négatif = on regarde depuis l'intérieur (la tête bouge)
controls.zoomSpeed = 0.7;
controls.minDistance = 0.1;
controls.maxDistance = 4;          // on reste près du sol (l'observateur ne s'envole pas)
controls.minPolarAngle = Math.PI * 0.46;  // ~83° : on peut pencher un peu vers l'horizon
controls.maxPolarAngle = Math.PI * 0.99;  // ~178° : jusqu'au zénith, jamais sous le sol
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.06;   // drift très lent et contemplatif

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Vol de caméra : "megazoom" vers une étoile au clic, retour au clic dans le vide
// ---------------------------------------------------------------------------
let activeFlight = null;   // tween en cours
let savedView = null;      // vue à restaurer au dézoom
let isZoomed = false;
let bodyGroup = null;      // corps FPS (caché en mode inspection)
const updaters = [];       // animations du décor (lucioles…)

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Deux jeux de limites OrbitControls : allongé au sol vs. inspection d'une étoile
function setControlMode(mode) {
  if (mode === 'ground') {
    controls.minDistance = 0.1; controls.maxDistance = 4;
    controls.minPolarAngle = Math.PI * 0.46; controls.maxPolarAngle = Math.PI * 0.99;
  } else { // 'inspect' : on tourne librement autour de l'étoile ciblée
    controls.minDistance = 2.5; controls.maxDistance = 70;
    controls.minPolarAngle = Math.PI * 0.04; controls.maxPolarAngle = Math.PI * 0.96;
  }
  if (bodyGroup) bodyGroup.visible = (mode === 'ground'); // on cache son corps en plein vol
}

function flyTo(destPos, lookAt, dur, onArrive) {
  controls.autoRotate = false;
  controls.enabled = false;
  activeFlight = {
    fromPos: camera.position.clone(), toPos: destPos.clone(),
    fromTgt: controls.target.clone(), toTgt: lookAt.clone(),
    t: 0, dur, onArrive,
  };
}

function updateFlight(dt) {
  const f = activeFlight;
  f.t = Math.min(1, f.t + dt / f.dur);
  const k = easeInOut(f.t);
  camera.position.lerpVectors(f.fromPos, f.toPos, k);
  controls.target.lerpVectors(f.fromTgt, f.toTgt, k);
  camera.lookAt(controls.target);
  if (f.t >= 1) {
    activeFlight = null;
    controls.enabled = true;
    if (f.onArrive) f.onArrive();
  }
}

// Retour à la vue allongée (clic dans le vide ou touche Échap)
function zoomOut() {
  if (!isZoomed || activeFlight) return;
  isZoomed = false;
  const card = $('#card');
  if (card) card.classList.remove('on');
  flyTo(savedView.pos, savedView.tgt, 1.1, () => {
    setControlMode('ground');
    controls.autoRotate = true;
  });
}

addEventListener('keydown', (e) => { if (e.key === 'Escape') zoomOut(); });

// Direction aléatoire contrainte au dôme (y >= HORIZON_Y)
function randomDomeDir() {
  const v = new THREE.Vector3().randomDirection();
  if (v.y < HORIZON_Y) v.y = HORIZON_Y + Math.abs(v.y) * (1 - HORIZON_Y);
  return v.normalize();
}

// ---------------------------------------------------------------------------
// 2. Décor : nappe d'étoiles de fond lointaines (ambiance) + sol
// ---------------------------------------------------------------------------
function addBackdrop() {
  const n = 1200, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = randomDomeDir().multiplyScalar(R * 1.6);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0x3a4470, size: 0.6, sizeAttenuation: true,
    transparent: true, opacity: 0.5, depthWrite: false });
  scene.add(new THREE.Points(g, m));
}

function addMeadow() {
  // --- sol (prairie de nuit) ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshBasicMaterial({ color: 0x07160d, fog: true })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  scene.add(ground);

  // --- collines low-poly à l'horizon (silhouette tout autour) ---
  const hillMat = new THREE.MeshBasicMaterial({ color: 0x040c08, fog: true });
  const HN = 26;
  for (let i = 0; i < HN; i++) {
    const ang = (i / HN) * Math.PI * 2 + Math.random() * 0.12;
    const dist = 55 + Math.random() * 25;
    const h = 7 + Math.random() * 13;
    const r = 14 + Math.random() * 10;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), hillMat);
    cone.position.set(Math.cos(ang) * dist, GROUND_Y + h / 2 - 1, Math.sin(ang) * dist);
    cone.rotation.y = Math.random() * Math.PI;
    scene.add(cone);
  }

  // --- herbe instanciée autour de l'observateur ---
  const blade = new THREE.PlaneGeometry(0.12, 1);
  blade.translate(0, 0.5, 0); // pivot au pied du brin
  const grass = new THREE.InstancedMesh(
    blade,
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: true }),
    2600
  );
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < grass.count; i++) {
    const rad = 2.5 + Math.pow(Math.random(), 1.4) * 36; // pas de brins collés à l'œil
    const ang = Math.random() * Math.PI * 2;
    dummy.position.set(Math.cos(ang) * rad, GROUND_Y, Math.sin(ang) * rad);
    dummy.rotation.set((Math.random() - 0.5) * 0.4, Math.random() * Math.PI, (Math.random() - 0.5) * 0.4);
    dummy.scale.set(0.7 + Math.random() * 0.5, 0.25 + Math.random() * 0.5, 1);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
    col.setHSL(0.31, 0.55, 0.07 + Math.random() * 0.07); // verts de nuit variés
    grass.setColorAt(i, col);
  }
  grass.instanceMatrix.needsUpdate = true;
  scene.add(grass);

  // --- lucioles (ambiance prairie de nuit) ---
  const FN = 80;
  const fpos = new Float32Array(FN * 3);
  const fphase = new Float32Array(FN);
  const base = [];
  for (let i = 0; i < FN; i++) {
    const rad = 2 + Math.random() * 22, ang = Math.random() * Math.PI * 2;
    const b = [Math.cos(ang) * rad, GROUND_Y + 0.4 + Math.random() * 3, Math.sin(ang) * rad];
    base.push(b);
    fpos.set(b, i * 3);
    fphase[i] = Math.random() * Math.PI * 2;
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  fgeo.setAttribute('aPhase', new THREE.BufferAttribute(fphase, 1));
  const fmat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aPhase; uniform float uTime; varying float vTw;
      void main(){
        vTw = 0.5 + 0.5 * sin(uTime * 2.0 + aPhase);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (5.0 + 4.0 * vTw) * (200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vTw;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(0.75, 1.0, 0.45, smoothstep(0.5, 0.0, d) * vTw);
      }`
  });
  const fireflies = new THREE.Points(fgeo, fmat);
  scene.add(fireflies);
  updaters.push((t) => {
    fmat.uniforms.uTime.value = t;
    const p = fgeo.getAttribute('position');
    for (let i = 0; i < FN; i++) {
      const b = base[i];
      p.setXYZ(i,
        b[0] + Math.sin(t * 0.5 + i) * 0.6,
        b[1] + Math.sin(t * 0.7 + i * 1.3) * 0.4,
        b[2] + Math.cos(t * 0.4 + i) * 0.6);
    }
    p.needsUpdate = true;
  });
}

// Corps low-poly de l'observateur, allongé au sol (objet monde) : on le voit en
// baissant le regard vers ses pieds, comme un vrai FPS allongé dans l'herbe.
function addBody() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshBasicMaterial({ color: 0x141a2e, fog: true }); // vêtements nuit
  const shoe = new THREE.MeshBasicMaterial({ color: 0x2a3346, fog: true });
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
  };
  const y0 = GROUND_Y + 0.4; // corps posé sur l'herbe
  // tête de l'observateur ~ origine ; le corps s'étend vers +z (les pieds)
  box(1.15, 0.55, 1.5, cloth, 0, y0, 2.1);        // torse
  box(0.42, 0.5, 1.6, cloth, -0.3, y0, 3.6);      // cuisse G
  box(0.42, 0.5, 1.6, cloth, 0.3, y0, 3.6);       // cuisse D
  box(0.36, 0.42, 1.4, cloth, -0.3, y0, 5.0);     // tibia G
  box(0.36, 0.42, 1.4, cloth, 0.3, y0, 5.0);      // tibia D
  box(0.42, 0.6, 0.55, shoe, -0.3, y0 + 0.12, 5.9); // chaussure G (dressée)
  box(0.42, 0.6, 0.55, shoe, 0.3, y0 + 0.12, 5.9);  // chaussure D
  scene.add(g);
  bodyGroup = g;
}

// ---------------------------------------------------------------------------
// 3. Placement par secteur (centres répartis en spirale de Fibonacci)
// ---------------------------------------------------------------------------
// Centres répartis sur le DÔME (hémisphère supérieur), du zénith vers l'horizon
function fibonacciDir(i, total) {
  const y = 0.95 - (i + 0.5) / total * (0.95 - (HORIZON_Y + 0.05));
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
}

function sectorCenters(sectors) {
  const centers = {};
  sectors.forEach((s, i) => { centers[s] = fibonacciDir(i, sectors.length); });
  return centers;
}

// ---------------------------------------------------------------------------
// 4. Encodages visuels (données → attributs)
// ---------------------------------------------------------------------------
const COLD = new THREE.Color(0.30, 0.52, 1.0);   // stable
const HOT  = new THREE.Color(1.0, 0.42, 0.13);   // nerveux

function volatilityColor(vol) {
  // médiane ~0.02, nerveux > 0.06
  const t = Math.max(0, Math.min(1, ((vol ?? 0.02) - 0.005) / (0.06 - 0.005)));
  return COLD.clone().lerp(HOT, t);
}

function sizeFromCap(logCap) {
  // log10 ~ 8.5 (petite) .. 12.7 (NVDA) -> rayon point
  return 2.0 + Math.max(0, (logCap ?? 9) - 8.3) * 3.2;
}

// ---------------------------------------------------------------------------
// 5. Construction du nuage d'étoiles
// ---------------------------------------------------------------------------
function buildStars(assets) {
  const sectors = [...new Set(assets.map(a => a.sector || '(ETF)'))];
  const centers = sectorCenters(sectors);

  const n = assets.length;
  const position = new Float32Array(n * 3);
  const aColor = new Float32Array(n * 3);
  const aSize = new Float32Array(n);
  const aBright = new Float32Array(n);
  const aPulse = new Float32Array(n);
  const aPhase = new Float32Array(n);
  const aVisible = new Float32Array(n);          // 0 = masquée (défaut), 1 = révélée
  const starSector = new Int32Array(n);          // index du secteur de chaque étoile (pour le picking)

  // accumulateurs par secteur (couleur moyenne + liste d'indices)
  const sectorList = sectors.map((name, si) => ({
    name, si, dir: centers[name], indices: [],
    color: new THREE.Color(0, 0, 0), pos: centers[name].clone().multiplyScalar(R),
  }));
  const sectorBySi = (a) => sectorList.find(s => s.name === (a.sector || '(ETF)'));

  assets.forEach((a, i) => {
    const sec = sectorBySi(a);
    const center = sec.dir;
    // direction = centre du secteur + jitter, renormalisée puis maintenue dans le dôme
    const dir = center.clone()
      .add(new THREE.Vector3().randomDirection().multiplyScalar(SECTOR_SPREAD))
      .normalize();
    if (dir.y < HORIZON_Y) { dir.y = HORIZON_Y; dir.normalize(); }
    position.set([dir.x * R, dir.y * R, dir.z * R], i * 3);

    const c = volatilityColor(a.volatility_30d);
    aColor.set([c.r, c.g, c.b], i * 3);
    aSize[i] = sizeFromCap(a.market_cap_log);
    aBright[i] = Math.max(0.45, Math.min(1.6, 0.55 + 0.6 * (a.volume_norm ?? 1)));
    aPulse[i] = Math.max(0, Math.min(1, Math.abs(a.change_pct ?? 0) / 5));
    aPhase[i] = Math.random() * Math.PI * 2;
    aVisible[i] = 0;
    starSector[i] = sec.si;
    sec.indices.push(i);
    sec.color.add(c);
  });

  // couleur représentative = moyenne des volatilités du secteur
  sectorList.forEach(s => { if (s.indices.length) s.color.multiplyScalar(1 / s.indices.length); });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute('aBright', new THREE.BufferAttribute(aBright, 1));
  geo.setAttribute('aPulse', new THREE.BufferAttribute(aPulse, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute('aVisible', new THREE.BufferAttribute(aVisible, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: innerHeight / 2 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor; attribute float aSize, aBright, aPulse, aPhase, aVisible;
      uniform float uTime, uScale;
      varying vec3 vColor; varying float vBright;
      void main() {
        vColor = aColor; vBright = aBright;
        float pulse = 1.0 + 0.35 * aPulse * sin(uTime * 3.0 + aPhase);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // aVisible = 0 -> taille nulle -> étoile non rendue (constellation masquée)
        gl_PointSize = aSize * pulse * aVisible * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vBright;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.0, d);
        float glow = pow(core, 2.2);
        gl_FragColor = vec4(vColor * vBright * (0.4 + glow), core);
      }`
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);
  return { points, mat, geo, sectorList, starSector };
}

// ---------------------------------------------------------------------------
// 5b. Centres de constellation : un marqueur (anneau) par secteur + lignes
// ---------------------------------------------------------------------------
function buildConstellations(sectorList, starPos) {
  // --- marqueurs des centres (un anneau lumineux par secteur) ---
  const m = sectorList.length;
  const cPos = new Float32Array(m * 3);
  const cColor = new Float32Array(m * 3);
  const cOn = new Float32Array(m); // 1 quand la constellation est dépliée
  sectorList.forEach((s, i) => {
    cPos.set([s.pos.x, s.pos.y, s.pos.z], i * 3);
    // teinte du marqueur : couleur secteur éclaircie pour rester lisible
    const c = s.color.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
    cColor.set([c.r, c.g, c.b], i * 3);
    cOn[i] = 0;
  });
  const cgeo = new THREE.BufferGeometry();
  cgeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
  cgeo.setAttribute('aColor', new THREE.BufferAttribute(cColor, 3));
  cgeo.setAttribute('aOn', new THREE.BufferAttribute(cOn, 1));
  const cmat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: innerHeight / 2 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor; attribute float aOn;
      uniform float uTime, uScale;
      varying vec3 vColor; varying float vOn;
      void main() {
        vColor = aColor; vOn = aOn;
        float pulse = 1.0 + 0.12 * sin(uTime * 1.5);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float base = 26.0 + 8.0 * aOn;
        gl_PointSize = base * pulse * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vOn;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        // anneau fin + petit coeur
        float ring = smoothstep(0.50, 0.44, d) - smoothstep(0.40, 0.34, d);
        float coreDot = smoothstep(0.16, 0.0, d);
        float a = ring * (0.85 + 0.15 * vOn) + coreDot * (0.5 + 0.5 * vOn);
        gl_FragColor = vec4(vColor * (1.0 + 0.6 * vOn), a);
      }`
  });
  const centerPoints = new THREE.Points(cgeo, cmat);
  centerPoints.renderOrder = 2;
  scene.add(centerPoints);

  // --- lignes de constellation : du centre vers chaque étoile du secteur ---
  sectorList.forEach((s) => {
    const k = s.indices.length;
    const lp = new Float32Array(k * 2 * 3); // 2 sommets par segment
    s.indices.forEach((idx, j) => {
      lp.set([s.pos.x, s.pos.y, s.pos.z], j * 6);
      lp.set([starPos.getX(idx), starPos.getY(idx), starPos.getZ(idx)], j * 6 + 3);
    });
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    const lmat = new THREE.LineBasicMaterial({
      color: s.color.clone().lerp(new THREE.Color(1, 1, 1), 0.25),
      transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(lgeo, lmat);
    lines.visible = false;
    scene.add(lines);
    s.lines = lines;
    s.cgeo = cgeo; // pour basculer aOn
  });

  return { centerPoints, cmat, cgeo };
}

// ---------------------------------------------------------------------------
// 5c. Labels HTML des constellations + bascule afficher/masquer les étoiles
// ---------------------------------------------------------------------------
const revealedSectors = new Set();

function setupConstellations(sectorList, starGeo, centerCgeo) {
  const wrap = document.createElement('div');
  wrap.id = 'labels';
  document.body.appendChild(wrap);

  const vis = starGeo.getAttribute('aVisible');
  const aOn = centerCgeo.getAttribute('aOn');

  function toggleSector(s) {
    const on = !revealedSectors.has(s.si);
    if (on) revealedSectors.add(s.si); else revealedSectors.delete(s.si);
    for (const idx of s.indices) vis.setX(idx, on ? 1 : 0);
    vis.needsUpdate = true;
    s.lines.visible = on;
    aOn.setX(s.si, on ? 1 : 0); aOn.needsUpdate = true;
    s.label.classList.toggle('on', on);
  }

  sectorList.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'clabel';
    el.innerHTML = `<span class="cname">${s.name}</span><span class="ccount">${s.indices.length}</span>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleSector(s); });
    wrap.appendChild(el);
    s.label = el;
  });

  // projection des labels à chaque frame (cachés quand on plonge dans une étoile)
  const v = new THREE.Vector3();
  updaters.push(() => {
    if (isZoomed) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    for (const s of sectorList) {
      v.copy(s.pos).project(camera);
      const el = s.label;
      if (v.z > 1) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
      el.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    }
  });

  return { toggleSector };
}

// ---------------------------------------------------------------------------
// 6. Interaction : clic → fiche détail
// ---------------------------------------------------------------------------
function setupPicking(points, assets, ctx) {
  const ray = new THREE.Raycaster();
  ray.params.Points.threshold = 2.4;
  const cray = new THREE.Raycaster();    // raycaster dédié aux centres (seuil plus large)
  cray.params.Points.threshold = 5.0;
  const card = $('#card');
  const ndc = new THREE.Vector2();
  const pos = points.geometry.getAttribute('position');

  function fmtCap(v) {
    if (!v) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + ' T$';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + ' G$';
    return (v / 1e6).toFixed(0) + ' M$';
  }

  // Affiche la fiche à côté de l'étoile (projetée à l'écran, ~au centre après le vol)
  function showCard(a, starPos) {
    const up = (a.change_pct ?? 0) >= 0;
    card.innerHTML = `
      <div class="tk">${a.ticker}</div>
      <div class="nm">${a.name ?? ''}</div>
      <div class="row"><span>Variation</span><span class="chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${(a.change_pct ?? 0).toFixed(2)} %</span></div>
      <div class="row"><span>Prix</span><span>${a.price != null ? a.price.toFixed(2) + ' $' : '—'}</span></div>
      <div class="row"><span>Capitalisation</span><span>${fmtCap(a.market_cap)}</span></div>
      <div class="row"><span>Secteur</span><span>${a.sector ?? a.asset_type}</span></div>
      <div class="row"><span>Volatilité 30j</span><span>${a.volatility_30d != null ? (a.volatility_30d * 100).toFixed(2) + ' %' : '—'}</span></div>
      <div class="row"><span>Beta</span><span>${a.beta ?? '—'}</span></div>`;
    const v = starPos.clone().project(camera);
    const sx = (v.x * 0.5 + 0.5) * innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * innerHeight;
    card.style.left = Math.min(Math.max(sx + 28, 16), innerWidth - 300) + 'px';
    card.style.top = Math.min(Math.max(sy - 70, 16), innerHeight - 240) + 'px';
    card.classList.add('on');
  }

  function handlePick(clientX, clientY) {
    if (activeFlight) return; // on ignore les clics pendant un vol
    ndc.x = (clientX / innerWidth) * 2 - 1;
    ndc.y = -(clientY / innerHeight) * 2 + 1;

    // 1) priorité aux centres de constellation : clic = afficher/masquer le secteur
    if (!isZoomed) {
      cray.setFromCamera(ndc, camera);
      const chits = cray.intersectObject(ctx.centerPoints);
      if (chits.length) {
        ctx.toggleSector(ctx.sectorList[chits[0].index]);
        return;
      }
    }

    // 2) sinon, on cible une étoile — mais seulement parmi les constellations dépliées
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(points)
      .filter(h => revealedSectors.has(ctx.starSector[h.index]));

    if (!hits.length) {
      if (isZoomed) zoomOut(); // clic dans le vide → retour à la vue allongée
      return;
    }

    const idx = hits[0].index;
    const a = assets[idx];
    const starPos = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx));

    // mémoriser la vue d'origine au premier plongeon
    if (!isZoomed) savedView = { pos: camera.position.clone(), tgt: controls.target.clone() };
    isZoomed = true;
    card.classList.remove('on'); // cachée pendant le vol

    // destination : juste devant l'étoile (sur le rayon observateur→étoile)
    const standoff = 8;
    const dest = starPos.clone().multiplyScalar((R - standoff) / R);
    flyTo(dest, starPos, 1.0, () => {
      setControlMode('inspect');
      showCard(a, starPos);
    });
  }

  // --- Distinguer un vrai tap (sélection) d'un glissé (navigation) ---------
  // OrbitControls consomme le drag pour tourner la tête. On ne déclenche la
  // sélection que si le pointeur a très peu bougé entre l'appui et le relâché :
  // au-delà du seuil, le geste est une navigation et on l'ignore.
  const DRAG_THRESHOLD = 6;     // px : tolérance de tremblement d'un clic franc
  let downX = 0, downY = 0, tapValid = false;

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) { tapValid = false; return; } // bouton gauche seulement
    downX = e.clientX; downY = e.clientY;
    tapValid = true;
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!tapValid) return;
    tapValid = false;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return; // glissé → navigation, pas de sélection
    handlePick(e.clientX, e.clientY);
  });
}

// ---------------------------------------------------------------------------
// 7. Boot
// ---------------------------------------------------------------------------
async function boot() {
  loaderP.textContent = 'chargement des données…';
  const doc = await fetch('./data/snapshot.json').then(r => r.json());
  const assets = doc.assets;
  loaderP.textContent = `construction de ${assets.length} étoiles…`;

  addBackdrop();
  addMeadow();
  addBody();
  const { points, mat, geo, sectorList, starSector } = buildStars(assets);
  const { centerPoints, cmat, cgeo } = buildConstellations(sectorList, geo.getAttribute('position'));
  const { toggleSector } = setupConstellations(sectorList, geo, cgeo);
  setupPicking(points, assets, { sectorList, starSector, centerPoints, toggleSector });

  $('#hud-sub').textContent =
    `${assets.length} actifs · ${sectorList.length} constellations · clic = déplier`;
  $('#loader').classList.add('gone');

  // debug exposé en console (préférence projet)
  window.debug = { THREE, scene, camera, controls, assets, mat, doc, bodyGroup,
    sectorList, revealedSectors, toggleSector };

  const clock = new THREE.Clock();
  let elapsed = 0;
  (function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    elapsed += dt;
    mat.uniforms.uTime.value = elapsed;
    cmat.uniforms.uTime.value = elapsed;
    for (const u of updaters) u(elapsed, dt);
    if (activeFlight) updateFlight(dt);
    else controls.update();
    renderer.render(scene, camera);
  })();
}

boot().catch(err => {
  console.error('[Celestial] boot error', err);
  loaderP.textContent = 'erreur : ' + err.message;
});
