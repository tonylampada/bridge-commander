import { baseOutPropertiesSchema, createInPropertiesSchema, defineSchema } from '../properties/schema.js';
import { computed, signal } from '@preact/signals-core';
import { Vector2 } from 'three';
import { computedClippingRect } from '../clipping.js';
import { ElementType, setupOrderInfo } from '../order.js';
import { setupInstancedPanel } from '../panel/instance/setup.js';
import { getDefaultPanelMaterialConfig } from '../panel/material/config.js';
import { computedAnyAncestorScrollable, computedGlobalScrollMatrix, setupScroll, setupScrollbars, setupScrollHandlers, } from '../scroll.js';
import { computedFontFamilies } from '../text/font.js';
import { computedPanelGroupDependencies } from '../panel/instance/properties.js';
import { Component } from './component.js';
import { parseNumberValue } from '../properties/values.js';
export const ContainerPropertiesSchema = /* @__PURE__ */ defineSchema(() => createInPropertiesSchema(baseOutPropertiesSchema));
export class Container extends Component {
    inputConfig;
    downPointerMap = new Map();
    scrollVelocity = new Vector2();
    anyAncestorScrollable;
    clippingRect;
    childrenMatrix;
    fontFamilies;
    scrollPosition = signal([0, 0]);
    constructor(inputProperties, initialClasses, inputConfig) {
        const scrollHandlers = signal(undefined);
        super(inputProperties, initialClasses, {
            hasNonUikitChildren: false,
            isRenderless: true,
            dynamicHandlers: scrollHandlers,
            ...inputConfig,
        });
        this.inputConfig = inputConfig;
        this.material.visible = false;
        const updateScrollFrame = setupScroll(this);
        setupScrollHandlers(scrollHandlers, this, this.abortSignal, updateScrollFrame);
        this.childrenMatrix = computedGlobalScrollMatrix(this.properties, this.scrollPosition, this.globalMatrix);
        const parentClippingRect = computed(() => this.parentContainer.value?.clippingRect.value);
        this.fontFamilies = computedFontFamilies(this.properties, this.parentContainer);
        this.clippingRect = computedClippingRect(this.globalMatrix, this, computed(() => parseNumberValue(this.properties.value.pixelSize)), parentClippingRect);
        this.anyAncestorScrollable = computedAnyAncestorScrollable(this.parentContainer);
        const panelGroupDeps = computedPanelGroupDependencies(this.properties);
        setupOrderInfo(this.orderInfo, this.properties, 'zIndex', ElementType.Panel, panelGroupDeps, computed(() => (this.parentContainer.value == null ? null : this.parentContainer.value.orderInfo.value)), this.abortSignal);
        setupInstancedPanel(this.properties, this.root, this.orderInfo, panelGroupDeps, this.globalPanelMatrix, this.size, this.borderInset, parentClippingRect, this.isVisible, getDefaultPanelMaterialConfig(), this.abortSignal);
        //scrolling:
        setupScrollbars(this, parentClippingRect, this.orderInfo, panelGroupDeps);
    }
    clone(recursive) {
        const cloned = new Container(this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
}
