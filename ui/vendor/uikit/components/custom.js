import { baseOutPropertiesSchema, createInPropertiesSchema, defineSchema } from '../properties/schema.js';
import { computed } from '@preact/signals-core';
import { createGlobalClippingPlanes } from '../clipping.js';
import { setupOrderInfo, ElementType, setupRenderOrder } from '../order.js';
import { abortableEffect, setupMatrixWorldUpdate } from '../utils.js';
import { Component } from './component.js';
import { MeshDepthMaterial, MeshDistanceMaterial } from 'three';
import { parseNumberValue } from '../properties/values.js';
export const CustomPropertiesSchema = /* @__PURE__ */ defineSchema(() => createInPropertiesSchema(baseOutPropertiesSchema));
export class Custom extends Component {
    inputConfig;
    constructor(inputProperties, initialClasses, inputConfig) {
        super(inputProperties, initialClasses, { hasNonUikitChildren: false, ...inputConfig });
        this.inputConfig = inputConfig;
        setupOrderInfo(this.orderInfo, this.properties, 'zIndex', ElementType.Custom, undefined, computed(() => (this.parentContainer.value == null ? null : this.parentContainer.value.orderInfo.value)), this.abortSignal);
        this.frustumCulled = false;
        setupRenderOrder(this, this.root, this.orderInfo);
        const clippingPlanes = createGlobalClippingPlanes(this);
        this.customDepthMaterial = new MeshDepthMaterial();
        this.customDistanceMaterial = new MeshDistanceMaterial();
        this.material.clippingPlanes = clippingPlanes;
        this.customDepthMaterial.clippingPlanes = clippingPlanes;
        this.customDistanceMaterial.clippingPlanes = clippingPlanes;
        abortableEffect(() => {
            this.material.depthTest = this.properties.value.depthTest;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        abortableEffect(() => {
            this.material.depthWrite = this.properties.value.depthWrite ?? false;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        abortableEffect(() => {
            this.renderOrder = parseNumberValue(this.properties.value.renderOrder ?? 0);
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        abortableEffect(() => {
            this.castShadow = this.properties.value.castShadow;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        abortableEffect(() => {
            this.receiveShadow = this.properties.value.receiveShadow;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        setupMatrixWorldUpdate(this, this.root, this.globalPanelMatrix, this.abortSignal);
        abortableEffect(() => {
            this.visible = this.isVisible.value;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
    }
    clone(recursive) {
        const cloned = new Custom(this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
}
