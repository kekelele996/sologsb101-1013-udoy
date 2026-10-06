<script setup lang="ts">
/**
 * 外业普查组 · 巡次登记（/field/visits）
 * 记每次巡访的样带、珊瑚记录与鱼类计数：同一站位季度重访时同编号样带各属各巡次，
 * 覆盖率 / 白化指数按巡次分开，绝不把几次巡访混算。
 * 补不出巡次的旧样带在底部单列，可人工补挂到某次巡访。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useVisitStore } from '@/stores/visitStore'
import { useArchiveStore } from '@/stores/archiveStore'
import { QUARTERS, QUARTER_LABEL, defaultVisitName } from '@/types/visit'
import type { Quarter, Visit } from '@/types/visit'
import type { Belt } from '@/types/belt'
import { bleachGrade, bleachIndex, coralCoveragePct, fishDensity } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const visitStore = useVisitStore()
const archiveStore = useArchiveStore()

const selectedReefId = ref<string>('')
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  year: new Date().getFullYear(),
  quarter: 'Q3' as Quarter,
  name: '',
  leader: '',
  remark: ''
})

const reefs = computed(() => [...reefStore.reefs].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')))
const selectedReef = computed(() => reefStore.reefById(selectedReefId.value))

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (!selectedReefId.value && reefs.value.length > 0) selectedReefId.value = reefs.value[0].id
})

function ensureReef(): void {
  if (!selectedReefId.value && reefs.value.length > 0) selectedReefId.value = reefs.value[0].id
}

/** 某礁区的巡访卡片（年份 / 季度降序），含样带数与该次巡访的覆盖率 / 白化 */
const visitCards = computed(() =>
  visitStore.visitsOfReef(selectedReefId.value).map((visit) => {
    const belts = beltStore.belts.filter((belt) => belt.visitId === visit.id)
    const beltIds = new Set(belts.map((belt) => belt.id))
    const corals = surveyStore.corals.filter((coral) => beltIds.has(coral.beltId))
    const fishes = surveyStore.fishes.filter((fish) => beltIds.has(fish.beltId))
    const index = bleachIndex(corals)
    const coverCm = corals.reduce((sum, coral) => sum + coral.coverCm, 0)
    const totalLen = belts.reduce((sum, belt) => sum + belt.lengthM, 0)
    const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
    const usedBy = archiveStore.reefIdsByVisit[visit.id] ?? []
    return {
      visit,
      belts,
      beltCount: belts.length,
      coralCount: corals.length,
      coveragePct: totalLen > 0 ? coralCoveragePct(coverCm, totalLen) : 0,
      bleachIndex: index,
      grade: bleachGrade(index),
      fishTotal,
      fishDensity: totalLen > 0 ? fishDensity(fishTotal, totalLen) : 0,
      usedBy
    }
  })
)

/** 未挂巡次的样带（补不出的旧数据单列） */
const unassignedBelts = computed(() =>
  beltStore.belts
    .filter((belt) => belt.visitId === null)
    .map((belt) => {
      const site = reefStore.siteById(belt.siteId)
      const corals = surveyStore.coralsOfBelt(belt.id)
      return { belt, site, coralCount: corals.length, index: bleachIndex(corals) }
    })
)

const stats = computed(() => ({
  visitCount: visitCards.value.length,
  beltCount: visitCards.value.reduce((sum, card) => sum + card.beltCount, 0),
  coralCount: visitCards.value.reduce((sum, card) => sum + card.coralCount, 0),
  unassigned: unassignedBelts.value.length
}))

function openCreate(): void {
  ensureReef()
  editingId.value = null
  form.year = new Date().getFullYear()
  form.quarter = 'Q3'
  form.name = ''
  form.leader = ''
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(visit: Visit): void {
  editingId.value = visit.id
  form.year = visit.year
  form.quarter = visit.quarter
  form.name = visit.name
  form.leader = visit.leader
  form.remark = visit.remark
  dialogVisible.value = true
}

function syncName(): void {
  if (!editingId.value) form.name = defaultVisitName(form.year, form.quarter)
}

async function submitForm(): Promise<void> {
  if (!selectedReefId.value) {
    ElMessage.warning('请先选择礁区')
    return
  }
  if (!Number.isInteger(form.year) || form.year < 1900 || form.year > 3000) {
    ElMessage.warning('请填写正确的年份')
    return
  }
  const conflict = visitStore.findVisitConflict(selectedReefId.value, form.year, form.quarter, editingId.value)
  if (conflict) {
    ElMessage.warning(`该礁区 ${form.year} ${form.quarter} 已有巡访「${conflict.name}」，同季度不可重复登记`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      reefId: selectedReefId.value,
      year: form.year,
      quarter: form.quarter,
      name: form.name.trim() || defaultVisitName(form.year, form.quarter),
      leader: form.leader.trim(),
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await visitStore.updateVisit(editingId.value, {
        year: payload.year,
        quarter: payload.quarter,
        name: payload.name,
        leader: payload.leader,
        remark: payload.remark
      })
      ElMessage.success('巡次已更新')
    } else {
      await visitStore.createVisit(payload)
      ElMessage.success('巡次已登记，可在该次巡访下布设样带')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeVisit(visit: Visit): Promise<void> {
  const count = visitStore.beltCountByVisit[visit.id] ?? 0
  const usedBy = archiveStore.reefIdsByVisit[visit.id] ?? []
  try {
    await ElMessageBox.confirm(
      `删除巡次「${visit.name}」将同时删除其下 ${count} 条样带及珊瑚 / 鱼类记录。` +
        (usedBy.length > 0
          ? ` 该巡次已被档案室定案引用（${usedBy.join('、')}），删除只影响普查组这侧，档案室定案不回退（会标记巡次缺失）。`
          : '') +
        '确认删除？',
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await visitStore.removeVisit(visit.id)
  ElMessage.success('巡次及其样带记录已删除；档案室定案未回退')
}

function gotoBelts(visit: Visit): void {
  // 落到该礁区站位页，外业在站位下按巡次布设样带
  const site = reefStore.sites.find((item) => item.reefId === visit.reefId)
  if (site) void router.push(`/sites/${site.id}/belts?visit=${visit.id}`)
  else ElMessage.warning('该礁区还没有站位，请先到礁区台账新增站位')
}

function gotoBelt(belt: Belt): void {
  void router.push(`/belts/${belt.id}/corals`)
}

/** 补挂未挂巡次的样带 */
const assigning = ref<Record<string, string>>({})
async function assignBelt(belt: Belt, visitId: string): Promise<void> {
  if (!visitId) return
  await visitStore.assignBeltToVisit(belt.id, visitId)
  ElMessage.success(`样带 ${belt.no} 已补挂到该巡次`)
}

function quarterLabel(quarter: Quarter): string {
  return QUARTER_LABEL[quarter]
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">外业普查组 · 季度巡访登记</h2>
        <p class="gb-hint">
          每次巡访单独登记，样带、珊瑚记录与鱼类计数都挂在具体巡次上；同编号样带季度重访各算各的，覆盖率与白化指数不混算。
        </p>
      </div>
      <div class="page__actions">
        <el-select v-model="selectedReefId" placeholder="选择礁区" class="page__reef-select" @change="ensureReef">
          <el-option v-for="reef in reefs" :key="reef.id" :label="reef.name" :value="reef.id" />
        </el-select>
        <el-button type="primary" :icon="Plus" :disabled="!selectedReefId" @click="openCreate">登记巡次</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="本礁区巡次" :value="stats.visitCount" suffix="次" icon="Calendar" />
      <StatBadge label="巡访样带" :value="stats.beltCount" suffix="条" tone="info" icon="Files" />
      <StatBadge label="珊瑚记录" :value="stats.coralCount" suffix="条" tone="success" icon="Histogram" />
      <StatBadge
        label="未挂巡次样带"
        :value="stats.unassigned"
        suffix="条"
        :tone="stats.unassigned > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
    </div>

    <EmptyPanel
      v-if="!selectedReef"
      title="请选择礁区"
      description="先在上方选择一个礁区，再登记或查看它的季度巡访。"
      compact
    />

    <EmptyPanel
      v-else-if="visitCards.length === 0"
      title="该礁区还没有巡访记录"
      description="登记第一次季度巡访后，即可在该次巡访下按站位布设样带、录入珊瑚与鱼类。"
      action-text="登记巡次"
      @action="openCreate"
    />

    <div v-else class="visit-grid">
      <el-card v-for="card in visitCards" :key="card.visit.id" shadow="hover" class="visit-card">
        <template #header>
          <div class="visit-card__head">
            <div>
              <strong class="visit-card__name">{{ card.visit.name }}</strong>
              <el-tag size="small" effect="plain" class="visit-card__q">{{ quarterLabel(card.visit.quarter) }}</el-tag>
            </div>
            <BleachTag :level="card.grade" size="small" />
          </div>
        </template>

        <div class="visit-card__stats">
          <StatBadge label="样带" :value="card.beltCount" suffix="条" size="small" icon="Files" />
          <StatBadge label="珊瑚记录" :value="card.coralCount" suffix="条" size="small" tone="success" icon="Histogram" />
          <StatBadge label="覆盖率" :value="card.coveragePct" suffix="%" size="small" tone="info" icon="PieChart" />
          <StatBadge label="白化指数" :value="card.bleachIndex" suffix="/4" size="small" :tone="card.bleachIndex > 1 ? 'warning' : 'success'" icon="TrendCharts" />
        </div>

        <div class="visit-card__meta">
          <span>领队：{{ card.visit.leader || '未填写' }}</span>
          <span>鱼类 {{ card.fishTotal }} 尾（{{ card.fishDensity }} 尾/100m²）</span>
        </div>
        <p v-if="card.visit.remark" class="visit-card__remark">{{ card.visit.remark }}</p>

        <el-alert
          v-if="card.usedBy.length > 0"
          type="success"
          :closable="false"
          show-icon
          :title="`已被档案室定案引用：${card.usedBy.join('、')}`"
          class="visit-card__final"
        />

        <div v-if="card.belts.length > 0" class="visit-card__belts">
          <div v-for="belt in card.belts" :key="belt.id" class="visit-card__belt">
            <el-button text type="primary" size="small" @click="gotoBelt(belt)">
              站位 {{ reefStore.siteById(belt.siteId)?.no ?? '—' }} · {{ belt.no }}（{{ belt.orientation }}向）
            </el-button>
            <span class="gb-hint gb-mono">{{ belt.surveyDate }}</span>
          </div>
        </div>

        <div class="visit-card__actions">
          <el-button type="primary" size="small" :icon="Right" @click="gotoBelts(card.visit)">该次巡访样带</el-button>
          <el-button size="small" :icon="Edit" @click="openEdit(card.visit)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeVisit(card.visit)">删除</el-button>
        </div>
      </el-card>
    </div>

    <el-card v-if="unassignedBelts.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>补不出巡次的样带（{{ unassignedBelts.length }} 条，单列）</h3>
        <span class="gb-hint">多为调查日期缺失的旧数据；补挂到某次巡访后才进入评定口径</span>
      </div>
      <el-table :data="unassignedBelts" border stripe size="small" class="gb-table-compact">
        <el-table-column label="礁区 / 站位" min-width="180">
          <template #default="{ row }">
            <div>{{ row.site ? reefStore.reefById(row.site.reefId)?.name ?? '未知礁区' : '未知礁区' }}</div>
            <div class="gb-hint">站位 {{ row.site?.no ?? '—' }} · 样带 {{ row.belt.no }}</div>
          </template>
        </el-table-column>
        <el-table-column label="调查日期" width="130">
          <template #default="{ row }">
            <el-tag type="danger" size="small" effect="plain">{{ row.belt.surveyDate || '日期缺失' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="coralCount" label="珊瑚记录" width="100" align="right" />
        <el-table-column label="白化指数" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.index }}</span>
          </template>
        </el-table-column>
        <el-table-column label="补挂到巡次" min-width="240">
          <template #default="{ row }">
            <el-select
              :model-value="assigning[row.belt.id] ?? ''"
              placeholder="选择本礁区巡次"
              size="small"
              @change="(value: string) => assignBelt(row.belt, value)"
            >
              <el-option
                v-for="visit in visitStore.visitsOfReef(row.site?.reefId)"
                :key="visit.id"
                :label="visit.name"
                :value="visit.id"
              />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑巡次' : '登记季度巡访'" width="520px" :close-on-click-modal="false">
      <el-form label-width="92px">
        <el-form-item label="年份" required>
          <el-input-number v-model="form.year" :min="2000" :max="2100" :step="1" controls-position="right" @change="syncName" />
        </el-form-item>
        <el-form-item label="季度" required>
          <el-radio-group v-model="form.quarter" @change="syncName">
            <el-radio-button v-for="q in QUARTERS" :key="q" :value="q">{{ q }}</el-radio-button>
          </el-radio-group>
          <div class="gb-hint">{{ quarterLabel(form.quarter) }}</div>
        </el-form-item>
        <el-form-item label="巡次名称" required>
          <el-input v-model="form.name" :placeholder="defaultVisitName(form.year, form.quarter)" maxlength="40" />
        </el-form-item>
        <el-form-item label="领队">
          <el-input v-model="form.leader" placeholder="如：林之遥" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="海况、台风扰动等" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '登记巡次' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}
.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.page__reef-select {
  width: 220px;
}
.visit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}
.visit-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.visit-card__name {
  font-size: 15px;
  color: #10312f;
}
.visit-card__q {
  margin-left: 8px;
}
.visit-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}
.visit-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #4c6663;
}
.visit-card__remark {
  margin: 6px 0 0;
  font-size: 12px;
  color: #7c9995;
}
.visit-card__final {
  margin: 8px 0;
}
.visit-card__belts {
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.visit-card__belt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.visit-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
