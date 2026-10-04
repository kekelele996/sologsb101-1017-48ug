/**
 * 出炉检验（Inspect）—— 检验室留存的那份单子
 * 管检验结论、缺陷说明与返工退回哪道工序；不管吹制工序的温度、时长、操作人。
 * 判定不合格时生成返工提示，按「作品 + 道次序号」对账到具体工序，原始工序记录保留不变。
 */
import type { Step, StepState } from './step'

/** 检验结果：合格 / 裂纹 / 气泡 / 变形 */
export type InspectResult = '合格' | '裂纹' | '气泡' | '变形'

export const INSPECT_RESULT_OPTIONS: InspectResult[] = ['合格', '裂纹', '气泡', '变形']

/**
 * 返工状态（由检验记录与工序记录按「作品 + 道次序号」对账派生，不单独落库）
 * - 无：合格，不返工
 * - 待返工：已指定退回道次，且该道次尚未重新完成
 * - 已挂起：指定的道次对不上（工序被删 / 序号重排后不存在该 seq），等人工确认
 * - 已完成：退回的道次已重新推进到「已完成」
 * - 只读：升级前的老返工记录，只记在作品上、拆不到具体道次，保留原样不可改
 */
export type ReworkStatus = '无' | '待返工' | '已挂起' | '已完成' | '只读'

export const REWORK_STATUS_OPTIONS: ReworkStatus[] = ['无', '待返工', '已挂起', '已完成', '只读']

/** 返工对账结果：一条检验记录 + 它指向的具体工序（可能对不上） */
export interface ReworkReconcile {
  inspect: Inspect
  status: ReworkStatus
  /** 对账命中的工序；对不上时为 null（挂起） */
  target: Step | null
}

export interface Inspect {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 检验结果 */
  result: InspectResult
  /** 缺陷说明 */
  defectNote: string
  /** 检验人 */
  inspector: string
  /** 检验日期 YYYY-MM-DD */
  date: string
  /**
   * 返工退回的道次序号（吹制工序的 seq）。
   * null 表示不返工（合格）或老记录未结构化。
   * 与 pieceId 一起作为对账键，工序重排后按此序号重新对账。
   */
  reworkStepSeq: number | null
  /**
   * 升级前的老返工记录标记：只记在作品上、拆不到具体道次。
   * 这类记录保留原样、只读，不可编辑 / 改派 / 删除。
   */
  legacyReadonly: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑出炉检验的表单草稿 */
export interface InspectDraft {
  pieceId: string
  result: InspectResult
  defectNote: string
  inspector: string
  date: string
  /** 返工退回道次序号；合格时为 null */
  reworkStepSeq: number | null
}

/**
 * 由检验记录与工序列表按「作品 + 道次序号」对账，派生返工状态。
 * 纯函数：不写库，状态随时可重算。
 */
export function deriveReworkStatus(inspect: Inspect, steps: Step[]): ReworkStatus {
  if (inspect.legacyReadonly) return '只读'
  if (inspect.result === '合格') return '无'
  const seq = inspect.reworkStepSeq
  if (seq === null || seq === undefined) return '已挂起'
  const target = steps.find((row) => row.pieceId === inspect.pieceId && row.seq === seq) ?? null
  if (target === null) return '已挂起'
  if (target.state === '已完成') return '已完成'
  return '待返工'
}

/** 对账：返回检验记录指向的具体工序（按作品 + 道次序号），对不上返回 null */
export function findReworkTarget(inspect: Inspect, steps: Step[]): Step | null {
  if (inspect.result === '合格' || inspect.legacyReadonly) return null
  const seq = inspect.reworkStepSeq
  if (seq === null || seq === undefined) return null
  return steps.find((row) => row.pieceId === inspect.pieceId && row.seq === seq) ?? null
}

/** 工序状态是否需要返工（未重新完成） */
export function stepNeedsRework(step: Step | null): boolean {
  return step !== null && step.state !== '已完成'
}

/** 解析老返工备注里隐含的道次序号：先认「第N道」，再认工序名称 */
export function parseReworkSeqFromNote(note: string, steps: Step[]): number | null {
  const seqMatch = note.match(/第\s*(\d+)\s*道/)
  if (seqMatch !== null) {
    const seq = Number.parseInt(seqMatch[1], 10)
    if (steps.some((row) => row.seq === seq)) return seq
  }
  for (const row of steps) {
    if (note.includes(row.name)) return row.seq
  }
  return null
}

/** 返工状态对应的标签色调（Element Plus tag type） */
export function reworkStatusTagType(status: ReworkStatus): '' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case '已完成':
      return 'success'
    case '待返工':
      return 'warning'
    case '已挂起':
      return 'danger'
    case '只读':
      return 'info'
    case '无':
    default:
      return 'info'
  }
}

/** 返工状态的中文说明 */
export function reworkStatusHint(status: ReworkStatus, target: Step | null): string {
  switch (status) {
    case '无':
      return '合格归档，不返工'
    case '待返工':
      return target === null
        ? '返工进行中'
        : `退回第 ${target.seq} 道「${target.name}」返工，该道次重新完成前不能进入退火排位`
    case '已挂起':
      return '指定的返工道次对不上（工序可能已被删除或重排），请确认退回道次后再执行'
    case '已完成':
      return target === null ? '返工已完成' : `第 ${target.seq} 道「${target.name}」已重新完成`
    case '只读':
      return '升级前的老返工记录，只记在作品上、拆不到具体道次，保留原样不可修改'
  }
}

/** 供外部判断某工序状态是否为「返工中」（重新打开的已完成道次） */
export function isReopenedState(state: StepState): boolean {
  return state === '进行中'
}
