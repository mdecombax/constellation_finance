// Celestial Market — rendu de la voûte boursière.
// Charge data/snapshot.json et place 4000 étoiles encodées sur une voûte sphérique.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const R = 100;            // rayon de la voûte
const HORIZON_Y = 0.06;   // hauteur min des étoiles (au-dessus de l'horizon = dôme hémisphérique)
const GROUND_Y = -2.7;    // niveau du sol (juste sous l'observateur allongé)

// Disposition de la voûte — deux gestes du corps, deux dimensions :
//   azimut (où l'on tourne la tête)  = secteur → un "quartier" du ciel par secteur
//   élévation (jusqu'où l'on lève les yeux) = dollar volume du jour → les plus gros
//   brasseurs culminent au zénith, les endormis rasent l'horizon.
const EL_MIN = 0.12;       // élévation mini (~7°, juste au-dessus de l'horizon)
const EL_MAX = 1.45;       // élévation maxi (~83°, proche zénith sans converger en un point)
const QUARTER_FILL = 0.7;  // part du quartier azimutal réellement occupée (gap entre secteurs)

const $ = (s) => document.querySelector(s);
const loaderP = $('#loader-p');

// ---------------------------------------------------------------------------
// 1. Scène / caméra / contrôles
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x02030a, 0.0016);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0.2, -2.4, 0.95); // allongé au sol, regard tourné vers le ciel (zénith)

// Zoom optique (FOV) en contemplation : on grossit la portion de ciel visée,
// "façon jumelles". Bien plus lisible que le dolly OrbitControls (la tête ne bouge pas).
const FOV = { base: 62, min: 22, max: 62 };

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableRotate = false;     // la rotation est pilotée à la main (pointer lock, cf. §6) ;
                                   // OrbitControls ne garde que le zoom + le damping + flyTo
controls.rotateSpeed = -0.25;      // (conservé pour mémoire : sert de calibrage à la nav)
controls.zoomSpeed = 0.7;
controls.enableZoom = false;       // en contemplation : zoom FOV maison (cf. wheel ci-dessous) ;
                                   // réactivé en mode 'inspect' où le dolly autour de l'étoile a du sens
controls.minDistance = 0.1;
controls.maxDistance = 4;          // on reste près du sol (l'observateur ne s'envole pas)
controls.minPolarAngle = Math.PI * 0.46;  // ~83° : on peut pencher un peu vers l'horizon
controls.maxPolarAngle = Math.PI * 0.99;  // ~178° : jusqu'au zénith, jamais sous le sol
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = false;       // pas de drift automatique : la vue reste fixe sans interaction
controls.autoRotateSpeed = 0.06;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Molette / pinch trackpad → zoom optique en contemplation (le FOV se resserre).
// En inspection d'une étoile, on laisse OrbitControls faire son dolly (enableZoom=true).
renderer.domElement.addEventListener('wheel', (e) => {
  if (isZoomed || activeFlight) return;           // 'inspect'/vol : géré ailleurs
  e.preventDefault();
  camera.fov = Math.max(FOV.min, Math.min(FOV.max, camera.fov + e.deltaY * 0.04));
  camera.updateProjectionMatrix();
}, { passive: false });

// ---------------------------------------------------------------------------
// Vol de caméra : "megazoom" vers une étoile au clic, retour au clic dans le vide
// ---------------------------------------------------------------------------
let activeFlight = null;   // tween en cours
let savedView = null;      // vue à restaurer au dézoom
let isZoomed = false;
let bodyGroup = null;      // corps FPS de l'observateur
const updaters = [];       // animations PERMANENTES du décor (lucioles, ondes…)
const dayUpdaters = [];    // animations liées aux DONNÉES du jour (vidées au rebuild)

// État mutable de la "scène data" courante (étoiles + constellations + picking).
// Les listeners stables (souris, clavier) lisent ces refs ; au changement de jour,
// buildWorld() reconstruit tout et réaffecte world.* — pas d'empilement de listeners.
const world = {
  points: null, geo: null, mat: null, cmat: null, assets: [],
  sectorList: [], starSector: null, centerPoints: null, sectorLines: [],
  labelsWrap: null,
  toggleSector: () => {}, toggleAll: () => {},
  handlePick: () => {}, rotateHead: () => {},
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const STANDOFF = 8;   // distance d'arrêt devant l'étoile au bout du plongeon (effet "cœur")
const LOOK_R   = 2;   // rayon de la cible FPS : on regarde un point proche, pivot = la caméra

// Limites OrbitControls. Au sol : on reste allongé (faible distance, on ne regarde
// que le ciel). Zoomé près d'une étoile : on relâche tout pour pouvoir tourner la
// tête à 360° en FPS sans qu'OrbitControls reclampe distance/angle à chaque frame.
function setOrbitLimits(zoomed) {
  if (zoomed) {
    controls.minDistance = 0.1; controls.maxDistance = 1e4;
    controls.minPolarAngle = 0.001; controls.maxPolarAngle = Math.PI - 0.001;
  } else {
    controls.minDistance = 0.1; controls.maxDistance = 4;
    controls.minPolarAngle = Math.PI * 0.46; controls.maxPolarAngle = Math.PI * 0.99;
  }
}

// Tween de caméra : plongeon vers une étoile (position + cible + FOV) puis retour.
function flyTo(destPos, lookAt, dur, onArrive, toFov) {
  controls.autoRotate = false;
  controls.enabled = false;
  activeFlight = {
    fromPos: camera.position.clone(), toPos: destPos.clone(),
    fromTgt: controls.target.clone(), toTgt: lookAt.clone(),
    fromFov: camera.fov, toFov: toFov ?? camera.fov,
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
  if (f.fromFov !== f.toFov) {
    camera.fov = f.fromFov + (f.toFov - f.fromFov) * k;
    camera.updateProjectionMatrix();
  }
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
  // Grand retour : on revole jusqu'à la vue allongée dans la prairie, puis on
  // restaure les limites "sol" une fois posé.
  flyTo(savedView.pos, savedView.tgt, 1.1, () => setOrbitLimits(false),
    savedView ? savedView.fov : FOV.base);
}

addEventListener('keydown', (e) => { if (e.key === 'Escape') zoomOut(); });

// ---------------------------------------------------------------------------
// Ondes de choc : anneaux lumineux qui se propagent depuis le centre d'un secteur
// au moment où sa constellation éclôt (renfort visuel de l'explosion).
// ---------------------------------------------------------------------------
const activeShocks = [];
const SHOCK_DUR = 0.7;

function spawnShockwave(pos, color) {
  // deux anneaux concentriques décalés → impression d'impulsion
  for (let k = 0; k < 2; k++) {
    const geo = new THREE.RingGeometry(0.80, 1.0, 64);
    const mat = new THREE.MeshBasicMaterial({
      color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.55),
      transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.copy(pos);
    ring.renderOrder = 3;
    scene.add(ring);
    activeShocks.push({ ring, mat, t: -k * 0.12 }); // 2e anneau légèrement en retard
  }
}

// mise à jour des ondes (poussée une fois, persistante)
updaters.push((_elapsed, dt) => {
  for (let i = activeShocks.length - 1; i >= 0; i--) {
    const s = activeShocks[i];
    s.t += dt;
    if (s.t < 0) continue;                       // pas encore éclos (retard du 2e anneau)
    const k = s.t / SHOCK_DUR;
    if (k >= 1) {
      scene.remove(s.ring);
      s.ring.geometry.dispose(); s.mat.dispose();
      activeShocks.splice(i, 1);
      continue;
    }
    const e = 1 - Math.pow(1 - k, 3);            // easeOutCubic : départ vif
    s.ring.scale.setScalar(2.0 + e * 17.0);
    s.ring.lookAt(camera.position);              // billboard face caméra
    s.mat.opacity = (1 - k) * 0.9;
  }
});

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
// Direction unitaire depuis un azimut (tour d'horizon) et une élévation (horizon→zénith).
// y = sin(el) : zénith → y=1, horizon → y≈0. Le vecteur est déjà normé.
function dirFromAzEl(az, el) {
  const cE = Math.cos(el), sE = Math.sin(el);
  return new THREE.Vector3(Math.cos(az) * cE, sE, Math.sin(az) * cE);
}

// Un secteur = un quartier d'azimut. Son "centre" (marqueur + départ d'explosion)
// se pose à mi-hauteur du dôme, dans la direction du quartier.
function sectorCenters(sectors) {
  const centers = {};
  const m = sectors.length;
  const elMid = (EL_MIN + EL_MAX) / 2;
  sectors.forEach((s, i) => {
    const az = ((i + 0.5) / m) * Math.PI * 2;
    centers[s] = dirFromAzEl(az, elMid);
  });
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
  const aReveal = new Float32Array(n);           // 0 = masquée (défaut) → 1 = jaillie à sa place (continu, animé)
  const aCenter = new Float32Array(n * 3);       // centre du secteur : point de départ de l'explosion
  const starSector = new Int32Array(n);          // index du secteur de chaque étoile (pour le picking)
  const rawDist = new Float32Array(n);           // distance étoile→centre (sert au délai de ripple)
  const staggerByIdx = new Float32Array(n);      // délai d'éclosion (s) par étoile : vague depuis le centre

  // accumulateurs par secteur (couleur moyenne + liste d'indices)
  const sectorList = sectors.map((name, si) => ({
    name, si, dir: centers[name], indices: [],
    color: new THREE.Color(0, 0, 0), pos: centers[name].clone().multiplyScalar(R),
  }));
  const sectorBySi = (a) => sectorList.find(s => s.name === (a.sector || '(ETF)'));

  // Élévation = dollar volume du jour (prix × volume, échelle log), borné par quantiles
  // robustes (p2/p98) pour qu'une poignée d'extrêmes n'écrase pas toute la voûte.
  const dvLog = assets.map(a => (a.price > 0 && a.volume > 0) ? Math.log10(a.price * a.volume) : null);
  const sortedDv = dvLog.filter(v => v != null).sort((x, y) => x - y);
  const dvAt = (p) => sortedDv[Math.floor(p * (sortedDv.length - 1))];
  const DV_LO = dvAt(0.02), DV_HI = dvAt(0.98);
  const elevOf = (i) => {
    const v = dvLog[i];
    const t = v == null ? 0 : Math.max(0, Math.min(1, (v - DV_LO) / (DV_HI - DV_LO)));
    return EL_MIN + t * (EL_MAX - EL_MIN);
  };

  // Azimut = quartier du secteur (largeur utile QUARTER_FILL, gap entre quartiers)
  const m = sectors.length;
  const quarterWidth = (Math.PI * 2 / m) * QUARTER_FILL;

  assets.forEach((a, i) => {
    const sec = sectorBySi(a);
    // azimut : centre du quartier du secteur + jitter contenu dans le quartier
    const az = ((sec.si + 0.5) / m) * Math.PI * 2 + (Math.random() - 0.5) * quarterWidth;
    // élévation : dollar volume + léger bruit pour l'épaisseur (sans brouiller la lecture)
    const el = elevOf(i) + (Math.random() - 0.5) * 0.06;
    const dir = dirFromAzEl(az, el);
    position.set([dir.x * R, dir.y * R, dir.z * R], i * 3);

    const c = volatilityColor(a.volatility_30d);
    aColor.set([c.r, c.g, c.b], i * 3);
    aSize[i] = sizeFromCap(a.market_cap_log);
    aBright[i] = Math.max(0.45, Math.min(1.6, 0.55 + 0.6 * (a.volume_norm ?? 1)));
    aPulse[i] = Math.max(0, Math.min(1, Math.abs(a.change_pct ?? 0) / 5));
    aPhase[i] = Math.random() * Math.PI * 2;
    aReveal[i] = 0;
    aCenter.set([sec.pos.x, sec.pos.y, sec.pos.z], i * 3); // l'étoile part du centre du secteur
    rawDist[i] = sec.pos.distanceTo(new THREE.Vector3(dir.x * R, dir.y * R, dir.z * R));
    starSector[i] = sec.si;
    sec.indices.push(i);
    sec.color.add(c);
  });

  // couleur représentative = moyenne des volatilités du secteur
  sectorList.forEach(s => { if (s.indices.length) s.color.multiplyScalar(1 / s.indices.length); });

  // Délai d'éclosion par étoile : vague qui part du centre (les plus proches éclosent d'abord).
  // Normalisé par secteur pour que chaque constellation, petite ou grande, explose pareil.
  const STAGGER_SPAN = 0.42; // étalement total de la vague (s)
  sectorList.forEach(s => {
    let maxD = 1e-6;
    for (const idx of s.indices) maxD = Math.max(maxD, rawDist[idx]);
    for (const idx of s.indices) {
      staggerByIdx[idx] = (rawDist[idx] / maxD) * STAGGER_SPAN + Math.random() * 0.06;
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geo.setAttribute('aBright', new THREE.BufferAttribute(aBright, 1));
  geo.setAttribute('aPulse', new THREE.BufferAttribute(aPulse, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute('aReveal', new THREE.BufferAttribute(aReveal, 1));
  geo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: innerHeight / 2 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor; attribute vec3 aCenter;
      attribute float aSize, aBright, aPulse, aPhase, aReveal;
      uniform float uTime, uScale;
      varying vec3 vColor; varying float vBright; varying float vReveal; varying float vSize;
      void main() {
        vColor = aColor; vBright = aBright;
        float r = clamp(aReveal, 0.0, 1.0);
        vReveal = r;
        // morph de position : jaillit du centre du secteur vers sa place (ease décélérée)
        float e = r * r * (3.0 - 2.0 * r);
        vec3 p = mix(aCenter, position, e);
        // pulsation désactivée pour l'instant (aPulse conservé pour réactivation future)
        // enveloppe "pop" : croît vite puis dépasse (overshoot) avant de se caler à 1
        float grow = smoothstep(0.0, 0.45, r);
        float pop  = grow * (1.0 + 0.55 * sin(r * 3.14159));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // aReveal = 0 -> pop = 0 -> taille nulle -> étoile non rendue (constellation masquée)
        gl_PointSize = aSize * pop * (uScale / -mv.z);
        vSize = gl_PointSize;   // taille à l'écran (px) → pilote l'apparition des pics
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vBright; varying float vReveal; varying float vSize;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;          // [-0.5, 0.5]
        float d = length(uv);
        if (d > 0.5) discard;

        // cœur net + halo serré : un point dense, pas un disque mou
        float disk = smoothstep(0.5, 0.0, d);
        float halo = pow(disk, 2.4);            // halo doux qui retombe vite (garde la teinte)
        float core = pow(disk, 7.0);            // cœur resserré, très brillant (blanchit)

        // pics de diffraction (croix 4 branches), thickness ~10% du sprite
        vec2 a = abs(uv);
        float spikeH = pow(max(0.0, 1.0 - a.y / 0.05), 2.0) * smoothstep(0.5, 0.0, a.x);
        float spikeV = pow(max(0.0, 1.0 - a.x / 0.05), 2.0) * smoothstep(0.5, 0.0, a.y);
        // n'apparaissent que quand l'étoile devient grosse à l'écran (flyTo / approche)
        float spikeAmt = smoothstep(40.0, 120.0, vSize);
        float spikes = (spikeH + spikeV) * spikeAmt * 0.7;

        // flash blanc au moment de l'éclosion (chaud au cœur de la vague, se résorbe)
        float burst = smoothstep(0.55, 0.0, abs(vReveal - 0.45)) * (1.0 - smoothstep(0.0, 1.0, vReveal));

        // profil d'intensité (forme) porté par l'alpha (cf. AdditiveBlending)
        float shape = clamp(0.3 * halo + core + spikes, 0.0, 1.0);
        // le cœur et les pics tendent vers le blanc ; le halo conserve la couleur
        vec3 col = mix(vColor, vec3(1.0), clamp(core * 0.9 + burst * 0.6, 0.0, 1.0));
        gl_FragColor = vec4(col * vBright + halo * burst, shape);
      }`
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);
  return { points, mat, geo, sectorList, starSector, staggerByIdx };
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

function setupConstellations(sectorList, starGeo, centerCgeo, staggerByIdx) {
  const wrap = document.createElement('div');
  wrap.id = 'labels';
  document.body.appendChild(wrap);

  const vis = starGeo.getAttribute('aReveal');
  const aOn = centerCgeo.getAttribute('aOn');

  const REVEAL_DUR = 0.5;        // durée d'éclosion d'une étoile (s) une fois son délai écoulé
  const activeAnims = [];        // secteurs dont l'explosion / implosion est en cours
  let nowT = 0;                  // temps écoulé courant (rafraîchi chaque frame)

  function toggleSector(s) {
    const on = !revealedSectors.has(s.si);
    if (on) {
      revealedSectors.add(s.si);
      s.lines.visible = true;
      aOn.setX(s.si, 1);
    } else {
      revealedSectors.delete(s.si); // retirée tout de suite : non sélectionnable pendant l'implosion
      aOn.setX(s.si, 0);
    }
    aOn.needsUpdate = true;
    s.label.classList.toggle('on', on);
    s.anim = { dir: on ? 1 : -1, t0: nowT };
    if (!activeAnims.includes(s)) activeAnims.push(s);
    spawnShockwave(s.pos, s.color); // onde de choc au centre, dans les deux sens
  }

  // Pilote l'explosion : chaque étoile éclôt après son délai, sur REVEAL_DUR.
  dayUpdaters.push((elapsed) => {
    nowT = elapsed;
    if (!activeAnims.length) return;
    for (let a = activeAnims.length - 1; a >= 0; a--) {
      const s = activeAnims[a];
      const anim = s.anim;
      let done = true;
      for (const idx of s.indices) {
        const p = (elapsed - anim.t0 - staggerByIdx[idx]) / REVEAL_DUR;
        let r = Math.max(0, Math.min(1, p));
        if (anim.dir < 0) r = 1 - r;             // implosion = lecture inverse
        vis.setX(idx, r);
        if (anim.dir > 0 ? r < 1 : r > 0) done = false;
      }
      // les lignes se dessinent / s'effacent avec la vague
      const lead = Math.max(0, Math.min(1, (elapsed - anim.t0) / (REVEAL_DUR * 1.4)));
      if (s.lines.material) s.lines.material.opacity = (anim.dir > 0 ? lead : 1 - lead) * 0.18;
      if (done) {
        if (anim.dir < 0) s.lines.visible = false;
        s.anim = null;
        activeAnims.splice(a, 1);
      }
    }
    vis.needsUpdate = true;
  });

  sectorList.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'clabel';
    el.innerHTML = `<span class="cname">${s.name}</span><span class="ccount">${s.indices.length}</span>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleSector(s); });
    wrap.appendChild(el);
    s.label = el;
  });

  // Bascule globale : rien d'ouvert → on déplie tout ; sinon → on replie tout ce qui est ouvert.
  function toggleAll() {
    const anyOpen = revealedSectors.size > 0;
    for (const s of sectorList) {
      const open = revealedSectors.has(s.si);
      if (anyOpen ? open : !open) toggleSector(s);
    }
  }
  // (la touche Espace → toggleAll est gérée une seule fois dans installControls)

  // projection des labels à chaque frame (cachés quand on plonge dans une étoile)
  const v = new THREE.Vector3();
  dayUpdaters.push(() => {
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

  return { toggleSector, toggleAll, wrap };
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
      <div class="row"><span>Volume échangé ($)</span><span>${fmtCap((a.price ?? 0) * (a.volume ?? 0))}</span></div>
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

    // 2) sinon, on cible une étoile — mais seulement parmi les constellations dépliées.
    // Three.js trie les hits de Points par profondeur (distance caméra) : dans un
    // groupe serré au réticule, ça privilégie l'étoile la plus proche plutôt que
    // celle qu'on vise vraiment. On retrie par angle au réticule
    // (distanceToRay / distance) → la mieux centrée à l'écran gagne.
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(points)
      .filter(h => revealedSectors.has(ctx.starSector[h.index]))
      .sort((a, b) => (a.distanceToRay / a.distance) - (b.distanceToRay / b.distance));

    if (!hits.length) {
      if (isZoomed) zoomOut(); // clic dans le vide → retour à la vue allongée
      return;
    }

    const idx = hits[0].index;
    const a = assets[idx];
    const starPos = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx));

    // Plongeon cinématique jusqu'au "cœur" de l'étoile, puis bascule en regard
    // FPS (tête qui pivote sur place) : on garde l'effet wow ET la liberté de
    // viser les voisines. Cliquer une voisine relance un plongeon vers elle.
    if (!isZoomed) {
      savedView = { pos: camera.position.clone(), tgt: controls.target.clone(), fov: camera.fov };
    }
    isZoomed = true;
    card.classList.remove('on'); // cachée pendant le plongeon
    const dest = starPos.clone().multiplyScalar((R - STANDOFF) / R); // arrêt devant l'étoile
    flyTo(dest, starPos, 1.0, () => {
      setOrbitLimits(true);
      // On rapproche la cible à LOOK_R devant la caméra, dans l'axe de l'étoile :
      // le regard ne change pas (cible alignée), mais le pivot devient la caméra.
      const dir = starPos.clone().sub(camera.position).normalize();
      controls.target.copy(camera.position).addScaledVector(dir, LOOK_R);
      camera.lookAt(controls.target);
      showCard(a, starPos);
    }, FOV.base);
  }

  // --- Navigation Pointer Lock : la tête tourne en continu, sans re-clic ----
  // État par défaut = curseur verrouillé. Le moindre mouvement du trackpad fait
  // pivoter la tête, sans jamais buter sur un bord (mouvement relatif infini).
  // On ne réécrit PAS OrbitControls : on tourne nous-mêmes camera.position autour
  // de controls.target via un Spherical ; controls.update() (sans delta en attente)
  // est idempotent et se contente de préserver/reclamper notre rotation.
  const reticle = $('#reticle');
  const sph = new THREE.Spherical();
  const centerNdc = new THREE.Vector2(0, 0);   // réticule = centre exact de l'écran
  // sens : multiplicateur ; signX/signY : orientation. Le facteur (π/2)/h calque
  // l'ancien drag OrbitControls (2π · rotateSpeed 0.25 / hauteur) → ressenti identique.
  const NAV = { sens: 1.0, signX: 1, signY: 1 };

  function rotateHead(dx, dy) {
    if (activeFlight) return;                   // pas de rotation pendant un vol caméra
    // sensibilité ∝ FOV : plus on est zoomé (FOV serré), plus on ralentit, pour que
    // le ciel défile à la même vitesse à l'écran quel que soit le niveau de zoom.
    const k = (Math.PI * 0.5) / innerHeight * NAV.sens * (camera.fov / FOV.base);
    if (isZoomed) {
      // FPS : la caméra reste sur place, c'est le regard (la cible) qui pivote
      // autour d'elle → on peut balayer les étoiles voisines tout autour.
      const dir = controls.target.clone().sub(camera.position);
      const len = dir.length();
      sph.setFromVector3(dir);
      sph.theta += k * dx * NAV.signX;
      // phi inversé vs. le sol : ici on pivote la direction du regard (et non
      // l'offset caméra↔cible, qui est le vecteur opposé) → même ressenti vertical.
      sph.phi   -= k * dy * NAV.signY;
      sph.phi = Math.max(0.06, Math.min(Math.PI - 0.06, sph.phi)); // anti-bascule
      sph.makeSafe();
      dir.setFromSpherical(sph).setLength(len);
      controls.target.copy(camera.position).add(dir);
      camera.lookAt(controls.target);
      return;
    }
    // Sol : la tête pivote autour du point d'observation (on regarde la voûte).
    const off = camera.position.clone().sub(controls.target);
    sph.setFromVector3(off);
    sph.theta += k * dx * NAV.signX;
    sph.phi   += k * dy * NAV.signY;
    sph.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, sph.phi));
    sph.makeSafe();
    off.setFromSpherical(sph);
    camera.position.copy(controls.target).add(off);
    camera.lookAt(controls.target);
  }

  // (les listeners souris/pointer-lock sont installés une seule fois dans
  //  installControls et délèguent à world.handlePick / world.rotateHead)

  // Retour visuel : le réticule s'accroche quand une cible cliquable est visée.
  dayUpdaters.push(() => {
    if (!reticle) return;
    if (document.pointerLockElement !== renderer.domElement) { reticle.classList.remove('hit'); return; }
    let hit = false;
    if (!isZoomed) {
      cray.setFromCamera(centerNdc, camera);
      hit = cray.intersectObject(ctx.centerPoints).length > 0;
    }
    if (!hit) {
      ray.setFromCamera(centerNdc, camera);
      hit = ray.intersectObject(points).some(h => revealedSectors.has(ctx.starSector[h.index]));
    }
    reticle.classList.toggle('hit', hit);
  });

  // exposé pour calibrer la sensibilité depuis la console (préférence projet)
  window.debug = Object.assign(window.debug || {}, { NAV });
  return { handlePick, rotateHead };
}

// ---------------------------------------------------------------------------
// 7. Boot
// ---------------------------------------------------------------------------

// Charge un JSON gzippé (data/days/<date>.json.gz) et le décompresse côté client
// via DecompressionStream (natif, zéro lib).
async function loadGzJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

// Charge le manifest + la séance la plus récente. Fallback défensif sur
// snapshot.json si l'index ou le .gz sont indisponibles.
async function loadLatest() {
  try {
    const res = await fetch('./data/index.json');
    if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
    const index = await res.json();
    if (!index.latest) throw new Error('index.json sans champ latest');
    const doc = await loadGzJson(`./data/days/${index.latest}.json.gz`);
    return { doc, index };
  } catch (e) {
    console.warn('[Celestial] index/gz indisponible, fallback snapshot.json :', e);
    const doc = await fetch('./data/snapshot.json').then(r => r.json());
    return { doc, index: null };
  }
}

// Détruit la scène data courante (étoiles, constellations, labels, updaters) et
// libère la mémoire GPU — appelé avant chaque (re)construction de jour.
function disposeWorld() {
  if (world.points) { scene.remove(world.points); world.points.geometry.dispose(); world.points.material.dispose(); }
  if (world.centerPoints) { scene.remove(world.centerPoints); world.centerPoints.geometry.dispose(); world.centerPoints.material.dispose(); }
  for (const ln of world.sectorLines) { scene.remove(ln); ln.geometry.dispose(); ln.material.dispose(); }
  world.sectorLines = [];
  if (world.labelsWrap) { world.labelsWrap.remove(); world.labelsWrap = null; }
  dayUpdaters.length = 0;        // on retire les animations du jour précédent
  revealedSectors.clear();
  $('#card')?.classList.remove('on');
}

// (Re)construit la scène data pour un jeu d'actifs (un jour donné).
function buildWorld(assets) {
  disposeWorld();
  isZoomed = false; activeFlight = null; setOrbitLimits(false); // état d'interaction neuf

  const { points, mat, geo, sectorList, starSector, staggerByIdx } = buildStars(assets);
  const { centerPoints, cmat, cgeo } = buildConstellations(sectorList, geo.getAttribute('position'));
  const { toggleSector, toggleAll, wrap } = setupConstellations(sectorList, geo, cgeo, staggerByIdx);
  const { handlePick, rotateHead } = setupPicking(
    points, assets, { sectorList, starSector, centerPoints, toggleSector });

  Object.assign(world, {
    points, geo, mat, cmat, assets, sectorList, starSector, centerPoints,
    sectorLines: sectorList.map(s => s.lines).filter(Boolean),
    labelsWrap: wrap, toggleSector, toggleAll, handlePick, rotateHead,
  });
}

// Listeners stables (attachés une seule fois) : ils délèguent à world.* qui est
// réaffecté à chaque changement de jour — donc aucun empilement de handlers.
function installControls() {
  const isLocked = () => document.pointerLockElement === renderer.domElement;
  document.addEventListener('mousemove', (e) => {
    if (isLocked()) world.rotateHead(e.movementX || 0, e.movementY || 0);
  });
  document.addEventListener('pointerlockchange', () => {
    document.body.classList.toggle('locked', isLocked());
  });
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (isLocked()) world.handlePick(innerWidth / 2, innerHeight / 2);
    else renderer.domElement.requestPointerLock();
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isZoomed) { e.preventDefault(); world.toggleAll(); }
  });
}

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
              'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fmtDay(iso) {              // "2026-06-05" -> "05 juin 2026"
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MOIS[m - 1]} ${y}`;
}

// Sélecteur de séance : flèches ◀ ▶ + touches ← → ; recharge le .gz du jour et
// reconstruit la voûte. Désactivé aux bornes de l'historique.
function setupDayNav(index) {
  if (!index || !Array.isArray(index.days) || index.days.length === 0) return;
  let i = index.days.indexOf(index.latest);
  if (i < 0) i = index.days.length - 1;

  const bar = document.createElement('div');
  bar.id = 'daynav';
  bar.innerHTML =
    `<button id="dn-prev" aria-label="jour précédent">◀</button>` +
    `<span id="dn-date"></span>` +
    `<button id="dn-next" aria-label="jour suivant">▶</button>`;
  document.body.appendChild(bar);
  const prev = bar.querySelector('#dn-prev');
  const next = bar.querySelector('#dn-next');
  const lbl = bar.querySelector('#dn-date');
  let busy = false;

  function render() {
    lbl.textContent = busy ? '…' : fmtDay(index.days[i]);
    prev.disabled = busy || i <= 0;                       // ◀ = jour plus ancien
    next.disabled = busy || i >= index.days.length - 1;   // ▶ = jour plus récent
  }

  async function go(delta) {
    const j = i + delta;
    if (busy || j < 0 || j >= index.days.length) return;
    busy = true; render();
    try {
      const doc = await loadGzJson(`./data/days/${index.days[j]}.json.gz`);
      i = j;
      buildWorld(doc.assets);
      window.debug.doc = doc; window.debug.assets = doc.assets;
    } catch (e) {
      console.error('[Celestial] changement de jour échoué :', e);
    } finally {
      busy = false; render();
    }
  }

  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  });

  render();
}

async function boot() {
  loaderP.textContent = 'chargement des données…';
  const { doc, index } = await loadLatest();
  const assets = doc.assets;
  loaderP.textContent = `construction de ${assets.length} étoiles…`;

  addBackdrop();
  addMeadow();
  addBody();
  installControls();      // listeners stables, une seule fois
  buildWorld(assets);     // étoiles + constellations + picking du jour
  setupDayNav(index);     // flèches ◀ ▶ entre séances

  $('#hud-sub').textContent =
    `tour d'horizon = secteurs · hauteur = $ échangés aujourd'hui · clic = déplier · espace = tout déplier/replier`;
  $('#loader').classList.add('gone');

  // debug exposé en console (préférence projet) — merge pour garder window.debug.NAV
  window.debug = Object.assign(window.debug || {}, { THREE, scene, camera, controls,
    doc, index, world, bodyGroup, revealedSectors, assets });

  const clock = new THREE.Clock();
  let elapsed = 0;
  (function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    elapsed += dt;
    if (world.mat) world.mat.uniforms.uTime.value = elapsed;
    if (world.cmat) world.cmat.uniforms.uTime.value = elapsed;
    for (const u of updaters) u(elapsed, dt);
    for (const u of dayUpdaters) u(elapsed, dt);
    if (activeFlight) updateFlight(dt);
    else controls.update();
    renderer.render(scene, camera);
  })();
}

boot().catch(err => {
  console.error('[Celestial] boot error', err);
  loaderP.textContent = 'erreur : ' + err.message;
});
