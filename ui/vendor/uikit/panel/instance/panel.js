import { signal } from '@preact/signals-core';
import { defaultClippingData } from '../../clipping.js';
import { abortableEffect } from '../../utils.js';
export class InstancedPanel {
    group;
    minorIndex;
    matrix;
    size;
    borderInset;
    clippingRect;
    materialConfig;
    indexInBucket;
    bucket;
    insertedIntoGroup = false;
    active = signal(false);
    abortController;
    constructor(properties, group, minorIndex, matrix, size, borderInset, clippingRect, isVisible, materialConfig, abortSignal) {
        this.group = group;
        this.minorIndex = minorIndex;
        this.matrix = matrix;
        this.size = size;
        this.borderInset = borderInset;
        this.clippingRect = clippingRect;
        this.materialConfig = materialConfig;
        const setters = materialConfig.setters;
        abortableEffect(() => {
            if (!isVisible.value || !this.active.value) {
                return;
            }
            return properties.subscribePropertyKeys((key) => {
                if (!materialConfig.hasProperty(key)) {
                    return;
                }
                abortableEffect(() => {
                    const index = this.getIndexInBuffer();
                    if (index == null) {
                        return;
                    }
                    const { instanceData, instanceDataOnUpdate: instanceDataAddUpdateRange, root } = this.group;
                    setters[key](instanceData.array, instanceData.itemSize * index, properties.value[key], size, properties.signal.opacity, instanceDataAddUpdateRange);
                    root.requestRender?.();
                }, abortSignal);
            });
        }, abortSignal);
        const isPanelVisible = materialConfig.computedIsVisibile(properties, borderInset, size, isVisible);
        abortableEffect(() => {
            if (isPanelVisible.value) {
                this.requestShow();
                return;
            }
            this.hide();
        }, abortSignal);
        abortSignal.addEventListener('abort', () => this.hide());
    }
    setIndexInBucket(index) {
        this.indexInBucket = index;
    }
    getIndexInBuffer() {
        if (this.bucket == null || this.indexInBucket == null) {
            return undefined;
        }
        return this.bucket.offset + this.indexInBucket;
    }
    activate(bucket, index) {
        this.bucket = bucket;
        this.indexInBucket = index;
        this.active.value = true;
        this.abortController = new AbortController();
        abortableEffect(() => {
            const matrix = this.matrix.value;
            if (matrix == null) {
                return;
            }
            const index = this.getIndexInBuffer();
            if (index == null) {
                return;
            }
            const arrayIndex = index * 16;
            const { instanceMatrix, root } = this.group;
            matrix.toArray(instanceMatrix.array, arrayIndex);
            instanceMatrix.addUpdateRange(arrayIndex, 16);
            instanceMatrix.needsUpdate = true;
            root.requestRender?.();
        }, this.abortController.signal);
        abortableEffect(() => {
            const index = this.getIndexInBuffer();
            const size = this.size.value;
            if (index == null || size == null) {
                return;
            }
            const [width, height] = size;
            const { instanceData, root } = this.group;
            const { array } = instanceData;
            const bufferIndex = index * 16 + 14;
            array[bufferIndex] = width;
            array[bufferIndex + 1] = height;
            instanceData.addUpdateRange(bufferIndex, 2);
            instanceData.needsUpdate = true;
            root.requestRender?.();
        }, this.abortController.signal);
        abortableEffect(() => {
            const index = this.getIndexInBuffer();
            const borderInset = this.borderInset.value;
            if (index == null || borderInset == null) {
                return;
            }
            const { instanceData, root } = this.group;
            const offset = index * 16 + 0;
            instanceData.array.set(borderInset, offset);
            instanceData.addUpdateRange(offset, 4);
            instanceData.needsUpdate = true;
            root.requestRender?.();
        }, this.abortController.signal);
        abortableEffect(() => {
            const index = this.getIndexInBuffer();
            if (index == null) {
                return;
            }
            const { instanceClipping, root } = this.group;
            const offset = index * 16;
            const clipping = this.clippingRect?.value;
            if (clipping != null) {
                clipping.toArray(instanceClipping.array, offset);
            }
            else {
                instanceClipping.array.set(defaultClippingData, offset);
            }
            instanceClipping.addUpdateRange(offset, 16);
            instanceClipping.needsUpdate = true;
            root.requestRender?.();
        }, this.abortController.signal);
    }
    requestShow() {
        if (this.insertedIntoGroup) {
            return;
        }
        this.insertedIntoGroup = true;
        this.group.insert(this.minorIndex, this);
    }
    hide() {
        if (!this.insertedIntoGroup) {
            return;
        }
        this.active.value = false;
        this.group.delete(this.minorIndex, this.indexInBucket, this);
        this.insertedIntoGroup = false;
        this.bucket = undefined;
        this.indexInBucket = undefined;
        this.abortController?.abort();
        this.abortController = undefined;
    }
}
