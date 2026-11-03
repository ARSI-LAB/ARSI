/**
 * Shared runtime scope. Modules add typed capabilities through declaration
 * merging; the owner supplies those capabilities before handing out a scope.
 * Contexts are live process objects and must not be persisted as JSON.
 */
export class RuntimeContext {
  /**
   * Inherit this scope and shadow only the supplied fields, following Cordis's
   * metadata scope model. Descriptors preserve getters and symbol keys. Values
   * are shared by reference; derive a new value before changing nested state.
   */
  extend<Parent extends RuntimeContext, T extends object>(
    this: Parent,
    properties: T & Partial<RuntimeContext>,
  ): Parent & T {
    const child: Parent & T = Object.create(this);
    Object.defineProperties(
      child,
      Object.getOwnPropertyDescriptors(properties),
    );
    return child;
  }
}
