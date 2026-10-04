/**
 * 吹制工序（Step）
 * 逐道记录温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 */

/** 工序名称 */
export type StepName = '取料' | '吹制' | '塑形' | '开模' | '收口'

/** 工序执行状态 */
export type StepState = '未开始' | '进行中' | '已完成'

export const STEP_NAME_OPTIONS: StepName[] = ['取料', '吹制', '塑形', '开模', '收口']
export const STEP_STATE_OPTIONS: StepState[] = ['未开始', '进行中', '已完成']

export interface Step {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 工序序号，从 1 开始 */
  seq: number
  /** 工序名称 */
  name: StepName
  /** 工序温度（℃） */
  tempC: number
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 备注 */
  remark: string
  /** 工序状态 */
  state: StepState
  /**
   * 返工标记（只由吹制工序台维护）：检验室把返工点到这道后，
   * 工序台「领取返工」时置为 true，合格复检关闭返工后清除。
   * 已有的温度 / 时长 / 操作人记录保留不变，这里只标记返工生命周期。
   */
  reworkMark: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑吹制工序的表单草稿 */
export interface StepDraft {
  pieceId: string
  seq: number
  name: StepName
  tempC: number
  durationMin: number
  operator: string
  remark: string
  state: StepState
}
