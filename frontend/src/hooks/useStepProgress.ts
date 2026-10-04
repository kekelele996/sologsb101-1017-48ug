/**
 * 工序进度派生 hook
 * 统计某作品的工序完成度与当前道次，返回响应式进度，被工序页与退火页消费。
 * 同时订阅检验室记录做返工对账：未平的返工会阻断推进与退火排位。
 */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import { liveQuery } from 'dexie'
import type { Step } from '../types/step'
import type { Inspect, ReworkPhase } from '../types/inspect'
import { db, initDatabase } from '../utils/db'
import { openReworks, reworkBlockReason, type ReworkStatus } from '../utils/rework'

/** 返工对账结果（附带对应检验记录） */
export interface OpenRework extends ReworkStatus {
  inspect: Inspect
  /** 展示用阶段 */
  phaseLabel: string
}

/** 工序进度派生结果 */
export interface StepProgress {
  pieceId: string
  /** 工序总数 */
  total: number
  /** 已完成道数 */
  done: number
  /** 进行中道数 */
  inProgress: number
  /** 未开始道数 */
  pending: number
  /** 完成度（0–100，按道次计） */
  pct: number
  /** 当前道次序号（第一个未完成的工序） */
  currentSeq: number
  /** 当前道次名称 */
  currentName: string
  /** 是否所有工序均已完成（可进入退火排位） */
  allDone: boolean
  /** 阻断原因；可进入退火时为空串 */
  blockReason: string
  /** 累计工时（分钟） */
  totalMinutes: number
  /** 该作品未平的返工（待接收 / 返工中 / 待复检 / 挂起） */
  openReworks: OpenRework[]
  /** 是否存在返工（含挂起） */
  hasRework: boolean
  /** 是否有挂起待确认的返工 */
  hasSuspendedRework: boolean
  /** 返工导致的推进 / 退火阻断原因；无返工时为空串 */
  reworkBlockReason: string
}

/** 空进度，用于作品不存在或尚无工序时兜底，避免页面白屏 */
export function emptyProgress(pieceId: string): StepProgress {
  return {
    pieceId,
    total: 0,
    done: 0,
    inProgress: 0,
    pending: 0,
    pct: 0,
    currentSeq: 0,
    currentName: '',
    allDone: false,
    blockReason: '尚未登记任何吹制工序',
    totalMinutes: 0,
    openReworks: [],
    hasRework: false,
    hasSuspendedRework: false,
    reworkBlockReason: '',
  }
}

const REWORK_PHASE_LABEL: Record<ReworkPhase, string> = {
  无返工: '',
  待接收: '待工序台领取',
  返工中: '返工中',
  待复检: '待检验室复检',
  挂起: '挂起待确认',
  只读老记录: '只读老记录',
}

/** 纯函数：由工序列表与检验记录派生进度（含返工对账） */
export function buildStepProgress(pieceId: string, steps: Step[], inspects: Inspect[] = []): StepProgress {
  const list = steps
    .filter((row) => row.pieceId === pieceId)
    .slice()
    .sort((a, b) => a.seq - b.seq)

  const reworkList: OpenRework[] = openReworks(pieceId, inspects, steps).map((row) => ({
    ...row,
    phaseLabel: REWORK_PHASE_LABEL[row.phase],
  }))
  const suspended = reworkList.some((row) => row.phase === '挂起')
  const reworkReason = reworkBlockReason(pieceId, inspects, steps)

  if (list.length === 0) {
    return { ...emptyProgress(pieceId), openReworks: reworkList, hasRework: reworkList.length > 0, hasSuspendedRework: suspended, reworkBlockReason: reworkReason }
  }

  const done = list.filter((row) => row.state === '已完成').length
  const inProgress = list.filter((row) => row.state === '进行中').length
  const pending = list.filter((row) => row.state === '未开始').length
  const current = list.find((row) => row.state !== '已完成') ?? null
  const firstUnfinishedIndex = list.findIndex((row) => row.state !== '已完成')

  // 任一前序未完成即阻断进入退火排位
  let blockReason = ''
  if (done < list.length) {
    const blockedBy = list.slice(0, firstUnfinishedIndex).find((row) => row.state !== '已完成')
    blockReason =
      blockedBy === undefined
        ? `第 ${current?.seq ?? list.length} 道「${current?.name ?? '未命名'}」尚未完成（当前状态：${current?.state ?? '未开始'}）`
        : `前序第 ${blockedBy.seq} 道「${blockedBy.name}」未完成，不能进入退火排位`
  }
  // 返工未平（含挂起）同样阻断退火排位
  if (blockReason === '' && reworkReason !== '') blockReason = reworkReason

  return {
    pieceId,
    total: list.length,
    done,
    inProgress,
    pending,
    pct: Math.round((done / list.length) * 1000) / 10,
    currentSeq: current === null ? list.length : current.seq,
    currentName: current === null ? '全部工序已完成' : current.name,
    allDone: done === list.length && reworkList.length === 0,
    blockReason,
    totalMinutes: Math.round(list.reduce((acc, row) => acc + row.durationMin, 0) * 10) / 10,
    openReworks: reworkList,
    hasRework: reworkList.length > 0,
    hasSuspendedRework: suspended,
    reworkBlockReason: reworkReason,
  }
}

export interface UseStepProgressResult {
  progress: ComputedRef<StepProgress>
  steps: Ref<Step[]>
  loading: Ref<boolean>
  error: Ref<string>
}

/**
 * 订阅全部工序与检验记录并派生指定作品的工序进度（含返工对账）。
 * pieceId 为 null 时返回空进度，调用方可据此渲染友好空态。
 */
export function useStepProgress(pieceId: Ref<string | null> | string | null): UseStepProgressResult {
  const idRef = computed<string | null>(() => (typeof pieceId === 'string' || pieceId === null ? pieceId : pieceId.value))

  const steps = ref<Step[]>([])
  const inspects = ref<Inspect[]>([])
  const loading = ref(true)
  const error = ref('')

  void initDatabase()
  const subscription = liveQuery(async () => {
    await initDatabase()
    const [stepRows, inspectRows] = await Promise.all([db.steps.toArray(), db.inspects.toArray()])
    return { stepRows, inspectRows }
  }).subscribe({
    next: ({ stepRows, inspectRows }) => {
      steps.value = stepRows
      inspects.value = inspectRows
      loading.value = false
      error.value = ''
    },
    error: (err: unknown) => {
      error.value = err instanceof Error ? err.message : '读取工序数据失败'
      loading.value = false
    },
  })

  onScopeDispose(() => {
    subscription.unsubscribe()
  })

  const progress = computed<StepProgress>(() => {
    const id = idRef.value
    if (id === null || id === '') return emptyProgress('')
    return buildStepProgress(id, steps.value, inspects.value)
  })

  return { progress, steps, loading, error }
}
