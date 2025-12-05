// ---------------------
// Cloudy v12 – Star-to-Cloud Morphing Ribbon
// ---------------------

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { createDefaultWeatherState, applyMapping, updateParticle } from './engine.js';
import { createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.esm.min.js';
import { fetchRealtimeWeather } from './weatherapi.js';

// ======================================================
// ★ 1. THREE.JS SETUP
// ======================================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d26); 
scene.fog = new THREE.FogExp2(0x1a1d26, 0.02);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 14);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ======================================================
// ★ 2. SHAPE & DISTRIBUTION LOGIC
// ======================================================

const MAX_BLOBS = 8; // More nodes for a longer, irregular chain
const blobs = [];

function initBlobChain() {
    blobs.length = 0;
    // Arrange in a messy, wandering path
    const startX = -14;
    const endX = 14;
    const span = endX - startX;
    
    for (let i = 0; i < MAX_BLOBS; i++) {
        const t = i / (MAX_BLOBS - 1);
        const x = startX + t * span + (Math.random()-0.5)*2.0; // Jitter X
        
        // Irregular wave
        const y = Math.sin(t * Math.PI * 3.0) * 2.0 + (Math.random()-0.5)*3.0; 
        const z = Math.cos(t * Math.PI * 2.5) * 1.5 + (Math.random()-0.5)*3.0;

        blobs.push({
            center: new THREE.Vector3(x, y, z),
            // Base radius grows with index? or random?
            baseRadius: 2.5 + Math.random() * 1.5,
            radius: 0.0, 
            targetRadius: 0.0,
            rotation: Math.random() * Math.PI * 2, // For star rotation
            active: false,
            phase: Math.random() * 100
        });
    }
}
initBlobChain();

const noise3D = createNoise3D();
function n3d(x, y, z, scale = 1.0) {
    return noise3D(x * scale, y * scale, z * scale);
}

// Helper: Get point on Star Outline
function getStarSurface(blob, dir) {
    // 2D Star shape projected along view or local axis?
    // Let's do a 3D star approximation: 
    // Modulate radius based on angle in X/Y plane primarily
    
    // Project dir to local 2D (rotate by blob.rotation)
    const c = Math.cos(-blob.rotation);
    const s = Math.sin(-blob.rotation);
    const lx = dir.x * c - dir.y * s;
    const ly = dir.x * s + dir.y * c;
    
    const angle = Math.atan2(ly, lx);
    // 5-point star modulation
    const starMod = Math.cos(angle * 5.0) * 0.5 + 0.5; 
    
    // Sharper radius for star
    const r = blob.radius * (0.4 + 0.6 * starMod); 
    
    // Return surface point
    // We keep Z relatively flat for "star" look, or puff it slightly
    const flatDir = new THREE.Vector3(dir.x, dir.y, dir.z * 0.3).normalize();
    return blob.center.clone().addScaledVector(flatDir, r);
}

// Helper: Get point on Cloud Shell
function getCloudSurface(blob, dir) {
    // Irregular Noise Shell
    const n = n3d(dir.x, dir.y, dir.z, 0.5);
    const r = blob.radius * (0.8 + 0.4 * n); // Puffy
    return blob.center.clone().addScaledVector(dir, r);
}

// Project to Morphing Shape
export function projectToShape(position) {
    let pos = position;
    if (!pos || typeof pos.distanceToSquared !== 'function') {
        if (Array.isArray(pos)) pos = new THREE.Vector3(pos[0] || 0, pos[1] || 0, pos[2] || 0);
        else return new THREE.Vector3(0,0,0);
    }

    let closest = null;
    let minD = Infinity;

    for (const b of blobs) {
        if (!b.active && b.radius < 0.1) continue;
        const d = pos.distanceToSquared(b.center);
        if (d < minD) {
            minD = d;
            closest = b;
        }
    }

    if (!closest) return new THREE.Vector3(0,0,0);

    const dir = pos.clone().sub(closest.center).normalize();
    
    // Morph Logic based on global cloudCover (passed via blob radius or global input?)
    // We'll use a global 'morphFactor' which we can approximate by checking blob.radius vs baseRadius
    // Or better: Use the input mapping directly if we had access. 
    // Since we don't have inputs here, we'll infer from radius/baseRadius ratio.
    // Low radius = Star, High radius = Cloud.
    
    const ratio = Math.min(1.0, closest.radius / (closest.baseRadius * 1.2));
    // Map ratio: 0.0->0.4 = Star, 0.6->1.0 = Cloud
    const t = Math.max(0, Math.min(1, (ratio - 0.3) * 2.5));
    
    const pStar = getStarSurface(closest, dir);
    const pCloud = getCloudSurface(closest, dir);
    
    // Lerp between star target and cloud target
    return pStar.lerp(pCloud, t);
}

function noiseFn(pos, time) {
    const scale = 0.3; 
    const e = 0.1;
    const n1 = n3d(pos.x, pos.y + e, pos.z, scale) - n3d(pos.x, pos.y - e, pos.z, scale);
    const n2 = n3d(pos.x, pos.y, pos.z + e, scale) - n3d(pos.x, pos.y, pos.z - e, scale);
    const n3 = n3d(pos.x + e, pos.y, pos.z, scale) - n3d(pos.x - e, pos.y, pos.z, scale);
    return new THREE.Vector3(n1 - n2, n2 - n3, n3 - n1);
}

// Sample for respawn
function sampleVolumetricPoint(blob) {
    let p = new THREE.Vector3();
    // Random spherical
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi)
    );
    // Bias to shell
    const r = blob.radius * (0.5 + 0.5 * Math.random());
    p.copy(dir).multiplyScalar(r).add(blob.center);
    return p;
}

// ======================================================
// ★ 3. INPUTS & MAPPING
// ======================================================

const inputs = {
    cloudCover: 0.5, 
    airQuality: 0.9,
    windSpeed: 0.1
};

const mappingConfig = {
    // Morphing handled in animate
    airQuality: { to: "turbulence", min: 1.0, max: 0.2 },
    windSpeed: { to: "flowSpeed", min: 0.5, max: 12.0 }
};

// ======================================================
// ★ 4. GUI
// ======================================================

const gui = new GUI({ title: 'Cloud Morph' });
gui.hide();
window.addEventListener('keydown', () => {
    if (gui.domElement.style.display === 'none') gui.show();
    else gui.hide();
});

const info = { location: "...", condition: "...", realCloud: "0%", realAQI: "0" };
gui.add(info, 'location').disable();
gui.add(info, 'condition').disable();
gui.add(info, 'realCloud').disable();
gui.add(inputs, 'cloudCover', 0, 1).name('Cloud Cover').listen();
gui.add(inputs, 'airQuality', 0, 1).name('Air Quality').listen();
gui.add(inputs, 'windSpeed', 0, 1).name('Wind Speed').listen();

async function syncWeather() {
    try {
        let query = "auto:ip";
        if ("geolocation" in navigator) {
            try {
                const pos = await new Promise((res, rej) => 
                    navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
                );
                query = `${pos.coords.latitude},${pos.coords.longitude}`;
            } catch (e) { }
        }
        const data = await fetchRealtimeWeather(query);
        
        // Map API Data to Inputs
        inputs.cloudCover = Math.min(data.current.cloud / 100.0, 1.0);
        inputs.windSpeed = Math.min(data.current.wind_kph / 60.0, 1.0);
        
        // Air Quality: Map EPA Index (1-6) to 1.0-0.0 (1=Best)
        let aqiScore = 0.9; // Default Good
        if (data.current.air_quality && data.current.air_quality['us-epa-index']) {
            const idx = data.current.air_quality['us-epa-index'];
            aqiScore = 1.0 - Math.min(Math.max(idx - 1, 0) / 5.0, 1.0);
        }
        inputs.airQuality = aqiScore;

        info.location = data.location.name;
        info.condition = data.current.condition.text;
        info.realCloud = `${data.current.cloud}%`;
        info.realAQI = data.current.air_quality ? data.current.air_quality['us-epa-index'] : "N/A";
        
    } catch (e) { console.warn(e); }
}
syncWeather();
setInterval(syncWeather, 300000);

// ======================================================
// ★ 5. PARTICLE SYSTEM
// ======================================================

function createCloudTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.8)'); 
    grad.addColorStop(0.3, 'rgba(230, 235, 255, 0.3)');
    grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
}

const PARTICLE_COUNT = 45000;
const particlesData = [];
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
const particleSizes = new Float32Array(PARTICLE_COUNT);
const particleOpacities = new Float32Array(PARTICLE_COUNT);

for (let i = 0; i < PARTICLE_COUNT; i++) {
    const px = (Math.random() - 0.5) * 30;
    const py = (Math.random() - 0.5) * 10;
    const pz = (Math.random() - 0.5) * 10;

    particlesData.push({
        position: [px, py, pz],
        velocity: [0, 0, 0],
        life: Math.random(),
        maxLife: 2.0 + Math.random() * 2.0
    });
    particlePositions[i*3] = px;
    particlePositions[i*3+1] = py;
    particlePositions[i*3+2] = pz;
    particleSizes[i] = 0.15 + Math.random() * 0.2; 
    particleOpacities[i] = 0.0;
}

const particleGeometry = new THREE.BufferGeometry();
particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
particleGeometry.setAttribute('size', new THREE.BufferAttribute(particleSizes, 1));
particleGeometry.setAttribute('opacity', new THREE.BufferAttribute(particleOpacities, 1));

const particleMaterial = new THREE.ShaderMaterial({
    uniforms: {
        map: { value: createCloudTexture() },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xeef4ff) }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
        attribute float size;
        attribute float opacity;
        varying float vOpacity;
        void main() {
            vOpacity = opacity;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (350.0 / -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
        }
    `,
    fragmentShader: `
        uniform sampler2D map;
        uniform vec3 uColor;
        varying float vOpacity;
        void main() {
            vec4 tex = texture2D(map, gl_PointCoord);
            gl_FragColor = vec4(uColor, tex.a * vOpacity);
        }
    `
});

const particleSystem = new THREE.Points(particleGeometry, particleMaterial);
scene.add(particleSystem);

// ======================================================
// ★ 6. ANIMATION LOOP
// ======================================================

const clock = new THREE.Clock();
const baseState = createDefaultWeatherState();
baseState.noiseScaleLarge = 0.2;
baseState.noiseScaleSmall = 2.0;
baseState.deformFactor = 0.3; 

function projectToShapeAdapter(pArr) {
    if(!pArr) return [0,0,0];
    const v = new THREE.Vector3(pArr[0], pArr[1], pArr[2]);
    const res = projectToShape(v);
    return [res.x, res.y, res.z];
}

function noiseFnAdapter(pArr, t) {
    if(!pArr) return [0,0,0];
    const v = new THREE.Vector3(pArr[0], pArr[1], pArr[2]);
    const res = noiseFn(v, t);
    return [res.x, res.y, res.z];
}

function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const time = clock.getElapsedTime();

    // 1. Blob Activation & Morphing Logic
    // Map cloudCover to number of blobs: 0.1->1 blob, 1.0->MAX_BLOBS
    // But make it a smooth transition by activating them one by one
    const activeFraction = Math.pow(inputs.cloudCover, 0.6); // Non-linear
    const activeCount = Math.max(1, Math.ceil(activeFraction * MAX_BLOBS));

    for(let i=0; i<MAX_BLOBS; i++) {
        const b = blobs[i];
        const isActive = i < activeCount;
        b.active = isActive;
        
        if (isActive) {
            // Radius expands with cloudCover
            // Low cover = small radius (Star)
            // High cover = large radius (Cloud)
            const targetMult = 0.5 + inputs.cloudCover * 1.0; // 0.5x to 1.5x base
            b.targetRadius = b.baseRadius * targetMult;
            b.radius += (b.targetRadius - b.radius) * dt * 1.0;
            
            // Slow spin for stars
            b.rotation += dt * 0.1;
        } else {
            b.targetRadius = 0.0;
            b.radius += (b.targetRadius - b.radius) * dt * 0.5;
        }
    }

    // 2. Engine Update
    const engineInputs = {
        cloudCover: inputs.cloudCover,
        airQuality: inputs.airQuality,
        windSpeed: inputs.windSpeed
    };
    const weatherState = applyMapping(engineInputs, mappingConfig, baseState);
    weatherState.flowDirection = [0.2, 0, 0]; 

    // 3. Particle Update
    particleMaterial.uniforms.uTime.value = time;
    const posAttr = particleGeometry.attributes.position;
    const opAttr = particleGeometry.attributes.opacity;
    const clarity = 0.5 + inputs.airQuality * 2.0; 

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particlesData[i];

        updateParticle(p, dt, weatherState, projectToShapeAdapter, noiseFnAdapter, time);

        const isFar = Math.abs(p.position[0]) > 20 || Math.abs(p.position[1]) > 10;
        
        if (p.life <= 0 || isFar) {
            // Respawn active blob
            // Filter active
            const activeBlobs = blobs.filter(b => b.radius > 0.2);
            if (activeBlobs.length > 0) {
                const b = activeBlobs[Math.floor(Math.random() * activeBlobs.length)];
                const newPos = sampleVolumetricPoint(b);
            p.position = [newPos.x, newPos.y, newPos.z];
            } else {
                p.position = [0, -100, 0]; // Hide
            }
            p.velocity = [(Math.random()-0.5)*0.5, (Math.random()-0.5)*0.5, 0];
            p.life = p.maxLife;
            particleOpacities[i] = 0.0;
        } else {
            const lifeRatio = p.life / p.maxLife;
            let op = Math.min(1.0, (1.0 - lifeRatio) * 2.0) * Math.min(1.0, lifeRatio * 2.0);
            op *= 0.5 * clarity; 
            
            if (lifeRatio < 0.3) {
                p.velocity[0] += inputs.windSpeed * dt * 15.0;
                // Ribbon Trail
                p.velocity[1] += Math.sin(p.position[0] * 0.4 + time * 2.0) * 0.3 * (0.5 + inputs.windSpeed);
                op *= 0.6;
            }
            particleOpacities[i] = op;
        }

        posAttr.setXYZ(i, p.position[0], p.position[1], p.position[2]);
        opAttr.setX(i, particleOpacities[i]);
    }

    posAttr.needsUpdate = true;
    opAttr.needsUpdate = true;
    camera.position.x = Math.sin(time * 0.05) * 1.0;
    renderer.render(scene, camera);
}

animate();
