export function noteSimilarity(a: number[][], b: number[][], power = 4): number {
  if (!a.length || !b.length) return 0;
  const cosine = (x: number[], y: number[]) => {
    if (x.length !== y.length) return 0;
    let dot = 0, xx = 0, yy = 0;
    for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; xx += x[i] ** 2; yy += y[i] ** 2; }
    return xx && yy ? Math.max(0, Math.min(1, dot / Math.sqrt(xx * yy))) : 0;
  };
  const direction = (x: number[][], y: number[][]) => (x.reduce((sum, v) => sum + Math.max(...y.map(w => cosine(v, w))) ** power, 0) / x.length) ** (1 / power);
  return Math.max(0, Math.min(1, (direction(a, b) + direction(b, a)) / 2));
}
