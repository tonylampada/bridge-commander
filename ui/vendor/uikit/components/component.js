import { batch, computed, signal } from '@preact/signals-core';
import { Matrix4, Mesh, Sphere, } from 'three';
import { abortableEffect, computedAncestorsHaveListeners, computedGlobalMatrix, computedHandlers, computedIsVisible, computeWorldToGlobalMatrix, setupPointerEvents, } from '../utils.js';
import { computedPanelMatrix, InstancedPanelMesh, makeClippedCast, makePanelSpherecast, panelGeometry, setupBoundingSphere, } from '../panel/index.js';
import { Overflow } from 'yoga-layout/load';
import { computedIsClipped } from '../clipping.js';
import { FlexNode } from '../flex/node.js';
import { allAliases } from '../properties/alias.js';
import { createConditionals } from '../properties/conditional.js';
import { PropertiesImplementation, } from '../properties/index.js';
import { computedTransformMatrix } from '../transform.js';
import { setupCursorCleanup } from '../hover.js';
import { ClassList, getStarProperties, StyleSheet } from './classes.js';
import { InstancedGlyphMesh } from '../text/index.js';
import { buildRootContext, buildRootMatrix } from '../context.js';
import { inheritedPropertyKeys } from '../properties/inheritance.js';
import { componentDefaults } from '../properties/defaults.js';
import { getLayerIndex } from '../properties/layer.js';
import { parseNumberValue, parseAbsoluteLengthValue } from '../properties/values.js';
const IdentityMatrix = new Matrix4();
const sphereHelper = new Sphere();
const worldToGlobalMatrixHelper = new Matrix4();
const returnFalseFunction = () => false;
let currentGlobalProperties;
const baseLayerIndex = getLayerIndex({ type: 'base', section: 'base' });
export function resetGlobalProperties(properties) {
    currentGlobalProperties = properties;
    globalProperties.setLayer(baseLayerIndex, currentGlobalProperties);
}
export function setGlobalProperties(properties) {
    resetGlobalProperties({
        ...properties,
        ...currentGlobalProperties,
    });
}
const globalProperties = new PropertiesImplementation(allAliases, new Proxy({}, { get: () => returnFalseFunction }));
globalProperties.setEnabled(true);
export class Component extends Mesh {
    inputProperties;
    initialClasses;
    abortController = new AbortController();
    handlers;
    orderInfo = signal(undefined);
    isVisible;
    isClipped;
    boundingSphere = new Sphere();
    /**
     * the properties of the this component
     * e.g. get the final computed backgroundColor using `component.properties.value.backgroundColor`
     */
    properties;
    starProperties;
    node;
    size = signal(undefined);
    relativeCenter = signal(undefined);
    borderInset = signal(undefined);
    overflow = signal(Overflow.Visible);
    displayed = signal(false);
    scrollable = signal([false, false]);
    paddingInset = signal(undefined);
    maxScrollPosition = signal([undefined, undefined]);
    root;
    parentContainer = signal(undefined);
    isAttached = signal(false);
    isRootAttached = computed(() => this.parentContainer.value?.isRootAttached.value ?? this.isAttached.value);
    hoveredList = signal([]);
    activeList = signal([]);
    ancestorsHaveListenersSignal;
    globalMatrix;
    globalPanelMatrix;
    abortSignal = this.abortController.signal;
    classList;
    needsRenderTraversal;
    renderTraversalChildCount = signal(0);
    constructor(inputProperties, initialClasses, config) {
        super(panelGeometry, config?.material);
        this.inputProperties = inputProperties;
        this.initialClasses = initialClasses;
        this.matrixAutoUpdate = false;
        //setting up the parent signal
        const updateParentState = () => {
            batch(() => {
                const isAttached = this.parent != null;
                this.parentContainer.value = this.parent instanceof Component ? this.parent : undefined;
                this.isAttached.value = isAttached;
            });
        };
        this.addEventListener('added', updateParentState);
        this.addEventListener('removed', updateParentState);
        this.root = buildRootContext(this, config?.renderContext);
        //properties
        const conditionals = createConditionals(this.root, this.hoveredList, this.activeList, config?.hasFocus, config?.isPlaceholder);
        this.properties = new PropertiesImplementation(allAliases, conditionals, config?.defaults ?? componentDefaults);
        this.properties.setLayersWithConditionals({ type: 'default-overrides' }, {
            width: computed(() => {
                const sizeX = this.properties.value.sizeX;
                if (sizeX == null) {
                    return undefined;
                }
                return parseAbsoluteLengthValue(sizeX) / parseNumberValue(this.properties.value.pixelSize);
            }),
            height: computed(() => {
                const sizeY = this.properties.value.sizeY;
                if (sizeY == null) {
                    return undefined;
                }
                return parseAbsoluteLengthValue(sizeY) / parseNumberValue(this.properties.value.pixelSize);
            }),
            ...config?.defaultOverrides,
        });
        abortableEffect(() => {
            if (!this.properties.enabled.value) {
                return;
            }
            const parentProprties = this.parentContainer.value?.properties;
            const layerIndex = getLayerIndex({ type: 'inheritance' });
            const cleanup = parentProprties?.subscribePropertyKeys((key) => {
                if (!inheritedPropertyKeys.includes(key)) {
                    return;
                }
                const signal = parentProprties.signal[key];
                this.properties.set(layerIndex, key, signal);
            });
            return () => {
                cleanup?.();
                this.properties.setLayer(layerIndex, undefined);
            };
        }, this.abortSignal);
        this.starProperties = new PropertiesImplementation(allAliases, conditionals);
        this.starProperties.setLayersWithConditionals({ type: 'default-overrides' }, getStarProperties(config?.defaultOverrides));
        abortableEffect(() => {
            const isRootAttached = this.isRootAttached.value;
            this.properties.setEnabled(isRootAttached);
            this.starProperties.setEnabled(isRootAttached);
        }, this.abortSignal);
        abortableEffect(() => {
            if (!this.properties.enabled.value || !this.starProperties.enabled.value) {
                return;
            }
            const parentStarProprties = this.parentContainer.value?.starProperties ?? globalProperties;
            const layerIndex = getLayerIndex({ type: 'star-inheritance' });
            const cleanup = parentStarProprties?.subscribePropertyKeys((key) => {
                const signal = parentStarProprties.signal[key];
                this.starProperties.set(layerIndex, key, signal);
                this.properties.set(layerIndex, key, signal);
            });
            return () => {
                cleanup?.();
                this.properties.setLayer(layerIndex, undefined);
                this.starProperties.setLayer(layerIndex, undefined);
            };
        }, this.abortSignal);
        this.resetProperties(inputProperties);
        this.classList = new ClassList(this.properties, this.starProperties);
        if (initialClasses != null) {
            this.classList.add(...initialClasses);
        }
        abortableEffect(() => {
            const elementId = this.properties.value.id;
            if (elementId == null) {
                return;
            }
            const idClassName = `__id__${elementId}`;
            if (!(idClassName in StyleSheet)) {
                return;
            }
            this.classList.add(idClassName);
            return () => this.classList.remove(idClassName);
        }, this.abortSignal);
        this.node = new FlexNode(this);
        this.globalMatrix = computedGlobalMatrix(computed(() => this.parentContainer.value?.childrenMatrix.value ?? buildRootMatrix(this.properties, this.size)), computedTransformMatrix(this));
        const pixelSize = computed(() => parseNumberValue(this.properties.value.pixelSize));
        this.isClipped = computedIsClipped(this.parentContainer, this.globalMatrix, this.size, pixelSize);
        this.isVisible = computedIsVisible(this, this.isClipped, this.properties);
        this.handlers = computedHandlers(this.properties, this.starProperties, this.hoveredList, this.activeList, config?.dynamicHandlers);
        this.ancestorsHaveListenersSignal = computedAncestorsHaveListeners(this.parentContainer, this.handlers);
        this.globalPanelMatrix = computedPanelMatrix(this.properties, this.globalMatrix, this.size, undefined);
        this.raycast = makeClippedCast(this, this.raycast.bind(this), this.root, this.parentContainer, this.orderInfo);
        this.spherecast = makeClippedCast(this, makePanelSpherecast(this.root, this.boundingSphere, this.globalPanelMatrix, this), this.root, this.parentContainer, this.orderInfo);
        setupCursorCleanup(this.hoveredList, this.abortSignal);
        setupBoundingSphere(this.boundingSphere, pixelSize, this.globalMatrix, this.size, this.abortSignal);
        const hasNonUikitChildren = config?.hasNonUikitChildren ?? true;
        const isRenderless = config?.isRenderless ?? false;
        this.needsRenderTraversal = computed(() => !isRenderless || this.parentContainer.value == null || this.renderTraversalChildCount.value > 0);
        abortableEffect(() => {
            const parent = this.parentContainer.value;
            if (parent == null || !this.needsRenderTraversal.value) {
                return;
            }
            parent.renderTraversalChildCount.value = parent.renderTraversalChildCount.peek() + 1;
            return () => {
                parent.renderTraversalChildCount.value = parent.renderTraversalChildCount.peek() - 1;
            };
        }, this.abortSignal);
        if (isRenderless) {
            abortableEffect(() => {
                this.visible = this.needsRenderTraversal.value;
            }, this.abortSignal);
        }
        setupPointerEvents(this, hasNonUikitChildren);
        abortableEffect(() => {
            const { value } = this.handlers;
            for (const key in value) {
                this.addEventListener(keyToEventName(key), value[key]);
            }
            return () => {
                for (const key in value) {
                    this.removeEventListener(keyToEventName(key), value[key]);
                }
            };
        }, this.abortSignal);
        if (!hasNonUikitChildren) {
            //only uikit children allowed - throw when non uikit child is added
            const listener = ({ child }) => {
                if (child instanceof Component || child instanceof InstancedPanelMesh || child instanceof InstancedGlyphMesh) {
                    return;
                }
                throw new Error(`Only pmndrs/uikit components can be added as children to this component. Got ${child.constructor.name} instead.`);
            };
            this.addEventListener('childadded', listener);
            this.abortSignal.addEventListener('abort', () => this.removeEventListener('childadded', listener));
        }
    }
    raycast(raycaster, intersects) {
        this.root.peek().component.updateMatrix();
        computeWorldToGlobalMatrix(this.root.peek(), worldToGlobalMatrixHelper);
        sphereHelper.copy(this.boundingSphere).applyMatrix4(worldToGlobalMatrixHelper);
        if (!raycaster.ray.intersectsSphere(sphereHelper)) {
            return false;
        }
        this.updateWorldMatrix(false, false);
        super.raycast(raycaster, intersects);
        return false;
    }
    updateMatrixWorld() {
        this.updateWorldMatrix(false, true);
    }
    updateWorldMatrix(updateParents, updateChildren) {
        const root = this.root.peek().component;
        const rootParent = root.parent;
        if (updateParents) {
            rootParent?.updateWorldMatrix(true, false);
        }
        if (this === root) {
            root.updateMatrix();
        }
        computeWorldToGlobalMatrix(this.root.peek(), worldToGlobalMatrixHelper);
        this.matrixWorld.multiplyMatrices(worldToGlobalMatrixHelper, this.globalPanelMatrix.peek() ?? IdentityMatrix);
        if (updateChildren && this.root.peek().component === this) {
            for (const update of this.root.value.onUpdateMatrixWorldSet) {
                update();
            }
        }
    }
    /**
     * allows to extending the existing properties
     */
    setProperties(inputProperties) {
        this.resetProperties({
            ...this.inputProperties,
            ...inputProperties,
        });
    }
    /**
     * allows to overwrite the properties
     */
    resetProperties(inputProperties) {
        this.inputProperties = inputProperties;
        this.properties.setLayersWithConditionals({ type: 'base' }, inputProperties);
        this.starProperties.setLayersWithConditionals({ type: 'base' }, getStarProperties(inputProperties));
    }
    /**
     * must only be called for the root component; the component that has a non-uikit component as a parent
     */
    update(delta) {
        const root = this.root.peek();
        if (root.component != this) {
            //we only call .update on the root component => if not the root component return
            return;
        }
        root.isUpdateRunning = true;
        for (const onFrame of this.root.peek().onFrameSet) {
            onFrame(delta);
        }
        root.isUpdateRunning = false;
    }
    copyInto(target, recursive) {
        target.name = this.name;
        target.up.copy(this.up);
        target.position.copy(this.position);
        target.rotation.order = this.rotation.order;
        target.quaternion.copy(this.quaternion);
        target.scale.copy(this.scale);
        target.matrix.copy(this.matrix);
        target.matrixWorld.copy(this.matrixWorld);
        target.matrixAutoUpdate = this.matrixAutoUpdate;
        target.matrixWorldAutoUpdate = this.matrixWorldAutoUpdate;
        target.layers.mask = this.layers.mask;
        target.visible = this.visible;
        target.castShadow = this.castShadow;
        target.receiveShadow = this.receiveShadow;
        target.frustumCulled = this.frustumCulled;
        target.renderOrder = this.renderOrder;
        target.animations = this.animations.slice();
        target.userData = JSON.parse(JSON.stringify(this.userData));
        if (recursive !== false) {
            for (const child of this.children) {
                if (child instanceof InstancedPanelMesh || child instanceof InstancedGlyphMesh) {
                    continue;
                }
                if (child instanceof Component) {
                    target.add(child.clone());
                }
            }
        }
    }
    clone(recursive) {
        const cloned = new Component(this.inputProperties, this.initialClasses);
        this.copyInto(cloned, recursive);
        return cloned;
    }
    copy(_source, _recursive) {
        throw new Error('Component.copy() is not supported because uikit components require constructor-based initialization. Use Component.clone() instead.');
    }
    dispose() {
        this.parent?.remove(this);
        this.abortController.abort();
    }
    /**
     * only used for internally adding instanced panel group and instanced gylph group in case this component is a root component
     */
    addUnsafe(...objects) {
        for (const object of objects) {
            super.add(object);
        }
        return this;
    }
}
function keyToEventName(key) {
    return key.slice(2).toLowerCase();
}
