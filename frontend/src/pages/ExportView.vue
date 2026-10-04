<script setup lang="ts">
/**
 * /export 出炉检验登记与 JSON 结构版本导入导出（质检台账）
 * 检验挂到「那一炉」（已出炉退火记录）上；不合格生成返工提示与重烧请求（不打断在烧的炉）。
 * 质检台账落账失败按本侧重试，排产台账不动；对不上窑位的老记录只读。
 * 复用组件：<StatBadge>、<EmptyPanel>、<StageTag>、<FilterBar>、<ReconcilePanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import ReconcilePanel from '@/components/common/ReconcilePanel.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { useInspectStore } from '@/stores/inspectStore'
import { useReworkStore } from '@/stores/reworkStore'
import { DB_NAME, DB_SCHEMA_VERSION, exportSnapshot, importSnapshot, resetDatabase } from '@/utils/db'
import { exportScheduleCsvFile, exportSnapshotJson, parseSnapshot } from '@/utils/export'
import { reconcile } from '@/utils/reconcile'
import { INSPECT_RESULT_OPTIONS, needsRework, type Inspect, type InspectDraft, type InspectResult } from '@/types/inspect'
import type { ReworkRequest } from '@/types/rework'
import { today } from '@/utils/id'

const router = useRouter()
const pieceStore = usePieceStore()
const annealStore = useAnnealStore()
const furnaceStore = useFurnaceStore()
const inspectStore = useInspectStore()
const reworkStore = useReworkStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const keyword = ref('')
const resultFilter = ref<InspectResult | 'all'>('all')
const formRef = ref<FormInstance>()

const form = reactive<InspectDraft>({
  pieceId: '',
  annealId: '',
  result: '合格',
  defectNote: '',
  inspector: '',
  date: today(),
})

const rules = computed<FormRules<InspectDraft>>(() => ({
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  annealId: [{ required: true, message: '请选择被检验的那一炉（已出炉退火记录）', trigger: 'change' }],
  result: [{ required: true, message: '请选择检验结果', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检验人', trigger: 'blur' }],
  date: [{ required: true, message: '请选择检验日期', trigger: 'change' }],
  defectNote: form.result === '合格' ? [] : [{ required: true, message: '判定不合格时必须填写缺陷说明', trigger: 'blur' }],
}))

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`])),
)

/** 所选作品可检验的炉次：已出炉的退火记录（按出炉时间倒序） */
const annealOptions = computed(() => {
  if (form.pieceId === '') return []
  return annealStore.anneals
    .filter((row) => row.pieceId === form.pieceId && row.state === '已出炉')
    .sort((a, b) => b.outAt.localeCompare(a.outAt))
})

/** 切换作品时重置炉次选择 */
function onPieceChange(): void {
  form.annealId = ''
}

const filtered = computed<Inspect[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return inspectStore.inspects
    .filter((row) => {
      if (resultFilter.value !== 'all' && row.result !== resultFilter.value) return false
      if (key === '') return true
      return (
        (pieceLabel.value[row.pieceId] ?? '').toLowerCase().includes(key) ||
        row.inspector.toLowerCase().includes(key) ||
        row.defectNote.toLowerCase().includes(key) ||
        row.kilnSlot.toLowerCase().includes(key)
      )
    })
    .sort((a, b) => b.date.localeCompare(a.date))
})

/** 排产台账与质检台账按「作品 + 窑位」对账 */
const reconcileResult = computed(() => reconcile(annealStore.anneals, inspectStore.inspects, pieceStore.pieces))

/** 检验记录 → 重烧请求（按 sourceInspectId 关联） */
const reworkByInspect = computed<Record<string, ReworkRequest>>(() =>
  Object.fromEntries(reworkStore.reworks.map((row) => [row.sourceInspectId, row])),
)

const stats = computed(() => {
  const total = inspectStore.inspects.length
  const pass = inspectStore.inspects.filter((row) => row.result === '合格').length
  const defect = total - pass
  return {
    total,
    pass,
    defect,
    passPct: total === 0 ? 0 : Math.round((pass / total) * 1000) / 10,
    inProgress: pieceStore.pieces.filter((row) => row.state === '设计中' || row.state === '制作中').length,
    occupancyRate: annealStore.occupancyRate,
  }
})

onMounted(() => {
  void pieceStore.loadAll()
  void annealStore.loadAll()
  void furnaceStore.loadAll()
  void inspectStore.loadAll()
  void reworkStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    annealId: '',
    result: '合格' as InspectResult,
    defectNote: '',
    inspector: '',
    date: today(),
  })
  dialogVisible.value = true
}

function openEdit(row: Inspect): void {
  if (row.readonly) {
    ElMessage.warning('该检验记录为升级前的老数据（未挂窑位），只读，不可编辑。')
    return
  }
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    annealId: row.annealId,
    result: row.result,
    defectNote: row.defectNote,
    inspector: row.inspector,
    date: row.date,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await inspectStore.createInspect({ ...form })
      if (row === null) {
        ElMessage.error(inspectStore.error || '检验登记失败')
        return
      }
      ElMessage.success(inspectStore.lastMessage)
    } else {
      const ok = await inspectStore.updateInspect(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(inspectStore.error || '检验更新失败')
        return
      }
      ElMessage.success('检验记录已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleRetry(): Promise<void> {
  const row = await inspectStore.retryLastFailed()
  if (row === null) {
    ElMessage.error(inspectStore.error || '重试失败')
    return
  }
  ElMessage.success(inspectStore.lastMessage)
}

async function handleDelete(row: Inspect): Promise<void> {
  if (row.readonly) {
    ElMessage.warning('该检验记录为升级前的老数据（未挂窑位），只读，不可删除。')
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的检验记录（${row.result}）？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const ok = await inspectStore.removeInspect(row.id)
  if (!ok) {
    ElMessage.error(inspectStore.error || '删除失败')
    return
  }
  ElMessage.success('检验记录已删除')
}

async function handleExportJson(): Promise<void> {
  const snapshot = await exportSnapshot()
  const filename = exportSnapshotJson(snapshot)
  ElMessage.success(`已导出整库存档 ${filename}`)
}

function handleExportCsv(): void {
  const filename = exportScheduleCsvFile(
    furnaceStore.furnaces,
    furnaceStore.batches,
    pieceStore.pieces,
    pieceStore.steps,
    annealStore.anneals,
    inspectStore.inspects,
  )
  ElMessage.success(`已导出窑务排产汇总 ${filename}`)
}

async function handleImport(uploadFile: UploadFile): Promise<void> {
  const raw = uploadFile.raw
  if (raw === undefined) return
  const text = await raw.text()
  const result = parseSnapshot(text)
  if (!result.ok || result.snapshot === null) {
    ElMessage.error(result.message)
    return
  }
  await importSnapshot(result.snapshot)
  await Promise.all([
    pieceStore.loadAll(),
    annealStore.loadAll(),
    furnaceStore.loadAll(),
    inspectStore.loadAll(),
    reworkStore.loadAll(),
  ])
  ElMessage.success(`导入成功：${result.message}`)
}

function handleReset(): void {
  ElMessageBox.confirm(
    '全部窑炉、料液批次、作品、工序、退火、检验与重烧请求都会被清空，并重新灌入演示数据。',
    '确认重置本地数据？',
    { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' },
  )
    .then(async () => {
      await resetDatabase()
      await Promise.all([
        pieceStore.loadAll(),
        annealStore.loadAll(),
        furnaceStore.loadAll(),
        inspectStore.loadAll(),
        reworkStore.loadAll(),
      ])
      ElMessage.success('已重置为演示数据')
    })
    .catch(() => undefined)
}

const defectRows = computed<Inspect[]>(() => inspectStore.inspects.filter((row) => row.result !== '合格'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="检验记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="合格" :value="stats.pass" suffix="条" tone="success" icon="DataLine" />
      <StatBadge label="不合格" :value="stats.defect" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="合格率" :value="`${stats.passPct}%`" :percent="stats.passPct" tone="success" icon="PieChart" />
      <StatBadge label="在制件数" :value="stats.inProgress" suffix="件" tone="warning" icon="TrendCharts" />
      <StatBadge
        label="窑位占用率"
        :value="`${stats.occupancyRate}%`"
        :percent="stats.occupancyRate"
        tone="primary"
        icon="PieChart"
      />
      <StatBadge
        label="数据结构版本"
        :value="`v${DB_SCHEMA_VERSION}`"
        :suffix="`· ${DB_NAME}`"
        tone="info"
        icon="Histogram"
        hint="IndexedDB 库名与结构版本；v3 检验挂到退火炉次并新增重烧请求"
      />
    </div>

    <!-- 对账结果：挂起 / 待质检 / 件数对不上 -->
    <el-card shadow="never" class="mb-14">
      <template #header>
        <span class="card-header__title">排产 · 质检对账（按作品 + 窑位）</span>
      </template>
      <ReconcilePanel :result="reconcileResult" :loading="inspectStore.loading || annealStore.loading" />
    </el-card>

    <!-- 待出炉重烧：在烧的那炉不能打断 -->
    <el-alert
      v-if="reworkStore.pendingReworks.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`${reworkStore.pendingReworks.length} 条重烧请求待出炉（在烧的那炉出炉后再退回待排，不打断当前炉）`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in reworkStore.pendingReworks" :key="row.id">
            {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · 原因 {{ row.reason }} —— 等原炉出炉后重烧另开一条，原炉排位保留。
          </div>
        </div>
      </template>
    </el-alert>

    <!-- 质检台账落账失败：只在本侧重试，排产台账不动 -->
    <el-alert
      v-if="inspectStore.lastFailedInspect !== null"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      title="质检台账落账失败"
      :description="inspectStore.error || '已按本侧重试仍未成功；排产台账未变动，可点击右侧按钮重试。'"
    >
      <template #default>
        <div class="retry-bar">
          <span>
            {{ pieceLabel[inspectStore.lastFailedInspect.pieceId] ?? '（作品已删除）' }} ·
            {{ inspectStore.lastFailedInspect.date }} · {{ inspectStore.lastFailedInspect.result }}
          </span>
          <el-button size="small" type="danger" plain @click="handleRetry">重试落账（仅质检本侧）</el-button>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="defectRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${defectRows.length} 条检验记录判定不合格，已生成返工提示`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in defectRows" :key="row.id">
            {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.date }} · {{ row.result }}：
            {{ row.defectNote }} —— 原始工序记录保留，重烧另开一条退火记录（原炉排位保留）。
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">出炉检验登记与结构版本</span>
          <el-space wrap>
            <el-button @click="handleExportJson">
              <el-icon><Download /></el-icon>
              <span>导出 JSON 存档</span>
            </el-button>
            <el-button @click="handleExportCsv">
              <el-icon><Download /></el-icon>
              <span>导出 CSV 汇总</span>
            </el-button>
            <el-upload :auto-upload="false" :show-file-list="false" accept=".json" :on-change="handleImport">
              <el-button>
                <el-icon><Upload /></el-icon>
                <span>导入 JSON 存档</span>
              </el-button>
            </el-upload>
            <el-button type="danger" plain @click="handleReset">重置演示数据</el-button>
            <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0">
              <el-icon><Plus /></el-icon>
              <span>登记检验</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[{ key: 'result', label: '检验结果', options: INSPECT_RESULT_OPTIONS as unknown as string[] }]"
        :values="{ result: resultFilter }"
        :result-text="`命中 ${filtered.length} / ${inspectStore.inspects.length} 条`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="(key: string, value: string) => { if (key === 'result') resultFilter = value as InspectResult | 'all' }"
        @reset="
          () => {
            keyword = ''
            resultFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="inspectStore.ready && inspectStore.inspects.length === 0"
        title="还没有出炉检验记录"
        description="作品退火出炉后，挂到对应的那一炉登记检验结果；判定为裂纹 / 气泡 / 变形时生成返工提示与重烧请求，重烧等出炉后另开一条退火记录。"
        action-text="登记第一条检验"
        @action="openCreate"
      />

      <el-table v-else v-loading="inspectStore.loading || !pieceStore.ready" :data="filtered" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <StageTag
                :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="窑位" width="120">
          <template #default="{ row }">
            <span v-if="row.readonly" class="cell-sub">未挂窑位</span>
            <span v-else>{{ row.kilnSlot || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检验日期" width="120" />
        <el-table-column label="检验结果" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.result === '合格' ? 'success' : row.result === '裂纹' ? 'danger' : row.result === '气泡' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.result }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="缺陷说明 / 返工提示" min-width="280">
          <template #default="{ row }">
            <span v-if="row.defectNote === ''" class="cell-sub">无缺陷</span>
            <span v-else :class="{ 'cell-warn': row.result !== '合格' }">{{ row.defectNote }}</span>
          </template>
        </el-table-column>
        <el-table-column label="重烧" width="130">
          <template #default="{ row }">
            <el-tag
              v-if="needsRework(row.result) && reworkByInspect[row.id]"
              size="small"
              :type="reworkByInspect[row.id].state === '待出炉' ? 'warning' : reworkByInspect[row.id].state === '已退回待排' ? 'success' : 'info'"
              effect="plain"
            >
              {{ reworkByInspect[row.id].state }}
            </el-tag>
            <span v-else-if="needsRework(row.result)" class="cell-sub">—</span>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="inspector" label="检验人" width="110" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="row.readonly" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="row.readonly" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记出炉检验' : '编辑出炉检验'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select
            v-model="form.pieceId"
            filterable
            style="width: 100%"
            :disabled="editingId !== null"
            @change="onPieceChange"
          >
            <el-option
              v-for="item in pieceStore.pieces"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${item.craft} · ${item.state}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="被检验炉次" prop="annealId">
          <el-select v-model="form.annealId" filterable style="width: 100%" :placeholder="form.pieceId === '' ? '请先选择作品' : '请选择已出炉的那一炉'">
            <el-option
              v-for="item in annealOptions"
              :key="item.id"
              :value="item.id"
              :label="`${item.kilnSlot} · 出炉 ${item.outAt.replace('T', ' ')}`"
            />
          </el-select>
          <div v-if="form.pieceId !== '' && annealOptions.length === 0" class="form-tip">
            该作品没有已出炉的退火记录；在烧的那炉出炉后才能登记检验。
          </div>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="检验结果" prop="result">
              <el-select v-model="form.result" style="width: 100%">
                <el-option v-for="item in INSPECT_RESULT_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验人" prop="inspector">
              <el-input v-model="form.inspector" placeholder="如：吴岚" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="检验日期" prop="date">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="缺陷说明" prop="defectNote">
          <el-input
            v-model="form.defectNote"
            type="textarea"
            :rows="2"
            :placeholder="form.result === '合格' ? '可选：填写检验备注' : '必填：描述缺陷位置与程度，并给出返工建议'"
          />
        </el-form-item>
        <el-alert
          v-if="needsRework(form.result)"
          type="warning"
          show-icon
          :closable="false"
          title="判定不合格将生成返工提示与重烧请求"
          description="原始吹制工序记录完整保留；重烧不打断在烧的那炉，等确实出炉后重烧另开一条退火记录（原来那炉排位保留）。"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="合格归档"
          description="检验合格后作品状态会自动回写为「已检验」，并与排产台账按作品 + 窑位对账。"
        />
        <el-checkbox v-model="inspectStore.simulateFail" class="simulate-fail">
          模拟首次质检落账失败（验证重试：仅质检本侧重试，排产台账不动）
        </el-checkbox>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.cell-warn {
  color: #c0392b;
}

.defect-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.retry-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  line-height: 1.8;
}

.form-tip {
  font-size: 12px;
  color: #e6a23c;
  line-height: 1.6;
  margin-top: 4px;
}

.simulate-fail {
  margin-top: 10px;
  font-size: 12px;
  color: #8b95a1;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
