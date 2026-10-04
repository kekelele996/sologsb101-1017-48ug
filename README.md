# 玻璃吹制工序与退火窑编排台（sologsb101-1017）

面向玻璃工作室的窑务排产员：把每件作品的取料、吹制、塑形、开模、收口逐道工序排定，
分配退火窑位与温度曲线，出炉检验并归档；窑位冲突时禁止提交，不合格自动生成返工提示。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22817**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbglassblow` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期时间选择、进度条、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22817） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbglassblow`，`v1 → v2` 为 Piece 增加 craft 索引；`v2 → v3` 把返工从作品级拆到「作品 + 道次序号」 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1017/
├── README.md
├── docker-compose.yml          # name: gbglassblow，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前作品上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # furnace.ts batch.ts piece.ts step.ts anneal.ts inspect.ts
        ├── stores/             # furnaceStore.ts pieceStore.ts annealStore.ts
        ├── components/common/  # StageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useStepProgress.ts useIdbTable.ts
        ├── pages/              # 5 个模块页面
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # thermal.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/furnaces` | `pages/FurnaceList.vue` | 窑炉与料液台账：新建/编辑/级联删除窑炉、登记料液批次、取料按剩余量扣减、低于阈值高亮提示补料 |
| `/pieces` | `pages/PieceList.vue` | 作品登记与设计尺寸录入：按工艺与状态筛选、设计尺寸比例校验、显示工序完成度与当前道次 |
| `/pieces/:id/steps` | `pages/StepDetail.vue` | 吹制工序逐道记录：拖拽排序、回填温度/时长/操作人、推进工序状态、前序未完成阻断进入退火排位 |
| `/annealing` | `pages/AnnealingBoard.vue` | 退火窑位分配与曲线编排：窑位占用表、**窑位冲突时禁用提交**、状态流转、出炉回写作品状态 |
| `/export` | `pages/ExportView.vue` | 出炉检验登记（不合格按作品 + 道次序号点返工，对账不上挂起确认）+ JSON 结构版本查看与导入导出 + 窑务 CSV 汇总 |

`/` 重定向到 `/furnaces`，未匹配路径统一回落到 `/furnaces`。
**层级路由支持直接深链**：把 `http://localhost:22817/pieces/piece-morning-vase/steps` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「作品不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbglassblow`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`
  * `db.version(1)`：建立全部表与 `[pieceId+seq]` 复合索引；
  * `db.version(2)`：**为 `Piece` 增加 `craft` 索引并回填默认值**，同时补齐其余索引与字段：
    * `.upgrade()` 中逐行回填 `revision` / `createdAt` / `updatedAt`；
    * `pieces.craft` 缺失时回填 `吹制`，`pieces.state` 缺失时回填 `设计中`；
    * `steps.state` 缺失时按历史记录视为 `已完成`，避免升级后被误判为待办；
    * `anneals` 补齐 `outAt` 与 `curveSeg`，`inspects` 补齐 `defectNote`。
  * `db.version(3)`：**检验返工从「只记在作品上」拆到「作品 + 道次序号」**，两边分账、按道次对账：
    * `inspects` 增加 `[pieceId+reworkStepSeq]` 复合索引与 `reworkStepSeq` / `reworkStepId` /
      `reworkClosed` / `reworkClosedBy` / `legacy` 字段；`steps` 增加本侧 `reworkMark`；
    * 升级时把旧的作品级不合格记录**按当时的道次顺序**拆到最后一道并锚定工序 id；
      该作品若有更晚的合格复检，则把旧返工标记为已关闭；
    * 实在对不上（作品已无任何工序）的老记录置 `legacy` 且不锚定，界面上**只读保留**、不可编辑删除。
* **检验室与工序台分账（v3 核心规则）**：
  * **检验室（`inspects`）**只记检验结论、缺陷说明、返工退回哪道工序；
    **吹制工序台（`steps`）**只记每道工序的温度、时长、操作人。两张表互不代写。
  * 返工**只退回被点中的那一道**：工序台「领取返工」仅把该道重开（`reworkMark=true`、退回进行中），
    前面确认过的工序记录原样保留，绝不抹掉；该道重做完成进入「待复检」，合格复检才关闭返工。
  * 两边**按作品 + 道次序号对账**，`reworkStepId` 作重排锚点；隔天工序重排导致对不上时，
    返工先**挂起等确认**，不会自动落到别的道次，挂起期间阻断推进与退火排位。
  * 工序台保存失败时**只在本侧重试**（`utils/retry.ts`，仅重试 steps 表写入），检验室那份不动。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `furnaces` | id | code, type, state, fuelType, createdAt, updatedAt |
  | `batches` | id | furnaceId, colorCode, meltDate, remainKg |
  | `pieces` | id | batchId, state, artist, **craft**, name |
  | `steps` | id | pieceId, **[pieceId+seq]**, seq, state, name |
  | `anneals` | id | pieceId, kilnSlot, state, inAt, curveSeg |
  | `inspects` | id | pieceId, date, result, inspector, **[pieceId+reworkStepSeq]** |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `furnaces` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **窑炉 → 料液批次 → 作品 → 吹制工序 → 退火 → 出炉检验** 三层互相引用：
  * 3 台窑炉（KILN-01 熔化炉 / KILN-02 坩埚炉 / AN-01 退火窑）；
  * 4 批料液（含 `A-207` 剩余 42 kg，故意低于 60 kg 补料阈值用于验证高亮与提醒）；
  * 5 件作品（覆盖四种状态与三种工艺）、17 道吹制工序（每件 2–5 道，seq 连续）；
  * 4 条退火记录（窑位 A1/A2/A3/B1 互不冲突，覆盖已出炉 / 退火中 / 待入窑）；
  * 4 条出炉检验（含「裂纹」返工后复检合格、一条「变形」待工序台领取的返工，锚定到赤霞杯第 3 道）。
  * 固定 id 如 `piece-morning-vase`、`piece-frost-bottle` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的作品 id」这一界面偏好，不存业务数据。
* 删除窑炉会级联清理其料液批次；删除作品会级联清理其工序、退火与检验记录（均在同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22817
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/thermal.ts`）

* **退火曲线时长换算**
  * 升温：20 ℃ → 560 ℃，按 120 ℃/h；
  * 保温：560 ℃ 恒温，每 5 mm 壁厚保温 1.2 小时（壁厚越大保温越久）；
  * 缓冷：560 ℃ → 60 ℃，按 40 ℃/h。
  三段合计即该作品的**理论退火时长**，壁厚直接决定总时长。
* **窑位占用判重**：同一窑位的时间窗 `[入窑, 出炉]` 重叠即判定冲突；未出炉时以「入窑 + 该曲线段理论时长」作为临时出炉时间参与判重。
  **冲突时提交按钮禁用**并给出冲突的既有记录说明。
* **温度单位换算**：℃ ↔ ℉（`cToF` / `fToC`）。
* **工序温度校验**：不得超过所选窑炉的 `maxTempC`，且应落在工艺适宜区间（吹制 900–1200 ℃ / 铸造 800–1150 ℃ / 热塑 700–1000 ℃）附近。
* **设计尺寸校验**：壁厚需 ≥ 1.5 mm 且小于设计高度的 1/8，否则给出成型与退火难度提示。
* **前序阻断**：任一前序工序未推进到「已完成」，`/pieces/:id/steps` 的「进入退火排位」会给出明确阻断原因。
* **状态回写**：退火状态推进到「已出炉」即把作品状态回写为「已退火」；登记出炉检验后回写为「已检验」；
  判定不合格时只向被点中的道次（作品 + 道次序号）挂返工，**前面确认过的原始工序记录完整保留**。
  返工流程为「待接收 → 返工中（本道重开）→ 待复检 → 合格复检关闭」；
  对账不上（道次被删 / 重排后序号错位）时返工挂起等确认，挂起与未平返工都阻断进入退火排位。
* **料液扣减**：取料按剩余量扣减（不足时扣到 0），剩余量低于 60 kg 时列表行高亮并在顶部汇总提醒。
