import {
  buildCanonicalLines,
  reconcileMismatches,
  listUnassignedBelts,
  buildCanonicalReefSummaries
} from '../src/utils/reconcile.ts'
import { quarterOfDate, yearOfDate, legacyVisitId } from '../src/types/visit.ts'

let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) {
    pass++
    console.log('  ✓', msg)
  } else {
    fail++
    console.error('  ✗', msg)
  }
}

/* ---------- 构造测试数据：两个礁区，各含 Q3 / Q4 两次重访 ---------- */
const reefs = [
  { id: 'r1', name: '甲礁', location: '', areaKm2: 1, protectStatus: '核心区', manager: '', createdAt: 1, updatedAt: 1 },
  { id: 'r2', name: '乙礁', location: '', areaKm2: 1, protectStatus: '缓冲区', manager: '', createdAt: 1, updatedAt: 1 }
]
const sites = [{ id: 's1', reefId: 'r1', no: 'S-01', lat: 1, lng: 1, depthM: 5, substrate: '岩礁', createdAt: 1, updatedAt: 1 },
  { id: 's2', reefId: 'r2', no: 'S-01', lat: 1, lng: 1, depthM: 5, substrate: '岩礁', createdAt: 1, updatedAt: 1 }]
const visits = [
  { id: 'v_q3', reefId: 'r1', year: 2026, quarter: 'Q3', name: 'Q3', leader: '', remark: '', createdAt: 1, updatedAt: 1 },
  { id: 'v_q4', reefId: 'r1', year: 2026, quarter: 'Q4', name: 'Q4', leader: '', remark: '', createdAt: 1, updatedAt: 1 },
  { id: 'v2_q3', reefId: 'r2', year: 2026, quarter: 'Q3', name: '乙Q3', leader: '', remark: '', createdAt: 1, updatedAt: 1 },
  { id: 'v2_q4', reefId: 'r2', year: 2026, quarter: 'Q4', name: '乙Q4', leader: '', remark: '', createdAt: 1, updatedAt: 1 }
]
// r1: 定案 Q4。s1/T-01 在 Q3（重白化指数）与 Q4（轻）各一条；s1/T-02 只在 Q3（定案缺测）。
// r2: 未定案。s2/T-01 在 Q3（重）与 Q4（无），应取后一次 Q4。
const belts = [
  { id: 'b_q3', siteId: 's1', visitId: 'v_q3', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-01', observer: '', createdAt: 1, updatedAt: 1 },
  { id: 'b_q4', siteId: 's1', visitId: 'v_q4', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-12-01', observer: '', createdAt: 1, updatedAt: 1 },
  { id: 'b_q3b', siteId: 's1', visitId: 'v_q3', no: 'T-02', lengthM: 50, orientation: '东', surveyDate: '2026-09-01', observer: '', createdAt: 1, updatedAt: 1 },
  { id: 'b2_q3', siteId: 's2', visitId: 'v2_q3', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-01', observer: '', createdAt: 1, updatedAt: 1 },
  { id: 'b2_q4', siteId: 's2', visitId: 'v2_q4', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-12-01', observer: '', createdAt: 1, updatedAt: 1 },
  { id: 'b_x', siteId: 's2', visitId: null, no: 'T-99', lengthM: 20, orientation: '北', surveyDate: '', observer: '', createdAt: 1, updatedAt: 1 }
]
const corals = [
  // r1 s1 T-01 Q3：指数高（重）
  { id: 'c1', beltId: 'b_q3', genus: '鹿', form: '枝状', coverCm: 1000, bleachLevel: '重', remark: '', createdAt: 1, updatedAt: 1 },
  // r1 s1 T-01 Q4：指数低（轻）—— 定案 Q4 应取这条
  { id: 'c2', beltId: 'b_q4', genus: '鹿', form: '枝状', coverCm: 1000, bleachLevel: '轻', remark: '', createdAt: 1, updatedAt: 1 },
  // r1 s1 T-02 仅 Q3
  { id: 'c3', beltId: 'b_q3b', genus: '滨', form: '块状', coverCm: 1000, bleachLevel: '死亡', remark: '', createdAt: 1, updatedAt: 1 },
  // r2 s2 T-01 Q3 重 / Q4 无（后一次）
  { id: 'c4', beltId: 'b2_q3', genus: '鹿', form: '枝状', coverCm: 1000, bleachLevel: '重', remark: '', createdAt: 1, updatedAt: 1 },
  { id: 'c5', beltId: 'b2_q4', genus: '鹿', form: '枝状', coverCm: 1000, bleachLevel: '无', remark: '', createdAt: 1, updatedAt: 1 },
  { id: 'c6', beltId: 'b_x', genus: '滨', form: '块状', coverCm: 100, bleachLevel: '轻', remark: '', createdAt: 1, updatedAt: 1 }
]
const fishes = []
const finalizations = [
  { id: 'f_r1_2026', reefId: 'r1', year: 2026, visitId: 'v_q4', archivist: '', opinion: '', finalizedAt: 1, createdAt: 1, updatedAt: 1 }
]
const data = { reefs, sites, visits, belts, corals, fishes, finalizations }

console.log('定案礁区 r1：')
const lines = buildCanonicalLines(data, 2026)
const r1t01 = lines.find((l) => l.siteNo === 'S-01' && l.beltNo === 'T-01')
assert(r1t01.visitId === 'v_q4', 'r1 S-01/T-01 采用定案巡次 Q4（belt=b_q4）')
assert(r1t01.bleachIndex === 1, `r1 S-01/T-01 白化指数=1（轻），实际 ${r1t01.bleachIndex}`)
assert(r1t01.status === 'finalized-divergent', `状态 finalized-divergent，实际 ${r1t01.status}`)
assert(r1t01.visitCount === 2, '该编号样带记录到 2 次巡访')

const r1t02 = lines.find((l) => l.siteNo === 'S-01' && l.beltNo === 'T-02')
assert(r1t02.visitId === 'v_q3', 'r1 S-01/T-02 定案巡次缺测，取后一次（仅有的 Q3）补齐')
assert(r1t02.status === 'gap-filled', `状态 gap-filled，实际 ${r1t02.status}`)
assert(r1t02.grade === '死亡', 'T-02 指数按死亡算（不与别的样带平均）')

console.log('未定案礁区 r2：取后一次，不平均')
const r2t01 = lines.find((l) => l.siteNo === 'S-01' && l.reefId === 'r2')
assert(r2t01.visitId === 'v2_q4', 'r2 S-01/T-01 未定案，取后一次 Q4')
assert(r2t01.bleachIndex === 0, `r2 S-01/T-01 指数=0（无），不是两次平均 1.5，实际 ${r2t01.bleachIndex}`)
assert(r2t01.status === 'latest-wins', `状态 latest-wins，实际 ${r2t01.status}`)

console.log('口径每个编号只有一行（不混算）：')
assert(lines.length === 3, `共 3 个口径行（r1 T-01/T-02 + r2 T-01），未挂巡次的 b_x 不入口径，实际 ${lines.length}`)

console.log('对不上的巡次单列：')
const mm = reconcileMismatches(data, 2026)
const keys = mm.map((m) => `${m.reefId}-${m.beltNo}-${m.status}`)
assert(keys.includes('r1-T-01-finalized-divergent'), 'r1/T-01 定案与其他巡访不一致 → 单列')
assert(keys.includes('r1-T-02-gap-filled'), 'r1/T-02 定案缺测补齐 → 单列')
assert(keys.includes('r2-T-01-latest-wins'), 'r2/T-01 多次不一致取后一次 → 单列')
assert(mm.every((m) => m.observations.length >= 1), '每条差异都带历次巡访观测')

console.log('补不出巡次的样带单列：')
const un = listUnassignedBelts(data)
assert(un.length === 1 && un[0].beltId === 'b_x', '日期缺失的 b_x 进入未挂巡次清单')
assert(!lines.some((l) => l.beltId === 'b_x'), '未挂巡次样带不进入评定口径')

console.log('礁区汇总：')
const sums = buildCanonicalReefSummaries(data, 2026, lines)
const sr1 = sums.find((s) => s.reefId === 'r1')
assert(sr1.finalizedVisitId === 'v_q4', 'r1 汇总标注定案 Q4')
assert(sr1.beltCount === 2, `r1 口径样带 2 条（T-01 取 Q4 + T-02 补齐），实际 ${sr1.beltCount}`)

console.log('旧数据季度归并工具：')
assert(quarterOfDate('2026-09-12') === 'Q3', '9 月 → Q3')
assert(quarterOfDate('2026-12-08') === 'Q4', '12 月 → Q4')
assert(yearOfDate('2026-09-12') === 2026, '年份解析 2026')
assert(quarterOfDate('') === null && yearOfDate('x') === null, '非法日期归 null（补不出 → 单列）')
assert(legacyVisitId('r1', 2026, 'Q3') === 'visit_legacy_r1_2026_Q3', '补录巡次 id 稳定（同礁同年同季只补一条）')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
