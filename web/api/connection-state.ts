export const connectionError = 'Connection unavailable';
let disconnected = false;
const listeners = new Set<() => void>();
const retries = new Set<() => void>();

export function connectionSnapshot(): boolean {
  return disconnected;
}
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setDisconnected(value: boolean): void {
  if (disconnected === value) return;
  disconnected = value;
  listeners.forEach((listener) => listener());
}
export function subscribeRetry(retry: () => void): () => void {
  retries.add(retry);
  return () => {
    retries.delete(retry);
  };
}
export function retryConnection(): void {
  retries.forEach((retry) => retry());
}
