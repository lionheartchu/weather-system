import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { createDefaultWeatherState, applyMapping, updateParticle } from './engine.js';
import { createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.esm.min.js';

// ------------------------------------------------------------------
// 1. VISUALS & TEXTURES
// ------------------------------------------------------------------

function createSunTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    // 更柔和一点的光斑
    grad.addColorStop(0,   'rgba(255, 255, 255, 0.8)');
    grad.addColorStop(0.25,'rgba(255, 255, 255, 0.5)');
    grad.addColorStop(0.55,'rgba(255, 255, 255, 0.15)');
    grad.addColorStop(1,   'rgba(0, 0, 0, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    return new THREE.CanvasTexture(canvas);
}

// ------------------------------------------------------------------
// 2. MAPPING CONFIG
// ------------------------------------------------------------------
// We map normalized inputs (uvIndex, temperature) to weatherState props
// and custom props stored in weatherState for our own logic.

const SUNNY_MAPPING = {
    // UV Index effects (Intensity/Complexity)
    // Map to standard engine props where relevant:
    turbulence: { from: 'uvIndex', min: 0.1, max: 0.5 },
    flowSpeed: { from: 'uvIndex', min: 0.2, max: 1.5 }, // Global rotation speed
    noiseScaleLarge: { from: 'uvIndex', min: 1.0, max: 2.0 },
    
    // Custom props for Sunny logic:
    rotationSpeed: { from: 'uvIndex', min: 0.0, max: 0.8 },   // 0=static, 0.8=fast spin
    morphIntensity: { from: 'uvIndex', min: 0.0, max: 1.0 },  // How much the wedges morph/shift
    inwardPull: { from: 'uvIndex', min: 1.5, max: 0.0 },      // Inverted: strong pull at low UV, none at high
    wedgeCount: { from: 'uvIndex', min: 12.0, max: 40.0 },    // Higher density of sectors
    wedgeContrast: { from: 'uvIndex', min: 0.3, max: 0.9 },  // Visibility of wedge edges
    photonDensity: { from: 'uvIndex', min: 0.2, max: 1.0 },  // How many photons are active
    photonSpeed: { from: 'uvIndex', min: 1.0, max: 4.0 },    // Speed of photons
    glowStrength: { from: 'uvIndex', min: 0.2, max: 0.8 },   // Lens flare visibility

    // Temperature effects (Color/Mood)
    // We'll use 'colorTemperature' from engine schema
    colorTemperature: { from: 'temperature', min: 0.0, max: 1.0 },
    
    // Visuals
    brightness: { from: 'uvIndex', min: 0.8, max: 1.5 },
    sizeMin: { from: 'uvIndex', min: 0.5, max: 0.8 },
    lifeSpan: { from: 'uvIndex', min: 2.0, max: 4.0 }, // Higher UV -> more chaotic but maybe longer trails?
};

// ------------------------------------------------------------------
// 3. GEOMETRY & PROJECTORS
// ------------------------------------------------------------------

// Particle Types
const TYPE_CORE = 0;
const TYPE_WEDGE = 1;
const TYPE_PHOTON = 2;
const TYPE_FLARE = 3;

const noise3D = createNoise3D();

// --- Projectors (Shape Attractors) ---

// A. Core: Attract to a central sphere/disc
function projectToCore(pos, ws) {
    // Attract to a radius of ~2.0
    const r = 2.0;
    const len = Math.sqrt(pos[0]*pos[0] + pos[1]*pos[1] + pos[2]*pos[2]) + 0.001;
    const scale = r / len;
    return [pos[0] * scale, pos[1] * scale, pos[2] * scale];
}

// B. Wedge: cleaner kaleidoscope projection (no per-frame Math.random)
function projectToWedge(pos, ws) {
    let x = pos[0];
    let y = pos[1];
    let z = pos[2];
    let r = Math.sqrt(x * x + y * y) + 0.0001;

    // angle in [0, 2π)
    const PI2 = Math.PI * 2;
    let angle = Math.atan2(y, x);
    angle = (angle + PI2) % PI2;

    const t = ws.time || 0.0;

    // Rotation logic
    // const rotSpeed = 0.1; // Old hardcoded value
    const spin = ws.globalRotationSpeed || 1;
    const rot = -t * spin; // Change to clockwise

    // Quantize angle in rotating frame
    // We need to handle wrapping carefully for modulo
    let localAngle = angle - rot;
    // Wrap localAngle to [0, 2π) for consistent sector indexing
    localAngle = (localAngle % PI2 + PI2) % PI2;

    // ---- Wedge setup ----
    const wedgeCount = Math.max(12, Math.floor(ws.wedgeCount || 24));
    const sectorSize = PI2 / wedgeCount;

    // which wedge
    const wIndex = Math.floor(localAngle / sectorSize);

    // angle inside this sector [0, sectorSize)
    const angleInSector = localAngle - wIndex * sectorSize;

    // per-wedge slow parameters（用 index 做 seed，保证稳定）
    // Morphing intensity is now driven by UV (ws.morphIntensity)
    const morphIntensity = ws.morphIntensity || 0.0;
    const seed = wIndex * 17.13;
    
    // At low UV, offset and width are stable; at high UV, they animate more
    const offset = morphIntensity * 0.2 * sectorSize * Math.sin(t * 0.25 + seed);
    const widthFactor = 0.5 + morphIntensity * 0.3 * Math.sin(t * 0.2 + seed * 0.7);

    const center = sectorSize * 0.5 + offset;
    const halfWidth = (sectorSize * 0.5) * widthFactor;

    // delta from center line, 使用 soft clamp
    let d = angleInSector - center;
    d = Math.max(-halfWidth, Math.min(halfWidth, d));

    // final angle（带一点高频 shimmer，但很小）
    // const shimmer = 0.03 * Math.sin(t * 1.5 + angle * 20.0); // Removed to reduce jitter
    // Reconstruct global angle: Start of wedge + center offset + delta + global rotation
    const finalAngle = wIndex * sectorSize + center + d + rot; // removed shimmer

    // ---- radial length ----
    // Don't clamp radius here - let particles drift naturally
    // The update loop will respawn them when they go too far
    // This prevents accumulation at the outer edge (halo effect)
    const finalR = r;

    // Z 压扁一点
    const finalZ = z * 0.4;

    return [
        Math.cos(finalAngle) * finalR,
        Math.sin(finalAngle) * finalR,
        finalZ
    ];
}


// C. Photon: Move radially outward, no shape attraction (or loose)
function projectToPhoton(pos, ws) {
    // Photons largely ignore shape attraction (shapeStrength can be 0 via logic), 
    // OR we project them to "themselves" so v_shape is 0.
    return pos;
}

// D. Flare: Slowly drifting large particles
function projectToFlare(pos, ws) {
    return pos; // Drifts with flow
}


// --- Noise Functions (Flow Fields) ---

function sunNoiseFn(pos, time, ws) {
    // Global slow swirl
    const scale = ws.noiseScaleLarge || 1.0;
    const t = time * 0.5;
    
    // Simple rotational noise
    const n1 = noise3D(pos[0] * scale, pos[1] * scale, t);
    const n2 = noise3D(pos[1] * scale, pos[2] * scale, t + 100);
    const n3 = noise3D(pos[2] * scale, pos[0] * scale, t + 200);
    
    // Apply inward pull field based on UV
    // At low UV: strong pull toward center (keeps particles compact)
    // At high UV: no pull (particles can expand naturally)
    const inwardPull = ws.inwardPull || 0.0;
    const len = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2) + 0.01;
    
    // Inward radial vector (negative = toward center)
    const rx = -(pos[0] / len) * inwardPull;
    const ry = -(pos[1] / len) * inwardPull;
    const rz = -(pos[2] / len) * inwardPull * 0.3; // Less Z pull

    return [n1 + rx, n2 + ry, n3 + rz];
}

// Radial flow for photons
function photonFlowFn(pos, time, ws) {
    // Radial vector
    const len = Math.sqrt(pos[0]*pos[0] + pos[1]*pos[1] + pos[2]*pos[2]) + 0.01;
    // Normalized radial direction
    const rx = pos[0] / len;
    const ry = pos[1] / len;
    const rz = pos[2] / len;
    
    // Add some swirl
    const swirlX = -ry;
    const swirlY = rx;
    
    const speed = ws.photonSpeed || 1.0;
    
    // Return a vector that will be used as "noise" direction in engine
    // Engine: v_large = normalize(noiseFn) * turbulence
    // We want this to drive them outward.
    // So we return a strong radial vector plus some noise.
    const n = noise3D(pos[0], pos[1], time);
    
    return [
        rx * 5.0 + swirlX * 2.0 + n * 0.5,
        ry * 5.0 + swirlY * 2.0 + n * 0.5,
        rz * 5.0 // Less Z movement
    ];
}

// ------------------------------------------------------------------
// 4. EXPORTED SCENE CREATOR
// ------------------------------------------------------------------

export function createWeatherScene(options = {}) {
    const count = options.count || 12000;
    // Retrieve renderer from options if available
    const renderer = options.renderer;

    // We'll split count into layers
    // 10% Core, 60% Wedges, 30% Photons, plus a few flares
    const flareCount = 8;
    const coreCount = Math.floor(count * 0.01);
    const wedgeCount = Math.floor(count * 0.6);
    const photonCount = count - coreCount - wedgeCount - flareCount;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // Will be cleared/overdrawn usually, but safe default

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 30);
    camera.lookAt(0, 0, 0);

    // Geometry Setup
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    
    // Custom tracking
    const particles = [];

    // Initialize
    let idx = 0;
    
    // 1. Core Particles
    for (let i = 0; i < coreCount; i++) {
        const r = Math.random() * 2.5;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        
        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.sin(phi) * Math.sin(theta);
        const z = r * Math.cos(phi) * 0.5; // Flattened sphere

        particles.push({
            type: TYPE_CORE,
            position: [x, y, z],
            velocity: [0, 0, 0],
            life: Math.random(),
            baseColor: new THREE.Color(1, 0.9, 0.5) // Pale yellow core
        });
        idx++;
    }

    // 2. Wedge Particles
    for (let i = 0; i < wedgeCount; i++) {
        const r = 6.0 + Math.random() * 22.0;
        const theta = Math.random() * Math.PI * 2;
        
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const z = (Math.random() - 0.5) * 2.0;

        particles.push({
            type: TYPE_WEDGE,
            position: [x, y, z],
            velocity: [0, 0, 0],
            life: Math.random(),
            angle: theta, // Store initial angle
            baseColor: new THREE.Color(1, 0.5, 0) // Orange default
        });
        idx++;
    }

    // 3. Photon Particles
    for (let i = 0; i < photonCount; i++) {
        const r = Math.random() * 30.0;
        const theta = Math.random() * Math.PI * 2;
        
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        const z = (Math.random() - 0.5) * 5.0;

        particles.push({
            type: TYPE_PHOTON,
            position: [x, y, z],
            velocity: [0, 0, 0],
            life: Math.random(),
            baseColor: new THREE.Color(1, 1, 1)
        });
        idx++;
    }

    // 4. Lens Flares
    for (let i = 0; i < flareCount; i++) {
        // Random positions across screen
        const x = (Math.random() - 0.5) * 40;
        const y = (Math.random() - 0.5) * 40;
        const z = 5 + Math.random() * 10; // Closer to camera

        particles.push({
            type: TYPE_FLARE,
            position: [x, y, z],
            velocity: [0, 0, 0],
            life: Math.random(),
            baseColor: new THREE.Color(1, 0.9, 0.8)
        });
        idx++;
    }

    // Initial buffer population
    for(let i=0; i<count; i++) {
        positions[i*3] = particles[i].position[0];
        positions[i*3+1] = particles[i].position[1];
        positions[i*3+2] = particles[i].position[2];
        sizes[i] = 1.0;
        colors[i*3] = 1; colors[i*3+1] = 1; colors[i*3+2] = 1;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // Material
    const material = new THREE.PointsMaterial({
        size: 0.8,
        vertexColors: true,
        map: createSunTexture(),
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const baseState = createDefaultWeatherState();

    // Update Loop
    function update(dt, time, normalizedInputs) {
        const ws = applyMapping(normalizedInputs, SUNNY_MAPPING, baseState);
        ws.time = time;
        
        // global rotation speed (low UV = static, high UV = fast spin)
        // Purely UV driven, no base auto-spin
        ws.globalRotationSpeed = ws.rotationSpeed !== undefined ? ws.rotationSpeed : 0;

        // Color Palette generation based on Temperature
        // 0.0 = Cool/White/Blueish
        // 0.5 = Golden/Orange
        // 1.0 = Hot/Red/Magenta
        const temp = (ws.colorTemperature !== undefined) ? ws.colorTemperature : 0.5;
        
        const colCore = new THREE.Color().lerpColors(
            new THREE.Color(0xffffee), new THREE.Color(0xffaa00), temp
        );
        const colWedgeHigh = new THREE.Color().lerpColors(
            new THREE.Color(0xffcc00), new THREE.Color(0xff0000), temp
        );
        const colWedgeLow = new THREE.Color().lerpColors(
            new THREE.Color(0x00aaff), new THREE.Color(0xff0044), temp
        );
        
        // Update buffers
        const posAttr = geometry.attributes.position;
        const colAttr = geometry.attributes.color;
        const sizeAttr = geometry.attributes.size;

        // Pre-calculate noise/projector wrappers
        const coreProjector = (pos) => projectToCore(pos, ws);
        const wedgeProjector = (pos) => projectToWedge(pos, ws);
        const photonProjector = (pos) => projectToPhoton(pos, ws);
        const flareProjector = (pos) => projectToFlare(pos, ws);
        
        const generalNoise = (pos, t) => sunNoiseFn(pos, t, ws);
        const photonNoise = (pos, t) => photonFlowFn(pos, t, ws);

        // Global Rotation (Flow Direction)
        // We can rotate the whole system slowly via flowDirection?
        // Engine uses flowDirection for linear movement.
        // We'll use noise for rotation.

        for (let i = 0; i < count; i++) {
            const p = particles[i];
            
            // Logic per type
            let projector, nFn, turbulenceOverride;
            let targetColor = p.baseColor;
            let targetSize = ws.sizeMin || 1.0;

            if (p.type === TYPE_CORE) {
                projector = coreProjector;
                nFn = generalNoise;
                ws.shapeStrength = 5.0; // Strong hold
                ws.turbulence = 0.2;
                
                targetColor = colCore;
                targetSize = 1.2 + Math.sin(time * 1.5 + i) * 0.3;
                
                // Core flicker
                if (Math.random() < 0.03) targetSize *= 1.2;

                // Respawn Core (keep dense center)
                if (p.life <= 0) {
                    const newR = Math.random() * 2.5;
                    const newTheta = Math.random() * Math.PI * 2;
                    const newPhi = Math.acos(2 * Math.random() - 1);
                    p.position = [
                        newR * Math.sin(newPhi) * Math.cos(newTheta),
                        newR * Math.sin(newPhi) * Math.sin(newTheta),
                        newR * Math.cos(newPhi) * 0.5
                    ];
                    p.life = 1.0;
                    p.velocity = [0,0,0];
                }
                
                // Fix: Clamp Core particles to center to avoid drifting spots
                const coreDist = Math.sqrt(p.position[0]**2 + p.position[1]**2 + p.position[2]**2);
                if (coreDist > 3.5) {
                     p.position = [0,0,0]; // Force reset if it drifted too far
                     p.life = 1.0;
                     p.velocity = [0,0,0];
                }
                
            } else if (p.type === TYPE_WEDGE) {
                projector = wedgeProjector;
                nFn = generalNoise;
                ws.shapeStrength = 2.0; // Moderate hold to spokes
                ws.turbulence = ws.turbulence; // From mapping
                
                // Color gradient based on radius
                const r = Math.sqrt(p.position[0]**2 + p.position[1]**2);
                const tC = Math.min(1, r / 20.0);
                
                const baseGradient = new THREE.Color().lerpColors(colWedgeHigh, colWedgeLow, tC);
                
                // "Bright white as lights": Mix white into the center
                // Keeps the inner radial lines bright white regardless of temp
                const centerGlow = Math.max(0, 1.0 - r / 8.0); // Strong white fade-out over 8 units
                targetColor = new THREE.Color().lerpColors(baseGradient, new THREE.Color(1, 1, 1), centerGlow * 0.8);
                
                // Size
                targetSize = (1.0 - tC) * 1.5 + 0.5;

                // Respawn Logic for Wedges (prevent diminishing)
                // If they drift too far or die, reset to random spot in a wedge
                // Use a fixed large boundary so the halo fades naturally by density/lifespan
                const maxR = 45.0; 
                if (p.life <= 0 || r > maxR) {
                    const newR = 6.0 + Math.random() * 15.0; // Spawn closer, let them grow out
                    const newTheta = Math.random() * Math.PI * 2;
                    p.position = [
                        newR * Math.cos(newTheta),
                        newR * Math.sin(newTheta),
                        (Math.random() - 0.5) * 4.0
                    ];
                    p.life = 1.0;
                    p.velocity = [0,0,0];
                }

            } else if (p.type === TYPE_PHOTON) {
                projector = photonProjector; // No shape attraction
                nFn = photonNoise;
                ws.shapeStrength = 0.0; // Free flowing
                ws.turbulence = 1.0; // Driven by photonFlowFn (which we abuse as noise)
                
                targetColor = new THREE.Color(1, 1, 1);
                targetSize = 0.5;
                
                // Reset if too far
                const r = Math.sqrt(p.position[0]**2 + p.position[1]**2);
                if (r > 40 || p.life <= 0) {
                    const newR = Math.random() * 30.0;
                    const newTheta = Math.random() * Math.PI * 2;
                    p.position = [
                        newR * Math.cos(newTheta),
                        newR * Math.sin(newTheta),
                        (Math.random() - 0.5) * 5.0
                    ];
                    p.life = 1.0;
                    p.velocity = [0,0,0];
                }

            } else if (p.type === TYPE_FLARE) {
                projector = flareProjector;
                nFn = generalNoise;
                ws.shapeStrength = 0.0;
                ws.turbulence = 0.05; // Very stable
                
                // Visibility controlled by uvIndex (glowStrength)
                // We use size or color alpha to hide them
                const strength = ws.glowStrength || 0.0;
                targetColor = p.baseColor.clone(); // Use a clone to not mess up base
                
                // Pulse brightness
                const pulse = 0.8 + 0.2 * Math.sin(time * 0.5 + i);
                targetSize = 15.0 * pulse; // Very large
                
                // If low UV, hide by setting size to 0 or moving away?
                // Setting size is easier.
                if (strength < 0.3) targetSize = 0.0;
                else targetSize *= strength;

                // Wrap around screen
                if (p.position[0] > 30) p.position[0] = -30;
                if (p.position[0] < -30) p.position[0] = 30;
                if (p.position[1] > 30) p.position[1] = -30;
                if (p.position[1] < -30) p.position[1] = 30;
            }

            // Update Physics
            updateParticle(p, dt, ws, projector, nFn, time);

            // Write to buffers
            posAttr.setXYZ(i, p.position[0], p.position[1], p.position[2]);
            colAttr.setXYZ(i, targetColor.r, targetColor.g, targetColor.b);
            sizeAttr.setX(i, targetSize * (ws.sizeMin || 1.0));
        }

        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
        sizeAttr.needsUpdate = true;

        // Only render if renderer is available (it might be handled externally)
        if (renderer) {
            renderer.render(scene, camera);
        }
    }

    function dispose() {
        geometry.dispose();
        material.dispose();
        material.map.dispose();
    }

    return { scene, camera, update, dispose };
}

// ------------------------------------------------------------------
// 5. SELF-RUNNER
// ------------------------------------------------------------------
if (typeof window !== 'undefined') {
    (function initStandalone() {
        // Check if already initialized or imported
        const isStandalone = !window.weatherSystemInitialized; 
        if (!isStandalone) return;

        // Create UI
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        const { update } = createWeatherScene({ count: 15000, renderer });
        window.weatherSystemInitialized = true;

        // Debug Params
        const params = { 
            uvIndex: 0.5, 
            temperatureC: 15 // 15°C is roughly 0.5 in our -10 to 40 mapping
        };
        
        const gui = new GUI();
        gui.add(params, 'uvIndex', 0, 1).name('UV Intensity');
        // Map -10°C (coldest) to 40°C (hottest)
        gui.add(params, 'temperatureC', -10, 40).name('Temperature (°C)');

        const clock = new THREE.Clock();
        let time = 0;

        function animate() {
            requestAnimationFrame(animate);
            const dt = clock.getDelta();
            time += dt;
            
            // Normalize temperature from Celsius back to 0..1
            // -10°C -> 0.0
            // 40°C  -> 1.0
            const normalizedTemp = (params.temperatureC - (-10)) / 50; // Range is 50
            
            const inputs = {
                uvIndex: params.uvIndex,
                temperature: Math.max(0, Math.min(1, normalizedTemp))
            };

            update(dt, time, inputs);
        }
        animate();
    })();
}

