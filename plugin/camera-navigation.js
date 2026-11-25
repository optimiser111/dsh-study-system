import { Matrix4 } from 'three';

// Screen-space offsets are normalized to the viewport, so resizing/fullscreen
// preserves the view. Zoom keeps the point beneath the pointer fixed at any depth.
export function zoomCamera(camera, delta, mode = 0, anchor = [.5, .5]) {
  if (!Number.isFinite(delta)) return camera;
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 480 : 1);
  const zoom = Math.max(.35, Math.min(3.5, camera.zoom * Math.exp(-Math.max(-600, Math.min(600, pixels)) * .0015)));
  const ratio = zoom / camera.zoom;
  if (ratio === 1) return camera;
  return { ...camera, zoom,
    panX: (camera.panX || 0) * ratio + (anchor[0] - .5) * (1 - ratio),
    panY: (camera.panY || 0) * ratio + (anchor[1] - .5) * (1 - ratio) };
}
export function panCamera(camera, dx, dy, viewport) {
  if (!viewport?.every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return camera;
  return { ...camera, panX: (camera.panX || 0) + dx / viewport[0], panY: (camera.panY || 0) + dy / viewport[1] };
}
export function pointerAnchor(element, event) {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return [.5, .5];
  try {
    const matrix = element.getScreenCTM?.(), box = element.viewBox?.baseVal;
    if (matrix && box?.width > 0 && box.height > 0 && element.createSVGPoint) {
      const point = element.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      return [(local.x - box.x) / box.width, (local.y - box.y) / box.height];
    }
  } catch { /* A detached SVG can temporarily have no invertible screen matrix. */ }
  const box = element.getBoundingClientRect?.();
  return box?.width > 0 && box.height > 0 ? [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height] : [.5, .5];
}

export function updateMapCamera(camera, view, origin, fit, viewport) {
  const [width,height]=viewport,distance=view.distance||900;
  camera.aspect=width/height;
  camera.fov=2*Math.atan(height/(2*distance*fit*view.zoom))*180/Math.PI;
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[8]-=2*(view.panX||0);
  camera.projectionMatrix.elements[9]+=2*(view.panY||0);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  const cy=Math.cos(view.yaw),sy=Math.sin(view.yaw),cp=Math.cos(view.pitch),sp=Math.sin(view.pitch);
  const matrix=new Matrix4().set(cy,0,-sy,0,-sy*sp,cp,-cy*sp,0,sy*cp,sp,cy*cp,-distance,0,0,0,1);
  matrix.multiply(new Matrix4().makeTranslation(-origin[0],origin[1],origin[2]));
  camera.matrixWorld.copy(matrix).invert();camera.matrixWorldInverse.copy(matrix);
}
