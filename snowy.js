import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { createDefaultWeatherState, applyMapping, updateParticle } from './engine.js';
import { createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.esm.min.js';
// Import weather data function
import { fetchRealtimeWeather } from './weatherapi.js'; // Assuming fetchRealtimeWeather is exported

// ------------------------------------------------------------------
// 0. HELPER: CREATE CRYSTAL TEXTURE (Icy, glowing, structured)
// ------------------------------------------------------------------
function createCrystalTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    // 1. Base Icy Glow (Radial)
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(220, 240, 255, 1.0)'); // Bright Core
    grad.addColorStop(0.4, 'rgba(120, 180, 255, 0.6)'); // Blue Halo
    grad.addColorStop(1, 'rgba(100, 150, 255, 0.0)'); // Soft Edge
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    
    // 2. Subtle Crystalline Structure (Micro-spokes/Diamond)
    ctx.save();
    ctx.translate(32, 32);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 0);
    ctx.moveTo(0, 12);
    ctx.lineTo(-8, 0);
    ctx.fill();
    
    ctx.restore();
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

// ------------------------------------------------------------------
// 1. THREE.JS SETUP
// ------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a); // Deep dark blue-black
scene.fog = new THREE.FogExp2(0x05070a, 0.02);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 2, 14); 
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
function projectToShape(pos) {
    const time = Date.now() * 0.0001;
    
    // 1. Base Rolling Terrain
    const largeWave = Math.sin(pos[0] * 0.15 + time) * 1.5 + Math.cos(pos[2] * 0.15) * 1.5;
    
    // 2. Detail bumps
    const detailWave = Math.sin(pos[0] * 0.5) * 0.3 + Math.cos(pos[2] * 0.5) * 0.3;
    
    // 3. Volumetric Thickness
    const thickness = 3.0; 
    const hash = Math.sin(pos[0] * 12.9898 + pos[2] * 78.233) * 43758.5453; 
    const volumeOffset = (hash % 1) * thickness - (thickness / 2);

    const baseY = 6.0; 
    
    return [pos[0], baseY + largeWave + detailWave + volumeOffset, pos[2]];
}

const noise3D = createNoise3D();
function noiseFn(pos, time) {
    const eps = 0.1;
    const scale = 0.3;
    
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
    precipitation: 0.0, 
    windSpeed: 0.1,     
    windDegree: 90,     
    accumulation: 0.0,
    targetAccumulation: 1.0 // Default target
};

const mappingConfig = {
    shapeStrength: { from: 'adjPrecip', min: 1.5, max: 0.0 }, 
    deformFactor: { from: 'adjPrecip', min: 0.2, max: 1.0 },
    verticalBias: { from: 'adjPrecip', min: 0.0, max: 4.0 },
    turbulence: { from: 'windSpeed', min: 0.5, max: 6.0 }, // Extreme turbulence
    flowSpeed: { from: 'windSpeed', min: 1.0, max: 16.0 }, // Hurricane speed
    noiseScaleSmall: { from: 'adjPrecip', min: 1.5, max: 4.0 }, // High freq chaos
    brightness: { from: 'adjPrecip', min: 1.0, max: 2.5 } // Blinding explosion 
};

// ------------------------------------------------------------------
// 4. GUI SETUP & WEATHER DATA FETCH
// ------------------------------------------------------------------
const gui = new GUI({ title: 'Crystal Storm' });

// Hide GUI initially and toggle on key press
gui.hide();
window.addEventListener('keydown', () => {
    if (gui.domElement.style.display === 'none') {
        gui.show();
    } else {
        gui.hide();
    }
});

// Add Info Controller (Read-only)
const info = {
    location: "Loading...",
    condition: "...",
    realPrecip: "0 mm",
    realTemp: "0°C"
};

gui.add(info, 'location').name('Location').listen().disable();
gui.add(info, 'condition').name('Condition').listen().disable();
gui.add(info, 'realPrecip').name('Real Precip').listen().disable();
gui.add(info, 'realTemp').name('Real Temp').listen().disable();

gui.add(inputs, 'precipitation', 0, 1).name('Intensity').listen();
gui.add(inputs, 'windSpeed', 0, 1).name('Wind Speed').listen();
gui.add(inputs, 'windDegree', 0, 360).name('Wind Direction').listen();
gui.add(inputs, 'accumulation', 0, 1).name('Ice Accumulation').listen();

// --- Real-time Weather Fetch & Mapping ---
async function syncWeather() {
    try {
        // Use geolocation or fallback to auto:ip logic from weatherapi.js
        let query = "auto:ip";
        if ("geolocation" in navigator) {
            try {
                const pos = await new Promise((res, rej) => 
                    navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
                );
                query = `${pos.coords.latitude},${pos.coords.longitude}`;
            } catch (e) {
                console.warn("Geolocation failed, using IP");
            }
        }

        const data = await fetchRealtimeWeather(query);
        const current = data.current;
        const loc = data.location;

        // --- UPDATE GUI INFO ---
        info.location = `${loc.name}, ${loc.country}`;
        info.condition = current.condition.text;
        info.realPrecip = `${current.precip_mm} mm`;
        info.realTemp = `${current.temp_c}°C`;

        // --- MAP REAL-TIME DATA TO INPUTS ---
        
        // 1. Wind Speed (kph -> 0-1 range)
        inputs.windSpeed = Math.min(current.wind_kph / 60.0, 1.0);
        
        // 2. Wind Direction (degrees)
        if (current.wind_degree !== undefined) {
            inputs.windDegree = current.wind_degree;
        }

        // 3. Precipitation (mm -> 0-1 range)
        inputs.precipitation = Math.min(current.precip_mm / 5.0, 1.0);
        
        // 4. Accumulation Target
        // Force 1.0 if there is significant weather, to ensure visual effect plays out
        const tempC = current.temp_c;
        let targetAcc = 0.0;

        // If it's freezing OR raining/snowing, go full ice
        if (tempC <= 0 || inputs.precipitation > 0.1) {
            targetAcc = 1.0;
        } else {
             // Partial accumulation based on coolness
             // 10C -> 0.0, 0C -> 1.0
             targetAcc = Math.max(0, (10 - tempC) / 10);
        }
        
        // We store the target accumulation, but we let the animation loop handle the increase
        inputs.targetAccumulation = targetAcc;

        console.log("Weather Synced:", { 
            loc: info.location,
            temp: tempC,
            targetAcc: targetAcc
        });

    } catch (err) {
        console.error("Weather sync failed:", err);
        info.location = "Error";
        info.condition = "Offline";
    }
}

// Initial Sync
syncWeather();
// Sync every 5 mins
setInterval(syncWeather, 300000);


// ------------------------------------------------------------------
// 5. PARTICLE SYSTEM (Instanced Mesh for True Stretching)
// ------------------------------------------------------------------
const PARTICLE_COUNT = 10000;
const particlesData = [];

// We use a Plane for each particle to allow non-uniform scaling (stretching)
const baseGeometry = new THREE.PlaneGeometry(1, 1);
const instancedGeometry = new THREE.InstancedBufferGeometry();
instancedGeometry.index = baseGeometry.index;
instancedGeometry.attributes.position = baseGeometry.attributes.position;
instancedGeometry.attributes.uv = baseGeometry.attributes.uv;

const instancePositions = new Float32Array(PARTICLE_COUNT * 3);
const instanceVelocities = new Float32Array(PARTICLE_COUNT * 3);
const instanceScales = new Float32Array(PARTICLE_COUNT);
const instancePhases = new Float32Array(PARTICLE_COUNT);

instancedGeometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(instancePositions, 3));
instancedGeometry.setAttribute('instanceVelocity', new THREE.InstancedBufferAttribute(instanceVelocities, 3));
instancedGeometry.setAttribute('instanceScale', new THREE.InstancedBufferAttribute(instanceScales, 1));
instancedGeometry.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(instancePhases, 1));

// Custom Shader Material to handle Billboarding + Stretching
const material = new THREE.ShaderMaterial({
    uniforms: {
        map: { value: createCrystalTexture() },
        uTime: { value: 0 },
        uBrightness: { value: 1.0 },
        uAccumulation: { value: 0.0 }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
        uniform float uAccumulation;
        attribute vec3 instancePosition;
        attribute vec3 instanceVelocity;
        attribute float instanceScale;
        attribute float instancePhase;
        
        varying vec2 vUv;
        varying float vPhase;
        varying float vSpeed;
        
        void main() {
            vUv = uv;
            vPhase = instancePhase;
            
            // 1. Calculate View Space Position of the Center
            vec4 mvPosition = modelViewMatrix * vec4(instancePosition, 1.0);
            
            // 2. Calculate View Space Velocity
            // We only care about direction in 2D view plane to stretch the quad
            vec3 viewVel = (modelViewMatrix * vec4(instanceVelocity, 0.0)).xyz;
            vec2 vel2D = viewVel.xy;
            float speed = length(vel2D);
            vSpeed = speed;
            
            // 3. Billboard Rotation & Stretch Logic
            vec2 pos2D = position.xy;
            
            // Base Size
            // INCREASED SCALE: Boost multiplier from 0.35 -> 0.5
            // Also add a small boost from accumulation
            float size = 0.5 * instanceScale * (1.0 + uAccumulation * 0.3);
            pos2D *= size;
            
            // Stretch Factor based on speed & accumulation
            // The faster it moves, the longer it gets
            // INCREASED TRAIL RANGE:
            // Use a larger multiplier for uAccumulation
            float stretch = 1.0 + min(speed, 8.0) * (0.2 + uAccumulation * 3.5);
            
            if (speed > 0.05) {
                // Align X axis to velocity
                float angle = atan(vel2D.y, vel2D.x);
                float c = cos(angle);
                float s = sin(angle);
                
                // Stretch along X (Length)
                // Shrink Y slightly (Width) to preserve volume feeling
                // RELAXED SHRINKING: mix(1.0, 0.6, ...) instead of 0.5 to keep them thicker
                pos2D.x *= stretch;
                pos2D.y *= mix(1.0, 0.6, min(speed * 0.1, 0.5)); 
                
                // Rotate to align
                vec2 rotated = vec2(
                    pos2D.x * c - pos2D.y * s,
                    pos2D.x * s + pos2D.y * c
                );
                pos2D = rotated;
            }
            
            // 4. Apply Offset in View Space
            mvPosition.xy += pos2D;
            
            gl_Position = projectionMatrix * mvPosition;
        }
    `,
    fragmentShader: `
        uniform sampler2D map;
        uniform float uTime;
        uniform float uBrightness;
        uniform float uAccumulation;
        
        varying vec2 vUv;
        varying float vPhase;
        varying float vSpeed;
        
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            vec4 texColor = texture2D(map, vUv);
            
            // -- Ice Accumulation & Visuals --
            
            // 1. Crystal Sharpness
            // As accumulation grows, we sharpen the core and break the edges
            float dist = length(vUv - 0.5);
            
            // High frequency "Shatter" Noise
            // Used to break up trails and edges
            float shatterNoise = hash(vUv * vec2(15.0, 50.0) + floor(uTime * 30.0)); 
            
            // Accumulation Effect A: Extreme Sharpness
            // 0.0 -> Soft (0.3)
            // 1.0 -> Razor Sharp (0.001)
            float sharpness = mix(0.3, 0.001, uAccumulation);
            
            // Accumulation Effect B: Broken Shatter Trails
            // If the particle is stretched (based on speed/shape), we eat away chunks
            // heavily to avoid "smooth liquid" look.
            float trailBreakup = smoothstep(0.4, 0.6, shatterNoise);
            float breakupStrength = mix(0.0, 0.8, uAccumulation);
            
            // Apply fracture to distance field
            // This makes the round particle look like a jagged shard
            float fractureDist = dist + (shatterNoise - 0.5) * mix(0.1, 0.5, uAccumulation);
            
            // Calculate Core Alpha
            // We mix the solid core with the broken trail mask
            float core = smoothstep(sharpness, 0.0, fractureDist);
            core *= mix(1.0, trailBreakup, breakupStrength); // Apply shatter mask
            
            // 2. Micro-Flicker (Irregular & Violent)
            // "Broken" flicker for fractured feel
            float slowBreathe = sin(uTime * 3.0 + vPhase) * 0.5 + 0.5;
            
            // Violent staccato strobing
            // Randomize frequency per particle
            float strobeSpeed = 20.0 + hash(vec2(vPhase)) * 50.0;
            float fastSparkle = step(0.6, sin(uTime * strobeSpeed + vPhase * 30.0)); 
            
            // Combined flicker
            float sparkleIntensity = mix(0.5, 1.5, uAccumulation); // Very bright flashes
            float glint = slowBreathe * 0.5 + fastSparkle * shatterNoise * sparkleIntensity;
            
            // 3. Color Composition
            vec3 baseColor = texColor.rgb;
            
            // Accumulation Effect C: Freezer Explosion Palette
            // Deep Electric Blue + Blinding White
            
            vec3 colElectricBlue = vec3(0.1, 0.4, 1.0); // Darker, richer blue
            vec3 colBlindingWhite = vec3(1.2, 1.2, 1.5); // Overdriven white
            
            // Random mix factor per particle: Chaos!
            float colorMix = fract(vPhase * 99.99); 
            // Bias towards white for "snow chaos" feel (70% white)
            vec3 particleTint = mix(colElectricBlue, colBlindingWhite, step(0.3, colorMix));
            
            // Interpolate
            vec3 finalTint = mix(vec3(0.8, 0.9, 1.0), particleTint, uAccumulation);
            
            // Combine
            // Base texture is kept minimal to focus on the sharp shards
            vec3 finalColor = baseColor * vec3(0.5, 0.6, 0.8) * 0.2; 
            
            // Add EXPLOSIVE Core
            finalColor += finalTint * core * glint * mix(1.5, 5.0, uAccumulation);
            
            // Apply Global Brightness
            finalColor *= uBrightness;
            
            // Alpha - Keep it punchy
            // Boost opacity for glitchy bright look
            float alpha = texColor.a * (0.5 + 0.8 * core * mix(1.0, 2.0, uAccumulation));
            
            gl_FragColor = vec4(finalColor, alpha);
        }
    `
});

// ------------------------------------------------------------------
// 5.5. FROST OVERLAY (Screen-mapped effect)
// ------------------------------------------------------------------
const frostMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
        uTime: { value: 0 },
        uPrecip: { value: 0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            // Draw full screen quad in NDC
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uPrecip;
        uniform float uTime;
        varying vec2 vUv;
        
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            // Vignette
            vec2 uv = vUv * 2.0 - 1.0;
            float dist = length(uv);
            float vignette = smoothstep(0.5, 1.5, dist);
            
            // Frost Noise
            float noise = hash(vUv * 5.0 + floor(uTime * 10.0));
            
            // Color
            vec3 frostColor = vec3(0.8, 0.9, 1.0);
            
            // Opacity mapped to precipitation
            float opacity = vignette * noise * uPrecip * 0.3;
            
            gl_FragColor = vec4(frostColor, opacity);
        }
    `
});
// Create a plane that covers the screen (size 2x2 in NDC)
const frostMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), frostMat);
// To ensure it renders on top, we could use a second scene or just rely on order.
// Since depthTest is false, it should draw over things if drawn last.
// But usually three.js sorts by depth. 
// We can add it to the camera or scene.
frostMesh.renderOrder = 999; // Force draw last
scene.add(frostMesh);

const particleSystem = new THREE.Mesh(instancedGeometry, material);
particleSystem.frustumCulled = false; // Always render
scene.add(particleSystem);

// Initialize
for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = (Math.random() - 0.5) * 40;
    const y = 6 + (Math.random() - 0.5) * 4;
    const z = (Math.random() - 0.5) * 40;

    particlesData.push({
        position: [x, y, z],
        velocity: [0, 0, 0],
        life: Math.random()
    });
    
    instancePositions[i * 3] = x;
    instancePositions[i * 3 + 1] = y;
    instancePositions[i * 3 + 2] = z;
    
    instanceVelocities[i * 3] = 0;
    instanceVelocities[i * 3 + 1] = 0;
    instanceVelocities[i * 3 + 2] = 0;
    
    // Variation: MORE SMALL DUST (92% small, 8% larger shards)
    const r = Math.random();
    if (r > 0.92) {
        // Large shard (Exploded chunks)
        instanceScales[i] = 0.6 + Math.random() * 0.6;
    } else {
        // Small chaotic dust (Ice powder)
        instanceScales[i] = 0.1 + Math.random() * 0.25; 
    }

    instancePhases[i] = Math.random() * Math.PI * 2;
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

    // Update Shader Uniforms
    material.uniforms.uTime.value = time;
    
    // Auto-increase accumulation over time
    // We slowly approach the "target" set by weather, or just keep growing if desired.
    // "Accumulation should increase automatically over time" -> Let's make it grow slowly
    // until it hits the target (or 1.0 if raining/snowing).
    if (inputs.targetAccumulation !== undefined) {
        // Grow slowly towards target
        // Rate: 0.05 per second
        if (inputs.accumulation < inputs.targetAccumulation) {
            inputs.accumulation += dt * 0.05;
        }
    } else {
        // Default slow growth behavior if no weather data yet
        inputs.accumulation = Math.min(inputs.accumulation + dt * 0.02, 1.0);
    }
    
    material.uniforms.uAccumulation.value = inputs.accumulation;
    
    // Update Frost Overlay
    frostMat.uniforms.uTime.value = time;
    frostMat.uniforms.uPrecip.value = inputs.precipitation;

    // Inputs
    const adjPrecip = Math.pow(inputs.precipitation, 0.4);
    const engineInputs = {
        adjPrecip: adjPrecip,
        windSpeed: inputs.windSpeed
    };

    const weatherState = applyMapping(engineInputs, mappingConfig, baseState);
    
    if (weatherState.brightness !== undefined) {
        material.uniforms.uBrightness.value = weatherState.brightness;
    }

    // Wind Direction
    const rad = (inputs.windDegree) * (Math.PI / 180);
    weatherState.flowDirection = [Math.sin(rad), 0, Math.cos(rad)];

    // Particle Update
    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particlesData[i];

        updateParticle(p, dt, weatherState, projectToShape, noiseFn, time);

        // Respawn
        const isDead = p.life <= 0;
        const isTooLow = p.position[1] < -2; 
        const isTooFar = Math.abs(p.position[0]) > 30 || Math.abs(p.position[2]) > 30;

        if (isDead || isTooLow || isTooFar) {
            p.life = 1.0;
            p.velocity = [0, 0, 0];
            
            const spawnX = (Math.random() - 0.5) * 40;
            const spawnZ = (Math.random() - 0.5) * 40;
            const spawnY = 6 + (Math.random() - 0.5) * 3; 

            const windOffsetX = -weatherState.flowDirection[0] * inputs.windSpeed * 15;
            const windOffsetZ = -weatherState.flowDirection[2] * inputs.windSpeed * 15;

            p.position = [spawnX + windOffsetX, spawnY, spawnZ + windOffsetZ];
        }

        // Update Buffers
        const idx = i * 3;
        instancePositions[idx] = p.position[0];
        instancePositions[idx + 1] = p.position[1];
        instancePositions[idx + 2] = p.position[2];
        
        instanceVelocities[idx] = p.velocity[0];
        instanceVelocities[idx + 1] = p.velocity[1];
        instanceVelocities[idx + 2] = p.velocity[2];
    }

    instancedGeometry.attributes.instancePosition.needsUpdate = true;
    instancedGeometry.attributes.instanceVelocity.needsUpdate = true;
    
    renderer.render(scene, camera);
}

animate();
