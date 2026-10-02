// ============================================================
// B안 첫 화면 3D 장면 — 지형(와이어 + 점) · 자기장 벽(파란 원통) · 떠다니는 입자 · 금색 플레이어 표식
// three.js 모듈(CDN). 저사양 · 움직임 줄이기 · WebGL 없음이면 아무것도 하지 않고 대체 화면이 남는다.
// ============================================================
import * as THREE from "three";

const canvas = document.getElementById("scene");
const hero = document.querySelector(".hero");
function webglOK() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; }
}
if (canvas && !window.MRI_LITE && webglOK()) start();

function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06080b, 0.026);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

  // ── 지형: 잡음으로 높이를 준 평면 ─────────────────────
  const SIZE = 90, SEG = 180;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const H = (x, z) => {
    const n = noise(x * 0.06, z * 0.06) * 6 + noise(x * 0.15, z * 0.15) * 2 + noise(x * 0.4, z * 0.4) * 0.5;
    const flat = Math.min(1, Math.hypot(x - 6, z + 4) / 14); // 최종 서클 근처는 평평하게
    return (n - 4.2) * (0.35 + 0.65 * flat);
  };
  for (let i = 0; i < pos.count; i++) pos.setY(i, H(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();

  const terrainMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uZone: { value: new THREE.Vector3(6, 0, -4) }, uR: { value: 26 } },
    vertexShader: `
      varying vec3 vP; varying float vH;
      void main(){ vec4 w = modelMatrix * vec4(position,1.); vP = w.xyz; vH = position.y;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uZone; uniform float uR; varying vec3 vP; varying float vH;
      void main(){
        // 등고선: 높이를 일정 간격으로 끊어 얇은 선만 남긴다
        float h = vH * 2.2; float f = abs(fract(h) - .5); float line = smoothstep(.06, .0, f);
        float major = smoothstep(.03,.0, abs(fract(vH*0.44)-.5));
        float d = length(vP.xz - uZone.xz);
        float inside = smoothstep(uR + .4, uR - .4, d);
        vec3 base = mix(vec3(.30,.48,.85), vec3(.62,.70,.82), inside);
        float a = line * .38 + major * .35;
        // 자기장 경계 근처를 밝게
        float rim = smoothstep(1.6, .0, abs(d - uR));
        vec3 col = base + vec3(.18,.45,1.) * rim * .9;
        a += rim * .35;
        a *= smoothstep(44., 18., length(vP.xz));
        gl_FragColor = vec4(col, a);
      }`
  });
  const terrain = new THREE.Mesh(geo, terrainMat);
  scene.add(terrain);

  // 지형 점(밤하늘처럼 아주 옅게)
  const ptsMat = new THREE.PointsMaterial({ color: 0x9bb6e6, size: 0.06, transparent: true, opacity: 0.35, depthWrite: false });
  scene.add(new THREE.Points(geo, ptsMat));

  // ── 자기장 벽: 위로 갈수록 사라지는 파란 원통 + 흐르는 줄무늬 ──
  const zoneMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `
      uniform float uTime; varying vec2 vUv;
      void main(){
        float fade = pow(1. - vUv.y, 2.2);
        float stripes = .55 + .45 * sin((vUv.x * 160. + vUv.y * 18. - uTime * 2.4));
        float edge = smoothstep(.0,.06, vUv.y) ;
        vec3 c = vec3(.18,.49,1.);
        gl_FragColor = vec4(c, fade * (.18 + .22 * stripes) * edge);
      }`
  });
  const zone = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 16, 160, 1, true), zoneMat);
  zone.position.set(6, 6, -4);
  scene.add(zone);

  // 다음 안전 구역: 흰 고리
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 160), new THREE.MeshBasicMaterial({ color: 0xeef3ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(9, 0.15, -2); scene.add(ring);

  // 금색 플레이어 표식(빛기둥 + 점)
  const goldDot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf5c518 }));
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec2 vUv; void main(){ float a = pow(1.-vUv.y, 3.) * .7; gl_FragColor = vec4(1., .78, .1, a); }`
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 9, 12, 1, true), beamMat);
  const player = new THREE.Group(); player.add(goldDot); beam.position.y = 4.5; player.add(beam);
  scene.add(player);

  // ── 떠다니는 입자(먼지 · 재) ─────────────────────────
  const P = 1400, pGeo = new THREE.BufferGeometry(), arr = new Float32Array(P * 3), sp = new Float32Array(P);
  for (let i = 0; i < P; i++) { arr[i * 3] = (Math.random() - .5) * 70; arr[i * 3 + 1] = Math.random() * 14; arr[i * 3 + 2] = (Math.random() - .5) * 70; sp[i] = .2 + Math.random(); }
  pGeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const dust = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xbfd2ff, size: 0.05, transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(dust);

  // ── 크기 · 카메라 · 마우스 시차 ─────────────────────
  function size() {
    const r = canvas.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.fov = camera.aspect < 0.8 ? 58 : 42;
    camera.updateProjectionMatrix();
  }
  size(); window.addEventListener("resize", size);
  let mx = 0, my = 0;
  window.addEventListener("pointermove", (e) => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; }, { passive: true });

  const clock = new THREE.Clock();
  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) clock.getDelta(); }).observe(hero);

  function frame() {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = clock.getElapsedTime();
    const k = Math.min(1, window.scrollY / Math.max(1, hero.offsetHeight)); // 첫 화면 스크롤 비율
    // 자기장: 시간에 따라 천천히 줄었다가(26 → 14) 스크롤하면 더 줄어든다
    const R = 26 - 6 * (0.5 + 0.5 * Math.sin(t * 0.18)) - k * 8;
    zone.scale.set(R, 1, R);
    terrainMat.uniforms.uR.value = R;
    terrainMat.uniforms.uTime.value = t; zoneMat.uniforms.uTime.value = t;
    ring.scale.setScalar(R * 0.55);
    // 플레이어: 다음 안전 구역 쪽으로 걸어간다
    const px = -4 + Math.sin(t * 0.25) * 2 + k * 10, pz = 3 - k * 4;
    player.position.set(px, H(px, pz) + 0.25, pz);
    goldDot.scale.setScalar(1 + .25 * Math.sin(t * 4));
    // 먼지
    const a = pGeo.attributes.position.array;
    for (let i = 0; i < P; i++) { a[i * 3 + 1] += 0.004 * sp[i]; if (a[i * 3 + 1] > 14) a[i * 3 + 1] = 0; }
    pGeo.attributes.position.needsUpdate = true;
    // 카메라: 낮게 비행하며 천천히 돌고, 스크롤하면 내려다본다
    const ang = t * 0.035 + mx * 0.25;
    const dist = 30 - k * 6, hgt = 9 + k * 10 - my * 2;
    camera.position.set(Math.sin(ang) * dist + 4, hgt, Math.cos(ang) * dist - 2);
    camera.lookAt(5, 0 + k * -2, -3);
    renderer.render(scene, camera);
  }
  frame();
  hero.classList.add("has3d");
}
