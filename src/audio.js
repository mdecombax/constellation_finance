// audio.js — musique d'ambiance en boucle (Web Audio API, loop sample-précis)
//
// Source : Orbiting_Memory.mp3 retaillé (1ʳᵉ sec + 2 dernières sec coupées),
// raccord crossfadé pour une boucle sans couture -> assets/orbiting_loop.ogg
//
// La lecture audio nécessite un geste utilisateur (politique autoplay des
// navigateurs) : on démarre au premier clic / appui touche / pointerdown.

const SRC_OGG = './assets/orbiting_loop.ogg';
const SRC_MP3 = './assets/orbiting_loop.mp3';
const TARGET_VOLUME = 0.55;   // volume cible (0–1)
const FADE_IN = 2.5;          // fondu d'entrée (s)

let ctx = null;
let gain = null;
let source = null;
let started = false;

function pickSource() {
  const a = document.createElement('audio');
  if (a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"')) return SRC_OGG;
  return SRC_MP3;
}

async function start() {
  if (started) return;
  started = true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();

    const url = pickSource();
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch audio ' + res.status);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());

    gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.connect(ctx.destination);

    source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;            // boucle sample-précise (gapless)
    source.connect(gain);
    source.start(0);

    // Fondu d'entrée doux pour que ça « passe bien »
    gain.gain.exponentialRampToValueAtTime(TARGET_VOLUME, ctx.currentTime + FADE_IN);
  } catch (e) {
    console.warn('[audio] démarrage impossible :', e);
    started = false; // autorise un nouvel essai au prochain geste
  }
}

// Démarre au premier geste utilisateur, puis se désabonne.
function arm() {
  const fire = () => { start(); cleanup(); };
  const cleanup = () => {
    window.removeEventListener('pointerdown', fire);
    window.removeEventListener('keydown', fire);
    window.removeEventListener('click', fire);
  };
  window.addEventListener('pointerdown', fire, { once: false });
  window.addEventListener('keydown', fire, { once: false });
  window.addEventListener('click', fire, { once: false });
}
arm();

// Contrôles debug depuis la console
window.debug = window.debug || {};
window.debug.audio = {
  start,
  setVolume(v) {
    if (gain && ctx) gain.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.3);
    return v;
  },
  mute() { this.setVolume(0); },
  unmute() { this.setVolume(TARGET_VOLUME); },
  stop() { if (source) { try { source.stop(); } catch (e) {} } },
  get ctx() { return ctx; },
};
