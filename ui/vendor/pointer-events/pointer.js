import { Object3D } from 'three';
import { PointerEvent, WheelEvent, emitPointerEvent } from './event.js';
import { intersectPointerEventTargets } from './intersections/utils.js';
const buttonsDownTimeKey = Symbol('buttonsDownTime');
const buttonsClickTimeKey = Symbol('buttonsClickTime');
globalThis.pointerEventspointerMap ??= new Map();
Object3D.prototype.setPointerCapture = function (pointerId) {
    getPointerById(pointerId)?.setCapture(this);
};
Object3D.prototype.releasePointerCapture = function (pointerId) {
    const pointer = getPointerById(pointerId);
    if (pointer == null || !pointer.hasCaptured(this)) {
        return;
    }
    pointer.setCapture(undefined);
};
Object3D.prototype.hasPointerCapture = function (pointerId) {
    return getPointerById(pointerId)?.hasCaptured(this) ?? false;
};
export function getPointerById(pointerId) {
    return globalThis.pointerEventspointerMap?.get(pointerId);
}
export class Pointer {
    id;
    type;
    state;
    intersector;
    getCamera;
    onMoveCommited;
    parentSetPointerCapture;
    parentReleasePointerCapture;
    options;
    //state
    prevIntersection;
    intersection;
    prevEnabled = true;
    enabled = true;
    wheelIntersection;
    //derived state
    /**
     * ordered leaf -> root (bottom -> top)
     */
    pointerEntered = [];
    pointerEnteredHelper = [];
    pointerCapture;
    buttonsDownTime = new Map();
    buttonsDown = new Set();
    //to handle interaction before first move (after exit)
    wasMoved = false;
    onFirstMove = [];
    constructor(id, type, state, intersector, getCamera, onMoveCommited, parentSetPointerCapture, parentReleasePointerCapture, options = {}) {
        this.id = id;
        this.type = type;
        this.state = state;
        this.intersector = intersector;
        this.getCamera = getCamera;
        this.onMoveCommited = onMoveCommited;
        this.parentSetPointerCapture = parentSetPointerCapture;
        this.parentReleasePointerCapture = parentReleasePointerCapture;
        this.options = options;
        globalThis.pointerEventspointerMap?.set(id, this);
    }
    getPointerCapture() {
        return this.pointerCapture;
    }
    hasCaptured(object) {
        return this.pointerCapture?.object === object;
    }
    setCapture(object) {
        if (this.pointerCapture?.object === object) {
            return;
        }
        this.clearPointerCapture();
        if (object != null && this.intersection != null) {
            this.pointerCapture = { object, intersection: this.intersection };
            this.parentSetPointerCapture?.();
        }
    }
    getButtonsDown() {
        return this.buttonsDown;
    }
    /**
     * @returns undefined if no intersection was executed yet
     */
    getIntersection() {
        return this.intersection;
    }
    getEnabled() {
        return this.enabled;
    }
    setEnabled(enabled, nativeEvent, commit = true) {
        if (this.enabled === enabled) {
            return;
        }
        if (!enabled && this.pointerCapture != null) {
            this.clearPointerCapture();
        }
        this.enabled = enabled;
        if (commit) {
            this.commit(nativeEvent, false);
        }
    }
    computeIntersection(type, scene, nativeEvent) {
        if (this.pointerCapture != null) {
            return this.intersector.intersectPointerCapture(this.pointerCapture, nativeEvent);
        }
        this.intersector.startIntersection(nativeEvent);
        intersectPointerEventTargets(type, scene, [this]);
        return this.intersector.finalizeIntersection(scene);
    }
    setIntersection(intersection) {
        this.intersection = intersection;
    }
    commit(nativeEvent, emitMove) {
        const camera = this.getCamera();
        const prevIntersection = this.prevEnabled ? this.prevIntersection : undefined;
        const intersection = this.enabled ? this.intersection : undefined;
        //pointer out
        if (prevIntersection != null && prevIntersection.object != intersection?.object) {
            emitPointerEvent(new PointerEvent('pointerout', true, nativeEvent, this, prevIntersection, camera));
        }
        const pointerLeft = this.pointerEntered;
        this.pointerEntered = [];
        this.pointerEnteredHelper.length = 0;
        computeEnterLeave(intersection?.object, this.pointerEntered, pointerLeft, this.pointerEnteredHelper);
        //pointerleave
        const length = pointerLeft.length;
        for (let i = 0; i < length; i++) {
            const object = pointerLeft[i];
            emitPointerEvent(new PointerEvent('pointerleave', false, nativeEvent, this, prevIntersection, camera, object));
        }
        //pointer over
        if (intersection != null && prevIntersection?.object != intersection.object) {
            emitPointerEvent(new PointerEvent('pointerover', true, nativeEvent, this, intersection, camera));
        }
        //pointer enter
        //inverse loop so that we emit enter from top -> bottom (root -> leaf)
        for (let i = this.pointerEnteredHelper.length - 1; i >= 0; i--) {
            const object = this.pointerEnteredHelper[i];
            emitPointerEvent(new PointerEvent('pointerenter', false, nativeEvent, this, intersection, camera, object));
        }
        //pointer move
        if (emitMove && intersection != null) {
            emitPointerEvent(new PointerEvent('pointermove', true, nativeEvent, this, intersection, camera));
        }
        this.prevIntersection = this.intersection;
        this.prevEnabled = this.enabled;
        if (!this.wasMoved && this.intersector.isReady()) {
            this.wasMoved = true;
            const length = this.onFirstMove.length;
            for (let i = 0; i < length; i++) {
                this.onFirstMove[i](camera);
            }
            this.onFirstMove.length = 0;
        }
        this.onMoveCommited?.(this);
    }
    /**
     * computes and commits a move
     */
    move(scene, nativeEvent) {
        this.intersection = this.computeIntersection('pointer', scene, nativeEvent);
        this.commit(nativeEvent, true);
    }
    /**
     * computes and commits the pointer if a move has not yet occured
     */
    over(scene, nativeEvent) {
        if (!this.wasMoved) {
            this.intersection = this.computeIntersection('pointer', scene, nativeEvent);
            this.commit(nativeEvent, false);
        }
    }
    /**
     * emits a move without (re-)computing the intersection
     * just emitting a move event to the current intersection
     */
    emitMove(nativeEvent) {
        if (this.intersection == null) {
            return;
        }
        emitPointerEvent(new PointerEvent('pointermove', true, nativeEvent, this, this.intersection, this.getCamera()));
    }
    down(nativeEvent) {
        this.buttonsDown.add(nativeEvent.button);
        if (!this.enabled) {
            return;
        }
        if (!this.wasMoved) {
            this.onFirstMove.push(this.down.bind(this, nativeEvent));
            return;
        }
        if (this.intersection == null) {
            return;
        }
        //pointer down
        emitPointerEvent(new PointerEvent('pointerdown', true, nativeEvent, this, this.intersection, this.getCamera()));
        //store button down times on object and on pointer
        const { object } = this.intersection;
        object[buttonsDownTimeKey] ??= new Map();
        object[buttonsDownTimeKey].set(nativeEvent.button, nativeEvent.timeStamp);
        this.buttonsDownTime.set(nativeEvent.button, nativeEvent.timeStamp);
    }
    up(nativeEvent) {
        this.buttonsDown.delete(nativeEvent.button);
        if (!this.enabled) {
            return;
        }
        if (!this.wasMoved) {
            this.onFirstMove.push(this.up.bind(this, nativeEvent));
            return;
        }
        if (this.intersection == null) {
            return;
        }
        const { clickThesholdMs, contextMenuButton = 2, dblClickThresholdMs = 500, clickThresholdMs = clickThesholdMs ?? 300, } = this.options;
        this.clearPointerCapture();
        const isClicked = getIsClicked(this.buttonsDownTime, this.intersection.object[buttonsDownTimeKey], nativeEvent.button, nativeEvent.timeStamp, clickThresholdMs);
        const camera = this.getCamera();
        //context menu
        if (isClicked && nativeEvent.button === contextMenuButton) {
            emitPointerEvent(new PointerEvent('contextmenu', true, nativeEvent, this, this.intersection, camera));
        }
        //poinerup
        emitPointerEvent(new PointerEvent('pointerup', true, nativeEvent, this, this.intersection, camera));
        if (!isClicked || nativeEvent.button === contextMenuButton) {
            return;
        }
        //click
        emitPointerEvent(new PointerEvent('click', true, nativeEvent, this, this.intersection, camera));
        //dblclick
        const { object } = this.intersection;
        const buttonsClickTime = (object[buttonsClickTimeKey] ??= new Map());
        const buttonClickTime = buttonsClickTime.get(nativeEvent.button);
        if (buttonClickTime == null || nativeEvent.timeStamp - buttonClickTime > dblClickThresholdMs) {
            buttonsClickTime.set(nativeEvent.button, nativeEvent.timeStamp);
            return;
        }
        emitPointerEvent(new PointerEvent('dblclick', true, nativeEvent, this, this.intersection, camera));
        buttonsClickTime.delete(nativeEvent.button);
    }
    cancel(nativeEvent) {
        this.buttonsDown.clear();
        this.buttonsDownTime.clear();
        this.clearPointerCapture();
        this.onFirstMove.length = 0;
        if (!this.enabled || !this.wasMoved || this.intersection == null) {
            return;
        }
        //pointer cancel
        emitPointerEvent(new PointerEvent('pointercancel', true, nativeEvent, this, this.intersection, this.getCamera()));
    }
    wheel(scene, nativeEvent, useMoveIntersection = false) {
        if (!this.enabled) {
            return;
        }
        if (!this.wasMoved && useMoveIntersection) {
            this.onFirstMove.push(this.wheel.bind(this, scene, nativeEvent, useMoveIntersection));
            return;
        }
        if (!useMoveIntersection) {
            this.wheelIntersection = this.computeIntersection('wheel', scene, nativeEvent);
        }
        const intersection = useMoveIntersection ? this.intersection : this.wheelIntersection;
        if (intersection == null) {
            return;
        }
        //wheel
        emitPointerEvent(new WheelEvent(nativeEvent, this, intersection, this.getCamera()));
    }
    emitWheel(nativeEvent, useMoveIntersection = false) {
        if (!this.enabled) {
            return;
        }
        if (!this.wasMoved && useMoveIntersection) {
            this.onFirstMove.push(this.emitWheel.bind(this, nativeEvent, useMoveIntersection));
            return;
        }
        const intersection = useMoveIntersection ? this.intersection : this.wheelIntersection;
        if (intersection == null) {
            return;
        }
        //wheel
        emitPointerEvent(new WheelEvent(nativeEvent, this, intersection, this.getCamera()));
    }
    exit(nativeEvent) {
        if (this.buttonsDown.size > 0 || this.pointerCapture != null) {
            this.cancel(nativeEvent);
        }
        if (this.wasMoved) {
            //reset state
            this.intersection = undefined;
            this.commit(nativeEvent, false);
        }
        this.onFirstMove.length = 0;
        this.wasMoved = false;
    }
    clearPointerCapture() {
        if (this.pointerCapture == null) {
            return;
        }
        this.parentReleasePointerCapture?.();
        this.pointerCapture = undefined;
    }
}
/**
 * @returns an array that contains the object and all its ancestors ordered leaf -> root (bottom -> top)
 */
function computeEnterLeave(currentObject, targetAllAncestors, targeDiffRemovedAncestors, targetDiffAddedAncestors) {
    if (currentObject == null) {
        return;
    }
    const index = targeDiffRemovedAncestors.indexOf(currentObject);
    if (index != -1) {
        targeDiffRemovedAncestors.splice(index, 1);
    }
    else {
        targetDiffAddedAncestors.push(currentObject);
    }
    targetAllAncestors.push(currentObject);
    computeEnterLeave(currentObject.parent, targetAllAncestors, targeDiffRemovedAncestors, targetDiffAddedAncestors);
}
function getIsClicked(pointerButtonsPressTime, objectButtonsDownTime, button, buttonUpTime, clickThresholdMs) {
    if (objectButtonsDownTime == null) {
        return false;
    }
    const objectButtonPressTime = objectButtonsDownTime.get(button);
    if (objectButtonPressTime == null) {
        return false;
    }
    if (buttonUpTime - objectButtonPressTime > clickThresholdMs) {
        return false;
    }
    if (objectButtonPressTime != pointerButtonsPressTime.get(button)) {
        //we have released the button somewhere else
        return false;
    }
    return true;
}
