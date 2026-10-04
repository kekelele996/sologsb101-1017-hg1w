<script setup lang="ts">
/**
 * 对账面板：排产台账（Anneal）与质检台账（Inspect）按「作品 + 窑位」对账结果。
 * - 挂起：质检有检验、排产无对应已出炉炉记录（件数对不上先挂起）
 * - 待质检：已出炉但还没检验
 * - 件数对不上：同作品已出炉退火数与检验数不一致
 */
import { computed } from 'vue'
import type { ReconcileResult } from '@/utils/reconcile'

const props = defineProps<{
  result: ReconcileResult
  loading?: boolean
}>()

const suspendedCount = computed(() => props.result.suspended.length)
const pendingCount = computed(() => props.result.pending.length)
const mismatchCount = computed(() => props.result.mismatchedCounts.length)
</script>

<template>
  <div v-loading="loading">
    <el-alert
      v-if="result.balanced"
      type="success"
      show-icon
      :closable="false"
      title="排产台账与质检台账对账一致"
      description="已出炉炉次均有检验，检验记录均能按作品 + 窑位对应到已出炉炉次，件数一致。"
    />
    <template v-else>
      <el-alert
        v-if="suspendedCount > 0"
        type="error"
        show-icon
        :closable="false"
        class="mb-10"
        :title="`对账挂起：${suspendedCount} 条检验对不上炉次`"
        description="质检台账有检验，但排产台账按「作品 + 窑位」找不到对应的已出炉炉记录；件数对不上先挂起，待两边核对一致后再处理。"
      >
        <template #default>
          <div class="reconcile-list">
            <div v-for="row in result.suspended" :key="row.inspectId">
              挂起 · {{ row.pieceName }} · 窑位 {{ row.kilnSlot || '（未挂窑位）' }} —— {{ row.note }}
            </div>
          </div>
        </template>
      </el-alert>

      <el-alert
        v-if="mismatchCount > 0"
        type="warning"
        show-icon
        :closable="false"
        class="mb-10"
        :title="`件数对不上：${mismatchCount} 件作品的已出炉炉数与检验数不一致`"
        description="同作品的已出炉退火记录数与检验记录数对不上，先挂起核对。"
      >
        <template #default>
          <div class="reconcile-list">
            <div v-for="row in result.mismatchedCounts" :key="row.pieceId">
              {{ row.pieceName }} · 已出炉 {{ row.annealCount }} 炉 / 检验 {{ row.inspectCount }} 条
            </div>
          </div>
        </template>
      </el-alert>

      <el-alert
        v-if="pendingCount > 0"
        type="info"
        show-icon
        :closable="false"
        :title="`待质检：${pendingCount} 炉已出炉但尚未检验`"
        description="以下炉次已出炉，等待质检员登记检验结论。"
      >
        <template #default>
          <div class="reconcile-list">
            <div v-for="row in result.pending" :key="row.annealId">
              {{ row.pieceName }} · 窑位 {{ row.kilnSlot }} —— {{ row.note }}
            </div>
          </div>
        </template>
      </el-alert>
    </template>
  </div>
</template>

<style scoped>
.mb-10 {
  margin-bottom: 10px;
}

.reconcile-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}
</style>
