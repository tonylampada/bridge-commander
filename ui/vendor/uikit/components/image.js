import { boolean, enum as enumSchema, string, union } from 'zod';
import { baseOutPropertiesSchema, createInPropertiesSchema, defineSchema, instanceSchema, } from '../properties/schema.js';
import { computed, effect, signal } from '@preact/signals-core';
import { Component } from './component.js';
import { SRGBColorSpace, Texture, TextureLoader } from 'three';
import { abortableEffect, loadResourceWithParams, setupMatrixWorldUpdate } from '../utils.js';
import { createPanelMaterial, createPanelMaterialConfig, PanelDepthMaterial, PanelDistanceMaterial, writeColor, } from '../panel/material/index.js';
import { createGlobalClippingPlanes } from '../clipping.js';
import { ElementType, setupOrderInfo, setupRenderOrder } from '../order.js';
import { componentDefaults } from '../properties/defaults.js';
import { resolvePanelMaterialClassProperty } from '../panel/material/presets.js';
import { toAbsoluteNumber } from '../text/utils.js';
import { parseNumberValue } from '../properties/values.js';
export const imageOutPropertiesSchema = /* @__PURE__ */ defineSchema(() => baseOutPropertiesSchema.extend({
    src: union([string(), instanceSchema('Texture', Texture)]).optional(),
    objectFit: enumSchema(['cover', 'fill']).optional(),
    keepAspectRatio: boolean().optional(),
}));
export const ImagePropertiesSchema = /* @__PURE__ */ defineSchema(() => createInPropertiesSchema(imageOutPropertiesSchema));
export const imageDefaults = {
    ...componentDefaults,
    objectFit: 'fill',
    keepAspectRatio: true,
};
export class Image extends Component {
    inputConfig;
    texture = signal(undefined);
    constructor(inputProperties, initialClasses, inputConfig) {
        const aspectRatio = signal(undefined);
        super(inputProperties, initialClasses, {
            defaults: imageDefaults,
            hasNonUikitChildren: false,
            ...inputConfig,
            defaultOverrides: { aspectRatio, ...inputConfig?.defaultOverrides },
        });
        this.inputConfig = inputConfig;
        setupOrderInfo(this.orderInfo, this.properties, 'zIndex', ElementType.Image, undefined, computed(() => (this.parentContainer.value == null ? null : this.parentContainer.value.orderInfo.value)), this.abortSignal);
        this.frustumCulled = false;
        setupRenderOrder(this, this.root, this.orderInfo);
        if (inputConfig?.loadTexture ?? true) {
            loadResourceWithParams(this.texture, loadTextureImpl, cleanupTexture, this.abortSignal, this.properties.signal.src);
        }
        const clippingPlanes = createGlobalClippingPlanes(this);
        const isMeshVisible = getImageMaterialConfig().computedIsVisibile(this.properties, this.borderInset, this.size, computed(() => this.isVisible.value && this.texture.value != null));
        const data = new Float32Array(16);
        const info = { data: data, type: 'normal' };
        this.customDepthMaterial = new PanelDepthMaterial(info);
        this.customDistanceMaterial = new PanelDistanceMaterial(info);
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
            ;
            this.material.map = this.texture.value ?? null;
            this.material.needsUpdate = true;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        abortableEffect(() => {
            const material = createPanelMaterial(resolvePanelMaterialClassProperty(this.properties.value.panelMaterialClass), info);
            material.clippingPlanes = clippingPlanes;
            material.map = this.material.map;
            material.depthWrite = this.material.depthWrite;
            material.depthTest = this.material.depthTest;
            this.material = material;
            return () => material.dispose();
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
        const imageMaterialConfig = getImageMaterialConfig();
        abortableEffect(() => {
            if (!this.isVisible.value) {
                return;
            }
            data.set(imageMaterialConfig.defaultData);
            const cleanupSizeEffect = effect(() => {
                const size = this.size.value;
                if (size != null) {
                    data.set(size, 14);
                }
            });
            const cleanupBorderEffect = effect(() => {
                const borderInset = this.borderInset.value;
                if (borderInset != null) {
                    data.set(borderInset, 0);
                }
            });
            this.root.peek().requestRender?.();
            return () => {
                cleanupSizeEffect();
                cleanupBorderEffect();
            };
        }, this.abortSignal);
        abortableEffect(() => {
            if (!this.isVisible.value) {
                return;
            }
            const opacity = toAbsoluteNumber(this.properties.value.opacity ?? 1, () => 1);
            writeColor(data, 4, 0xffffff, opacity, undefined);
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        const setters = imageMaterialConfig.setters;
        abortableEffect(() => {
            if (!this.isVisible.value) {
                return;
            }
            return this.properties.subscribePropertyKeys((key) => {
                if (!imageMaterialConfig.hasProperty(key)) {
                    return;
                }
                abortableEffect(() => {
                    setters[key](data, 0, this.properties.value[key], this.size, this.properties.signal.opacity, undefined);
                    this.root.peek().requestRender?.();
                }, this.abortSignal);
            });
        }, this.abortSignal);
        abortableEffect(() => {
            const texture = this.texture.value;
            const size = this.size.value;
            const borderInset = this.borderInset.value;
            if (texture == null || size == null || borderInset == null) {
                return;
            }
            texture.matrix.identity();
            this.root.peek().requestRender?.();
            if (this.properties.value.objectFit === 'fill' || texture == null) {
                transformInsideBorder(borderInset, size, texture);
                return;
            }
            const { width: textureWidth, height: textureHeight } = texture.source.data;
            const textureRatio = textureWidth / textureHeight;
            const [width, height] = size;
            const [top, right, bottom, left] = borderInset;
            const boundsRatioValue = (width - left - right) / (height - top - bottom);
            if (textureRatio > boundsRatioValue) {
                texture.matrix
                    .translate(-(0.5 * (boundsRatioValue - textureRatio)) / boundsRatioValue, 0)
                    .scale(boundsRatioValue / textureRatio, 1);
            }
            else {
                texture.matrix
                    .translate(0, -(0.5 * (textureRatio - boundsRatioValue)) / textureRatio)
                    .scale(1, textureRatio / boundsRatioValue);
            }
            transformInsideBorder(borderInset, size, texture);
        }, this.abortSignal);
        abortableEffect(() => {
            this.visible = isMeshVisible.value;
            this.root.peek().requestRender?.();
        }, this.abortSignal);
        abortableEffect(() => {
            if (!this.properties.value.keepAspectRatio) {
                aspectRatio.value = undefined;
                return;
            }
            const tex = this.texture.value;
            if (tex == null) {
                aspectRatio.value = undefined;
                return;
            }
            const image = tex.source.data;
            const width = image.videoWidth ?? image.naturalWidth ?? image.width;
            const height = image.videoHeight ?? image.naturalHeight ?? image.height;
            aspectRatio.value = width / height;
        }, this.abortSignal);
    }
    clone(recursive) {
        const cloned = new Image(this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
    add() {
        throw new Error(`the image component can not have any children`);
    }
}
function transformInsideBorder(borderInset, size, texture) {
    const [outerWidth, outerHeight] = size;
    const [top, right, bottom, left] = borderInset;
    const width = outerWidth - left - right;
    const height = outerHeight - top - bottom;
    texture.matrix
        .translate(-1 + (left + width) / outerWidth, -1 + (top + height) / outerHeight)
        .scale(outerWidth / width, outerHeight / height);
}
const textureLoader = new TextureLoader();
function cleanupTexture(texture) {
    if (texture?.disposable === true) {
        texture.dispose();
    }
}
async function loadTextureImpl(src) {
    if (src == null) {
        return Promise.resolve(undefined);
    }
    if (src instanceof Texture) {
        return Promise.resolve(src);
    }
    try {
        const texture = await textureLoader.loadAsync(src);
        texture.colorSpace = SRGBColorSpace;
        texture.matrixAutoUpdate = false;
        return Object.assign(texture, { disposable: true });
    }
    catch (error) {
        console.error(error);
        return undefined;
    }
}
let imageMaterialConfig;
function getImageMaterialConfig() {
    imageMaterialConfig ??= createPanelMaterialConfig({
        borderBend: 'borderBend',
        borderBottomLeftRadius: 'borderBottomLeftRadius',
        borderBottomRightRadius: 'borderBottomRightRadius',
        borderColor: 'borderColor',
        borderTopLeftRadius: 'borderTopLeftRadius',
        borderTopRightRadius: 'borderTopRightRadius',
    }, {
        backgroundColor: 0xffffff,
    });
    return imageMaterialConfig;
}
