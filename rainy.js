
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { createDefaultWeatherState, applyMapping, updateParticle } from './engine.js';
import { createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.esm.min.js';

// ------------------------------------------------------------------
// 1. VISUALS & ASSETS
// ------------------------------------------------------------------
  
function createRainTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64; // Square to avoid stretching artifacts
    const ctx = canvas.getContext('2d');
    
    // "Capsule" / Rain Drop Texture
    // Vertical gradient: Bright head -> Fading tail
    const grad = ctx.createLinearGradient(32, 0, 32, 64);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.0)'); // Top padding
    grad.addColorStop(0.1, 'rgba(255, 255, 255, 1.0)'); // Bright Head (Center bloom)
    grad.addColorStop(0.4, 'rgba(200, 240, 255, 0.8)'); // Body
    grad.addColorStop(1.0, 'rgba(100, 150, 255, 0.0)'); // Tail fade

    ctx.fillStyle = grad;
    // Draw thin capsule
    ctx.beginPath();
    ctx.ellipse(32, 32, 3, 28, 0, 0, Math.PI * 2);
    ctx.fill();

    return new THREE.CanvasTexture(canvas);
}

// ------------------------------------------------------------------
// 2. MATH & LOGIC
// ------------------------------------------------------------------

const noise3D = createNoise3D();

// Fixed puddle centers on the ground plane
const PUDDLES = [
    { x: 0, z: 0, r: 7.0 },
    { x: -8, z: 5, r: 5.0 },
    { x: 6, z: -5, r: 5.5 },
    { x: 7, z: 7, r: 4.5 },
    { x: -10, z: -8, r: 5.2 }, // New puddle
    { x: 12, z: 3, r: 4.8 }    // New puddle
];

/**
 * Projector that handles both Puddle Logic (swirl/ripple) and Rain Logic (vertical streaks).
 * The behavior morphs based on weatherState.precipitation.
 */
function createRainProjector() {
    return function projectToRainSystem(pos, weatherState) {
        const t = weatherState.precipitation ?? 0.0; // 0.0 (Puddle) -> 1.0 (Glitch Storm)
        const time = performance.now() * 0.001;

        // MODE A: PUDDLES (0.0 -> 0.4)
        // Swirling vortex on ground with expanding ripple rings.
        
        // Find nearest puddle
        let nearestDist = Infinity;
        let nearestPuddle = PUDDLES[0];
        
        for (const p of PUDDLES) {
            const dx = pos[0] - p.x;
            const dz = pos[2] - p.z;
            const d = Math.sqrt(dx*dx + dz*dz);
            if (d < nearestDist) {
                nearestDist = d;
                nearestPuddle = p;
            }
        }

        // Calculate swirling target for Puddle Mode
        // To swirl, target is perpendicular to radius
        const px = pos[0] - nearestPuddle.x;
        const pz = pos[2] - nearestPuddle.z;
        const angle = Math.atan2(pz, px);
        const dist = Math.sqrt(px*px + pz*pz);
        
        // Irregular radius:
        // Base oscillation + Noise distortion
        // Increase noise scale for more irregularity at low precip
        const noiseVal = noise3D(Math.cos(angle) * 0.5, Math.sin(angle) * 0.5, time * 0.2);
        
        const ripplePhase = (dist * 1.5) - (time * 1.0);
        const rippleOffset = Math.sin(ripplePhase) * 0.2;
        
        // More chaos when precip is low to break the "belt" look
        // At t=0, chaos is high. At t=1, structure is tighter (more storm-like)
        const chaosAmount = 2.0 + (1.0 - t) * 3.0; 
        const chaoticOffset = noiseVal * chaosAmount; 
        
        // Vortex: Target is slightly ahead in angle
        // Add time-based swirl variance for more chaotic movement
        const swirlSpeed = 0.5 + t * 2.0; // Spin faster with more rain
        const nextAngle = angle + 0.2; // Look ahead
        
        // Target position for puddle mode
        const puddleTargetX = nearestPuddle.x + Math.cos(nextAngle) * (dist + rippleOffset + chaoticOffset);
        const puddleTargetZ = nearestPuddle.z + Math.sin(nextAngle) * (dist + rippleOffset + chaoticOffset);
        const puddleTargetY = 0.1; // Stay on ground
        
        
        // MODE B: VERTICAL RAIN (Rain Particles)
        // Falling high speed, single direction.
        
        // Apply abstraction effects (jitter / scanlines)
        // t = precipitation (density/speed), but let's use humidity for abstraction level?
        // The function signature only has 'weatherState'. 
        // We can infer abstraction from weatherState properties or pass it.
        // Let's assume weatherState.deformFactor correlates to abstraction.
        
        const abstraction = weatherState.deformFactor ?? 0.0;
        
        let targetX = pos[0];
        let targetZ = pos[2];
        
        // 1. Jitter / Signal Noise (Mid Abstraction)
        if (abstraction > 0.3) {
            // Jitter perpendicular to fall
            const jitter = (Math.random() - 0.5) * abstraction * 0.2;
            targetX += jitter;
        }
        
        // 2. Scanlines (High Abstraction)
        if (abstraction > 0.7) {
            // Quantize X to create vertical bands
            const scanGrid = 2.0;
            targetX = Math.round(targetX * scanGrid) / scanGrid;
        }
        
        // Return current pos for Y (let gravity handle it)
        // Target X/Z applies the "Shape" force which acts as a guide/correction
        return [targetX, pos[1], targetZ];
    };
}

const projectToRain = createRainProjector();


/**
 * Noise function that morphs from Soft Water -> Turbulent Storm -> Digital Glitch
 */
function createRainNoiseFn() {
    return function rainNoise(pos, time, weatherState) {
        const t = weatherState.precipitation ?? 0.0;
        
        let nx = 0, ny = 0, nz = 0;
        
        // 1. FLUID NOISE (Low Precip)
        // Smooth, rolling noise for water surface
        if (t < 0.6) {
            const scale = 0.3;
            nx = noise3D(pos[0]*scale, pos[1]*scale, time * 0.2);
            ny = noise3D(pos[1]*scale, pos[2]*scale, time * 0.2 + 100);
            nz = noise3D(pos[2]*scale, pos[0]*scale, time * 0.2 + 200);
        }
        
        // 2. GLITCH NOISE (High Precip)
        // High frequency, quantized, blocky
        if (t > 0.4) {
            // Quantize position for blocky noise look
            const q = 1.0 + (t * 5.0); // quantization level
            const qx = Math.floor(pos[0] * q) / q;
            const qy = Math.floor(pos[1] * q * 10.0) / (q * 10.0); // scanline feel on Y
            const qz = Math.floor(pos[2] * q) / q;
            
            const glitchIntensity = (t - 0.4) * 2.0; // 0 to 1.2ish
            
            const gnx = noise3D(qx * 2.0, qy * 20.0, time * 5.0); // Fast flicker
            const gny = noise3D(qy * 0.5, time * 2.0, 0);
            const gnz = noise3D(qz * 2.0, qy * 20.0, time * 5.0 + 43);
            
            // Blend
            nx += gnx * glitchIntensity;
            ny += gny * glitchIntensity;
            nz += gnz * glitchIntensity;
        }

        return [nx, ny, nz];
    };
}

const rainNoiseFn = createRainNoiseFn();


// ------------------------------------------------------------------
// 3. MAPPING CONFIG
// ------------------------------------------------------------------

const RAINY_MAPPING = {
    // Shape Attraction: Strong for puddles, weak for rain, medium for glitch sheets
    shapeStrength: { from: 'precipitation', min: 3.0, max: 0.5 }, // Fade out puddle grip as rain starts
    
    // Turbulence: Increases with storm
    turbulence: { from: 'precipitation', min: 0.1, max: 1.0 }, // Less chaotic flying, more straight fall
    
    // Vertical Fall: Controls Rain Speed
    verticalBias: { from: 'precipitation', min: 10.0, max: 40.0 }, // High speed fall
    
    // Abstraction (Deform): Controlled by Humidity
    deformFactor: { from: 'humidity', min: 0.0, max: 1.0 },
    
    // Visuals
    trailLength: { from: 'precipitation', min: 0.1, max: 0.5 }, 
    sizeMin: { from: 'humidity', min: 0.3, max: 0.5 }, 
    lifeSpan: { from: 'precipitation', min: 12.0, max: 13.0 }, // Short life to recycle fast
};


// ------------------------------------------------------------------
// 4. EXPORTED SCENE CREATOR
// ------------------------------------------------------------------

export function createWeatherScene(options = {}) {
    const count = options.count || 22000; // Increased count slightly
    const bounds = options.bounds || { x: 30, y: 30, z: 30 };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000205); // Very Dark
    scene.fog = new THREE.FogExp2(0x000205, 0.02);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 8, 20);
    camera.lookAt(0, 2, 0);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    
    const sizes = new Float32Array(count); 
    const opacities = new Float32Array(count); 
    // Add color attribute for the glitch effect
    const colors = new Float32Array(count * 3);

    const particles = [];

    for (let i = 0; i < count; i++) {
        const x = (Math.random() - 0.5) * bounds.x;
        const y = (Math.random() - 0.5) * bounds.y;
        const z = (Math.random() - 0.5) * bounds.z;

        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        sizes[i] = 1.0;
        opacities[i] = 1.0;
        
        colors[i*3] = 0.5;
        colors[i*3+1] = 0.7;
        colors[i*3+2] = 1.0;

        particles.push({
            position: [x, y, z],
            velocity: [0, 0, 0],
            life: Math.random(),
            isRain: false, // Track type
            isSparkle: false // Track sparkle state
        });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('opacity', new THREE.BufferAttribute(opacities, 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        vertexColors: true, // Enable vertex colors
        map: createRainTexture(),
        size: 0.5,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const baseState = createDefaultWeatherState();

    function update(dt, time, normalizedInputs) {
        // Custom Morphing Logic for Mapping
        
        const weatherState = applyMapping(normalizedInputs, RAINY_MAPPING, baseState);
        const precip = normalizedInputs.precipitation ?? 0.0; // 0 to 1
        const humidity = normalizedInputs.humidity ?? 0.5; // 0 to 1
        
        // --- DYNAMIC BEHAVIOR OVERRIDES ---
        
        // Prepare separate states for Puddles and Rain so they can co-exist
        // Puddles: Low gravity, strong shape grip
        const puddleState = { ...weatherState, verticalBias: 0.05, shapeStrength: 5.0 };
        
        // Rain: High gravity, weak shape grip (just fall)
        const rainState = { ...weatherState };
        
        if (precip < 0.1) {
             // Falling Speed for "0 Precip"
             // Gentle drift like mist
             rainState.verticalBias = 2.0; 
             // Also add some horizontal drift so they don't stick
             rainState.flowDirection = [0.5, 0, 0.2];
             rainState.flowSpeed = 1.0;
        } else {
             // Rain particles falling speed - SMOOTH RAMP
             // We want to blend from the "Mist" speed (2.0) up to "Storm" speed (45.0)
             // Previous: lerp(15, 45, precip) caused a jump from 2 to 15 at 0.1
             
             // New: Interpolate starting from 2.0 at precip=0.1 up to 45.0 at precip=1.0
             // Normalize t from range [0.1, 1.0] to [0, 1]
             const t = (precip - 0.1) / 0.9;
             rainState.verticalBias = THREE.MathUtils.lerp(2.0, 45.0, t);
             
             // Minimized shape strength so they fall straight
             rainState.shapeStrength = 0.5; 
             rainState.flowSpeed = 0.0; // Vertical fall dominates
        }
        
        // ----------------------------------

        const posAttr = geometry.attributes.position;
        const colAttr = geometry.attributes.color;
        
        // Color Palette: Dreamcore to Glitch
        
        // Dreamcore Base: Soft Lilac / Periwinkle
        const rDream = 0.6, gDream = 0.6, bDream = 1.0; 
        
        // Matrix/Glitch Palette
        const rLead = 0.8, gLead = 1.0, bLead = 1.0; // White-ish
        const rMat = 0.0, gMat = 0.8, bMat = 0.9; // Cyan
        
        // Creamy Look Mix Factor (Humidity driven)
        const creamFactor = Math.max(0, (humidity - 0.3) * 0.8); // Reduced intensity
        
        const isGlitch = precip > 0.6;

        // Wrappers
        const wrappedNoiseFn = (pos, t) => rainNoiseFn(pos, t, weatherState);
        
        // Puddle Projector (Keeps puddles round)
        const puddleProjector = (pos) => {
             return projectToRain(pos, { ...weatherState, precipitation: Math.min(precip, 0.4) });
        };
        
        // Rain Projector (Allows glitch/grid)
        const rainProjector = (pos) => {
             return projectToRain(pos, weatherState);
        };

        // Update Loop
        for (let i = 0; i < count; i++) {
            const p = particles[i];

            // Respawn Logic
            let dead = p.life <= 0;
            
            // Bounds check
            if (Math.abs(p.position[0]) > bounds.x || 
                Math.abs(p.position[2]) > bounds.z || 
                p.position[1] < -10 || 
                p.position[1] > bounds.y + 10) {
                dead = true;
            }
            
            if (dead) {
                // RESPAWN RULES
                // Blend probability based on precip
                // Ensure puddles NEVER disappear completely.
                // Max Rain Probability = 0.7 (leaving 30% for puddles)
                
                let rainProb = 0;
                if (precip > 0.05) { // Start blending rain earlier
                    // Scale precip to rainProb, but cap at 0.7
                    // Now: 0.05 -> 0 rain, 0.3 -> some rain
                    const t = (precip - 0.05) / 0.7; 
                    rainProb = Math.min(0.7, Math.max(0, t));
                }

                if (Math.random() > rainProb) {
                    // Spawn in Puddle (Persist!)
                    const pud = PUDDLES[Math.floor(Math.random() * PUDDLES.length)];
                    const ang = Math.random() * Math.PI * 2;
                    // Use a slightly fuzzier radius for respawn to avoid belt
                    const rad = Math.random() * pud.r; // Inside puddle
                    p.position[0] = pud.x + Math.cos(ang) * rad;
                    p.position[1] = 0.1 + (Math.random() * 0.2);
                    p.position[2] = pud.z + Math.sin(ang) * rad;
                    p.velocity = [0,0,0];
                    p.isRain = false;
                } else {
                    // Spawn as Rain from sky
                    // Spread wider than bounds to cover camera view
                    // 1. Pick a target puddle or ground spot to "fall towards"
                    // But gravity is straight down. So we must spawn ABOVE the target.
                    
                    // Weighted Choice: 
                    // 70% chance: Spawn exactly above a Puddle (to feed it)
                    // 30% chance: Random sky spawn
                    
                    if (Math.random() < 0.7) {
                        const pud = PUDDLES[Math.floor(Math.random() * PUDDLES.length)];
                        const ang = Math.random() * Math.PI * 2;
                        const rad = Math.random() * pud.r * 1.5; // Slightly wider than puddle
                        
                        p.position[0] = pud.x + Math.cos(ang) * rad;
                        p.position[2] = pud.z + Math.sin(ang) * rad;
                    } else {
                        p.position[0] = (Math.random() - 0.5) * bounds.x * 1.2;
                        p.position[2] = (Math.random() - 0.5) * bounds.z * 1.2;
                    }
                    
                    p.position[1] = 20 + Math.random() * 15; // High up
                    p.velocity = [0, -rainState.verticalBias, 0]; 
                    p.isRain = true;
                }
                p.life = 1.0; // Reset life to full
            }

            // Update based on type
            if (p.isRain) {
                 updateParticle(p, dt, rainState, rainProjector, wrappedNoiseFn, time);
                 
                 // LOGIC: If Rain hits ground (approx y=0), it turns into a Puddle particle?
                 // Or just respawns? 
                 // To "gather into puddles", we can make rain turn into puddle type upon landing.
                 if (p.position[1] <= 0.2 && p.position[1] >= -0.5) {
                     // Check distance to nearest puddle
                     let nearestDist = Infinity;
                     let nearestPuddle = null;
                     for (const pud of PUDDLES) {
                         const dx = p.position[0] - pud.x;
                         const dz = p.position[2] - pud.z;
                         const d = Math.sqrt(dx*dx + dz*dz);
                         if (d < pud.r * 1.2) { // Hit inside or near puddle
                             if (d < nearestDist) {
                                 nearestDist = d;
                                 nearestPuddle = pud;
                             }
                         }
                     }
                     
                     if (nearestPuddle) {
                        // Convert to Puddle Particle!
                        p.isRain = false;
                        p.life = 1.0 + Math.random(); // Fresh life as puddle
                        p.velocity = [0,0,0]; // Stop falling
                        p.position[1] = 0.1; // Snap to floor
                        
                        // Chance to become a "Sparkle" (jump out)
                        if (Math.random() < 0.1) { // 10% chance
                            p.isSparkle = true;
                            p.velocity = [
                                (Math.random() - 0.5) * 2.0, // Random spread X
                                Math.random() * 2.0,         // Jump UP
                                (Math.random() - 0.5) * 2.0  // Random spread Z
                            ];
                            p.life = 0.5; // Short life
                        } else {
                            p.isSparkle = false;
                        }
                    }
                }
                
           } else {
                // Puddle Logic (Swirl) or Sparkle Logic (Fly)
                
                if (p.isSparkle) {
                    // Simple gravity physics for jump
                    p.position[0] += p.velocity[0] * dt;
                    p.position[1] += p.velocity[1] * dt;
                    p.position[2] += p.velocity[2] * dt;
                    p.velocity[1] -= 9.8 * dt; // Gravity
                    p.life -= dt; // Decay faster
                } else {
                    updateParticle(p, dt, puddleState, puddleProjector, wrappedNoiseFn, time);
                }
           }

            posAttr.setXYZ(i, p.position[0], p.position[1], p.position[2]);
            
            // UPDATE COLORS: DREAMCORE -> GLITCH
            let r, g, b;
            
            if (p.isRain) {
                if (isGlitch) {
                    // Matrix Rain Effect (Shooting Stars)
                    // Grid coordinate to sync columns
                    const colX = Math.round(p.position[0] * 2.0);
                    const colZ = Math.round(p.position[2] * 2.0);
                    // Random offset per column
                    const offset = Math.sin(colX * 12.9898 + colZ * 78.233) * 43758.5453;
                    
                    // Moving wave
                    const wave = (p.position[1] * 0.5 + time * 5.0 + offset) % 10.0;
                    
                    if (wave < 1.0) {
                        // Leading Edge (Bright White/Cyan)
                        r = rLead; g = gLead; b = bLead;
                    } else if (wave < 4.0) {
                        // Body (Matrix Cyan)
                        const fade = 1.0 - ((wave - 1.0) / 3.0);
                        // Mix Dreamcore into Matrix Body for unification
                        r = rDream * 0.3 + rMat * 0.7 * fade;
                        g = gDream * 0.3 + gMat * 0.7 * fade;
                        b = bDream * 0.3 + bMat * 0.7 * fade;
                    } else {
                        // Tail (Dark)
                        r = 0; g = 0.1; b = 0.2;
                    }

                } else {
                    // Normal Rain: Uniform Dreamcore Blue
                    r = rDream; g = gDream; b = bDream;
                }
            } else {
                // Puddles: Always Dreamcore
                const shim = 0.8 + Math.sin(time * 3.0 + p.position[0]) * 0.2;
                r = rDream * shim; g = gDream * shim; b = bDream * shim;
            }
            
            // Mix Cream (Humidity) - Glow
            if (creamFactor > 0.0) {
                // Additive mix for glow
                r = Math.min(1.0, r + 0.2 * creamFactor);
                g = Math.min(1.0, g + 0.3 * creamFactor);
                b = Math.min(1.0, b + 0.4 * creamFactor);
            }
            
            colAttr.setXYZ(i, r, g, b);
        }

        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;

        // Material Updates
        // Use smaller size for crisp particles
        material.size = (weatherState.sizeMin || 0.25);
        
        // Solid opacity for visibility
        material.opacity = isGlitch ? 0.9 : 0.8;
    }

    function dispose() {
        geometry.dispose();
        material.dispose();
        material.map.dispose();
    }

    return {
        scene,
        camera,
        points,
        update,
        dispose
    };
}


// ------------------------------------------------------------------
// 5. SELF-RUNNER
// ------------------------------------------------------------------

if (typeof window !== 'undefined') {
    (function initStandalone() {
        // Prevent multiple runs if loaded via module system in main app
        // Check if canvas already exists
        if (document.querySelector('canvas')) return;
        
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        document.body.appendChild(renderer.domElement);

        const { scene, camera, update } = createWeatherScene({ count: 20000 });

        const state = {
            precipitation: 0.0, // Start with puddles
            humidity: 0.5,
            timeSpeed: 1.0,
            windSpeed: 0.0 // New Wind Speed parameter
        };

        const gui = new GUI({ title: 'Scattering Drops' });
        gui.add(state, 'precipitation', 0, 1).name('Precipitation / Morph');
        gui.add(state, 'humidity', 0, 1).name('Humidity');
        // Map UI 'Wind Speed' to both timeSpeed and wind logic
        gui.add(state, 'windSpeed', 0, 2).name('Wind / Time Speed');

        const clock = new THREE.Clock();
        let globalTime = 0;

        function animate() {
            requestAnimationFrame(animate);
            const dt = clock.getDelta();
            
            // Link timeSpeed to windSpeed (1.0 base + wind)
            state.timeSpeed = 1.0 + state.windSpeed;
            
            globalTime += dt * state.timeSpeed;

            update(dt, globalTime, state);
            renderer.render(scene, camera);
        }

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        animate();
    })();
}
