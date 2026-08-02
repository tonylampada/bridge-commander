import { Matrix4, Plane, Quaternion, Raycaster, Vector3, Vector2, Mesh, } from 'three';
import { computeIntersectionWorldPlane, getDominantIntersectionIndex, pushTimes, voidObjectIntersectionFromRay, } from './utils.js';
import { getClosestUV, updateAndCheckWorldTransformation } from '../utils.js';
const invertedMatrixHelper = new Matrix4();
const scaleHelper = new Vector3();
const NegZAxis = new Vector3(0, 0, -1);
const planeHelper = new Plane();
const point2Helper = new Vector2();
export class RayIntersector {
    space;
    options;
    raycaster = new Raycaster();
    raycasterQuaternion = new Quaternion();
    worldScale = 0;
    ready;
    intersects = [];
    pointerEventsOrders = [];
    constructor(space, options) {
        this.space = space;
        this.options = options;
    }
    isReady() {
        return this.ready ?? this.prepareTransformation();
    }
    prepareTransformation() {
        const spaceObject = this.space.current;
        if (spaceObject == null) {
            return (this.ready = false);
        }
        this.ready = updateAndCheckWorldTransformation(spaceObject);
        if (!this.ready) {
            return false;
        }
        spaceObject.matrixWorld.decompose(this.raycaster.ray.origin, this.raycasterQuaternion, scaleHelper);
        this.worldScale = scaleHelper.x;
        this.raycaster.ray.direction.copy(this.options?.direction ?? NegZAxis).applyQuaternion(this.raycasterQuaternion);
        return true;
    }
    intersectPointerCapture({ intersection, object }) {
        if (intersection.details.type != 'ray') {
            throw new Error(`unable to process a pointer capture of type "${intersection.details.type}" with a ray intersector`);
        }
        if (!this.prepareTransformation()) {
            return intersection;
        }
        intersection.object.updateWorldMatrix(true, false);
        computeIntersectionWorldPlane(planeHelper, intersection, intersection.object.matrixWorld);
        const { ray } = this.raycaster;
        const pointOnFace = ray.intersectPlane(planeHelper, new Vector3()) ?? intersection.point;
        const point = ray.direction
            .clone()
            .multiplyScalar(intersection.pointerPosition.distanceTo(intersection.point))
            .add(ray.origin);
        let uv = intersection.uv;
        if (intersection.object instanceof Mesh && getClosestUV(point2Helper, point, intersection.object)) {
            uv = point2Helper.clone();
        }
        return {
            ...intersection,
            uv,
            object,
            pointOnFace,
            point,
            pointerPosition: ray.origin.clone(),
            pointerQuaternion: this.raycasterQuaternion.clone(),
        };
    }
    startIntersection() {
        this.prepareTransformation();
    }
    executeIntersection(object, objectPointerEventsOrder) {
        if (!this.isReady()) {
            return;
        }
        const start = this.intersects.length;
        object.raycast(this.raycaster, this.intersects);
        pushTimes(this.pointerEventsOrders, objectPointerEventsOrder, this.intersects.length - start);
    }
    finalizeIntersection(scene) {
        const pointerPosition = this.raycaster.ray.origin.clone();
        const pointerQuaternion = this.raycasterQuaternion.clone();
        let filter;
        if (this.options.minDistance != null) {
            const localMinDistance = this.options.minDistance / this.worldScale;
            filter = (intersection) => intersection.distance >= localMinDistance;
        }
        const index = getDominantIntersectionIndex(this.intersects, this.pointerEventsOrders, this.options, filter);
        const intersection = index == null ? undefined : this.intersects[index];
        this.intersects.length = 0;
        this.pointerEventsOrders.length = 0;
        if (intersection == null) {
            return voidObjectIntersectionFromRay(scene, this.raycaster.ray, () => ({ type: 'ray' }), pointerPosition, pointerQuaternion);
        }
        intersection.object.updateWorldMatrix(true, false);
        return Object.assign(intersection, {
            details: {
                type: 'ray',
            },
            pointerPosition,
            pointerQuaternion,
            pointOnFace: intersection.point,
            localPoint: intersection.point
                .clone()
                .applyMatrix4(invertedMatrixHelper.copy(intersection.object.matrixWorld).invert()),
        });
    }
}
const directionHelper = new Vector3();
export class ScreenRayIntersector {
    prepareTransformation;
    options;
    raycaster = new Raycaster();
    cameraQuaternion = new Quaternion();
    fromPosition = new Vector3();
    fromQuaternion = new Quaternion();
    coords = new Vector2();
    viewPlane = new Plane();
    intersects = [];
    pointerEventsOrders = [];
    constructor(prepareTransformation, options) {
        this.prepareTransformation = prepareTransformation;
        this.options = options;
    }
    isReady() {
        return true;
    }
    intersectPointerCapture({ intersection, object }, nativeEvent) {
        const details = intersection.details;
        if (details.type != 'screen-ray') {
            throw new Error(`unable to process a pointer capture of type "${intersection.details.type}" with a camera ray intersector`);
        }
        if (!this.startIntersection(nativeEvent)) {
            return intersection;
        }
        this.viewPlane.constant -= details.distanceViewPlane;
        //find captured intersection point by intersecting the ray to the plane of the camera
        const point = this.raycaster.ray.intersectPlane(this.viewPlane, new Vector3());
        if (point == null) {
            return intersection;
        }
        intersection.object.updateWorldMatrix(true, false);
        computeIntersectionWorldPlane(this.viewPlane, intersection, intersection.object.matrixWorld);
        let uv = intersection.uv;
        if (intersection.object instanceof Mesh && getClosestUV(point2Helper, point, intersection.object)) {
            uv = point2Helper.clone();
        }
        return {
            ...intersection,
            details: {
                ...details,
                direction: this.raycaster.ray.direction.clone(),
                screenPoint: this.coords.clone(),
            },
            uv,
            object,
            point,
            pointOnFace: point,
            pointerPosition: this.raycaster.ray.origin.clone(),
            pointerQuaternion: this.cameraQuaternion.clone(),
        };
    }
    startIntersection(nativeEvent) {
        const from = this.prepareTransformation(nativeEvent, this.coords);
        if (from == null) {
            return false;
        }
        from.updateWorldMatrix(true, false);
        from.matrixWorld.decompose(this.fromPosition, this.fromQuaternion, scaleHelper);
        this.raycaster.setFromCamera(this.coords, from);
        this.viewPlane.setFromNormalAndCoplanarPoint(from.getWorldDirection(directionHelper), this.raycaster.ray.origin);
        return true;
    }
    executeIntersection(object, objectPointerEventsOrder) {
        const start = this.intersects.length;
        object.raycast(this.raycaster, this.intersects);
        pushTimes(this.pointerEventsOrders, objectPointerEventsOrder, this.intersects.length - start);
    }
    finalizeIntersection(scene) {
        const pointerPosition = this.fromPosition.clone();
        const pointerQuaternion = this.cameraQuaternion.clone();
        const pointerDirection = this.raycaster.ray.direction.clone();
        const index = getDominantIntersectionIndex(this.intersects, this.pointerEventsOrders, this.options);
        const intersection = index == null ? undefined : this.intersects[index];
        this.intersects.length = 0;
        this.pointerEventsOrders.length = 0;
        if (intersection == null) {
            return voidObjectIntersectionFromRay(scene, this.raycaster.ray, (_point, distance) => ({
                type: 'screen-ray',
                distanceViewPlane: distance,
                screenPoint: this.coords.clone(),
                direction: pointerDirection,
            }), pointerPosition, pointerQuaternion);
        }
        intersection.object.updateWorldMatrix(true, false);
        invertedMatrixHelper.copy(intersection.object.matrixWorld).invert();
        return Object.assign(intersection, {
            details: {
                type: 'screen-ray',
                distanceViewPlane: this.viewPlane.distanceToPoint(intersection.point),
                screenPoint: this.coords.clone(),
                direction: pointerDirection,
            },
            pointOnFace: intersection.point,
            pointerPosition,
            pointerQuaternion,
            localPoint: intersection.point.clone().applyMatrix4(invertedMatrixHelper),
        });
    }
}
