import { Matrix4, Sphere, Vector2, Vector3 } from 'three';
import { clamp } from 'three/src/math/MathUtils.js';
import { computeWorldToGlobalMatrix } from '../../utils.js';
const sphereHelper = new Sphere();
const vectorHelper = new Vector3();
const matrixHelper = new Matrix4();
const worldToGlobalMatrixHelper = new Matrix4();
export function makePanelSpherecast(root, globalSphereWithLocalScale, globalPanelMatrixSignal, object) {
    return (sphere, intersects) => {
        root.peek().component.updateMatrix();
        computeWorldToGlobalMatrix(root.peek(), worldToGlobalMatrixHelper);
        sphereHelper.copy(globalSphereWithLocalScale).applyMatrix4(worldToGlobalMatrixHelper);
        if (!sphereHelper.intersectsSphere(sphere)) {
            return;
        }
        object.updateMatrixWorld(true);
        vectorHelper.copy(sphere.center).applyMatrix4(matrixHelper.copy(object.matrixWorld).invert());
        vectorHelper.x = clamp(vectorHelper.x, -0.5, 0.5);
        vectorHelper.y = clamp(vectorHelper.y, -0.5, 0.5);
        vectorHelper.z = 0;
        const uv = new Vector2(vectorHelper.x, vectorHelper.y);
        vectorHelper.applyMatrix4(object.matrixWorld);
        const distance = sphere.center.distanceTo(vectorHelper);
        if (distance > sphere.radius) {
            return;
        }
        intersects.push({
            distance,
            object,
            point: vectorHelper.clone(),
            uv,
            normal: new Vector3(0, 0, 1),
        });
    };
}
