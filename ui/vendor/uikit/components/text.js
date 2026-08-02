import { unknown as unknownSchema } from 'zod';
import { baseOutPropertiesSchema, createInPropertiesSchema, defineSchema } from '../properties/schema.js';
import { computed, signal } from '@preact/signals-core';
import { Component } from './component.js';
import { ElementType, setupOrderInfo } from '../order.js';
import { additionalTextDefaults, computedFont, computedFontFamilies, computedGlobalTextMatrix, computedGylphGroupDependencies, createInstancedText, setupTextLayout, } from '../text/index.js';
import { computedPanelGroupDependencies } from '../panel/instance/properties.js';
import { setupInstancedPanel } from '../panel/instance/setup.js';
import { getDefaultPanelMaterialConfig } from '../panel/material/config.js';
import { abortableEffect } from '../utils.js';
import { componentDefaults } from '../properties/defaults.js';
export const textOutPropertiesSchema = /* @__PURE__ */ defineSchema(() => baseOutPropertiesSchema.extend({
    text: unknownSchema().optional(),
}));
export const TextPropertiesSchema = /* @__PURE__ */ defineSchema(() => createInPropertiesSchema(textOutPropertiesSchema));
export const textDefaults = { ...componentDefaults, ...additionalTextDefaults };
export class Text extends Component {
    inputConfig;
    backgroundOrderInfo = signal(undefined);
    backgroundGroupDeps;
    fontSignal;
    textLayout;
    globalTextMatrix;
    constructor(inputProperties, initialClasses, inputConfig) {
        super(inputProperties, initialClasses, {
            defaults: textDefaults,
            hasNonUikitChildren: false,
            isRenderless: true,
            ...inputConfig,
        });
        this.inputConfig = inputConfig;
        this.material.visible = false;
        const parentClippingRect = computed(() => this.parentContainer.value?.clippingRect.value);
        this.backgroundGroupDeps = computedPanelGroupDependencies(this.properties);
        this.globalTextMatrix = computedGlobalTextMatrix(this);
        setupOrderInfo(this.backgroundOrderInfo, this.properties, 'zIndex', ElementType.Panel, this.backgroundGroupDeps, computed(() => (this.parentContainer.value == null ? null : this.parentContainer.value.orderInfo.value)), this.abortSignal);
        const fontFamilies = computedFontFamilies(this.properties, this.parentContainer);
        this.fontSignal = computedFont(this.properties, fontFamilies);
        setupOrderInfo(this.orderInfo, this.properties, 'zIndex', ElementType.Text, computedGylphGroupDependencies(this.fontSignal), this.backgroundOrderInfo, this.abortSignal);
        setupInstancedPanel(this.properties, this.root, this.backgroundOrderInfo, this.backgroundGroupDeps, this.globalPanelMatrix, this.size, this.borderInset, parentClippingRect, this.isVisible, getDefaultPanelMaterialConfig(), this.abortSignal);
        const { layout, customLayouting } = setupTextLayout(this);
        this.textLayout = layout;
        createInstancedText(this, parentClippingRect, this.textLayout);
        abortableEffect(() => this.node.setCustomLayouting(customLayouting.value), this.abortSignal);
    }
    clone(recursive) {
        const cloned = new Text(this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
    add() {
        throw new Error(`the text component can not have any children`);
    }
}
