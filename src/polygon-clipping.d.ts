/**
 * polygon-clipping@0.15.7 的模块声明补丁。
 *
 * 该包的 ESM 产物 dist/polygon-clipping.esm.js 末尾是 `export { index as default }`，
 * 只导出一个含 union / intersection / xor / difference 的对象；但自带的 .d.ts
 * 只声明了具名导出。结果是 tsc 通过、Rollup 构建时报 "union is not exported"。
 * 这里用模块增强补上 default export 声明，让类型与实际 ESM 产物一致。
 */
declare module 'polygon-clipping' {
  const api: {
    union: (...args: any[]) => any;
    intersection: (...args: any[]) => any;
    difference: (...args: any[]) => any;
    xor: (...args: any[]) => any;
  };
  export default api;
}
export {};
