/**
 * 返工对账（检验室 ↔ 吹制工序台）
 *
 * 两边各记各的账：
 * - 检验室：检验结论、缺陷说明、返工退回哪道工序（作品 + 道次序号 + 锚定工序 id）；
 * - 工序台：每道工序的温度、时长、操作人，以及本侧的 reworkMark。
 *
 * 对账键：pieceId + reworkStepSeq；reworkStepId 作为重排识别锚点。
 * 对不上的返工先挂起等确认，不允许自动落到别的道次。
 */
import type { Inspect, ReworkPhase } from '../types/inspect'
import type { Step } from '../types/step'

export interface ReworkStatus {
  /** 返工生命周期阶段 */
  phase: ReworkPhase
  /** 对账命中的当前工序；挂起 / 无命中 / 无返工时为 null */
  targetStep: Step | null
  /** 对账说明（可直接展示给两边的人看） */
  reason: string
}

const NONE: ReworkStatus = { phase: '无返工', targetStep: null, reason: '' }

/**
 * 按「作品 + 道次序号」对一条检验记录做返工对账。
 * 纯函数：不读写任何数据，只根据检验记录与工序台现状派生阶段。
 */
export function reconcileInspect(inspect: Inspect, steps: Step[]): ReworkStatus {
  if (inspect.result === '合格') {
    return NONE
  }

  // 旧数据升级时拆不到具体道次的老记录（无锚点 id）：只读保留，不参与流转。
  // 必须先于 reworkStepSeq<=0 的兜底判断，否则这类记录会被误当成「无返工」。
  if (inspect.legacy && inspect.reworkStepId === '') {
    return {
      phase: '只读老记录',
      targetStep: null,
      reason: '旧返工只记在作品上，升级时未能按当时道次顺序拆分，保留为只读记录',
    }
  }

  if (inspect.reworkStepSeq <= 0) {
    return { phase: '挂起', targetStep: null, reason: '返工未点中具体道次，请检验室补登退回道次' }
  }

  const pieceSteps = steps
    .filter((step) => step.pieceId === inspect.pieceId)
    .slice()
    .sort((a, b) => a.seq - b.seq)

  // 已关闭：后续合格复检已确认，不再阻断工序台
  if (inspect.reworkClosed) {
    const closedAt = pieceSteps.find((step) => step.seq === inspect.reworkStepSeq)
    return { phase: '无返工', targetStep: closedAt ?? null, reason: '' }
  }

  const bySeq = pieceSteps.find((step) => step.seq === inspect.reworkStepSeq)
  const pinned = inspect.reworkStepId === '' ? undefined : pieceSteps.find((step) => step.id === inspect.reworkStepId)

  // ---------- 对账：作品 + 道次序号（+ 锚定 id） ----------
  if (pinned === undefined) {
    // 升级拆分出来但能按当时道次顺序对上：视为正常返工
    if (bySeq !== undefined) {
      return liveStatus(bySeq, '')
    }
    if (pieceSteps.length === 0) {
      return { phase: '挂起', targetStep: null, reason: '该作品在工序台查不到任何道次，返工先挂起等确认' }
    }
    return {
      phase: '挂起',
      targetStep: null,
      reason: `点中的第 ${inspect.reworkStepSeq} 道在工序台不存在（现有 ${pieceSteps.length} 道），返工先挂起等确认`,
    }
  }

  // 锚定工序还在，但道次序号已因重排变化：不允许自动落到别的道次
  if (pinned.seq !== inspect.reworkStepSeq) {
    return {
      phase: '挂起',
      targetStep: pinned,
      reason: `被点中的「${pinned.name}」已从第 ${inspect.reworkStepSeq} 道移到第 ${pinned.seq} 道，返工先挂起，等检验室确认后再退回`,
    }
  }

  // 序号位置上是另一道工序（锚点不在原位、原位换了别的道次）
  if (bySeq !== undefined && bySeq.id !== pinned.id) {
    return {
      phase: '挂起',
      targetStep: pinned,
      reason: `第 ${inspect.reworkStepSeq} 道现在是「${bySeq.name}」，原被点中的「${pinned.name}」已移位，返工先挂起等确认`,
    }
  }

  return liveStatus(pinned, '')
}

/** 对一条作品的全部检验记录逐条对账 */
export function reconcilePiece(pieceId: string, inspects: Inspect[], steps: Step[]): ReworkStatus[] {
  return inspects
    .filter((row) => row.pieceId === pieceId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => reconcileInspect(row, steps))
}

/** 该作品当前所有未关闭的返工（含待接收 / 返工中 / 待复检 / 挂起） */
export function openReworks(pieceId: string, inspects: Inspect[], steps: Step[]): Array<ReworkStatus & { inspect: Inspect }> {
  return inspects
    .filter((row) => row.pieceId === pieceId)
    .map((inspect) => ({ inspect, status: reconcileInspect(inspect, steps) }))
    .filter((entry) => entry.status.phase !== '无返工' && entry.status.phase !== '只读老记录')
    .map((entry) => ({ inspect: entry.inspect, ...entry.status }))
}

/** 工序台推进/退火阻断判定：有未平的返工时返回阻断原因，否则返回空串 */
export function reworkBlockReason(pieceId: string, inspects: Inspect[], steps: Step[]): string {
  const open = openReworks(pieceId, inspects, steps)
  if (open.length === 0) return ''
  const suspended = open.find((row) => row.phase === '挂起')
  if (suspended !== undefined) return `返工对账未平（第 ${suspended.inspect.reworkStepSeq} 道）：${suspended.reason}`
  const target = open[0]
  return `第 ${target.inspect.reworkStepSeq} 道返工尚未${target.phase === '待复检' ? '复检关闭' : '完成'}（当前：${target.phase}）`
}

/** 判定工序台能否推进某一道工序 */
export function canAdvanceStep(
  pieceId: string,
  stepId: string,
  inspects: Inspect[],
  steps: Step[],
): { allowed: boolean; reason: string } {
  const open = openReworks(pieceId, inspects, steps)
  if (open.length === 0) return { allowed: true, reason: '' }
  const suspended = open.find((row) => row.phase === '挂起')
  if (suspended !== undefined) {
    return { allowed: false, reason: `返工挂起中：${suspended.reason}` }
  }
  const rework = open.find((row) => row.targetStep?.id === stepId)
  if (rework === undefined) {
    const any = open[0]
    return {
      allowed: false,
      reason:
        any.phase === '待复检'
          ? `第 ${any.inspect.reworkStepSeq} 道返工待检验室复检关闭，其余道次暂不能推进`
          : `第 ${any.inspect.reworkStepSeq} 道有返工未完成，前面确认过的工序保持不动，先处理被点中的道次`,
    }
  }
  // 被点中的这道：待接收时不能直接「推进状态」，必须先领取返工（重开）
  if (rework.phase === '待接收') {
    return { allowed: false, reason: '这道被检验室点了返工，请先「领取返工」重开本道，再重做推进' }
  }
  // 返工中：本道可推进到完成（完成后进入待复检）；待复检：等检验室，不再推进
  if (rework.phase === '返工中') return { allowed: true, reason: '' }
  return { allowed: false, reason: '返工已重做完成，等待检验室复检关闭' }
}

function liveStatus(step: Step, reason: string): ReworkStatus {
  if (!step.reworkMark) {
    return { phase: '待接收', targetStep: step, reason }
  }
  if (step.state === '已完成') {
    return { phase: '待复检', targetStep: step, reason }
  }
  return { phase: '返工中', targetStep: step, reason }
}
