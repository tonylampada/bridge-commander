import { PropertiesImplementation as BasePropertiesImplementation, } from '@pmndrs/uikit-pub-sub';
import { batch, computed, signal, Signal } from '@preact/signals-core';
import { getLayerIndex, SpecialLayerSections, LayersSectionSize, } from './layer.js';
export class PropertiesImplementation extends BasePropertiesImplementation {
    conditionals;
    usedConditionals = {
        hover: signal(false),
        active: signal(false),
    };
    constructor(aliases, conditionals, defaults) {
        super((key, value, set) => {
            if (key in aliases) {
                const aliasList = aliases[key];
                for (const alias of aliasList) {
                    set(alias, value);
                }
                return;
            }
            set(key, value);
        }, defaults, () => {
            this.usedConditionals.active.value = hasConditional(this.propertiesLayers, 'active');
            this.usedConditionals.hover.value = hasConditional(this.propertiesLayers, 'hover');
        });
        this.conditionals = conditionals;
    }
    setLayersWithConditionals(layerInSectionIdentifier, properties) {
        batch(() => {
            this.setLayer(getLayerIndex({ ...layerInSectionIdentifier, section: 'base' }), properties);
            for (const layerSection of SpecialLayerSections) {
                const layerIndex = getLayerIndex({ ...layerInSectionIdentifier, section: layerSection });
                if (properties == null || !(layerSection in properties)) {
                    this.setLayer(layerIndex, undefined);
                    continue;
                }
                const getConditional = layerSection != 'important' ? this.conditionals[layerSection] : undefined;
                let conditionalProperties = properties[layerSection];
                if (getConditional != null) {
                    conditionalProperties = Object.fromEntries(Object.entries(conditionalProperties).map(([key, value]) => [
                        key,
                        computed(() => (getConditional() ? (value instanceof Signal ? value.value : value) : undefined)),
                    ]));
                }
                this.setLayer(layerIndex, conditionalProperties);
            }
        });
    }
}
function hasConditional(propertiesLayers, layerSection) {
    const layerSectionStart = getLayerIndex({ type: 'base', section: layerSection });
    for (const propertyLayerIndex of propertiesLayers.keys()) {
        if (layerSectionStart <= propertyLayerIndex && propertyLayerIndex < layerSectionStart + LayersSectionSize) {
            return true;
        }
    }
    return false;
}
export { componentDefaults } from './defaults.js';
export { baseOutPropertyShape, baseOutPropertiesSchema, createInPropertiesSchema, defineSchema, absoluteLengthValueSchema, lengthValueSchema, numberValueSchema, numberOrPercentageValueSchema, numberStringSchema, percentageStringSchema, pixelLengthStringSchema, viewportLengthStringSchema, } from './schema.js';
