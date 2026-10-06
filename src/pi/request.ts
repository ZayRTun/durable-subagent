export interface ModelRef { provider: string; modelId: string }
export function parseModelRef(value: string): ModelRef {
 const index = value.indexOf('/');
 if (index < 1 || index === value.length - 1 || /\s/.test(value)) throw Error('Expected provider/model-id');
 return {provider:value.slice(0,index),modelId:value.slice(index+1)};
}
