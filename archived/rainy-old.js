
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { createDefaultWeatherState, applyMapping, updateParticle } from '../engine.js';
import { createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.esm.min.js';

// ------------------------------------------------------------------
// 1. VISUALS & ASSETS
// ------------------------------------------------------------------
// ---------------
// FALLING RAIN PROJECTOR (Abstract Meteor Shower)
// ---------------

function createRainProjector() {
    const center = new THREE.Vector3(0, 0, 0);
    
    return function(pos, weatherState) {
      // Downward flow (y-axis)
      // We want particles to start high and end low/center
      
      const t = weatherState.shapeStrength || 1.0; 
      
      // Fall Speed (Precipitation drives speed)
      const fallSpeed = THREE.MathUtils.lerp(8.0, 25.0, t);
      
      // Curvature Logic:
      // As particles get closer to y=0 (ground), they curve towards the center
      // "Black Hole Waterfall" effect
      
      const currentY = pos[1];
      const distToCenterXZ = Math.sqrt(pos[0]*pos[0] + pos[2]*pos[2]) + 0.001;
      
      // Curve strength increases near bottom
      // range: 10.0 height -> 0.0 height
      let inwardPull = 0;
      if (currentY < 10.0 && currentY > -5.0) {
          // Normalized height factor (1.0 at top, 0.0 at bottom)
          const h = Math.max(0, (currentY + 5.0) / 15.0); 
          // Pull stronger as h gets smaller
          inwardPull = (1.0 - h) * THREE.MathUtils.lerp(2.0, 8.0, t);
      }
      
      // Flow Vector
      // Downward
      const vy = -fallSpeed;
      
      // Inward (Radial in XZ plane)
      const vx = (-pos[0] / distToCenterXZ) * inwardPull;
      const vz = (-pos[2] / distToCenterXZ) * inwardPull;
      
      // Target is current pos + velocity vector
      // Engine interpolates towards this target
      return [pos[0] + vx, pos[1] + vy, pos[2] + vz];
    };
}
const projectToRain = createRainProjector();

function createStormTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');   
    grad.addColorStop(0.2, 'rgba(200, 220, 255, 0.8)'); 
    grad.addColorStop(0.5, 'rgba(100, 120, 150, 0.2)'); 
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');         

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    return new THREE.CanvasTexture(canvas);
}

// ------------------------------------------------------------------
// 2. MATH & VORTEX LOGIC
// ------------------------------------------------------------------

const noise3D = createNoise3D();

function vortexNoiseFn(pos, time, weatherState) {
    // Rain Streaks Noise
    // We want vertical streakiness (less noise on Y, more on XZ)
    // Scale Y less to stretch noise vertically
    
    const x = pos[0];
    const y = pos[1];
    const z = pos[2];

    const scale = weatherState.noiseScaleLarge || 1.0;
    
    // Stretch noise on Y axis to make "tubes" or "streaks"
    const nX = noise3D(x * scale, y * scale * 0.2, time * 0.5); 
    const nY = noise3D(x * scale + 100, y * scale * 0.2, time * 0.5); // Vertical variance
    const nZ = noise3D(x * scale + 200, y * scale * 0.2, time * 0.5);
    
    return [nX, nY, nZ];
}



// ------------------------------------------------------------------
// 3. MAPPING CONFIG
// ------------------------------------------------------------------

const RAINY_MAPPING = {
    turbulence: { from: 'precipitation', min: 0.5, max: 3.0 }, 
    shapeStrength: { from: 'precipitation', min: 0.5, max: 2.0 },
    noiseScaleLarge: { from: 'precipitation', min: 0.1, max: 0.8 }, 
    deformFactor: { from: 'precipitation', min: 0.2, max: 0.8 },
    // sizeMin: { from: 'humidity', min: 0.2, max: 0.8 },
    sizeMin: { from: 'humidity', min: 0.05, max: 0.3 }, // Much smaller for rain
    sizeMax: { from: 'humidity', min: 0.1, max: 0.5 },
    softness: { from: 'humidity', min: 0.0, max: 0.5 }, // Sharper by default
    brightness: { from: 'humidity', min: 1.2, max: 0.8 }, // Brighter
    trailLength: { from: 'humidity', min: 0.1, max: 0.8 },
    lifeSpan: { from: 'precipitation', min: 2.0, max: 1.5 }
};


// ------------------------------------------------------------------
// 4. EXPORTED SCENE CREATOR
// ------------------------------------------------------------------

export function createWeatherScene(options = {}) {
    const count = options.count || 15000;
    const bounds = options.bounds || { x: 20, y: 20, z: 20 };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080a10); 
    scene.fog = new THREE.FogExp2(0x080a10, 0.03);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 2, 25); // Eye-level view to see vertical streaks
    camera.lookAt(0, 5, 0); // Look slightly up/center

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count); 
    const opacities = new Float32Array(count); 

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

        particles.push({
            position: [x, y, z],
            velocity: [0, 0, 0],
            life: Math.random()
        });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('opacity', new THREE.BufferAttribute(opacities, 1));

    const material = new THREE.PointsMaterial({
        color: 0x88ccff,
        map: createStormTexture(),
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
        const weatherState = applyMapping(normalizedInputs, RAINY_MAPPING, baseState);
        // Essential: Attach time to weatherState because projectToDiskVortex needs it for the wave effect!
        weatherState.time = time;
        
        // Set wind direction if provided (simulated here for standalone)
        // engine uses flowDirection
        // Let's map a fake wind rotation to flowDirection based on time or input?
        // For standalone, we can add a wind control or just rotate it slowly.
        if (!weatherState.flowDirection) {
             // Default gentle rotation
             const angle = time * 0.1;
             weatherState.flowDirection = [Math.sin(angle), Math.cos(angle) * 0.5, Math.cos(angle)];
        }

        // 1. Active Count based on Precipitation
        // 0.0 -> 40% active (Increase base density)
        // 1.0 -> 100% active
        const precip = normalizedInputs.precipitation ?? 0.5;
        const minActive = Math.floor(count * 0.4);
        const activeCount = Math.floor(minActive + (count - minActive) * precip);
        geometry.setDrawRange(0, activeCount);

        const posAttr = geometry.attributes.position;
        
        // Wrapped functions to capture weatherState
        const wrappedNoiseFn = (pos, t) => vortexNoiseFn(pos, t, weatherState);
        const wrappedProjectFn = (pos) => projectToRain(pos, weatherState);

        for (let i = 0; i < count; i++) { // Process all, but only render active
            const p = particles[i];

            // 2. Respawn Logic: Rain from Top
            const groundY = -10.0;
            const topY = 20.0;
            
            // If below ground or too far sideways, reset to top
            const isBelow = p.position[1] < groundY;
            const isFar = Math.abs(p.position[0]) > 20 || Math.abs(p.position[2]) > 20;

            if (p.life <= 0 || isBelow || isFar) {
                // Respawn at top, random XZ
                // Wider spread at top to cover area
                p.position = [
                    (Math.random() - 0.5) * 40,
                    topY + Math.random() * 5.0, // Staggered entry
                    (Math.random() - 0.5) * 40
                ];
                p.velocity = [0, -5, 0]; // Initial downward push
                p.life = 1.0;
            }

            updateParticle(p, dt, weatherState, wrappedProjectFn, wrappedNoiseFn, time);
            posAttr.setXYZ(i, p.position[0], p.position[1], p.position[2]);
        }

        posAttr.needsUpdate = true;

        material.size = weatherState.sizeMin || 0.5;
        const baseOpacity = 0.6;
        const softnessFactor = weatherState.softness || 0.5; 
        const opacityMod = 1.0 - (softnessFactor * 0.5); 
        material.opacity = weatherState.brightness * baseOpacity * opacityMod;
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
// 5. SELF-RUNNER (Auto-detect if running directly)
// ------------------------------------------------------------------
// If the script is loaded directly by index.html, we should run the loop.
// We can use a simple check or just always run if we detect we are in a browser context
// and no other mechanism has claimed control. 

// Simple "Main" logic that runs if not imported as a module (hard to detect in ES modules).
// But we can just expose a global or run immediately if a specific flag is set, 
// OR we can just run it and if someone else calls createWeatherScene they get a new one.

// We will run a default setup immediately.
// If this file is imported by another module, this code runs too.
// This might be a side effect. 
// However, to satisfy "work even no main.js", we need this.
// We can check if document.body has a canvas?

if (typeof window !== 'undefined') {
    // Check if we are the "entry point" script
    // A simple heuristic: check if the current script src ends with rainy.js 
    // AND there is no existing canvas or we are the only script tag (flaky).
    
    // Better: Just run it. If the user imports this module later for a switcher, 
    // they might need to disable this auto-run or we export a function `init()` 
    // and call it here.
    
    // Let's follow `snow.js` pattern: it just runs code at top level.
    
    // Only run if we haven't already set up a scene (prevent double init if main.js also exists later)
    // But since we are replacing main.js logic...
    
    (function initStandalone() {
        // Avoid interfering if imported strictly for library usage
        // But for this prototype, we'll just run.
        
        // 1. Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        document.body.appendChild(renderer.domElement);

        // 2. Scene
        const { scene, camera, update } = createWeatherScene({ count: 20000 });

        // 3. State & GUI
        const state = {
            precipitation: 0.5,
            humidity: 0.5,
            timeSpeed: 1.0
        };

        const gui = new GUI({ title: 'Rainy Debugger' });
        gui.add(state, 'precipitation', 0, 1).name('Precipitation');
        gui.add(state, 'humidity', 0, 1).name('Humidity');
        gui.add(state, 'timeSpeed', 0, 5).name('Time Speed');

        // 4. Loop
        const clock = new THREE.Clock();
        let globalTime = 0;

        function animate() {
            requestAnimationFrame(animate);
            const dt = clock.getDelta();
            globalTime += dt * state.timeSpeed;

            const inputs = {
                precipitation: state.precipitation,
                humidity: state.humidity
            };

            update(dt, globalTime, inputs);
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
