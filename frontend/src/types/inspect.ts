/**
 * 出炉检验（Inspect）—— 检验室账本
 * 检验室只登记：检验结论、缺陷说明、返工退回哪一道工序。
 * 工序的温度 / 时长 / 操作人属于吹制工序台，绝不写进检验记录。
 *
 * 返工挂在具体的（作品 + 道次序号）上：
 * - 只退回被点中的那道工序，前面已确认的工序记录原样保留；
 * - 两边按「作品 + 道次序号」对账，对不上先把返工挂起等确认；
 * - 旧数据升级时按当时的道次顺序拆到具体道次，对不上的老记录只读保留。
 */

/** 检验结果：合格 / 裂纹 / 气泡 / 变形 */
export type InspectResult = '合格' | '裂纹' | '气泡' | '变形'

export const INSPECT_RESULT_OPTIONS: InspectResult[] = ['合格', '裂纹', '气泡', '变形']

/** 返工生命周期阶段（由检验记录与工序台记录共同对账派生，不单独落库） */
export type ReworkPhase =
  | '无返工' // 合格检验或已关闭的返工
  | '待接收' // 检验室刚判返工，工序台尚未领取
  | '返工中' // 工序台已领取，被点中的道次重开
  | '待复检' // 该道返工重做完成，等检验室复检
  | '挂起' // 作品 + 道次对不上，挂起等人工确认
  | '只读老记录' // 升级时拆不到具体道次的旧返工，只读保留

export interface Inspect {
  id: string
  /** 所属作品（对账键之一） */
  pieceId: string
  /** 检验结果 / 检验结论 */
  result: InspectResult
  /** 缺陷说明 */
  defectNote: string
  /** 检验人 */
  inspector: string
  /** 检验日期 YYYY-MM-DD */
  date: string

  /* ----------------------------- 返工指向（检验室填写） ----------------------------- */
  /**
   * 返工退回的道次序号（对账键之二）；合格检验为 0。
   * 返工只退回这一道，不影响前面已确认的工序记录。
   */
  reworkStepSeq: number
  /**
   * 判定返工时锚定的工序 id。
   * 道次重排后用它识别「同一道工序挪了位置」：id 命中但 seq 对不上 → 挂起等确认。
   * 合格检验为空串；旧数据升级拆不出来时也为空串。
   */
  reworkStepId: string
  /** 返工是否已由后续合格复检关闭 */
  reworkClosed: boolean
  /** 关闭该返工的合格检验 id（追溯用） */
  reworkClosedBy: string
  /** 旧数据升级标记：true 表示来自 v2 及以前、返工原先只记在作品上的老记录 */
  legacy: boolean

  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑出炉检验的表单草稿（检验室职责范围内的字段） */
export interface InspectDraft {
  pieceId: string
  result: InspectResult
  defectNote: string
  inspector: string
  date: string
  /** 返工退回的道次序号；合格时传 0 */
  reworkStepSeq: number
}

/** 合格结论的占位道次序号 */
export const NO_REWORK_SEQ = 0
