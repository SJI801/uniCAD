# uniCAD — 项目长期记忆

> 2026-10-13 压缩版。**动手前先读「0. 工作方式」**。详细复盘见 git log 与每日日志。

## 0. 工作方式（硬性要求）

- **跑重活边界（10-13 修订）**：秒级自证允许（cargo test、探针 vitest、
  npm run typecheck/build/wasm）；**禁止**无头浏览器/CDP 脚本；**禁止**不打招呼起
  常驻进程，用完立刻停。**一次只跑一个。**
- **测试文件**：无头浏览器验证脚本禁止（旧 7 个已删，备份 `.workbuddy/backup/`）。
  进程内探针允许：根目录 `_probe_*.test.ts`；新探针守三条：进程内、秒级、
  只验有具体数字的结论。不建 `__tests__/`。
- **测试通过 ≠ 项目没问题**：三个「全绿但坏着」先例（RenderStyle.dash 没人读、
  PreviewGeometry.readout 没人渲染、属性面板只读）。绿色结论用「失败的话是什么坏了」审。
- **动手前先 grep 是否已存在**；结论先行不铺垫。

## 定位与进度

浏览器 2D CAD：React 19 + TS 5.7 / Rust+WASM 内核 / WebGL2 / JSON+DXF。
**阶段 0 完成**（参数化草图：尺寸驱动、自由度、完全定义锁、锚点）；
**阶段 1 完成**（特征树，2026-10-13：文档 = `nodes` + `activeSketch`，实体住在草图里，
特征是意图、网格由 `core/evaluate.ts` 现算，文件 v2 + v1 自动迁移，左栏「特征」页
可改名/改高度/抑制/删除）。
**阶段 2 的「差」完成**（`kernel/src/boolean.rs`：BSP 网格布尔，**差/并/交三种全做**；
特征树上点选 A → 另一行 ⊖ = 打孔，或建好后行内下拉改成 并/交；算子被标记「已消耗」不重复画）。
**阶段 3.1 旋转完成**（`mesh.rs::revolve`：把绕轴车削化成「沿 θ 拉伸」，与 extrude 同构；
轴是草图里的直线图元引用）。
**阶段 3.2 孔完成**（`mesh.rs::pick_mesh` 射线拾取 + `boolean.rs::subtract_hole` 造反圆柱刀；
`H` → 3D 点面 → 树上改 ⌀/深度；**面拾取只打可见网格**，所以第二个孔自动接第一个孔的结果）。
→ **ROADMAP「软件第一次能用」里程碑达成**：拉伸 + 旋转 + 打孔 + 布尔 + 阵列，能拼真实零件。
内核 113 tests / 探针 61 全绿（**探针不碰特征**——特征、求值器、3D 拾取、树面板只有
四道门 + 手动清单，见 README 验证状态）。
**⚠️ 易错点（血泪）**：体积类断言**必须手算期望值再写进测试**。2026-10-13 连着两次把期望算错
（把「第三个孔在块外」算成三个柱体、把内接多边形当成了真圆相切、把 10×6×6 当成 10³）——
每次都表现得像「布尔在多切体积」，实际是我的算术。**发现异常时先验期望，再怀疑代码。**
现有 `degenerate_inputs_all_land_on_their_exact_volumes`（22 例 6 类退化用例）已全绿，
可作回归锚点。
缺口：布尔退化面再扩类（2.3 未完的那半）、扫描/放样/圆角（3.3–3.5）、
阵列第二个方向与圆周阵列、椭圆缺尺寸类型。
下一步是阶段 2（新特征种类：`Revolve`/`Boolean`，内核布尔是「最硬的内核骨头」）。

## 架构铁律（精选）

- **几何全在 Rust 内核**，前端零几何逻辑（`evaluate.ts` 只编排，不算三角形）。
- **「哪些图元」只有一个地方回答**：`core/doc.ts` 选择器（`sketchEntities`/`findEntity`/
  `allEntities`/`sketchSlots`…）。任何模块自己遍历 `nodes` 都是错的。
- **实体补丁必须显式带 sketch id**（`addEntity(sketch, e)`），绝不隐式用「当前活动草图」：
  切走草图再撤销必须回到原来那张。
- **派生几何只算不存**：特征存意图（sketch/profile/height），网格每次文档变更全量重算
  （无增量图谱，顺序无关）；求值结果**不进撤销栈**。
- **错误是值不是异常**：轮廓被删/草图没了/不封闭/未实现 → error item 带原因，
  界面出口 = 树上的红点 + 状态栏「特征错误 N」。静默空网格是阶段 1 要消灭的失败方式。
- **一个平面 = 一张草图**（`sketchOfPlane`）；切面 = 切该面的草图，没有就建一张空的；
  `activePlane` 从 `activeSketch` 推导，两面永不背离。
- **删草图/删面先查引用**：还有图元、被特征引用、最后一张 → 拒绝并说明，不级联
  （例外：删**轮廓图元**会级联删特征，同一命令可一次撤销）。
- **suppress = 跳过求值保留节点**；`EMPTY_VERTS` 单例（空结果不是新分配）。
- **布尔「消耗」算子**：布尔的算子不再单独画（否则壳套壳），但只消耗**成功的**布尔；
  求值器按树序解析依赖（算子必须在前面 = 无环证明），算子网格靠 featureId → 网格的表传。
- **网格体积测试**：`soup_volume`（散度定理）验几何与朝向；注意顶点是 **6 浮动**（位置+法线），
  三角形三顶点偏移 0/6/12——按 0/3/6 读会把法线当位置（曾让方箱体积算出 0）。
  镶嵌网格体积天然小于精确值（径向壁是弦：`segs·sin(Δθ)`），断言要对镶嵌后的值。
- **坐标**：模型 y 上/屏幕 y 下，翻转只在相机；裁剪矩阵唯一实现 `camera.ts` 的
  clipMatrixOf，`ndcY = +2*(y-cy)/(s*h)`——**正号**错了整幅镜像且零报错。
- **线批次追加语义**：每帧开头显式 `beginLineBatch()`；入批顺序=层级。
- **uniform 取不到位置立刻抛异常**（GLSL 删未用声明 → null → 静默 no-op → 空画布）。
- **像素单位**：width/size/u_viewport 是 CSS 像素；gl_PointSize 是设备像素（乘 u_dpr）。
- **FFI 扁平 f64 数组**，绝不用 JsValue 传实体；顶点 Rust 返 Vec（--target web 无 memory）。
- **容忍内核未就绪**：initKernel 模块级 Promise 缓存（StrictMode 4 路并发）；kernelOrNull()
  + TS 回退；帧循环 try/catch + 先排下一帧。
- **GPU 缓冲增长式上传**：只在装不下时 bufferData 并查 getError()。
- **属性按全局顶点索引写，斜接缓存按实体局部索引写**，混用 → subData too large。
- **方框顶点用显式顶点表**（QUAD_AT_END/QUAD_SIDE），别用取模表达式。
- **斜接**：角平分线×1/cos(θ/2)（上限 4）；首尾单邻居跳过补偿。
- **屏幕空间描边与线型**：a_arc+a_dash 片元 mod 裁切；不在 CPU 切线。
- **补丁式撤销**：Command=Patch 列表，上限 500；多实体变换合并一条。
- **工具只产出预览几何+Command**；不 import render/；pick()/viewScale() 注入；预览节流。
  行为标志别从展示字符串推断。
- **GLSL 是 JS 模板字面量，注释禁反引号** → Vite 500 白屏，tsc 可能不报。
- **修剪 trim.rs**：按区间删；椭圆不支持；FFI 过滤刀刃含自身；求交卡 0≤t,u≤1。
  **破坏性工具预览对象=作用对象**（记 hoverTarget，位置锁 hoverAt）——凡「悬停算一次、
  点击再算一次」都要查。
- **split.rs 与修剪共用同一套参数化**，别写第二套；空返回=没交点；wire 用解码器游标。
- **约束求解**：LM+中心差分雅可比；分支解算开始时选一次固定；改属性只放开伙伴；
  `__` 前缀预览命令不解算。

## 本机工具链

没装 VS C++ 工具，GNU link.exe 遮蔽 MSVC → host 走 GNU ABI
`C:\ProgramData\mingw64\mingw64`；rustup 必须 RUSTUP_NO_SELF_UPDATE=1 + rsproxy 镜像；
cargo test 显式 `--target x86_64-pc-windows-gnu`；wasm-bindgen `--target web`。
调试钩子 `window.__unicadView`/`__unicadCursor`/`__unicadStore`。

## 交互与 UI 契约

- **Ribbon 两档** 62px/34px；标志位在 store+localStorage；加控件同步上调
  `RIBBON_AUTO_COLLAPSE_BELOW`。收拢按钮 sticky right:0 + 不透明背景；下拉 position:fixed
  做滚动容器兄弟；**flex-wrap 禁入定高 overflow-y:hidden 容器**。
- **dims.ts**：几何进 GPU 批次，文字走 DOM（渲染循环直写，不走 React state）。
- **props.ts 表驱动**：「能改」=有 applyTo，否则显式 kind:'info'；applyTo 第一参数是
  当前实体（闭包旧实体→回滚中间改动）。
- **视觉 token（10-13 精致化）**：--hl 顶边内高光、--shadow-1/2/pop、--focus-ring、--ease，
  dark/light 同步；.panel-section 圆角卡片；**dim-label 每帧 transform 禁加 backdrop-filter**。

## 命令

`npm run wasm`（改 Rust 后必跑）/ `dev` :5273（用完停）/ **typecheck 唯一入口
`npm run typecheck`**（根 tsconfig 直接 tsc 是假绿 exit 0）。

## 3D（已做：拉伸+基准面）

Solid 存 `doc.solids` 不进 Entity union（2D 零改动）；extrude 非索引平坦着色。
DocPlane/DocFrame 显式存储；`plane?` 缺省 XY。**铁律：凡按状态过滤图元（如活动面），
所有拾取入口都要改**（CanvasView 三处 + Workbench.pickEntityAt + selectAll）——漏过一次。
3D 光标=射线，不走 16ms tick。未做：三点定面、坐标系绝对变换、面拾取、布尔。
