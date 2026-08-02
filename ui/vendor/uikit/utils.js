import { computed, effect, Signal } from '@preact/signals-core';
import { addActiveHandlers } from './active.js';
import { addHoverHandlers } from './hover.js';
import { Component } from './components/component.js';
import { writeColor } from './panel/material/color.js';
import { parseNumberValue, parseAbsoluteLengthValue } from './properties/values.js';
export function searchFor(from, _class, maxSteps, allowNonUikit = false) {
    if (from instanceof _class) {
        return from;
    }
    let parent;
    if (from instanceof Component) {
        parent = from.parentContainer.value;
    }
    if (allowNonUikit) {
        parent ??= from.parent;
    }
    if (maxSteps === 0 || parent == null) {
        return undefined;
    }
    return searchFor(parent, _class, maxSteps - 1, allowNonUikit);
}
export function computedGlobalMatrix(parentMatrix, localMatrix) {
    return computed(() => {
        const local = localMatrix.value;
        const parent = parentMatrix.value;
        if (local == null || parent == null) {
            return undefined;
        }
        return parent.clone().multiply(local);
    });
}
export function computedIsVisible(component, isClipped, properties) {
    return computed(() => component.displayed.value &&
        (isClipped == null || !isClipped?.value) &&
        properties.value.visibility === 'visible');
}
export function loadResourceWithParams(target, fn, cleanup, abortSignal, param, ...additionals) {
    abortableEffect(() => {
        let canceled = false;
        let current;
        fn(readReactive(param), ...additionals)
            .then((value) => {
            if (!canceled) {
                target.value = current = value;
            }
        })
            .catch(console.error);
        return () => {
            canceled = true;
            if (current != null && cleanup != null) {
                cleanup(current);
            }
        };
    }, abortSignal);
}
const eventHandlerKeys = [
    'onClick',
    'onContextMenu',
    'onDblClick',
    'onPointerCancel',
    'onPointerDown',
    'onPointerEnter',
    'onPointerLeave',
    'onPointerMove',
    'onPointerOut',
    'onPointerOver',
    'onPointerUp',
    'onWheel',
];
export function computedHandlers(properties, starProperties, hoveredSignal, activeSignal, dynamicHandlers) {
    return computed(() => {
        if (!properties.enabled.value) {
            return {};
        }
        const handlers = {};
        for (const key of eventHandlerKeys) {
            const handler = properties.value[key];
            if (handler != null) {
                handlers[key] = handler;
            }
        }
        addHandlers(handlers, dynamicHandlers?.value);
        addHoverHandlers(handlers, properties, hoveredSignal, properties.usedConditionals.hover, starProperties.usedConditionals.hover);
        addActiveHandlers(handlers, properties, activeSignal, properties.usedConditionals.active, starProperties.usedConditionals.active);
        return handlers;
    });
}
export function computedAncestorsHaveListeners(parent, handlers) {
    return computed(() => (parent.value?.ancestorsHaveListenersSignal.value ?? false) || Object.keys(handlers.value).length > 0);
}
export function addHandlers(target, handlers) {
    for (const key in handlers) {
        addHandler(key, target, handlers[key]);
    }
}
export function addHandler(key, target, handler) {
    if (handler == null) {
        return;
    }
    const existingHandler = target[key];
    if (existingHandler == null) {
        target[key] = handler;
        return;
    }
    target[key] = ((e) => {
        existingHandler(e);
        handler(e);
    });
}
export function setupMatrixWorldUpdate(component, rootSignal, globalPanelMatrixSignal, abortSignal) {
    if (globalPanelMatrixSignal != null && !abortSignal.aborted) {
        const unsubscribe = globalPanelMatrixSignal.subscribe(() => {
            rootSignal.peek().requestRender?.();
        });
        abortSignal.addEventListener('abort', unsubscribe);
    }
    abortableEffect(() => {
        const root = rootSignal.value;
        if (root.component === component) {
            return;
        }
        const updateMatrixWorld = component.updateWorldMatrix.bind(component, false, true);
        root.onUpdateMatrixWorldSet.add(updateMatrixWorld);
        return () => root.onUpdateMatrixWorldSet.delete(updateMatrixWorld);
    }, abortSignal);
}
export function setupPointerEvents(component, canHaveNonUikitChildren) {
    component.defaultPointerEvents = 'auto';
    abortableEffect(() => {
        component.ancestorsHaveListeners = component.ancestorsHaveListenersSignal.value;
        component.pointerEvents = component.isVisible.value ? component.properties.value.pointerEvents : 'none';
        component.pointerEventsOrder = parseNumberValue(component.properties.value.pointerEventsOrder ?? 0);
        component.pointerEventsType = component.properties.value.pointerEventsType;
    }, component.abortSignal);
    abortableEffect(() => {
        if (!component.properties.enabled.value) {
            return;
        }
        const rootComponent = component.root.value.component;
        component.intersectChildren = canHaveNonUikitChildren || rootComponent === component;
        if (!canHaveNonUikitChildren && component.properties.value.pointerEvents === 'none') {
            return;
        }
        if (rootComponent === component) {
            //we must not add the component itself to its interactable descendants
            return;
        }
        rootComponent.interactableDescendants ??= [];
        const interactableDescendants = rootComponent.interactableDescendants;
        interactableDescendants.push(component);
        return () => {
            const index = interactableDescendants.indexOf(component);
            if (index === -1) {
                return;
            }
            interactableDescendants.splice(index, 1);
        };
    }, component.abortSignal);
}
export function abortableEffect(fn, abortSignal) {
    if (abortSignal.aborted) {
        return;
    }
    const unsubscribe = effect(fn);
    abortSignal.addEventListener('abort', unsubscribe);
}
export const alignmentXMap = { left: 0.5, center: 0, middle: 0, right: -0.5 };
export const alignmentYMap = { top: -0.5, center: 0, middle: 0, bottom: 0.5 };
export const alignmentZMap = { back: -0.5, center: 0, middle: 0, front: 0.5 };
/**
 * calculates the offsetX, offsetY, and scale to fit content with size [aspectRatio, 1] inside
 */
export function fitNormalizedContentInside(offsetTarget, scaleTarget, size, paddingInset, borderInset, pixelSize, aspectRatio) {
    const sizeValue = size.value;
    const paddingInsetValue = paddingInset.value;
    const borderInsetValue = borderInset.value;
    if (sizeValue == null || paddingInsetValue == null || borderInsetValue == null) {
        return;
    }
    const [width, height] = sizeValue;
    const [pTop, pRight, pBottom, pLeft] = paddingInsetValue;
    const [bTop, bRight, bBottom, bLeft] = borderInsetValue;
    const topInset = pTop + bTop;
    const rightInset = pRight + bRight;
    const bottomInset = pBottom + bBottom;
    const leftInset = pLeft + bLeft;
    offsetTarget.set((leftInset - rightInset) * 0.5 * pixelSize, (bottomInset - topInset) * 0.5 * pixelSize, 0);
    const innerWidth = width - leftInset - rightInset;
    const innerHeight = height - topInset - bottomInset;
    const flexRatio = innerWidth / innerHeight;
    if (flexRatio > aspectRatio) {
        scaleTarget.setScalar(innerHeight * pixelSize);
        return;
    }
    scaleTarget.setScalar((innerWidth * pixelSize) / aspectRatio);
}
export function readReactive(value) {
    value = value instanceof Signal ? value.value : value;
    if (value === 'initial') {
        return undefined;
    }
    return value;
}
export function computedBorderInset(properties, keys) {
    return computed(() => keys.map((key) => {
        const value = properties.value[key];
        return value == null ? 0 : parseAbsoluteLengthValue(value);
    }));
}
export function withOpacity(value, opacity) {
    return computed(() => {
        const result = [0, 0, 0, 0];
        writeColor(result, 0, readReactive(value), readReactive(opacity));
        return result;
    });
}
/**
 * assumes component.root.component.parent.matrixWorld and component.root.component.matrix is updated
 */
export function computeWorldToGlobalMatrix(root, target) {
    const rootComponent = root.component;
    if (rootComponent.parent == null) {
        target.copy(rootComponent.matrix);
        return;
    }
    target.multiplyMatrices(rootComponent.parent.matrixWorld, rootComponent.matrix);
}
