# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：按站位布设样带，逐条记录底质、珊瑚分类覆盖与鱼类计数，并评定白化等级。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore` / `visitStore` / `archiveStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord、定案 | 新建/编辑/删除礁区，按保护区状态与面积分档筛选；卡片汇总站位/样带/巡次，并优先展示该礁区最近年度定案的覆盖率与平均白化指数（未定案回退普查原始口径） |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt、Visit | 新增/编辑/删除站位，经纬度校验并显示度分秒，按水深区间筛选；样带统计取该站位最近一次巡访，不跨巡次混算 |
| `/sites/:id/belts` | 样带布设（分巡次） | Belt、Site、Visit、CoralRecord、FishCount | 开立/选择季度巡次，在该巡次下布设样带（编号、长度、朝向、调查日期、调查人），回显当次记录数、覆盖率与白化指数；同编号样带跨巡次各成一条 |
| `/belts/:id/corals` | 底质与珊瑚分类计数 | CoralRecord、Belt、Visit | 按属名与形态逐条录入覆盖长度与白化等级，汇总当次覆盖率、白化指数、白化占比与等级分布，批量粘贴、批量改级 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt、Visit | 按科名与体长段录入数量，按类别筛选与批量改类别，折算密度（尾/100 m²） |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 + 定案/对账 | 「档案室定案口径 / 普查原始（分巡次）」两套视图；定案口径按选定年度定案巡次重出，对不上条目单列；全量 JSON / 定案结论 JSON 导入导出 |
| `/archive` | 礁区档案室·年度定案 | Reef、Visit、ReefFinalization、ReconciliationRun | 按礁区/年份选定年度定案巡次，即时对账并重出覆盖率/白化指数；对不上的巡次与样带单列；支持只重跑普查侧对账（定案不回退）与导出定案结论 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # reef / site / visit / belt / coralRecord / fishCount / reefFinalization / reconciliation / filter
        ├── stores/             # reefStore / beltStore / surveyStore / visitStore / archiveStore
        ├── components/common/  # BleachTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCoverage / useArchive
        ├── pages/              # ReefList / SiteList / BeltBoard / CoralEntry / FishEntry / CoverageView / ArchiveBoard
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # bleach.ts（白化与覆盖度算法）/ reconcile.ts（定案对账口径）/ db.ts（Dexie 封装+迁移）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（v3 共八张）**：`reefs`（礁区）、`sites`（站位）、`visits`（季度巡次）、`belts`（样带，按巡次隔离）、`corals`（珊瑚记录）、`fishes`（鱼类与无脊椎动物计数）、`finalizations`（档案室年度定案）、`reconciliations`（对账记录）。
- **普查与定案分离**：外业普查组每次重访开立一条 `Visit`，同编号样带在不同巡次各成一条，珊瑚记录/鱼类计数/覆盖率/白化指数按巡次分别计算，绝不混算；原始记录永久保留。礁区档案室为「礁区 + 年份」选定一条定案巡次（`ReefFinalization`），之后礁区覆盖率、白化指数与导出结论统一按那次重出。
- **对账口径（评定与导出共用 `utils/reconcile.ts`）**：两边按「站位编号 + 样带编号」对账。① 编号对得上的样带一律取定案巡次那次（**定案覆盖，不取平均**）；② 定案缺号、同年其他常规巡次有同编号的，取**后一次巡访**（调查日期最晚，日期相同取季度更新者）跨巡次补位，仍不平均；③ 与定案巡次零交集的整条巡次、挂补登巡次的样带、站位编号缺失、定案巡次内编号重复的，全部**单列**为对不上条目，不参与评定与导出。对账状态写入 `ReconciliationRun`；**对账失败只重跑普查侧（`rerunById` 仅重算并新增一条对账记录），档案室定的巡次不回退**。
- **升级迁移**：`version(1)`/`version(2)` 保留历史结构与字段回填；`version(3)` 新增三张表并给 `belts` 补 `visitId` 索引——旧数据没有巡次标记时**按调查日期归入季度巡次**，日期缺失/非法补不出季度的样带统一进入 `*未分季` **补登巡次单列**。导入旧版备份时 `ensurePayloadVisits()` 执行同样兜底。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时幂等播种：3 个礁区 / 4 个站位 / 4 条巡次（2026 Q1–Q3 + 2025 补登）/ 14 条样带（同编号跨季度重复）/ 珊瑚与鱼类计数；清澜湾、永兴岛已定案 2026 年度（Q3），对账覆盖「定案覆盖 / 跨巡次补位 / 整巡次对不上 / 补登未归位 / 定案编号重复」全部情形，大洲岛留作未定案示例。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新，页面只读消费。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%；白化指数 = 按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4），并按指数换算总体等级；鱼类密度 = 计数 / （样带长度 × 1 m）× 100（尾/100 m²）。
- **备份与恢复**：`/coverage` 页可导出含八张表的全量 JSON，支持「覆盖导入」与「追加导入（业务数据重分 id、按巡次 code 复用巡次、不复制档案室定案）」；档案室页另可导出「年度定案结论 JSON」（只含参与评定的样带、礁区汇总与对不上条目，与评定页同一口径）。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
