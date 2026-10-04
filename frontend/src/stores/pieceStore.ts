/**
 * 作品与工序状态管理（Pinia）
 * 维护作品列表、当前作品与当前作品的工序；工序状态由 db.syncPieceState 联动作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Craft, Piece, PieceDraft, PieceState } from '../types/piece'
import type { Step, StepDraft } from '../types/step'
import type { Inspect, ReworkStatus } from '../types/inspect'
import { deriveReworkStatus, findReworkTarget } from '../types/inspect'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  initDatabase,
  putPiece,
  putStep,
  removePiece,
  removeStep,
  reorderSteps,
  reworkStep as reworkStepDb,
  syncPieceState,
} from '../utils/db'
import { withRetry } from '../utils/retry'
import { buildStepProgress, type StepProgress } from '../hooks/useStepProgress'
import { nowIso, uuid } from '../utils/id'

/** 作品筛选条件 */
export interface PieceFilters {
  keyword: string
  craft: Craft | 'all'
  state: PieceState | 'all'
}

const EMPTY_FILTERS: PieceFilters = { keyword: '', craft: 'all', state: 'all' }

const CURRENT_PIECE_KEY = 'gbglassblow:currentPieceId'

function readCurrentPieceId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PIECE_KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeCurrentPieceId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PIECE_KEY, id ?? '')
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

let subscribed = false

export const usePieceStore = defineStore('piece', () => {
  const pieces = ref<Piece[]>([])
  const steps = ref<Step[]>([])
  const inspects = ref<Inspect[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const currentPieceId = ref<string | null>(readCurrentPieceId())
  const filters = reactive<PieceFilters>({ ...EMPTY_FILTERS })

  const currentPiece = computed<Piece | null>(
    () => pieces.value.find((row) => row.id === currentPieceId.value) ?? null
  )

  const visiblePieces = computed<Piece[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return pieces.value.filter((piece) => {
      if (filters.craft !== 'all' && piece.craft !== filters.craft) return false
      if (filters.state !== 'all' && piece.state !== filters.state) return false
      if (keyword === '') return true
      return (
        piece.name.toLowerCase().includes(keyword) ||
        piece.artist.toLowerCase().includes(keyword) ||
        piece.craft.toLowerCase().includes(keyword)
      )
    })
  })

  function stepsOf(pieceId: string): Step[] {
    return steps.value.filter((row) => row.pieceId === pieceId).sort((a, b) => a.seq - b.seq)
  }

  /**
   * 某件作品的返工对账：把检验室的不合格记录按「作品 + 道次序号」对上工序台的具体工序。
   * 只返回指定了返工道次的不合格记录；状态由两边数据实时派生，不单独落库。
   */
  function reworksOf(pieceId: string): Array<{ inspect: Inspect; status: ReworkStatus; target: Step | null }> {
    const pieceSteps = steps.value.filter((row) => row.pieceId === pieceId)
    return inspects.value
      .filter((row) => row.pieceId === pieceId && row.result !== '合格' && row.reworkStepSeq !== null)
      .map((row) => ({
        inspect: row,
        status: deriveReworkStatus(row, pieceSteps),
        target: findReworkTarget(row, pieceSteps),
      }))
  }

  /** 某道工序是否被返工指向（且尚未重新完成），供工序台打「返工」标记 */
  function stepNeedsRework(pieceId: string, seq: number): boolean {
    return reworksOf(pieceId).some((row) => row.status === '待返工' && row.target?.seq === seq)
  }

  function progressOf(pieceId: string): StepProgress {
    return buildStepProgress(pieceId, steps.value)
  }

  const inProgressCount = computed<number>(
    () => pieces.value.filter((row) => row.state === '设计中' || row.state === '制作中').length
  )

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [pieceRows, stepRows, inspectRows] = await Promise.all([
            db.pieces.toArray(),
            db.steps.toArray(),
            db.inspects.toArray(),
          ])
          return { pieceRows, stepRows, inspectRows }
        }).subscribe({
          next: ({ pieceRows, stepRows, inspectRows }) => {
            const sorted = [...pieceRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            pieces.value = sorted
            steps.value = [...stepRows].sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
            inspects.value = [...inspectRows].sort((a, b) => b.date.localeCompare(a.date))
            loading.value = false
            ready.value = true
            error.value = ''
            const stillExists =
              currentPieceId.value !== null && sorted.some((row) => row.id === currentPieceId.value)
            if (!stillExists) {
              selectPiece(sorted.length > 0 ? sorted[0].id : null)
            }
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取作品数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function selectPiece(pieceId: string | null): void {
    currentPieceId.value = pieceId
    writeCurrentPieceId(pieceId)
  }

  function setFilters(patch: Partial<PieceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createPiece(draft: PieceDraft): Promise<Piece> {
    const stamp = nowIso()
    const row: Piece = {
      id: uuid('piece'),
      name: draft.name.trim() || '未命名作品',
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putPiece(row)
    selectPiece(row.id)
    revision.value += 1
    lastMessage.value = `已登记作品「${row.name}」，可继续录入吹制工序`
    return row
  }

  async function updatePiece(pieceId: string, draft: PieceDraft): Promise<void> {
    const existing = pieces.value.find((row) => row.id === pieceId)
    if (existing === undefined) return
    await putPiece({
      ...existing,
      name: draft.name.trim() || existing.name,
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
    })
    revision.value += 1
  }

  async function deletePiece(pieceId: string): Promise<void> {
    await removePiece(pieceId)
    if (currentPieceId.value === pieceId) selectPiece(null)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '作品及其工序、退火与检验记录已删除'
  }

  /* ------------------------------ 工序 ------------------------------ */

  async function createStep(draft: StepDraft): Promise<Step> {
    const stamp = nowIso()
    const row: Step = {
      id: uuid('step'),
      pieceId: draft.pieceId,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    // 工序台保存：失败只重试本侧（putStep 内部只写 steps + 作品状态），检验室那份不动
    await withRetry(() => putStep(row))
    revision.value += 1
    return row
  }

  async function updateStep(stepId: string, draft: StepDraft): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    await withRetry(() =>
      putStep({
        ...existing,
        seq: draft.seq,
        name: draft.name,
        tempC: draft.tempC,
        durationMin: draft.durationMin,
        operator: draft.operator.trim(),
        remark: draft.remark.trim(),
        state: draft.state,
      }),
    )
    revision.value += 1
  }

  async function deleteStep(stepId: string): Promise<void> {
    await withRetry(() => removeStep(stepId))
    revision.value += 1
    lastMessage.value = '工序已删除，作品状态已重新推导'
  }

  /** 推进工序状态：未开始 → 进行中 → 已完成 */
  async function advanceStep(stepId: string): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    const flow: Step['state'][] = ['未开始', '进行中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) {
      lastMessage.value = '该工序已处于「已完成」状态'
      return
    }
    const next = flow[index + 1]
    await withRetry(() => putStep({ ...existing, state: next }))
    revision.value += 1
    const piece = pieces.value.find((row) => row.id === existing.pieceId)
    lastMessage.value = `第 ${existing.seq} 道「${existing.name}」已推进为「${next}」${
      piece === undefined ? '' : `（作品：${piece.name}）`
    }`
  }

  /**
   * 工序台按检验室指定的道次返工：只重开被点中的那一道，前面已确认的工序记录不抹掉。
   * 失败按本侧重试（只重试工序侧写操作），检验室那份不动。
   * 返回 null 表示该道次对不上（工序被删 / 序号重排），检验室那笔已挂起等确认。
   */
  async function reworkStep(pieceId: string, seq: number): Promise<Step | null> {
    const target = await withRetry(() => reworkStepDb(pieceId, seq))
    if (target === null) {
      lastMessage.value = `第 ${seq} 道返工对不上工序（可能已被删除或重排），检验室那笔已挂起，请确认退回道次`
      return null
    }
    revision.value += 1
    const piece = pieces.value.find((row) => row.id === pieceId)
    lastMessage.value = `已按检验室要求退回第 ${seq} 道「${target.name}」返工，前面已确认的工序记录保留不变${
      piece === undefined ? '' : `（作品：${piece.name}）`
    }`
    return target
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveStepBefore(pieceId: string, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === fromId)
    const toIndex = list.findIndex((row) => row.id === toId)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    await withRetry(() => reorderSteps(list.map((row) => row.id)))
    revision.value += 1
    lastMessage.value = `已调整工序顺序：「${moved.name}」移动到第 ${toIndex + 1} 道`
  }

  /** 按序号升序重排（拖拽置顶/置底等场景） */
  async function moveStepToIndex(pieceId: string, stepId: string, targetIndex: number): Promise<void> {
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === stepId)
    if (fromIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    const index = Math.max(0, Math.min(list.length, targetIndex))
    list.splice(index, 0, moved)
    await withRetry(() => reorderSteps(list.map((row) => row.id)))
    revision.value += 1
    lastMessage.value = `已把「${moved.name}」调整到第 ${index + 1} 道`
  }

  /** 依工序与退火记录重新推导作品状态 */
  async function resyncPieceState(pieceId: string): Promise<void> {
    const next = await syncPieceState(pieceId)
    revision.value += 1
    if (next !== null) lastMessage.value = `作品状态已重新推导为「${next}」`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    pieces,
    steps,
    inspects,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    currentPieceId,
    currentPiece,
    visiblePieces,
    inProgressCount,
    stepsOf,
    progressOf,
    reworksOf,
    stepNeedsRework,
    loadAll,
    selectPiece,
    setFilters,
    resetFilters,
    createPiece,
    updatePiece,
    deletePiece,
    createStep,
    updateStep,
    deleteStep,
    advanceStep,
    reworkStep,
    moveStepBefore,
    moveStepToIndex,
    resyncPieceState,
    refreshCounts,
  }
})
