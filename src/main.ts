/**
 * Entry point. Boots the simulator (src/game/app.ts wires physics, world,
 * renderer, cameras, HUD and audio together).
 */
import * as THREE from 'three';

// Temporary placeholder until the integration wave lands: proves three.js renders.
const root = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
root.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e8);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 2, 6);
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
scene.add(box);
renderer.setAnimationLoop((t) => {
  box.rotation.y = t / 1000;
  renderer.render(scene, camera);
});
