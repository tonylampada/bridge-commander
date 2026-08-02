import { batch } from '@preact/signals-core';
import { conditionalKeys } from '../properties/conditional.js';
export const StyleSheet = {};
export class ClassList {
    properties;
    starProperties;
    list = [];
    constructor(properties, starProperties) {
        this.properties = properties;
        this.starProperties = starProperties;
    }
    *[Symbol.iterator]() {
        for (const entry in this.list) {
            if (entry != null) {
                yield entry;
            }
        }
    }
    set(...classes) {
        const length = Math.max(classes.length, this.list.length);
        this.list.length = classes.length;
        for (let classIndex = 0; classIndex < length; classIndex++) {
            const identifier = { type: 'class', classIndex };
            const classRef = classes[classIndex];
            let resolvedClass = classRef == null ? undefined : this.resolveClassRef(classRef);
            this.properties.setLayersWithConditionals(identifier, resolvedClass);
            this.starProperties.setLayersWithConditionals(identifier, getStarProperties(resolvedClass));
        }
    }
    add(...classes) {
        batch(() => {
            for (const classRef of classes) {
                let classIndex = 0;
                while (this.list[classIndex] != null) {
                    classIndex++;
                }
                this.list[classIndex] = classRef;
                const identifier = { type: 'class', classIndex };
                const resolvedClass = this.resolveClassRef(classRef);
                this.properties.setLayersWithConditionals(identifier, resolvedClass);
                this.starProperties.setLayersWithConditionals(identifier, getStarProperties(resolvedClass));
            }
        });
    }
    remove(...classes) {
        batch(() => {
            for (const classRef of classes) {
                const classIndex = this.list.indexOf(classRef);
                if (classIndex === -1) {
                    console.warn(`Class '${classRef}' not found in the classList`);
                    return;
                }
                if (classIndex + 1 === this.list.length) {
                    this.list.splice(classIndex, 1);
                }
                else {
                    this.list[classIndex] = undefined;
                }
                const identifier = { type: 'class', classIndex };
                this.properties.setLayersWithConditionals(identifier, undefined);
                this.starProperties.setLayersWithConditionals(identifier, undefined);
            }
        });
    }
    toggle(classRef) {
        if (this.contains(classRef)) {
            this.remove(classRef);
        }
        else {
            this.add(classRef);
        }
    }
    contains(classRef) {
        return this.list.includes(classRef);
    }
    replace(oldToken, newToken) {
        if (!this.contains(oldToken)) {
            return false;
        }
        this.remove(oldToken);
        this.add(newToken);
        return true;
    }
    resolveClassRef(classRef) {
        if (classRef == null) {
            return undefined;
        }
        if (typeof classRef != 'string') {
            return classRef;
        }
        if (!(classRef in StyleSheet)) {
            console.warn(`class "${classRef}" not present in the global stylesheet`);
            return undefined;
        }
        return StyleSheet[classRef];
    }
}
export function getStarProperties(properties) {
    if (properties == null) {
        return undefined;
    }
    let result;
    if ('*' in properties) {
        result = { ...properties['*'] };
    }
    for (const conditionalKey in conditionalKeys) {
        const conditionalEntry = properties[conditionalKey]?.['*'];
        if (conditionalEntry == null) {
            continue;
        }
        result ??= {};
        result[conditionalKey] = conditionalEntry;
    }
    return result;
}
