import { boolean, custom, string, union } from 'zod';
import { createInPropertiesSchema, defineSchema, numberValueSchema } from '../properties/schema.js';
import { Image, imageOutPropertiesSchema } from './image.js';
import { SRGBColorSpace, VideoTexture } from 'three';
import { computed, signal } from '@preact/signals-core';
import { abortableEffect, loadResourceWithParams } from '../utils.js';
import { parseNumberValue } from '../properties/values.js';
export const videoOutPropertiesSchema = /* @__PURE__ */ defineSchema(() => imageOutPropertiesSchema.omit({ src: true }).extend({
    src: union([
        string(),
        custom((value) => typeof MediaStream !== 'undefined' && value instanceof MediaStream),
        custom((value) => typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement),
    ]).optional(),
    volume: numberValueSchema.optional(),
    preservesPitch: boolean().optional(),
    playbackRate: numberValueSchema.optional(),
    muted: boolean().optional(),
    loop: boolean().optional(),
    autoplay: boolean().optional(),
    crossOrigin: string().nullable().optional(),
}));
export const VideoPropertiesSchema = /* @__PURE__ */ defineSchema(() => createInPropertiesSchema(videoOutPropertiesSchema));
function isVideoElement(value) {
    return typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement;
}
export class Video extends Image {
    inputConfig;
    element = signal();
    constructor(inputProperties, initialClasses, inputConfig) {
        super(inputProperties, initialClasses, {
            loadTexture: false,
            ...inputConfig,
        });
        this.inputConfig = inputConfig;
        const srcIsElement = computed(() => isVideoElement(this.properties.value.src));
        const notYetLoadedElement = computed(() => {
            if (srcIsElement.value) {
                return this.properties.value.src;
            }
            if (typeof document === 'undefined') {
                return undefined;
            }
            const element = document.createElement('video');
            element.style.position = 'absolute';
            element.style.width = '1px';
            element.style.zIndex = '-1000';
            element.style.top = '0px';
            element.style.left = '0px';
            return element;
        });
        abortableEffect(() => {
            const element = notYetLoadedElement.value;
            if (element == null) {
                return;
            }
            element.playsInline = true;
            element.volume = parseNumberValue(this.properties.value.volume ?? 1);
            element.preservesPitch = this.properties.value.preservesPitch ?? true;
            element.playbackRate = parseNumberValue(this.properties.value.playbackRate ?? 1);
            element.muted = this.properties.value.muted ?? false;
            element.loop = this.properties.value.loop ?? false;
            element.autoplay = this.properties.value.autoplay ?? false;
            element.crossOrigin = this.properties.value.crossOrigin ?? null;
            const src = this.properties.value.src;
            if (isVideoElement(src)) {
                return;
            }
            updateVideoElementSrc(element, src);
        }, this.abortSignal);
        abortableEffect(() => {
            const element = notYetLoadedElement.value;
            if (typeof document === 'undefined' || srcIsElement.value || element == null) {
                return;
            }
            document.body.appendChild(element);
            return () => element.remove();
        }, this.abortSignal);
        loadResourceWithParams(this.element, loadVideoElement, () => { }, this.abortSignal, notYetLoadedElement);
        abortableEffect(() => {
            const element = this.element.value;
            if (element == null) {
                return;
            }
            const updateTexture = () => {
                const texture = new VideoTexture(element);
                texture.colorSpace = SRGBColorSpace;
                texture.needsUpdate = true;
                this.texture.value = texture;
            };
            updateTexture();
            element.addEventListener('resize', updateTexture);
            return () => element.removeEventListener('resize', updateTexture);
        }, this.abortSignal);
        abortableEffect(() => {
            const { requestRender } = this.root.value;
            const element = this.element.value;
            if (requestRender == null || element == null) {
                return;
            }
            let requestId;
            const callback = () => {
                requestRender();
                requestId = element.requestVideoFrameCallback(callback);
            };
            requestId = element.requestVideoFrameCallback(callback);
            return () => element.cancelVideoFrameCallback(requestId);
        }, this.abortSignal);
    }
    clone(recursive) {
        const cloned = new Video(this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
}
async function loadVideoElement(element) {
    if (element == null) {
        return undefined;
    }
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve) => (element.onloadedmetadata = resolve));
    }
    return element;
}
export function updateVideoElementSrc(element, src) {
    if (src == null) {
        element.removeAttribute('src');
        element.removeAttribute('srcObject');
        return;
    }
    if (typeof src === 'string') {
        element.src = src;
        return;
    }
    element.srcObject = src;
}
