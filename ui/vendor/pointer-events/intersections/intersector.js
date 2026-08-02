import { Mesh, SphereGeometry } from 'three';
const VoidObjectRadius = 10000000000;
const VoidObjectGeometry = new SphereGeometry(VoidObjectRadius);
const sceneVoidObjectMap = new Map();
export function getVoidObject(scene) {
    let entry = sceneVoidObjectMap.get(scene);
    if (entry == null) {
        entry = new Mesh(VoidObjectGeometry);
        entry.isVoidObject = true;
        entry.parent = scene;
        //makes sure all other intersections are always prioritized
        entry.pointerEventsOrder = -Infinity;
        sceneVoidObjectMap.set(scene, entry);
    }
    return entry;
}
