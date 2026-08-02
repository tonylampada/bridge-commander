import { Input, InputPropertiesSchema } from './input.js';
export const TextareaPropertiesSchema = InputPropertiesSchema;
export class Textarea extends Input {
    inputConfig;
    constructor(inputProperties, initialClasses, inputConfig) {
        super(inputProperties, initialClasses, { multiline: true, ...inputConfig });
        this.inputConfig = inputConfig;
    }
    clone(recursive) {
        const cloned = new Textarea(this.inputProperties, this.initialClasses, this.inputConfig);
        this.copyInto(cloned, recursive);
        return cloned;
    }
}
