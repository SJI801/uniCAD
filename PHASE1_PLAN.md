# 阶段 1 拆解 · 特征树（feature tree）

> **状态：只拆解，未执行。** 拆解于 2026-10-13；执行前先读本文件 + `ROADMAP.md` 阶段 1 +
> `.workbuddy/memory/MEMORY.md` §0（工作方式）。
>
> **一句话目标**：让实体不再是「存下来的东西」，而是**特征树求值出来的结果**。
>
> **为什么必须先做这一步**：没有树的时候，每新增一种特征都要把「文档模型 / 撤销 / 存盘 /
> 渲染 / 面板」改造一遍；树是让后面每件事都「改一处、处处变」的那台发动机。顺序错了就整体返工
> —— 这也是 `ROADMAP.md` 第 3 行那句「顺序是刻意的」的由来。

本文件里的每一条现状结论都标了 `文件:行`，都是从当前代码读出来的，不是回忆。

---

## 1. 现状盘点（读代码得到的事实）

### 1.1 文档模型

`CadDocument`（`src/core/types.ts:463`）今天的字段：

```
meta · settings · layers · currentLayer · entities · solids · planes · frames · activePlane · constraints
```

- `entities: Entity[]` 是**唯一**的图元宿主，平铺一层，顺序即 z 序。
- `solids: Solid[]`（`types.ts:454`）是「特征」的雏形：`{ id, source: EntityId, height, layer }`。
  它被**刻意的**放在侧表、不进 `Entity` union（`types.ts:439-453` 的长注释）——因为 `Entity`
  是 2D 草图本体，`packScene` / 拾取 / 属性面板 / DXF 全都在吃它，放侧表让那些路径一行不改。
  这个取舍是对的，要继续保持。
- 但 `Solid` 缺四样东西，正是阶段 1 要补的：**没有名字、没有顺序、不能抑制、没有任何 UI**
  （全仓 grep `doc.solids` 只有 `history` / `json` / `CanvasView` 三处消费，界面上**看不见它**，
  只能靠删掉它引用的图元来删掉它）。
- `meta.version` 与 `FILE_VERSION` 都是 **1**（`types.ts:555`、`src/io/json.ts:52`）；
  读取端只有 warning、**没有迁移层**（`json.ts:398-401`）。

### 1.2 求值路径（好消息：网格本来就没进文档）

- 网格在内核现算：`extrudeMesh(profile, height, frame)`（`src/core/kernel.ts:1030`）→ 世界坐标
  三角面，`null` 表示「不是封闭区域」。
- 缓存按**引用比较**：`CanvasView.tsx:790` 的 `meshCache`，键 = 草图图元引用 / height / 平面引用
  （`CanvasView.tsx:810-826`）。渲染 effect 的依赖只有 `[ready, toWorld]`（`CanvasView.tsx:1295`），
  所以缓存**跨帧存活**，这是它能起作用的前提。
- 也就是说「网格是派生数据」这条铁律今天已经成立 ✓ ——阶段 1 要做的不是把它变派生，
  而是把**生成它的那个"东西"**从侧表搬进有序的树。

### 1.3 撤销

- `Patch` 目前 15 种 op（`src/core/history.ts:37-57`），apply / revert 各一个 switch。
- **每个补丁都 `structuredClone` 进栈**（`history.ts:75-210`）→ 两条推论：
  **① 派生数据（网格、求值结果、版本号）绝对不许进 `doc`**；② 类实例 / `Map` / getter 进不了 `doc`
  （克隆后引用比较同时失效）。
- 已经有「删草图级联删实体」的先例：`danglingSolids`（`history.ts:398`）；图元删除按 index 回插保序
  （`history.ts:165`）→ **`entities` 的顺序是有语义的，搬迁时不要顺手排序**。

### 1.4 2D 管线对 `doc.entities` 的依赖：**91 处**

这是 1.1 的全部成本所在。grep `\.entities\b` 命中 **91** 处，其中 **87** 处读的是 `doc.entities`
（另外 4 处是 `props.entities` / `action.entities` 这类同名局部变量）。按用途分类：

| 类别 | 处数 | 代表位置 | 搬迁后应该读什么 |
|---|---|---|---|
| 渲染 / 拾取 / 捕捉 / 徽章过滤 | 17 | `CanvasView.tsx:312,469,544,1101,1135`、`constraintMarks.ts:57,74,157,246,247` | 活动草图的图元 |
| store 的编辑入口 | 22 | `editorStore.ts:587,614,629,640,653,693,751,918,1373,1475,1550` | 活动草图（+ 按 id 查全图） |
| 纯函数内核桥 | 23 | `history.ts` 13 处、`trim.ts:91,96,139,143,332`、`split.ts:69,97`、`constraints.ts:210,748,879` | 单张草图内的图元 |
| IO | 5 | `json.ts:133`、`dxf.ts:249,382,593,869` | 活动草图（DXF）/ 全部草图（JSON） |
| UI 面板与工具 | 20 | `Workbench.tsx:81,345,426,447,487`、`LeftPanel.tsx:65,103`、`Ribbon.tsx:176`、`StatusBar.tsx:218`、`tools.ts:891,1079` | 活动草图 / 全图计数 |

### 1.5 「草图」今天只是概念，不是对象

- 约束分析只吃**活动基准面**上的图元（`constraints.ts:718-750`，`scene = doc.entities.filter(planeOf(e) === doc.activePlane)`）。
- 渲染同样只画活动平面（`CanvasView.tsx:1097-1103`），注释还写着「别的平面上的图元在这个 2D 视图里
  根本没有位置」。
- 所以「一个平面 = 一张草图」是**现状既有语义**，1.1 只是把它显式化成文档对象。这条很重要：
  它意味着迁移规则可以极简（见 1.6），也意味着「多草图」不是新能力，而是把已经存在的东西命名。
- 平面相关影响面（如果要动）：`planeOf(` 11 处、`activePlane` 43 处 / 9 个文件、实体上的 `.plane` 11 处。

### 1.6 其余相关事实

- UI：左栏三个标签 `layers | properties | datum`（`LeftPanel.tsx:48`），靠 `unicad:panel` 事件切换
  （`LeftPanel.tsx:52-59`）；右栏是状态与选择统计；**没有树**。
- ID：`newEntityId(prefix)` 会话内自增（`entities.ts:29-37`），跨草图全局唯一 → 迁移**不需要重编号**。
- 2D/3D 切换：`store.view3d`（`editorStore.ts:117`，默认 `false`，`editorStore.ts:457`）。
- 求值只在渲染循环里发生（`CanvasView.tsx:796-836`）；没有任何「先求值后存」的路径。

---

## 2. 目标数据模型

```ts
// 草图：一个基准面上的图元集合。它是图元的**唯一**宿主。
export interface Sketch {
  id: SketchId;
  name: string;
  plane: PlaneId;
  entities: Entity[];
}

// 特征：由草图（或其它特征）算出来的东西。
export interface FeatureBase {
  id: FeatureId;
  name: string;
  /** 抑制 = 跳过求值，但保留节点与其参数（与 SW 同名概念）。 */
  suppressed?: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  kind: 'extrude';
  sketch: SketchId;
  /** 只拉伸某一条封闭曲线；`null` = 整张草图的所有封闭区域（本阶段先只用具体 id）。 */
  profile: EntityId | null;
  height: number;
  layer: LayerId;
}

/** 1.3 只做类型占位，求值器返回「未实现」错误。真实现是阶段 2/3。 */
export interface RevolveFeature extends FeatureBase {
  kind: 'revolve';
  sketch: SketchId;
  axis: EntityId | null;
  angle: number;
}
export interface BooleanFeature extends FeatureBase {
  kind: 'boolean';
  op: 'union' | 'subtract' | 'intersect';
  of: FeatureId[];
}
export type Feature = ExtrudeFeature | RevolveFeature | BooleanFeature;

/** 有序 = 求值顺序 = 树上的显示顺序。草图必须排在使用它的特征之前。 */
export type TreeNode =
  | { kind: 'sketch'; sketch: Sketch }
  | { kind: 'feature'; feature: Feature };

export interface CadDocument {
  meta: DocumentMeta;
  settings: DrawingSettings;
  layers: Layer[];
  currentLayer: LayerId;
  planes: DocPlane[];
  frames: DocFrame[];
  activePlane: PlaneId;
  constraints: Constraint[];
  // —— 取代 entities / solids ——
  nodes: TreeNode[];
  /** 正在编辑的草图；2D 视图、拾取、捕捉、DXF 都只看它。 */
  activeSketch: SketchId;
}
```

### 决策与理由（每条都对应上面一个现状）

1. **图元搬进 `Sketch.entities`，`doc.entities` 删除。**
   被否掉的方案：保留 `doc.entities` 当「活动草图的别名」。否掉的原因是硬的——
   `CadDocument` 每条命令都被 `structuredClone`（`history.ts:75`），**getter 活不过克隆**，
   代理对象也活不过 JSON 存盘。留别名的代价就是**两套真相**，而这个项目已经为「两套真相」
   付过一次学费（尺寸「只显示不驱动」）。
2. **删除 `EntityBase.plane`，平面的唯一来源是 `Sketch.plane`。**
   今天 `entity.plane`（`types.ts:46`）和「活动平面」表达的是同一个事实的两种写法。
   留着必然出现「草图在 XY，里面的图元写着 YZ」。迁移时一次性删掉，不留兼容字段。
3. **`Solid` → `ExtrudeFeature`，`doc.solids` 删除。**
   必须新增 `sketch` 字段：特征有自己的顺序，不能靠「去活动草图里找那条曲线」。
   `profile` 保留，因为「选一条封闭曲线去拉伸」是现在的实际交互（`tools.ts:1140-1168`）。
4. **用**一个有序列表 `nodes: TreeNode[]` 同时装草图和特征**（与 ROADMAP 里写的
   「`sketches + features[]`」略有出入，这是刻意的）。被否掉的方案是两个平行数组：
   它们表达不了「草图 A → 拉伸1 → 草图 B → 拉伸2」这种**交替**，而真实零件就是交替的；
   硬用两个数组就要再发明一个「谁在谁前面」的序号字段，等于把一张有序表拆成两张再拼回来。
   一个列表同时也是树面板的显示顺序，不需要第二处真相。
5. **`nodes` 有序，且草图节点必须在使用它的特征之前。** 插入规则：
   新草图追加到末尾；由某草图创建的特征插在**该草图之后、其后的第一个特征之前**。
   本阶段**不做拖拽排序**（重排会改求值顺序，容易和这条前置约束打架）。
6. **派生数据绝不进 `doc`**：网格、求值错误、版本号放 store 的非文档字段或渲染循环内部。
   理由见 1.3：进 `doc` 既会被克隆、又会被撤销，还会让引用比较失效。
7. **`FILE_VERSION = 2`**，`meta.version` 同步；读取端加显式 `migrate()`（1.6）。
8. **内核 wire 不动。** 内核的输入是「一批图元 + 约束」，与它们存在文档的哪一层无关；
   本阶段原则上**不改 Rust**（唯一例外见 1.2 的可选包）。

---

## 3. 六个工作包

> 量：S ≈ 半天 · M ≈ 3–5 天 · L ≈ 1–2 周。与 `ROADMAP.md` 的标记一致。

### 3.0 依赖关系

```
1.6（版本 + 迁移）──┐
                    ├──> 刀 1 ──> 1.2（求值器）──> 1.5（编辑→重算）──> 刀 4 验收
1.1（文档模型）─────┘             ↑
                              1.3（特征类型，可与 1.2 并行）
1.4（树面板）依赖 1.1 + 1.2 + 1.3，可与 1.5 并行
```

**1.1 是硬前置**：其余五项都要读新模型。

---

### 3.1 文档模型（`1.1`，M，硬前置）

**落点**：`core/types.ts`、新增 `core/doc.ts`（选择器）、`core/history.ts`、`state/editorStore.ts`、
`io/json.ts`、`io/dxf.ts`、`core/trim.ts`、`core/split.ts`、`core/constraints.ts`、`render/*`、
`ui/*`、`tools/tools.ts`。

**关键步骤（顺序是刻意的：先加一层、再搬迁、最后才改形状）**

1. **先加选择器，行为零变化。** 新增 `core/doc.ts`：

   ```ts
   activeSketch(doc): Sketch
   sketchEntities(doc): Entity[]          // 2D 管线唯一入口
   findEntity(doc, id): Entity | undefined // 跨草图按 id 查（约束、补丁、选择集要）
   sketchOfEntity(doc, id): Sketch | undefined
   entitiesOfSketch(doc, sketchId): Entity[]
   treeNodes(doc): TreeNode[]
   featuresOf(doc): Feature[]
   ```
   此时它们内部仍然读 `doc.entities` —— 这一步**不改任何行为**，只是把「读哪里」收成一个口子，
   于是第 2 步可以一个模块一个模块地做，每步都能 typecheck。
2. **逐模块搬迁 91 处**，`doc.entities` → 选择器。每完成一个模块跑一次
   `npm run typecheck`；这一步结束时全仓只有 `core/doc.ts` 里还出现 `doc.entities`。
3. **这时才改形状**：`CadDocument` 换成 `nodes` + `activeSketch`，`core/doc.ts` 的选择器改成读
   `activeSketch(doc).entities`。真正的形状改动集中在**一个文件 + 一处类型定义**，diff 小、能审。
4. **补丁层**：`Patch` 增加
   `sketchAdd` / `sketchRemove` / `sketchUpdate` / `featureAdd` / `featureRemove` / `featureUpdate`
   / `setActiveSketch`；实体补丁（`add`/`remove`/`update`）**显式带上 `sketch` id**——
   不能隐式用「当前活动草图」，否则「切走草图再撤销」会把实体插回错的草图。
   apply / revert 两个 switch 都要加（漏一个的症状是「撤销后面板对不上」）。
5. 迁移放 1.6，同一刀落地。

**完成判据**
- `npm run typecheck` exit 0；`npm run build` 通过。
- **61 个既有探针一行不改、全绿**——这是「2D 行为零回归」的证据（探针里有真实 store + 真实 wasm）。
- 手工：开一个 v1 文件，图元/约束/锚点/实体全在；画一条线、存盘、读回，结构是 v2。

**坑**
- `entities` 顺序 = z 序（`history.ts:165` 按 index 回插），搬迁时别排序。
- `dxf.ts:869` 导入时直接 `result.doc.entities.push(...)`，也要走选择器/补丁。
- **绕过补丁直接写文档的地方要单独想清楚**：`dxf.ts:869`（DXF 导入）与 `Workbench.tsx:481-520`
  的 `seedDemo()` 都直接 `doc.entities.push(...)`。字段删掉之后 **typecheck 会拦住它们**
  （这是好事，不会静默），但真正要想清的是**语义**：导入的一堆图元进哪张草图？
  （答案：活动草图；若导入时文档还是空的，先建一张。）
- 补丁里的 `structuredClone` 会让「按引用比较」的缓存失效——这是**好事**（形状变了就该失效），
  但推理缓存逻辑时别忘了它。

---

### 3.2 求值器（`1.2`，L，第二个硬前置）

**落点**：新增 `core/featureTree.ts`；消费方 `ui/CanvasView.tsx`（`drawSolids` 改成消费求值结果）、
`ui/Workbench.tsx`（计数/状态）。

**设计**

```ts
export interface EvalResult {
  /** featureId → 交错顶点缓冲（x,y,z,nx,ny,nz），世界坐标。 */
  meshes: Map<FeatureId, Float32Array>;
  /** featureId → 人话错误（轮廓不封闭、草图缺失、尚未实现…）。 */
  errors: Map<FeatureId, string>;
}
export function evaluate(doc: CadDocument): EvalResult
```

- **先全量重算**：按 `nodes` 顺序逐个算，不做增量。理由写在 ROADMAP 里：慢而对，增量以后再说。
  规模现实感：一个零件的特征数是几十，`extrude_mesh` 已是现成导出，全量重算在毫秒级。
- **纯函数**：不读 store、不碰 DOM、不写日志。否则没法用探针测（本项目唯一的自证手段）。
- **错误必须显式**：现在 `extrudeMesh` 返回 `null` 就被 `continue` 掉了（`CanvasView.tsx:827`），
  用户看到的是「什么都没发生」。特征化之后这要变成该节点上的红点 + 一句人话——
  这是用户唯一能知道「为什么没有实体」的地方。
- **缓存键**（1.2 先用最简单的正确解）：渲染循环内保留 `meshCache`，但键从「引用比较」
  升级为「`docRevision` + featureId」。`docRevision` 由 store 在**任何文档变更**时自增
  （非文档字段、不进撤销栈）。等 1.5 再做细粒度失效。
- **可选包 1.2b（本阶段不做）**：如果全量重算在某张图上真的成为瓶颈，再加一个内核导出
  `extrude_many(...)` 一次算多个特征。**只在有实测数字时才做**，别提前优化。

**完成判据**
- 对「1 张草图 + 1 个拉伸」的示例图：`evaluate(doc).meshes` 与今天 `extrudeMesh` 的输出
  **逐顶点相同**（探针断言逐元素相等）。
- profile 不封闭时 `errors` 有人话，且渲染不崩。
- 渲染循环在 `docRevision` 不变时不重算（探针计数 `extrudeMesh` 的调用次数）。

---

### 3.3 特征类型（`1.3`，S）

- `ExtrudeFeature` 迁移现有 `Solid`（`source` → `sketch` + `profile`）。
- `RevolveFeature` / `BooleanFeature`：**只定义类型**，求值器对它们返回
  `errors.set(id, '旋转特征尚未实现')`。理由：类型先占位，1.4 的树面板才有东西可渲染可测；
  真实现是阶段 2 / 3（内核那边的布尔运算是「最硬的内核骨头」）。
- 完成判据：一张手写的 v2 文档（含一个 `revolve` 节点）能被求值器读入并在树上显示为「未实现」
  红色节点，而不是崩溃或静默空网格。

---

### 3.4 特征树面板（`1.4`，M）

**落点**：新增 `ui/FeatureTree.tsx`；`ui/LeftPanel.tsx` 第四个标签（`'tree'`）+
`unicad:panel` 事件白名单加 `'tree'`（`LeftPanel.tsx:55`）；`styles/global.css`。

**功能**（按性价比排序）

1. 节点列表：图标区分草图 / 拉伸；显示名字；当前活动草图高亮。
2. 选中：点草图 → 切 `activeSketch` + `activePlane` 并回 2D 视图；点特征 → 在 3D 视图里高亮它
   （复用 `drawMeshes` 的选中色）。
3. 重命名（进撤销栈）。
4. 双击改参数：拉伸高度（复用「草稿 + blur/Enter 提交」的既有惯例，`LeftPanel` 里已有这套）。
5. 删除：草图被特征引用时**拒绝并说明**（与「面上还有图元时拒绝删面」同一惯例，
   `editorStore.ts:1304-1314` 已有先例），而不是级联删。
6. 抑制（`suppressed`）：跳过求值、网格消失、树节点变灰；取消抑制即恢复。
7. 错误红点 + tooltip（接 1.2 的 `errors`）。

**完成判据**
- 删掉中间特征 → 依赖它的特征一起进入错误态（ROADMAP 验收原文）。
- 改名 / 改高度各进一次撤销栈，Ctrl+Z 一次回到原状。
- 抑制 → 网格消失；取消抑制 → 网格回来且与抑制前逐顶点相同。

---

### 3.5 编辑 → 重算（`1.5`，M）

**问题**：草图的图元改了，特征对象本身**没变**——只比较特征引用会漏掉重算。
**做法**：
- 求值输入用 `docRevision`（1.2）兜底；
- 更进一步（可选）：给 `Sketch` 记一个 `rev` 字段（草图内容版本，**进 doc**、进撤销栈，
  因为它属于文档语义），特征求值时拼进缓存键。
- 求值结果**不进撤销栈**：`run()` 之后只把缓存标脏。
- 完成判据：改一条草图的尺寸 → 3D 里的拉伸跟着变；**Ctrl+Z 一次**草图与实体同时回到原状。

---

### 3.6 版本与迁移（`1.6`，S，与 1.1 同刀）

**落点**：`io/json.ts`（`FILE_VERSION = 2`、`meta.version`、`migrate()`）、README 的文件格式一节。

**迁移规则（v1 → v2）**

1. `entities` 按 `plane` 分组，**每组一张草图**；`plane` 缺省 = XY。顺序：XY 那张排最前
   （并设为 `activeSketch`），其余按首次出现顺序。
   没有任何图元时也要建**一张空草图**——否则新画的图元没有宿主。
2. `solids[]` → `ExtrudeFeature[]`：`source`（图元 id）→ 它所属草图 + `profile = source`。
   节点顺序：**草图在前、特征在后**（按 `solids` 原顺序）。
3. `constraints` 原样保留（约束只在同一张草图内有意义——现状本来就是按活动平面分析的）。
4. 读入即迁移到内存 v2；**保存按 v2 写**。旧版本打不开新文件，可接受，warning 里说明。
5. 迁移必须是**幂等**的：v2 文件再读一次不产生第二张草图。

**完成判据（探针）**：v1 文本 → `deserializeDocument` → 断言结构（草图数、活动草图、
特征数、profile 指向）→ `serializeDocument` → 再读回 → 深度相等（幂等）。

---

## 4. 建议的落地顺序：四刀

每一刀结束都是一个**可用状态**，任何一刀停下都不留半截（不会出现「文档里有两套实体」
或「求值器半接线」的中间态）。

| 刀 | 内容 | 结束时用户看到什么 | 守门证据 |
|---|---|---|---|
| **刀 1** | 1.1（模型）+ 1.6（迁移） | 与今天**完全一样**（行为零变化） | 61 个旧探针全绿 + v1 文件能开 |
| **刀 2** | 1.3 + 1.2（特征类型 + 求值器） | 拉伸由树求值出来；拉伸失败时 3D 里有说明 | 逐顶点一致 + 调用次数 |
| **刀 3** | 1.5（编辑 → 重算） | 改草图尺寸，3D 实体跟着变 | 撤销一次全回来 |
| **刀 4** | 1.4（树面板） | 能看见、改名、抑制、删除特征 | ROADMAP 验收 4 条 |

**为什么刀 1 必须自己一刀**：它动了 91 处调用点却**不产生任何新功能**。把「零功能改动」
和「新功能」混在一刀里，一旦回归就分不清是搬迁错了还是新逻辑错了。

**为什么求值器（刀 2）在树面板（刀 4）之前**：树面板要显示的错误/抑制状态全部来自求值器；
先有数据再画 UI，反过来会为了「先看见效果」写一堆临时假数据。

---

## 5. 阶段 1 总验收

1. **旧文件能迁移读入**（v1 → v2，含约束与锚点），且迁移幂等。
2. **任意顺序改参数，结果都正确**：改草图尺寸 / 改拉伸高度 / 抑制再恢复，
   3D 结果始终与参数一致（全量重算，不存在"顺序敏感"的缓存 bug）。
3. **删除中间特征**：依赖它的后续特征进入错误态（不崩、不静默空网格）。
4. **一次 Ctrl+Z** 同时回滚几何与特征改动。
5. 内核单测 81 通过、前端探针（61 + 新增）全绿、`typecheck` 与 `build` 通过。
6. **不需要硬刷新**：本阶段不改内核 → 原则上不用 `npm run wasm`（若做了可选包 1.2b 则例外）。

---

## 6. 明确不做（本阶段边界）

- 真实 `Revolve` / `Boolean` 求值（内核布尔是阶段 2/3）。
- 增量重算、特征重排（拖拽排序）、特征分组/文件夹。
- 多草图**同屏**（2D 视图仍然只显示活动草图 —— 与现状一致）。
- 装配、工程图、STEP（阶段 4）。
- 草图之间互相引用（「用实体的边做草图」「投影」）——这是「树之上」的能力。
- 内核侧的新导出（除可选包 1.2b 外）。

---

## 7. 风险清单（按「会不会静默出错」排序）

1. **两套真相**（`doc.entities` 与新模型并存）→ 只允许存在**一刀之内**；搬迁期靠 `core/doc.ts`
   的选择器过渡，形状改动必须与最后一批调用点一起落。
2. **派生数据进撤销栈**：网格/版本号若进了 `doc`，既会被 `structuredClone` 克隆，又会被撤销，
   还会让「按引用比较」的缓存推理同时失效（`history.ts:75`）。
3. **形状改了但缓存没失效**：引用比较漏掉「特征顺序变了 / 被抑制了 / 草图内容变了」。
   用 `docRevision` 兜底，**不要太聪明**。
4. **`planeOf` 与 `Sketch.plane` 双写**：迁移时必须一次性删掉 `EntityBase.plane`，
   否则会出现「草图在 XY、图元写着 YZ」这种只在特定操作后才暴露的错。
5. **活动草图切走后撤销**：实体补丁必须显式记 `sketch` id（`history.ts` 的 apply/revert 对称加）。
6. **内核 wire 的 index 语义**：`packScene` 的实体索引、`extrude_mesh` 的 profile 都是**局部**索引
   → 求值器每次从草图局部数组重算，别缓存索引。
7. **DXF 只认单张草图**：导入/导出交换的是**活动草图**（+ 图层）。这条必须写进 README，
   否则用户导入一张图，发现别的草图「丢了」。

---

## 8. 需要拍板的三个问题（执行前回答）

1. **一个平面一张草图，还是允许同一平面多张草图？**
   建议：**一个平面一张草图**（与现状 `planeOf(e) === activePlane` 一致），迁移规则最简，
   「多草图」留到真需要时再开（届时 `activeSketch` 已经是现成的抓手）。
2. **删除被特征引用的草图**：拒绝并说明，还是级联删特征？
   建议：**拒绝并说明**（与「面上还有图元时拒绝删面」同一惯例，`editorStore.ts:1304-1314`）。
   ⚠️ 注意 `ROADMAP.md:52` 的坑句写的是「**删草图前先查引用**（复用 `danglingSolids` 的思路，
   扩大到所有特征）」，读起来更像**级联删**。两者是不同的产品行为，执行前必须定一个：
   级联删的好处是"删了就干净"，坏处是删一张草图会连带删掉五个特征、且用户不容易看出后果。
3. **拉伸的粒度**：保留「某一条封闭曲线」（`profile`），还是「整张草图的所有封闭区域」？
   建议：**保留 `profile`**，求值器先只拉伸它；「整张草图」以后用 `profile: null` 扩展，
   不必现在就把批量轮廓的逻辑写进内核。

---

## 附：文件改动清单（按刀）

| 刀 | 新增 | 大改 | 小改 |
|---|---|---|---|
| 刀 1 | `core/doc.ts` | `core/types.ts`、`core/history.ts`、`state/editorStore.ts`、`io/json.ts` | `io/dxf.ts`、`core/trim.ts`、`core/split.ts`、`core/constraints.ts`、`render/*`、`ui/*`、`tools/tools.ts` |
| 刀 2 | `core/featureTree.ts` | `ui/CanvasView.tsx` | `state/editorStore.ts`、`ui/Workbench.tsx`、`core/types.ts` |
| 刀 3 | — | `state/editorStore.ts` | `core/doc.ts`、`ui/CanvasView.tsx` |
| 刀 4 | `ui/FeatureTree.tsx` | `ui/LeftPanel.tsx`、`styles/global.css` | `state/editorStore.ts`、`ui/pieMenu.ts`（可选：饼菜单加入口） |
