export function createId() {
  const cryptoApi = globalThis.crypto as {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint32Array) => Uint32Array;
  } | undefined;

  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi?.getRandomValues) {
    const values = cryptoApi.getRandomValues(new Uint32Array(4));
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("-");
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
