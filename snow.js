import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { createDefaultWeatherState, applyMapping, updateParticle } from './engine.js';
import { createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.esm.min.js';

// ------------------------------------------------------------------
// 0. HELPER: CREATE SOFT TEXTURE (Get rid of squares)
// ------------------------------------------------------------------
function createSoftTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    
    // Radial gradient: white in center, transparent at edges
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

// ------------------------------------------------------------------
// 1. THREE.JS SETUP
// ------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505); 
scene.fog = new THREE.FogExp2(0x050505, 0.02);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 2, 14); // Lower camera slightly to look "into" the volume
camera.lookAt(0, 3, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------
// 2. SHAPE & NOISE DESIGN
// ------------------------------------------------------------------

// A. Shape: Volumetric Cloud Layer
// To make it "3D" (Volumetric), we don't return a single Y plane.
// We use a hash of the position to give each particle a slight vertical offset 
// target, creating a "thick" layer instead of a paper-thin sheet.
function projectToShape(pos) {
    const time = Date.now() * 0.0001; // Slow drift for the shape itself
    
    // 1. Base Rolling Terrain (Large waves)
    const largeWave = Math.sin(pos[0] * 0.15 + time) * 1.5 + Math.cos(pos[2] * 0.15) * 1.5;
    
    // 2. Detail bumps (Small waves)
    const detailWave = Math.sin(pos[0] * 0.5) * 0.3 + Math.cos(pos[2] * 0.5) * 0.3;
    
    // 3. Volumetric Thickness
    // We can't easily get particle ID here, so we use position hashing
    // to determine "where this particle belongs" in the thickness of the cloud.
    // Note: This assumes particles stay roughly in their "lanes".
    const thickness = 3.0; 
    const hash = Math.sin(pos[0] * 12.9898 + pos[2] * 78.233) * 43758.5453; 
    const volumeOffset = (hash % 1) * thickness - (thickness / 2);

    const baseY = 6.0; 
    
    return [pos[0], baseY + largeWave + detailWave + volumeOffset, pos[2]];
}

// B. Noise: Curl Noise
const noise3D = createNoise3D();

function noiseFn(pos, time) {
    const eps = 0.1;
    const scale = 0.3; // Looser noise
    
    const pX = (x, y, z) => noise3D(x * scale, y * scale, z * scale + time * 0.15);
    const pY = (x, y, z) => noise3D(x * scale + 100, y * scale, z * scale + time * 0.15);
    const pZ = (x, y, z) => noise3D(x * scale + 200, y * scale, z * scale + time * 0.15);

    const x = pos[0], y = pos[1], z = pos[2];

    const dy_pZ = (pZ(x, y + eps, z) - pZ(x, y - eps, z)) / (2 * eps);
    const dz_pY = (pY(x, y, z + eps) - pY(x, y, z - eps)) / (2 * eps);
    const dz_pX = (pX(x, y, z + eps) - pX(x, y, z - eps)) / (2 * eps);
    const dx_pZ = (pZ(x + eps, y, z) - pZ(x - eps, y, z)) / (2 * eps);
    const dx_pY = (pY(x + eps, y, z) - pY(x - eps, y, z)) / (2 * eps);
    const dy_pX = (pX(x, y + eps, z) - pX(x, y - eps, z)) / (2 * eps);

    return [dy_pZ - dz_pY, dz_pX - dx_pZ, dx_pY - dy_pX];
}

// ------------------------------------------------------------------
// 3. WEATHER INPUTS & MAPPING
// ------------------------------------------------------------------

const inputs = {
    precipitation: 0.0, // 0-1
    windSpeed: 0.1,     // 0-1
    windDegree: 90      // 0-360
};

// We use an intermediate mapping object for the engine because
// we might want to transform inputs non-linearly before applying them.
const mappingConfig = {
    // 1. Shape Attraction
    // At 0 precip, we want them loosely held (strength 1.5).
    // As soon as precip starts, they get looser fast.
    shapeStrength: { from: 'adjPrecip', min: 1.5, max: 0.0 }, 
    
    // 2. Deformation
    // Even light rain breaks the shape apart.
    deformFactor: { from: 'adjPrecip', min: 0.2, max: 1.0 },

    // 3. Falling
    // Start falling immediately with any precip.
    verticalBias: { from: 'adjPrecip', min: 0.0, max: 4.0 },

    // 4. Chaos
    turbulence: { from: 'windSpeed', min: 0.3, max: 2.5 },
    flowSpeed: { from: 'windSpeed', min: 0.5, max: 8.0 },
    
    noiseScaleSmall: { from: 'adjPrecip', min: 1.0, max: 2.5 },
};

// ------------------------------------------------------------------
// 4. GUI SETUP
// ------------------------------------------------------------------
const gui = new GUI({ title: 'Weather Control' });
gui.add(inputs, 'precipitation', 0, 1).name('Precipitation').listen();
gui.add(inputs, 'windSpeed', 0, 1).name('Wind Speed').listen();
gui.add(inputs, 'windDegree', 0, 360).name('Wind Direction').listen();

// ------------------------------------------------------------------
// 5. PARTICLE SYSTEM
// ------------------------------------------------------------------
const PARTICLE_COUNT = 10000;
const particlesData = [];

const geometry = new THREE.BufferGeometry();
const positions = new Float32Array(PARTICLE_COUNT * 3);
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

// Soft texture material
const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.25, // Slightly larger for soft texture
    map: createSoftTexture(),
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    alphaMap: createSoftTexture() // Ensure alpha works with map
});

const particleSystem = new THREE.Points(geometry, material);
scene.add(particleSystem);

// Initialize
for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Spawn in a wide volume to start with
    const x = (Math.random() - 0.5) * 40;
    const y = 6 + (Math.random() - 0.5) * 4; // Thickness init
    const z = (Math.random() - 0.5) * 40;

    particlesData.push({
        position: [x, y, z],
        velocity: [0, 0, 0],
        life: Math.random()
    });
}

// ------------------------------------------------------------------
// 6. ANIMATION LOOP
// ------------------------------------------------------------------
const clock = new THREE.Clock();
const baseState = createDefaultWeatherState();
baseState.lifeSpan = 5.0;

function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.1);
    const time = clock.getElapsedTime();

    // --- A. Handle Inputs & Sensitivities ---
    
    // 1. Non-linear curve for precipitation
    // This solves the "barely change between 0-0.3" issue.
    // Math.pow(x, 0.4) makes 0.1 input act like 0.4, 0.3 act like 0.6.
    // It pushes the "action" into the lower range.
    const adjPrecip = Math.pow(inputs.precipitation, 0.4);
    
    // Prepare inputs for mapping
    const engineInputs = {
        adjPrecip: adjPrecip,
        windSpeed: inputs.windSpeed
    };

    // 2. Generate State
    const weatherState = applyMapping(engineInputs, mappingConfig, baseState);

    // 3. Handle Wind Direction (Manually set vector based on degrees)
    // Convert degrees to radians. Three.js: Z is usually "South" or "North" depending on convention.
    // Here: 0 deg = +Z, 90 deg = +X
    const rad = (inputs.windDegree) * (Math.PI / 180);
    weatherState.flowDirection = [Math.sin(rad), 0, Math.cos(rad)];

    // --- B. Particle Update ---
    
    const posArray = geometry.attributes.position.array;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particlesData[i];

        updateParticle(p, dt, weatherState, projectToShape, noiseFn, time);

        // --- C. Respawn Logic ---
        const isDead = p.life <= 0;
        const isTooLow = p.position[1] < -2; // Fall floor
        const isTooFar = Math.abs(p.position[0]) > 30 || Math.abs(p.position[2]) > 30;

        if (isDead || isTooLow || isTooFar) {
            p.life = 1.0;
            p.velocity = [0, 0, 0];
            
            // Random spawn area
            const spawnX = (Math.random() - 0.5) * 40;
            const spawnZ = (Math.random() - 0.5) * 40;
            const spawnY = 6 + (Math.random() - 0.5) * 3; // Respawn inside the volume

            // Wind Offset: If wind is blowing +X, spawn further -X so they blow into view
            const windOffsetX = -weatherState.flowDirection[0] * inputs.windSpeed * 15;
            const windOffsetZ = -weatherState.flowDirection[2] * inputs.windSpeed * 15;

            p.position = [spawnX + windOffsetX, spawnY, spawnZ + windOffsetZ];
        }

        posArray[i * 3] = p.position[0];
        posArray[i * 3 + 1] = p.position[1];
        posArray[i * 3 + 2] = p.position[2];
    }

    geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}

animate();