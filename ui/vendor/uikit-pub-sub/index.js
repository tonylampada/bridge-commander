import { batch, effect, Signal, signal, untracked } from '@preact/signals-core';
export class PropertiesImplementation {
    apply;
    defaults;
    onLayerIndicesChanged;
    enabled = signal(false);
    value = new Proxy({}, { get: (_target, key) => this.getSignal(key).value });
    signal = new Proxy({}, {
        get: (_target, key) => this.getSignal(key),
    });
    peekProxy = new Proxy({}, { get: (_target, key) => this.peekValue(key) });
    propertyStateMap = {};
    propertiesLayers = new Map();
    propertyKeys;
    propertyKeySubscriptions = new Set();
    constructor(apply, defaults, onLayerIndicesChanged) {
        this.apply = apply;
        this.defaults = defaults;
        this.onLayerIndicesChanged = onLayerIndicesChanged;
        this.propertyKeys = defaults == null ? [] : Array.from(Object.keys(defaults));
    }
    peek() {
        return this.peekProxy;
    }
    subscribePropertyKeys(callback) {
        for (const key of this.propertyKeys) {
            callback(key);
        }
        this.propertyKeySubscriptions.add(callback);
        return () => this.propertyKeySubscriptions.delete(callback);
    }
    clearProvidedLayer(layer, index) {
        this.propertiesLayers.delete(index);
        for (const key in layer) {
            const value = layer[key];
            if (value === undefined) {
                continue;
            }
            const propertyState = this.propertyStateMap[key];
            if (propertyState == null) {
                //no one is reading
                continue;
            }
            propertyState.cleanup?.();
            propertyState.cleanup = undefined;
            if (propertyState.layerIndex != index) {
                //we have not published the value from this layer
                continue;
            }
            //no need to check if we are enabled, because if we are not enabled, the layerIndex is Number.MAX_SAFE_INTEGER, which makes the previous "if" already continue
            this.update(key, propertyState);
        }
    }
    setLayer(index, value) {
        let layer = this.propertiesLayers.get(index);
        const isNewLayer = layer == null;
        batch(() => {
            if (layer != null) {
                this.clearProvidedLayer(layer, index);
            }
            if (value === undefined) {
                return;
            }
            this.propertiesLayers.set(index, (layer = {}));
            const entries = Object.entries(value);
            for (const [key, value] of entries) {
                this.apply(key, value, this.setProperty.bind(this, layer, index), index);
            }
        });
        if (isNewLayer) {
            this.onLayerIndicesChanged?.();
        }
    }
    getSignal(key) {
        let propertyState = this.propertyStateMap[key];
        if (propertyState == null) {
            this.propertyStateMap[key] = propertyState = {
                signal: new Signal(),
                layerIndex: null, //will be set by update immediately
            };
            this.update(key, propertyState);
        }
        return propertyState.signal;
    }
    peekValue(key) {
        let propertyState = this.propertyStateMap[key];
        if (propertyState != null) {
            return propertyState.signal.peek();
        }
        const defaultValue = this.defaults?.[key];
        const layerIndices = Array.from(this.propertiesLayers.keys()).sort((a, b) => a - b);
        const [result] = untracked(() => selectLayerValue(0, layerIndices, this.propertiesLayers, key, defaultValue));
        return result;
    }
    set(layerIndex, key, value) {
        let propertiesLayer = this.propertiesLayers.get(layerIndex);
        if (propertiesLayer == null) {
            this.propertiesLayers.set(layerIndex, (propertiesLayer = {}));
        }
        this.apply(key, value, this.setProperty.bind(this, propertiesLayer, layerIndex), layerIndex);
    }
    setProperty(propertiesLayer, layerIndex, key, value) {
        if (!this.propertyKeys.includes(key)) {
            this.propertyKeys.push(key);
            for (const callback of this.propertyKeySubscriptions) {
                callback(key);
            }
        }
        if (propertiesLayer[key] === value) {
            //unchanged
            return;
        }
        propertiesLayer[key] = value;
        const propertyState = this.propertyStateMap[key];
        if (propertyState == null) {
            //no one listens
            return;
        }
        if (propertyState.layerIndex != null && layerIndex > propertyState.layerIndex) {
            //current value has higher prescedence
            return;
        }
        if (!this.enabled.peek()) {
            //no need to run update, since the value change has no effect while enabled is `false`
            return;
        }
        this.update(key, propertyState);
    }
    update(key, target) {
        target.cleanup?.();
        target.cleanup = undefined;
        const defaultValue = this.defaults?.[key];
        let result;
        if (this.enabled.peek()) {
            result = selectLayerValue(0, Array.from(this.propertiesLayers.keys()).sort((a, b) => a - b), this.propertiesLayers, key, defaultValue, (layerIndex) => (target.cleanup = effect(() => {
                const [value, index] = selectLayerValue(layerIndex, Array.from(this.propertiesLayers.keys()).sort((a, b) => a - b), this.propertiesLayers, key, defaultValue);
                target.signal.value = value;
                target.layerIndex = index;
            })));
        }
        else if (defaultValue instanceof Signal) {
            result = [defaultValue.peek(), Infinity];
        }
        else {
            result = [defaultValue, Number.MAX_SAFE_INTEGER];
        }
        if (result == null) {
            return;
        }
        const [value, index] = result;
        target.signal.value = value;
        target.layerIndex = index;
    }
    setEnabled(enabled) {
        if (this.enabled.peek() === enabled) {
            return;
        }
        this.enabled.value = enabled;
        this.updateAll();
    }
    updateAll() {
        for (const key in this.propertyStateMap) {
            this.update(key, this.propertyStateMap[key]);
        }
    }
    destroy() {
        for (const key in this.propertyStateMap) {
            this.propertyStateMap[key].cleanup?.();
        }
        this.propertyStateMap = {};
        this.propertyKeySubscriptions.clear();
    }
}
function selectLayerValue(startLayerIndex, sortedLayerIndexArray, propertiesLayers, key, defaultValue, onSignal) {
    let value;
    let layerIndex;
    const layerIndicies = sortedLayerIndexArray[Symbol.iterator]();
    do {
        layerIndex = layerIndicies.next().value ?? Number.MAX_SAFE_INTEGER;
        if (layerIndex < startLayerIndex) {
            continue;
        }
        value = layerIndex === Number.MAX_SAFE_INTEGER ? defaultValue : propertiesLayers.get(layerIndex)[key];
        if (typeof value === 'object' && value instanceof Signal) {
            if (onSignal != null) {
                onSignal(layerIndex);
                return undefined;
            }
            value = value.value;
        }
        if (value !== undefined) {
            break;
        }
    } while (layerIndex != Number.MAX_SAFE_INTEGER);
    if (value === 'initial') {
        value = defaultValue;
    }
    return [value, layerIndex];
}
