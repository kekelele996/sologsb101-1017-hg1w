<script setup lang="ts">
/**
 * /export 检验归档（质检账）
 * 质检员独管检验结论与缺陷说明，按作品挂到具体那一炉退火上（窑位快照）。
 * 判重烧即开重烧单退回排产：原炉在烧则等出炉后自动转待排，不打断在烧炉次；
 * 原炉已出炉则立即待排。落账失败只重试质检账，排产账不动。
 * 复用组件：<StatBadge>、<EmptyPanel>、<StageTag>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useInspectStore } from '@/stores/inspectStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { DB_NAME, DB_SCHEMA_VERSION, exportSnapshot, importSnapshot, resetDatabase } from '@/utils/db'
import { exportScheduleCsvFile, exportSnapshotJson, parseSnapshot } from '@/utils/export'
import { INSPECT_RESULT_OPTIONS, type Inspect, type InspectDraft, type InspectResult } from '@/types/inspect'
import { REFIRE_STATE_OPTIONS, type RefireState } from '@/types/refire'
import { today } from '@/utils/id'

const router = useRouter()
const pieceStore = usePieceStore()
const inspectStore = useInspectStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<InspectDraft>({
  pieceId: '',
  annealId: '',
  result: '合格',
  defectNote: '',
  inspector: '',
  date: today(),
})

/** 允许挂账的炉次：已出炉 + 退火中（在烧跟踪检验，判重烧等出炉再退待排）；待入窑不允许 */
const attachableAnneals = computed(() => {
  if (form.pieceId === '') return []
  return inspectStore
    .annealsOfPiece(form.pieceId)
    .filter((row) => row.state === '已出炉' || row.state === '退火中')
    .sort((a, b) => b.round - a.round)
})

const attachedAnneal = computed(
  () => inspectStore.anneals.find((row) => row.id === form.annealId && row.pieceId === form.pieceId) ?? null,
)

const rules = computed<FormRules<InspectDraft>>(() => ({
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  annealId: [{ required: true, message: '请选择挂账炉次（按作品挂到那一炉）', trigger: 'change' }],
  result: [{ required: true, message: '请选择检验结果', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检验人', trigger: 'blur' }],
  date: [{ required: true, message: '请选择检验日期', trigger: 'change' }],
  defectNote:
    form.result === '合格' ? [] : [{ required: true, message: '判定重烧必须填写缺陷说明', trigger: 'blur' }],
}))

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

const filtered = computed<Inspect[]>(() => inspectStore.visibleInspects)

const stats = computed(() => {
  const rows = inspectStore.inspects.filter((row) => !row.readOnly)
  const total = rows.length
  const pass = rows.filter((row) => row.result === '合格').length
  const defect = total - pass
  return {
    total,
    pass,
    defect,
    passPct: total === 0 ? 0 : Math.round((pass / total) * 1000) / 10,
    waiting: inspectStore.waitingSchedule.length,
    held: inspectStore.heldRefires.length,
  }
})

onMounted(() => {
  void pieceStore.loadAll()
  void inspectStore.loadAll()
  void furnaceStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  const defaultPiece = pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? ''
  Object.assign(form, {
    pieceId: defaultPiece,
    annealId: '',
    result: '合格' as InspectResult,
    defectNote: '',
    inspector: '',
    date: today(),
  })
  dialogVisible.value = true
}

function openEdit(row: Inspect): void {
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
      const outcome = await inspectStore.submit({ ...form })
      if (outcome === null) {
        ElMessage.error(inspectStore.lastMessage)
        return
      }
      ElMessage.success(inspectStore.lastMessage)
    } else {
      const ok = await inspectStore.update(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(inspectStore.lastMessage)
        return
      }
      ElMessage.success(inspectStore.lastMessage)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Inspect): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${row.date} 的检验记录（${row.result}）？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const ok = await inspectStore.remove(row.id)
  if (ok) ElMessage.success('检验记录已删除（排产账未改动）')
  else ElMessage.error(inspectStore.lastMessage)
}

async function handleUnhold(refireId: string): Promise<void> {
  await inspectStore.unhold(refireId)
  ElMessage.success(inspectStore.lastMessage)
}

async function handleReconcile(): Promise<void> {
  await inspectStore.runReconcile(true)
  ElMessage.success(inspectStore.lastMessage)
}

function handleExportJson(): void {
  void exportSnapshot().then((snapshot) => {
    const filename = exportSnapshotJson(snapshot)
    ElMessage.success(`已导出整库存档 ${filename}`)
  })
}

function handleExportCsv(): void {
  const filename = exportScheduleCsvFile(
    furnaceStore.furnaces,
    furnaceStore.batches,
    pieceStore.pieces,
    pieceStore.steps,
    inspectStore.anneals,
    inspectStore.inspects,
    inspectStore.refires,
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
  await Promise.all([pieceStore.loadAll(), inspectStore.loadAll(), furnaceStore.loadAll()])
  ElMessage.success(`导入成功：${result.message}`)
}

function handleReset(): void {
  ElMessageBox.confirm(
    '全部窑炉、料液批次、作品、工序、退火与两本账（检验 / 重烧单）都会被清空，并重新灌入演示数据。',
    '确认重置本地数据？',
    { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' },
  )
    .then(async () => {
      await resetDatabase()
      await Promise.all([pieceStore.loadAll(), inspectStore.loadAll(), furnaceStore.loadAll()])
      ElMessage.success('已重置为演示数据')
    })
    .catch(() => undefined)
}

function refireStateTagType(state: RefireState): 'info' | 'warning' | 'primary' | 'success' | 'danger' {
  switch (state) {
    case '待出炉':
      return 'warning'
    case '待排':
      return 'danger'
    case '已排产':
      return 'primary'
    case '已完成':
      return 'success'
    case '挂起':
      return 'info'
  }
}

const defectRows = computed(() => inspectStore.inspects.filter((row) => row.result !== '合格' && !row.readOnly))
const reconcileIssues = computed(() => inspectStore.report?.issues ?? [])
const errorIssues = computed(() => reconcileIssues.value.filter((issue) => issue.level === 'error'))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="检验记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="合格" :value="stats.pass" suffix="条" tone="success" icon="DataLine" />
      <StatBadge label="判重烧" :value="stats.defect" suffix="条" tone="danger" icon="Warning" />
      <StatBadge label="合格率" :value="`${stats.passPct}%`" :percent="stats.passPct" tone="success" icon="PieChart" />
      <StatBadge label="退回待排" :value="stats.waiting" suffix="张" tone="danger" icon="RefreshRight" />
      <StatBadge label="挂起" :value="stats.held" suffix="张" tone="info" icon="Lock" />
      <StatBadge
        label="数据结构版本"
        :value="`v${DB_SCHEMA_VERSION}`"
        :suffix="`· ${DB_NAME}`"
        tone="info"
        icon="Histogram"
        hint="v3：检验按作品挂到那一炉退火上，新增重烧单交接表；老检验回填不上窑位则只读"
      />
    </div>

    <el-alert
      v-if="defectRows.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${defectRows.length} 条检验判定重烧，已开重烧单退回排产`"
    >
      <template #default>
        <div class="defect-list">
          <div v-for="row in defectRows" :key="row.id">
            <el-tag size="small" :type="refireStateTagType(inspectStore.refireOfInspect(row.id)?.state ?? '挂起')" effect="dark">
              {{ inspectStore.refireOfInspect(row.id)?.state ?? '—' }}
            </el-tag>
            {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · 原炉 {{ row.kilnSlot || '未挂窑位' }} ·
            {{ row.date }} · {{ row.result }}：{{ row.defectNote }}
          </div>
        </div>
      </template>
    </el-alert>

    <el-card v-if="inspectStore.pendingRefires.length > 0" shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">重烧交接单（质检账 → 排产账）</span>
          <el-tag type="info" effect="plain">共 {{ inspectStore.pendingRefires.length }} 张在途</el-tag>
        </div>
      </template>
      <el-table :data="inspectStore.pendingRefires" row-key="id" size="small" stripe>
        <el-table-column label="作品" min-width="160">
          <template #default="{ row }">
            <el-link type="primary" @click="router.push(`/pieces/${row.pieceId}/steps`)">
              {{ pieceLabel[row.pieceId] ?? '（作品已删除）' }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column prop="defectResult" label="缺陷" width="90" />
        <el-table-column label="原炉窑位 / 时刻" min-width="230">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.sourceKilnSlot }}（排位保留，重烧另开一炉）</span>
              <span class="cell-sub">{{ row.sourceInAt.replace('T', ' ') }} → {{ row.sourceOutAt === '' ? '尚未出炉' : row.sourceOutAt.replace('T', ' ') }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="refireStateTagType(row.state)" effect="dark">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="220">
          <template #default="{ row }">
            <span v-if="row.state === '待出炉'" class="cell-warn">原炉仍在烧，不打断本炉；确实出炉后自动退回「待排」。</span>
            <span v-else>已退回排产员，等待在退火编排页另开重烧炉次。</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default>
            <el-button link type="primary" size="small" @click="router.push('/annealing')">去排产</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="inspectStore.heldRefires.length > 0 || errorIssues.length > 0" shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">两本账对账（按作品 + 窑位）</span>
          <el-space>
            <el-button size="small" :loading="inspectStore.reconciling" @click="handleReconcile">重新对账</el-button>
          </el-space>
        </div>
      </template>
      <el-alert
        v-if="errorIssues.length === 0 && inspectStore.heldRefires.length === 0"
        type="success"
        :closable="false"
        title="两本账件数与窑位一致"
      />
      <div v-else class="issue-list">
        <div v-for="(issue, index) in errorIssues.slice(0, 8)" :key="`${issue.kind}-${index}`" class="issue-row">
          <el-tag size="small" type="danger" effect="dark">{{ issue.kind }}</el-tag>
          <span>{{ issue.message }}</span>
        </div>
      </div>
      <el-table
        v-if="inspectStore.heldRefires.length > 0"
        :data="inspectStore.heldRefires"
        row-key="id"
        size="small"
        class="mt-14"
      >
        <el-table-column label="挂起重烧单" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ pieceLabel[row.pieceId] ?? '（作品已删除）' }} · {{ row.defectResult }}</span>
              <span class="cell-sub">{{ row.holdReason }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleUnhold(row.id)">核对无误，解挂</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">出炉检验登记与结构版本（质检账）</span>
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
        :keyword="inspectStore.filters.keyword"
        :fields="[
          { key: 'result', label: '检验结果', options: INSPECT_RESULT_OPTIONS as unknown as string[] },
          { key: 'refireState', label: '重烧状态', options: REFIRE_STATE_OPTIONS as unknown as string[] },
        ]"
        :values="{ result: inspectStore.filters.result, refireState: inspectStore.filters.refireState }"
        :result-text="`命中 ${filtered.length} / ${inspectStore.inspects.length} 条`"
        @update:keyword="(value: string) => inspectStore.setFilters({ keyword: value })"
        @change="
          (key: string, value: string) => {
            if (key === 'result') inspectStore.setFilters({ result: value as InspectResult | 'all' })
            if (key === 'refireState') inspectStore.setFilters({ refireState: value as RefireState | 'all' })
          }
        "
        @reset="inspectStore.resetFilters()"
      />

      <EmptyPanel
        v-if="inspectStore.inspects.length === 0 && !inspectStore.loading"
        title="还没有出炉检验记录"
        description="作品退火出炉后按作品挂到那一炉上登记检验；裂纹 / 气泡 / 变形判重烧时只开重烧单，不动排产账窑位。"
        action-text="登记第一条检验"
        @action="openCreate"
      />

      <el-table v-else v-loading="inspectStore.loading" :data="filtered" row-key="id" stripe>
        <el-table-column label="作品" min-width="180">
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
        <el-table-column label="挂账炉次 / 窑位" min-width="200">
          <template #default="{ row }">
            <div v-if="row.annealId === ''" class="cell-stack">
              <el-tag size="small" type="info" effect="plain">老记录未挂窑位</el-tag>
              <span class="cell-sub">升级时回填不上，按规则只读</span>
            </div>
            <div v-else class="cell-stack">
              <span>{{ row.kilnSlot }} · {{ row.date }}</span>
              <span class="cell-sub">
                炉次 {{ row.annealId }} · {{ row.outAt === '' ? '在烧（出炉后自动退待排）' : '已出炉' }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="date" label="检验日期" width="110" />
        <el-table-column label="结果" width="100">
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
        <el-table-column label="重烧单" width="100">
          <template #default="{ row }">
            <el-tag
              v-if="inspectStore.refireOfInspect(row.id)"
              size="small"
              :type="refireStateTagType(inspectStore.refireOfInspect(row.id)!.state)"
            >
              {{ inspectStore.refireOfInspect(row.id)!.state }}
            </el-tag>
            <span v-else class="cell-sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="缺陷说明" min-width="260">
          <template #default="{ row }">
            <span v-if="row.defectNote === ''" class="cell-sub">无缺陷</span>
            <span v-else :class="{ 'cell-warn': row.result !== '合格' }">{{ row.defectNote }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="inspector" label="检验人" width="90" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="row.readOnly" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="row.readOnly" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记出炉检验' : '编辑出炉检验'" width="660px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="作品" prop="pieceId">
          <el-select
            v-model="form.pieceId"
            filterable
            style="width: 100%"
            :disabled="editingId !== null"
            @change="form.annealId = ''"
          >
            <el-option
              v-for="item in pieceStore.pieces"
              :key="item.id"
              :value="item.id"
              :label="`${item.name} · ${item.craft} · ${item.state}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="挂账炉次" prop="annealId">
          <el-select v-model="form.annealId" filterable style="width: 100%" placeholder="按作品挂到那一炉上">
            <el-option
              v-for="item in attachableAnneals"
              :key="item.id"
              :value="item.id"
              :label="`第 ${item.round} 轮 · ${item.kilnSlot} · ${item.state} · ${item.inAt.replace('T', ' ')}`"
            />
          </el-select>
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
            :placeholder="form.result === '合格' ? '可选：填写检验备注' : '必填：描述缺陷位置与程度，重烧单会同步给排产员'"
          />
        </el-form-item>
        <el-alert
          v-if="form.result !== '合格' && attachedAnneal && attachedAnneal.state === '退火中'"
          type="warning"
          show-icon
          :closable="false"
          title="原炉还在烧：重烧单先挂「待出炉」"
          description="不打断在烧的这一炉；该炉确实出炉后重烧单自动转为「待排」，原炉排位保留，重烧另开一条。"
        />
        <el-alert
          v-else-if="form.result !== '合格'"
          type="error"
          show-icon
          :closable="false"
          :title="`判定为「${form.result}」：开具重烧单退回排产（待排）`"
          description="只写质检账（本页重试，不影响排产账）；排产员接收后另开一炉，原炉排位与原始工序记录完整保留。"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="合格归档"
          description="检验合格后作品状态回写为「已检验」；若此前有未接收的重烧单会一并撤回。"
        />
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

.defect-list,
.issue-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.8;
}

.issue-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
