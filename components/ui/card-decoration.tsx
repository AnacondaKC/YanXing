/** 总览指标卡与课题详情卡共用的光晕、同心圆与顶部高光。 */
export function CardAura({ showTopHighlight = true }: { showTopHighlight?: boolean } = {}) {
  return (
    <>
      <div className="absolute -right-10 -top-12 h-28 w-28 rounded-full bg-yx-brand-bright/12 blur-2xl" />
      <div className="absolute -bottom-12 -left-10 h-24 w-24 rounded-full bg-yx-brand/[0.06] blur-2xl" />
      <div className="absolute -right-7 -top-7 h-[4.75rem] w-[4.75rem] rounded-full border border-yx-brand/[0.12]" />
      <div className="absolute -right-3 -top-3 h-12 w-12 rounded-full border border-yx-brand/[0.08]" />
      <span className="absolute right-[38%] top-3 h-1 w-1 rounded-full bg-yx-brand-bright/40" />
      <span className="absolute bottom-[28%] right-[22%] h-1.5 w-1.5 rounded-full bg-yx-brand/25" />
      {showTopHighlight ? <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-yx-brand-bright/30 to-transparent" /> : null}
    </>
  )
}

export type WorkbenchCardKind = 'score' | 'details' | 'completeness' | 'visualization' | 'suggestions'

/** 对角基准刻线：仪表盘质感。 */
function CornerTicks() {
  return (
    <>
      <svg className="absolute left-2 top-2 h-3.5 w-3.5 text-yx-brand/25" viewBox="0 0 14 14" fill="none">
        <path d="M1 5V1h4" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <svg className="absolute bottom-2 right-2 h-3.5 w-3.5 text-yx-brand/25" viewBox="0 0 14 14" fill="none">
        <path d="M13 9v4H9" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    </>
  )
}

/** 呼应雷达图环线的同心虚线环与柔光，锚定卡片角落并向外溢出裁切。 */
function RingCorner({ side = 'right', compact = false }: { side?: 'left' | 'right'; compact?: boolean }) {
  if (compact) {
    return (
      <>
        <div className="absolute -bottom-10 -right-10 h-28 w-28">
          <div className="absolute inset-0 rounded-full border border-dashed border-yx-brand/[0.14]" />
          <div className="absolute inset-[1.75rem] rounded-full border border-yx-brand/[0.08]" />
        </div>
        <div className="absolute -bottom-8 right-3 h-16 w-20 rounded-full bg-yx-brand-bright/[0.07] blur-2xl" />
      </>
    )
  }
  return (
    <>
      <div className={`absolute -bottom-16 ${side === 'left' ? '-left-16' : '-right-16'} h-40 w-40`}>
        <div className="absolute inset-0 rounded-full border border-dashed border-yx-brand/[0.14]" />
        <div className="absolute inset-[2.375rem] rounded-full border border-yx-brand/[0.08]" />
      </div>
      <div className={`absolute -bottom-12 ${side === 'left' ? 'left-4' : 'right-4'} h-24 w-28 rounded-full bg-yx-brand-bright/[0.07] blur-2xl`} />
    </>
  )
}

/** 点阵纹理补丁，向 fade 方向渐隐。 */
function DotPatch({ className, fade = 'bottom-left' }: { className: string; fade?: 'bottom-left' | 'top-right' }) {
  const maskImage = fade === 'bottom-left'
    ? 'linear-gradient(to bottom left, black, transparent 72%)'
    : 'linear-gradient(to top right, black, transparent 72%)'
  return (
    <div
      aria-hidden="true"
      className={`absolute opacity-50 ${className}`}
      style={{
        backgroundImage: 'radial-gradient(color-mix(in srgb, var(--yx-brand) 32%, transparent) 1px, transparent 1px)',
        backgroundSize: '9px 9px',
        maskImage,
        WebkitMaskImage: maskImage,
      }}
    />
  )
}

/** 报告库分组卡装饰：基准刻线 + 紧凑同心虚线环，克制不干扰表格阅读。 */
export function GroupCardDecoration() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <CornerTicks />
      <RingCorner compact />
    </div>
  )
}

/** 课题详情卡片装饰层：点阵与基准刻线，不再使用角落同心圆。 */
export function WorkbenchCardDecoration({ kind }: { kind: WorkbenchCardKind }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <CornerTicks />
      {kind === 'visualization' ? (
        <DotPatch className="bottom-5 left-1 h-16 w-12" fade="top-right" />
      ) : (
        <DotPatch className={kind === 'completeness' ? 'right-3 top-6 h-10 w-20' : 'right-3 top-8 h-16 w-28'} />
      )}
    </div>
  )
}
