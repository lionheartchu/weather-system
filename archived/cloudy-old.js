// ---------------------
// Cloudy v5 – star field pointillism version
// ---------------------

import { applyMapping, updateParticle } from './engine.js';
import * as THREE from 'three';

// ======================================================
// ★ 1. PARAMETERS
// ======================================================

const STAR_COUNT = 5;          // how many stars
const STAR_MIN_R = 0.4;
const STAR_MAX_R = 1.2;

const POINT_COUNT = 6000;      // particle count
const POINT_JITTER = 0.08;     // point noise inside star shape

const FIELD_SPREAD = 4.0;      // random position spread for each star

// ======================================================
// ★ 2. RANDOM STAR POSITIONS + ROTATIONS
// ======================================================

const stars = [];
for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
        center: new THREE.Vector3(
            THREE.MathUtils.randFloatSpread(FIELD_SPREAD),
            THREE.MathUtils.randFloatSpread(FIELD_SPREAD),
            THREE.MathUtils.randFloatSpread(FIELD_SPREAD)
        ),
        radius: THREE.MathUtils.lerp(STAR_MIN_R, STAR_MAX_R, Math.random()),
        rotation: Math.random() * Math.PI * 2
    });
}

// ======================================================
// ★ 3. SDF FIVE-POINT STAR
// ======================================================

function sdfStar2D(p, r = 1.0) {
    // convert to polar
    const a = Math.atan2(p.y, p.x);
    const d = Math.sqrt(p.x * p.x + p.y * p.y);

    // create 5-point star angle pattern
    const s = Math.cos(a * 5.0) * 0.5 + 0.5;
    return d - r * (0.6 + 0.3 * s);
}

// ======================================================
// ★ 4. SAMPLE POINT ON STAR OUTLINE
// ======================================================

function sampleOnStar(star) {
    // 1. sample random angle
    const angle = Math.random() * Math.PI * 2;
    const base = new THREE.Vector2(Math.cos(angle), Math.sin(angle));

    // 2. bring to star SDF outline
    // march outward until close to zero
    const p = base.clone().multiplyScalar(star.radius);
    let d = sdfStar2D(p, star.radius);

    let iter = 0;
    while (Math.abs(d) > 0.01 && iter < 20) {
        p.addScaledVector(base, -d * 0.5);
        d = sdfStar2D(p, star.radius);
        iter++;
    }

    // 3. final jitter
    p.x += (Math.random() - 0.5) * POINT_JITTER;
    p.y += (Math.random() - 0.5) * POINT_JITTER;

    // 4. convert to 3D
    const pos = new THREE.Vector3(p.x, p.y, 0);

    // 5. apply rotation
    const c = Math.cos(star.rotation);
    const s = Math.sin(star.rotation);
    const x = pos.x * c - pos.y * s;
    const y = pos.x * s + pos.y * c;

    pos.x = x;
    pos.y = y;

    // 6. move to star center
    pos.add(star.center);

    return pos;
}

// ======================================================
// ★ 5. projectToShape() → THIS IS IMPORTANT
// ======================================================
// The reason your old version collapsed into 1D is because
// projectToShape() returned y=0 or z=0 or scaled too small.

export function projectToShape(position) {
    // find closest star
    let closest = stars[0];
    let minD = position.distanceTo(stars[0].center);

    for (let s of stars) {
        const d = position.distanceTo(s.center);
        if (d < minD) {
            minD = d;
            closest = s;
        }
    }

    // projection: pull position toward the ideal star outline
    const local = position.clone().sub(closest.center);

    // rotate back
    const c = Math.cos(-closest.rotation);
    const s = Math.sin(-closest.rotation);

    const lx = local.x * c - local.y * s;
    const ly = local.x * s + local.y * c;

    // 2D point
    const p = new THREE.Vector2(lx, ly);

    // push toward SDF zero
    const d = sdfStar2D(p, closest.radius);
    p.addScaledVector(p.normalize(), -d * 0.3);

    // rotate forward
    const fx = p.x * c + p.y * -s;
    const fy = p.x * s + p.y * c;

    const out = new THREE.Vector3(fx, fy, 0);

    // **keep the star floating in 3D**
    out.add(closest.center);

    return out;
}

// ======================================================
// ★ 6. noiseFn()
// ======================================================

export function noiseFn(position, time) {
    return new THREE.Vector3(
        Math.sin(position.y * 1.3 + time * 0.7) * 0.1,
        Math.sin(position.x * 1.1 - time * 0.4) * 0.1,
        Math.sin(position.z * 0.9 + time * 0.6) * 0.1
    );
}

// ======================================================
// ★ 7. mapping config
// ======================================================

export const mappingConfig = {
    cloudCover: {
        to: "shapeForce",
        min: 0.4,
        max: 1.2
    },
    airQuality: {
        to: "turbulence",
        min: 0.0,
        max: 0.5
    }
};

// ======================================================
// ★ 8. particle initializer
// ======================================================

export function initParticles(particles) {
    for (let i = 0; i < particles.length; i++) {
        const star = stars[Math.floor(Math.random() * stars.length)];
        particles[i].position.copy(sampleOnStar(star));
        particles[i].velocity.set(0, 0, 0);
    }
}
