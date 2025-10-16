// Query helpers (path access)
export function getByPath(obj: any, path: string) {
  if (!path) return undefined;
  const norm = path
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\["([^\"]+)"\]|\['([^']+)'\]/g, (_, d1, d2) => '.' + (d1 ?? d2));
  const parts = norm.split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as any)[p];
  }
  return cur;
}
export function projectInputs<T extends Record<string, string>>(obj: any, mapping: T): Record<keyof T, any> {
  const out: any = {};
  for (const [k, expr] of Object.entries(mapping)) {
    out[k] = getByPath(obj, expr);
  }
  return out;
}
