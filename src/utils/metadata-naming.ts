// Source-only metadata semantics; generated JSON retains its existing naming contract.
const reactComponents = new WeakSet<object>()

export function markReactComponentMetadata<T extends object> (component: T): T {
  reactComponents.add(component)
  return component
}

export function usesExactPropNames (component: object): boolean {
  return reactComponents.has(component)
}
