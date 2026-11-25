import * as THREE from 'three';
import { directConnections, edgeKey,rootKey,rootEdge } from './subject-areas.js';
import { nodeAppearance,UNCONFIRMED_COLOR } from './node-appearance.js';
import { updateMapCamera } from './camera-navigation.js';

// Points and travelling light stay in world space. SVG provides readable labels,
// accessible hit targets and the explicit non-WebGL fallback.
export function createKnowledgeScene(container, onLost) {
  if (!container?.appendChild) return null;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x040810, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(canvas);
  const scene = new THREE.Scene(), world = new THREE.Group(); scene.add(world);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 15000);
  camera.matrixAutoUpdate = false; camera.matrixWorldAutoUpdate = false;
  const heightUniform = { value: 600 }, timeUniform = { value: 0 };
  const motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let digest = '', disposed = false, size = '', ready = false, lastFrame = -Infinity;
  let flows = [], particles = null;
  const point = p => new THREE.Vector3(p[0], -p[1], -p[2]);
  const glowMaterial = (flat=false) => new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false, blending: flat?THREE.NormalBlending:THREE.AdditiveBlending,
    uniforms: { uHeight: heightUniform,uFlat:{value:flat?1:0} },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aOpacity;
      uniform float uHeight;
      varying vec3 vColor;
      varying float vOpacity;
      void main() {
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_PointSize = clamp(aSize * uHeight * .5 * projectionMatrix[1][1] / max(1.0, -p.z), 2.0, 180.0);
        vColor = aColor; vOpacity = aOpacity;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      varying float vOpacity;
      uniform float uFlat;
      void main() {
        float r = length(gl_PointCoord * 2.0 - 1.0);
        if (r > 1.0) discard;
        float core = 1.0 - smoothstep(.025, .20, r);
        float glow = exp(-r * r * 12.0) * .55 + pow(1.0-r, 3.0) * .20;
        float alpha=mix(min(1.0, core + glow),1.0-smoothstep(.72,1.0,r),uFlat);
        gl_FragColor = vec4(mix(vColor, vec3(1.0), core * .20*(1.0-uFlat)), alpha * vOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const cloud = (positions, colors, sizes, opacities,flat=false) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
    geometry.setAttribute('aOpacity', new THREE.Float32BufferAttribute(opacities, 1));
    const dots = new THREE.Points(geometry, glowMaterial(flat)); dots.frustumCulled = false; world.add(dots); return dots;
  };
  const release = () => {
    world.traverse(object => { object.geometry?.dispose(); for (const material of [].concat(object.material || [])) material.dispose(); });
    world.clear(); flows = []; particles = null;
  };
  function build(nodes, edges, roots, selected, areas, emphasis) {
    release();
    const index = new Map(nodes.map(n => [n.id, n]));
    const highlight=directConnections(nodes,edges,emphasis,roots);
    const positions = [], colors = [], sizes = [], opacities = [];
    const pendingPositions=[],pendingColors=[],pendingSizes=[],pendingOpacities=[];
    for (const n of nodes) {
      const active = n.id === selected || n.isCurrent, appearance=nodeAppearance(n);
      const related=highlight?.nodes.has(n.id);
      if(appearance.pending){pendingPositions.push(...point(n.position).toArray());pendingColors.push(...new THREE.Color(appearance.color).toArray());pendingSizes.push(active?34:related?30:24);pendingOpacities.push(highlight&&!related? .14:.85);continue;}
      positions.push(...point(n.position).toArray()); colors.push(...new THREE.Color(appearance.color).toArray());
      sizes.push(active ? 76 : related ? 58 : n.foundationRoot ? 54 : 44);
      opacities.push(highlight&&!related ? .08 : active ? 1 : related ? .95 : .85);
    }
    cloud(positions, colors, sizes, opacities);
    cloud(pendingPositions,pendingColors,pendingSizes,pendingOpacities,true);
    const curve = (from, to, tone, cross, lit, related = true) => {
      const a = point(from), b = point(to), c = a.clone().lerp(b, .34), d = a.clone().lerp(b, .72);
      c.y = a.y + (b.y - a.y) * .62; d.y = a.y + (b.y - a.y) * .8;
      const path = new THREE.CubicBezierCurve3(a, c, d, b), samples = path.getSpacedPoints(64);
      const geometry = new THREE.BufferGeometry().setFromPoints(samples);
      geometry.setAttribute('aProgress', new THREE.Float32BufferAttribute(samples.map((_, i) => i / 64), 1));
      const color = new THREE.Color(tone), offset = ((a.x * .013 + b.z * .017 + b.y * .007) % 1 + 1) % 1;
      const speed = 1 / (4.8 + offset * 2.4);
      const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: timeUniform, uColor: { value: color }, uOffset: { value: offset }, uSpeed: { value: speed },
          uBase: { value: highlight&&related ? .5 : lit ? .26 : .12 }, uOpacity:{value:related?1:.075}, uCross: { value: cross ? 1 : 0 }, uMotion: { value: motion?.matches||!lit ? 0 : 1 } },
        vertexShader: `attribute float aProgress; varying float vProgress;
          void main(){vProgress=aProgress;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
        fragmentShader: `uniform float uTime,uOffset,uSpeed,uBase,uCross,uMotion,uOpacity; uniform vec3 uColor; varying float vProgress;
          void main(){
            float head=fract(uTime*uSpeed+uOffset);
            float gap=head-vProgress;
            float trail=step(0.0,gap)*exp(-max(0.0,gap)*22.0)*(1.0-smoothstep(.14,.22,gap));
            float flash=exp(-gap*gap*5625.0);
            float dash=mix(1.0,step(.3,fract(vProgress*16.0)),uCross);
            gl_FragColor=vec4(mix(uColor,vec3(1.0),flash*.35),(uBase*dash+uMotion*(trail*.55+flash*.35))*uOpacity);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      });
      world.add(new THREE.Line(geometry, material));
      flows.push({ path, offset, speed, color,animated:lit, intensity: (lit ? .8 : 0)*(related?1:.075), material });
    };
    for (const e of edges) {
      const a = index.get(e.from), b = index.get(e.to); if (!a || !b) continue;
      const lit=nodeAppearance(a).glow&&nodeAppearance(b).glow;
      curve(a.position, b.position, !lit?UNCONFIRMED_COLOR:a.branch === b.branch ? b.tone || '#75e4df' : '#dfabff', a.branch !== b.branch, lit, !highlight||highlight.edges.has(edgeKey(e)));
    }
    for (const root of roots) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(28, .65, 6, 80), new THREE.MeshBasicMaterial({ color: root.tone, transparent: true, opacity: highlight?(highlight.roots.has(rootKey(root)) ? .8 : .06):.45 }));
      ring.position.copy(point(root.position)); ring.rotation.x = Math.PI / 2; world.add(ring);
      for (const id of root.children) if (index.has(id)){const appearance=nodeAppearance(index.get(id));curve(root.position, index.get(id).position, appearance.color, false, appearance.glow, !highlight||highlight.edges.has(edgeKey(rootEdge(root,id))));}
    }
    for(const area of areas){
      const points=Array.from({length:97},(_,i)=>point([area.position[0]+Math.cos(i*Math.PI/48)*area.radius,180,area.position[2]+Math.sin(i*Math.PI/48)*area.radius]));
      world.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineDashedMaterial({color:area.tone,transparent:true,opacity:.16,dashSize:22,gapSize:28,depthWrite:false})).computeLineDistances());
    }
    // One batched point cloud provides a bright head and a fading tail per edge.
    const particleColors = [], particleSizes = [], particleOpacities = [];
    for (const flow of flows) for (let i = 0; i < 4; i++) {
      particleColors.push(...flow.color.toArray()); particleSizes.push(23 - i * 4); particleOpacities.push(0);
    }
    particles = cloud(new Float32Array(flows.length * 12), particleColors, particleSizes, particleOpacities);
    canvas.dataset.nodeStyle = 'glow-points'; canvas.dataset.flowCount = String(flows.length);
    canvas.dataset.highlightedCount=String(highlight?.nodes.size||0);canvas.dataset.highlightedEdges=String(highlight?.edges.size||0);
    canvas.dataset.pendingNodeCount=String(pendingSizes.length);canvas.dataset.glowingNodeCount=String(sizes.length);canvas.dataset.animatedFlowCount=String(flows.filter(f=>f.animated).length);
  }
  function draw(now, force = false) {
    if (disposed || !ready || (!force && (document.hidden || now - lastFrame < 33))) return;
    lastFrame = now; timeUniform.value = now * .001;
    if (particles) {
      const positions = particles.geometry.attributes.position, opacity = particles.geometry.attributes.aOpacity;
      flows.forEach((flow, i) => {
        const head = (timeUniform.value * flow.speed + flow.offset) % 1;
        flow.material.uniforms.uMotion.value = motion?.matches||!flow.animated ? 0 : 1;
        for (let j = 0; j < 4; j++) {
          const t = head - j * .015, p = flow.path.getPointAt(Math.max(0, t)), slot = i * 4 + j;
          positions.setXYZ(slot, p.x, p.y, p.z);
          const fade = Math.min(1, head * 18, (1 - head) * 18);
          opacity.setX(slot, motion?.matches || !flow.animated || t < 0 ? 0 : flow.intensity * fade * Math.pow(.55, j));
        }
      });
      positions.needsUpdate = true; opacity.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }
  const animate = now => draw(now);
  renderer.setAnimationLoop(animate);
  const lost = event => { event.preventDefault(); renderer.setAnimationLoop(null); onLost?.(); };
  const visibility = () => { renderer.setAnimationLoop(document.hidden || motion?.matches ? null : animate); if (!document.hidden) draw(performance.now(), true); };
  canvas.addEventListener('webglcontextlost', lost); document.addEventListener('visibilitychange', visibility); motion?.addEventListener('change', visibility);
  if (motion?.matches) renderer.setAnimationLoop(null);
  return {
    update({ nodes, edges, roots = [], areas = [], emphasis, selected, camera: view, origin, fit, viewport }) {
      if (disposed) return;
      const next = JSON.stringify([nodes.map(n => [n.id, n.position, n.status, n.tone]), edges, roots, areas, selected, emphasis]);
      if (next !== digest) { build(nodes, edges, roots, selected, areas, emphasis); digest = next; }
      const [width, height] = viewport;
      if (size !== width + ':' + height) { renderer.setSize(width, height, false); size = width + ':' + height; }
      heightUniform.value = height * renderer.getPixelRatio();
      updateMapCamera(camera,view,origin,fit,viewport);
      ready = true; draw(performance.now(), true); canvas.dataset.meshCount = String(nodes.length);
    },
    dispose() {
      disposed = true; renderer.setAnimationLoop(null); canvas.removeEventListener('webglcontextlost', lost);
      document.removeEventListener('visibilitychange', visibility); motion?.removeEventListener('change', visibility);
      release(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}
