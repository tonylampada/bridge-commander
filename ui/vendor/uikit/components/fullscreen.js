import { baseOutPropertiesSchema, createInPropertiesSchema, defineSchema, numberValueSchema, } from '../properties/schema.js';
import { Camera, OrthographicCamera, PerspectiveCamera, Vector2 } from 'three';
import { batch, signal } from '@preact/signals-core';
import { searchFor } from '../utils.js';
import { Container } from './container.js';
import { parseNumberValue } from '../properties/values.js';
export const fullscreenOutPropertiesSchema = /* @__PURE__ */ defineSchema(() => baseOutPropertiesSchema.extend({
    distanceToCamera: numberValueSchema.optional(),
}));
export const FullscreenPropertiesSchema = /* @__PURE__ */ defineSchema(() => createInPropertiesSchema(fullscreenOutPropertiesSchema));
const vectorHelper = new Vector2();
export class Fullscreen extends Container {
    renderer;
    inputConfig;
    sizeX;
    sizeY;
    transformTranslateZ;
    pixelSize;
    constructor(renderer, properties, initialClasses, inputConfig) {
        const sizeX = signal(0);
        const sizeY = signal(0);
        const transformTranslateZ = signal(0);
        const pixelSize = signal(0);
        super(properties, initialClasses, {
            ...inputConfig,
            defaultOverrides: {
                sizeX,
                sizeY,
                pixelSize,
                transformTranslateZ,
                pointerEvents: 'listener',
                ...inputConfig?.defaultOverrides,
            },
        });
        this.renderer = renderer;
        this.inputConfig = inputConfig;
        this.sizeX = sizeX;
        this.sizeY = sizeY;
        this.transformTranslateZ = transformTranslateZ;
        this.pixelSize = pixelSize;
    }
    clone(recursive) {
        const cloned = new Fullscreen(this.renderer, this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
    update(delta) {
        super.update(delta);
        const camera = searchFor(this, Camera, 2, true);
        if (!(camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera)) {
            throw new Error(`fullscreen can only be added to a camera`);
        }
        const distanceToCamera = parseNumberValue(this.properties.peek().distanceToCamera ?? camera.near + 0.1);
        batch(() => {
            let pixelSize;
            if (camera instanceof PerspectiveCamera) {
                const cameraHeight = 2 * Math.tan((Math.PI * camera.fov) / 360) * distanceToCamera;
                pixelSize = cameraHeight / this.renderer.getSize(vectorHelper).y;
                this.sizeY.value = cameraHeight;
                this.sizeX.value = cameraHeight * camera.aspect;
            }
            else if (camera instanceof OrthographicCamera) {
                const cameraHeight = (camera.top - camera.bottom) / camera.zoom;
                const cameraWidth = (camera.right - camera.left) / camera.zoom;
                pixelSize = cameraHeight / this.renderer.getSize(vectorHelper).y;
                this.sizeY.value = cameraHeight;
                this.sizeX.value = cameraWidth;
            }
            else {
                //to make TS happy, this else branch cannot happen
                return;
            }
            //if we are in a screen-based xr session, apply the pixel ratio to the pixel size to display the UI in the same size as outside of XR
            if (this.renderer.xr.getSession()?.interactionMode === 'screen-space') {
                pixelSize *= window.devicePixelRatio;
            }
            this.pixelSize.value = pixelSize;
            this.transformTranslateZ.value = -distanceToCamera / pixelSize;
        });
    }
}
