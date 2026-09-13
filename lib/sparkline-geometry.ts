export function sparklineValues(points: number[]): number[] {
  return points.length > 1 ? points : points.length === 1 ? [points[0], points[0]] : [0, 0]
}

export function sparklineGeometry(
  points: number[],
  size: { width: number; height: number; pad: number },
) {
  const { width, height, pad } = size
  const min = Math.min(...points)
  const max = Math.max(...points)
  const flat = max === min
  const range = flat ? 1 : max - min
  const coords = points.map((point, index) => {
    const x = pad + (index * (width - pad * 2)) / (points.length - 1)
    const y = flat ? height / 2 : height - pad - ((point - min) / range) * (height - pad * 2)
    return [x, y] as const
  })
  const linePath = coords.map((coord, index) => (index === 0 ? 'M' : 'L') + coord[0].toFixed(1) + ',' + coord[1].toFixed(1)).join(' ')
  const areaPath = linePath + ' L' + coords[coords.length - 1][0].toFixed(1) + ',' + height + ' L' + coords[0][0].toFixed(1) + ',' + height + ' Z'
  return { coords, linePath, areaPath }
}
