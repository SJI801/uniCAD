# uniCAD — 项目长期记忆

> 整理于 2026-10-11（压缩版）。**动手前先读「0. 工作方式」—— 那几条比代码细节更容易踩。**
> 详细 bug 复盘见 git log 与每日 memory 日志，本文件只留「下次还会踩」的。

## 0. 工作方式（展博的硬性要求）

- **不主动跑测试/构建。** 他明确交代过（2026-10-11，语气很重）：我在他打游戏时连续跑
  无头浏览器验证脚本，机器被拖到死机。「以后不要再跑测试，我让你跑的时候再跑」。
  改完代码就如实说「我没验证」，把命令列出来由他决定。**绝不后台起常驻进程**
  （dev server / 监听 / 轮询）而不告诉他；用完立刻停。**一次只跑一个。**
- **禁止书写测试文件。** 同一天他要求把项目里已有的测试脚本**全部删除**（已删，备份在
  `.workbuddy/backup/verify-scripts-2026-10-11.tgz`），并交代以后不要再写：跑一次要
  把机器吃满，代价大于收益。不要新建 `*.test.*` / `*.spec.*` / `__tests__/` / 验证脚本。
- **测试通过 ≠ 项目没问题。** 只能证明它测过的那条路径。本项目有三个「全绿但坏着」：
  `RenderStyle.dash` 算出来没人读（图层表线型下拉点了没反应）、
  `PreviewGeometry.readout` 算出来没人渲染、属性面板整块几何只读。
  反向也成立：**测试是我写的，编码的是我的假设**（`verify:props` 首跑 8 项「失败」
  全是脚本自己的 bug，产品代码一行没问题）。
  所以每条绿色结论都要用「它失败的话，是什么坏了」审一遍；能答上来才算数。
- **动手前先 grep 是不是已经存在。** 上面第 2、3 条都是「早就写好了只是没人调用」，
  找到就能省掉一半工作。
- 结论先行，不铺垫，不说空话。

## 项目定位

浏览器端 2D CAD 绘图软件。需求原话：TypeScript 脚本 + 可集成 wasm + 性能靠后端。
方案：React 19 + TS 5.7 / Rust + WASM 自研几何内核 / WebGL2 渲染 / 一期只做 2D 绘图核心 /
自有 JSON + DXF 导入导出。

## 架构铁律

- **几何计算全部在 Rust 内核**，前端零几何逻辑。kernel 模块：math / geom / query /
  snap / constraints / trim / ffi。
- **坐标约定：模型 y 向上，屏幕 CSS 像素 y 向下，翻转只发生在相机里。**
  模型 → 裁剪空间的矩阵**只有一个实现**：`src/render/camera.ts` 的 `clipMatrixOf(view)`，
  必须与 `Camera.worldToScreen` 逐符号一致：`ndcY = +2*(y-cy)/(s*h)`。
  那个**正号**是要害 —— 读成负号整幅场景相对光标垂直镜像，且**零报错**。
  公式曾有三份抄写副本（唯一在用的那份写反），现在只剩一份。
- **线批次是「追加」语义**：`buildLineBatch` 只上传本次新增切片（`bufferSubData` +
  `dstElementOffset`），`drawLines` 画完归零，每帧开头必须显式 `beginLineBatch()`。
  先入批的在下层（栅格 → 实体 → 叠加层），整帧只发一次 `drawLines`。
- **着色器 uniform 取不到位置要立刻抛异常**。GLSL 会删掉未被 `main()` 读取的声明，
  `getUniformLocation` 返回 `null`，而 `gl.uniform*` 对 null 是**静默 no-op** ——
  「空间喂错」于是表现为干净控制台 + 空画布。
- **像素单位边界**：`RenderStyle.width`、`OverlayPoint.size`、`u_viewport` 是 **CSS 像素**；
  `gl_PointSize` 是**设备像素**（乘 `u_dpr`）；内核/几何是**模型单位**。跨线必须换算。
- **跨 FFI 用扁平 f64 数组**（`[kind, ...coords]`）：整个场景打包成一个 `Float64Array`
  + offsets，一次调用完成批量拾取/求交/捕捉/解算。**绝不用 `JsValue` 传实体。**
- **顶点数据用「Rust 返回 Vec」而非裸指针**：`--target web` 不导出 `memory`，JS 无法把裸
  `ptr` 包成 TypedArray。由 wasm-bindgen 整块 memcpy（`to_f32_array`/`to_f64_array`/
  `vertex_array`），既正确又快。
- **镶嵌容差按屏幕像素给**：`SceneBuffer.setScreenTolerance(px, scale)`（0.25 px），
  幂等，每帧调用不产生多余 FFI。
- **渲染路径必须容忍内核未就绪**：`initKernel()` 异步，首帧一定早于内核。
  `kernelOrNull()` + 纯 TS 回退镶嵌器 `tessellateTS()` 保证首帧能出图；两条路径共享同一套
  wire 格式与 sagitta 公式。
- **GPU 缓冲增长式上传**：仅当批次装不下时才 `bufferData`。**绝不每帧无条件
  `bufferData`** —— 驱动一旦拒绝分配，缓冲静默保持旧尺寸，随后 `bufferSubData` 必然越界
  （`INVALID_VALUE: bufferSubData: buffer overflow`，Chrome 不给 JS 栈）。
  分配后查 `gl.getError()`。`bytesPerElement` 显式传参，不要 `instanceof` 嗅探。
- **上传的属性按全局顶点索引写，斜接缓存按实体局部索引写。** 混用会得到
  `bufferSubData: srcOffset + length too large`（写 `a_arc` 时踩过）。
- **方框顶点用显式顶点表，不要用取模表达式描述顶点角色。** 曾用
  `pos = k%3===0 ? A : B` + `side = k%2===0 ? -1 : 1`，两者在 `k=5` 上矛盾，两个三角形
  沿不同对角线剖分，并集少掉四边形**起始那一半** —— 直线看不出来，细分过的圆变成
  周期=弦长的虚线。固定表：`QUAD_AT_END=[F,T,T,F,T,F]`、`QUAD_SIDE=[-1,1,-1,1,1,-1]`。
- **斜接接头**：每顶点 = 相邻两段法线的角平分线 × `1/cos(θ/2)`（上限 4）。相邻梯形共用
  端边 → 无缺口无重叠（有重叠 alpha 叠两次变黑）。**首尾只有一个邻居时必须跳过补偿**，
  否则每条线两端两倍宽。
- **解析抗锯齿**：片元按 `clamp((ext-|v_off|)/(2*u_aa),0,1)`，`u_aa = 0.5/dpr`。不能依赖
  MSAA：1.4 px 细线的表观粗细由亚像素相位决定，沿曲线会周期性摆动 40%+。
- **屏幕空间描边**，宽度与缩放无关。**线型同为屏幕空间**（`LINETYPE_DASHES` 单位 CSS
  像素）：顶点带累计弧长 `a_arc`(CSS px) + `a_dash=vec4(period,on0End,on1Start,on1End)`，
  片元按 `mod(arc,period)` 裁切。**不要在 CPU 上把线切成小段**（斜接在未切分序列上算，
  先切等于把每段内部接头变成两个平头端）。虚线端头用距离场羽化（`discard` 一次丢掉整个
  片元的所有采样点，MSAA 救不了）。周期不随缩放变化，所以**不需要**「周期太小就画实线」
  的兜底 —— 曾写过这个分支，写完才发现它永远走不到，已删。
- `resize()` 取整必须一致：背板 `floor()` 而 CSS 保留小数 → 差 1 px，浏览器重采样。
- **补丁式撤销**：Command = Patch 列表（add/remove/update/layerAdd/constraintAdd/
  constraintRemove/…），正向应用、反向回滚，上限 500 步。`transformSelection` 多实体
  **合并成一条命令**。
- **工具只产出预览几何 + Command，从不直接改文档**；`LineTool` 每段立即提交。
  **工具不能 import `render/`** —— `describeEntity` 当初就是从 `render/style` 搬出来的，
  理由正是这条反向依赖。需要颜色就在工具里本地定义。
- **`ToolContext.pick()` / `viewScale()` 是注入的**，不是让工具自己去 `packScene`：
  否则每个工具各打包一次整幅图。`move` 事件 16 ms 一 tick，**任何预览重算都要节流**
  （缓存上次光标点），但文档变更后必须强制重算一次。
- **行为标志不要从展示字符串推断**：`kernelReady` 曾由 `text.startsWith('WASM')` 推断 ——
  改一次措辞就静默关掉拾取/捕捉/测量。现在由显式 action 写入。
- **GLSL 源码是 JS 模板字面量：注释里不能出现反引号。** 会截断字符串 → Vite esbuild 500
  → 页面白屏、无 canvas、body 无文本、控制台只有一条 `Failed to load resource: 500`。
  `tsc` 可能不报（解析路径不同）。
- **修剪（新增）**：`kernel/src/trim.rs`。把目标归约成标量 `u∈[0,1]`，交点排序切成
  **区间**，删点击所在的那一个、**其余全留** —— 按区间而非「从 A 删到 B」是重复修剪
  能工作的原因。**椭圆不支持**（需要「椭圆弧」图元；退化成多段线会让类型/属性面板/
  DXF 全错位）。FFI 必须过滤「刀刃里有目标自己」，否则目标与自身相交无穷多点。
  前端剩件**继承目标的图层与线型**，且「删目标 + 加剩件」必须在**同一条 Command**。
  求交**必须查范围**（`LineSeg::intersect` 卡 `0≤t,u≤1`），否则延长线交点会成切点。
  **破坏性工具的「预览对象」与「作用对象」必须是同一个**：TrimTool 曾因
  `refreshHover` 与 `cut` **各调一次 `ctx.pick`**，十字交叉处两条线都在孔径内、
  谁近谁赢，于是红色预览画的和实际被剪的不是同一个东西。修法是记 `hoverTarget`，
  点击读它，只在它已不在文档里才回退重新拾取。凡「悬停算一次、点击再算一次」都要查。
  **位置也要锁**：预览在 `hoverAt`（节流 move 点）算、cut 却用点击落点，两点跨交点
  内核就选隔壁区间 —— 红画中间段、剪旁边段。cut 沿 `hoverAt` 剪。预览那次计算的
  **全部输入**（实体 + 坐标）都要在点击时复用。
- **交点分解（新增）**：`kernel/src/split.rs`，**与修剪共用同一套参数化**
  （`trim::cut_params_from_points` / `trim::slice`，都是 `pub(crate)`）——切点相同、
  子图元相同，只有「丢一段 vs 全留」的差别。**别写第二套参数化**：两套迟早在某个退化
  输入上给出不同切点。FFI `split_scene` 一次处理整幅图，**每个无序对只求交一次**、
  交点同时给两侧，外面套包围盒粗筛（`intersect` 对混合类型会退化成镶嵌后两两求交）。
  **没被切开的实体不出现在返回里**，所以空数组是「没有交点」这个真答案。
  wire 格式变长时**不要写「跳过 N 字节」的算术** —— 那是第二份解析器；让解码器回报
  游标（`decodePieceRun` 返回 `{pieces, next}`，`decodePieces` 是它的薄包装）。
  删原实体要**倒序**（每个 `remove` 记录索引，从后往前删前面的索引才有效）。
  椭圆同修剪不支持，且单独选中椭圆时给**专属提示**而不是「没有交点」。
- **约束（新增）**：9 种关系存进文档、进撤销栈、能存 JSON，删除图元时级联删除。
  求解器在 Rust 侧（`kernel/src/constraints.rs`）：Levenberg-Marquardt + 阻尼正规方程，
  中心差分雅可比（不手推），**分支在解算开始时选一次并固定**（直线-圆相切有两侧分支，
  残差里的 `|·|` 在 0 处不可微），残差按长度量纲归一化。`moving` 标志决定解算范围：
  拖拽放开选中集，改属性**只放开伙伴**（放开被编辑对象会让求解器把用户刚改的值改回去）。
  `__` 前缀的实时预览命令**不解算**（松手时真命令解算一次）。

## 本机工具链

**没装 VS C++ 生成工具**，且 Git Bash 自带的 GNU `link.exe` 遮蔽 MSVC 链接器 → Rust 编译
host build-script 必然失败。**唯一解**：host 端走 GNU ABI，用
`C:\ProgramData\mingw64\mingw64`（MinGW-w64 GCC 16.1）。

```bash
# rustup 的 self-update 会让安装"看起来成功"但不落地（拒绝访问）。必须加 NO_SELF_UPDATE！
RUSTUP_NO_SELF_UPDATE=1 rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
rustup target add wasm32-unknown-unknown --toolchain stable-x86_64-pc-windows-gnu
cargo install wasm-bindgen-cli --version 0.2.129   # 必须与 crate 版本一致
# 国内镜像（必需）
export RUSTUP_DIST_SERVER="https://rsproxy.cn"; export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
```

- `cargo test` 会因 `.cargo/config.toml` 的 `[build] target` 去跑 `.wasm` 二进制
  → 必须显式 `--target x86_64-pc-windows-gnu`
- wasm-bindgen 必须 `--target web`（`bundler` 生成裸 ESM wasm 导入，Vite 6 报
  `"ESM integration proposal for Wasm" is not supported`）；前端配
  `import('..._bg.wasm?url')` 再 `await init({module_or_path: url})`
- npm 可选依赖会漏装：`@rollup/rollup-win32-x64-msvc`、`@esbuild/win32-x64`
- 大目录（>50 文件）`rm -rf` 被安全策略拦 → 改增量构建
- 本机 `http_proxy` 会拦 `127.0.0.1`（自查时需 `NO_PROXY`）
- 测试钩子仍在：`window.__unicadView` / `__unicadCursor` / `__unicadStore`，控制台手动自查

## 已修复的内核 bug（机制值得记住）

1. `fillet` 圆心/切点算错：原依赖 `s1.b` 判断切点方向，但角点可能不在线段上。
   改为「角点 + 远离角点的单位向量 + 角平分线」
2. 圆切线捕捉：应为 `center + r*(cosθ,sinθ)`，`θ = angle(from-center) ± acos(r/d)`
3. 圆垂足重复 push 同一点：应为近点与远点两个（`center ± u*r`）
4. `initKernel()` 必须有模块级 `loading: Promise` 缓存（StrictMode 双挂载 + 两组件各调
   一次 = 4 次并发）。分工：`Workbench` 静默预热，`CanvasView` 负责状态写入与日志
5. 崩溃 `Cannot read properties of undefined (reading 'buffer')`：`kernel().memory` 在
   `--target web` 下是 `undefined`；帧循环调 `kernel()` 未就绪会打断整帧，wasm trap 污染
   分配器导致之后每帧都 trap（实测 249 条同款异常）。修法：`kernelOrNull()` + TS 回退 +
   `run()` 内 try/catch + 帧循环先排下一帧再绘制。顺带修 TS 回退两处：strips 索引在全局
   `vo` 上重复叠加 `indexBase`；`arcSegments(r<=1e-9)` 应返回 `max_seg` 而非 2
6. React 受控输入必须**草稿 + blur/Enter 提交**，且提交要让出一次事件循环，否则处理函数
   拿到上一次渲染的闭包 → 表现「改了没反应」
7. 改受控输入不能只设 `el.value`：React 装了 setter，直接赋值被当外部改写丢弃。
   要走原型上的原生 setter + 冒泡 input 事件

## 交互与 UI 契约

- **顶部工具栏两档**：展开 62px（六分组）/ 收拢 34px（单行）。标志位在 store（快捷键层要翻
  它 + 持久化 localStorage），**不能放组件局部 state**。**加控件就要同步上调
  `RIBBON_AUTO_COLLAPSE_BELOW`**（阈值必须 ≥ 展开态实际内容宽，展开态约 1911px）。
  - 收拢按钮必须 `position: sticky; right: 0` + 不透明背景，否则会滚出屏幕。
  - 下拉必须 `position: fixed` 渲染成滚动容器的**兄弟节点**，放进去会被 `overflow-x:auto`
    裁成 34px 高的缝。菜单开着时 `Escape` 要 `stopPropagation`。
  - **`flex-wrap: wrap` 不要放进定高 + `overflow-y: hidden` 的容器里**：换行的第二行不是
    「挤」而是**看不见**；且 wrap 让内容不再溢出，`overflow-x:auto` 从不触发 ——
    控件不报错地消失。
- **自动尺寸**：`src/render/dims.ts` 是唯一同时产出「几何 + 文本」的模块。几何走模型坐标并进
  同一 GPU 批次，文字走**屏幕坐标 + DOM**（浏览器光栅化器比字形图集清晰且便宜）。文字层由
  **渲染循环直接写 DOM**，不走 React state；span 池 + `--dx/--dy` + 每帧取整。
  模型法向 → 屏幕方向**只翻 y** → `(nx,-ny)`；偏移与刻度按屏幕像素给再乘 scale。
  **标注朝向看整批选中对象的包围盒中心**（单看一条边判断不出外侧）。标签 clamp 进视口、
  `pointer-events:none`、上限 40 条。
- **属性面板（表驱动）**：`src/core/props.ts` 每个参数一行，自带
  `applyTo/applyValueTo/inheritFrom`。「能不能改」= 「这一行有没有 applyTo」，没写的必须显式
  `kind:'info'`。`applyTo` 第一个参数是**当前实体**而非渲染时捕获的（面板按一份快照渲染、
  按另一份提交，闭包捕获旧实体会把中间改动悄悄回滚）。派生量同样可改，规则写进 tooltip。
  颜色/线型/线宽支持「随层」清除覆盖。多选只列通用参数，不一致显示「多值」。
  数值输入 `type="text"` + `inputMode="decimal"`，提交 `round6`。

## 验证

**本项目没有也不再有测试脚本。** 原 `scripts/` 下 7 个无头浏览器验证脚本已删除（备份在
`.workbuddy/backup/`），`scripts/` 现在只剩 `build-wasm.mjs`。`package.json` 的 `test` /
`verify:*` 已移除。内核 49 个单测**内联在 `kernel/src/*.rs` 的 `#[cfg(test)]` 里**，不是独立
文件，因此保留 —— 但**不要主动跑**。

## 常用命令

```bash
npm run wasm           # 编译内核 → src/wasm/pkg/（改 Rust 后必须跑，否则新导出不存在）
npm run dev            # 开发服务器 :5273（用完记得停）
npm run typecheck      # ★ 真检查：tsc --noEmit -p tsconfig.app.json
npm run build          # 类型检查 + 生产构建
npm run build:full     # wasm + 生产构建
```

**★ 类型检查只有这一个入口。** 根 `tsconfig.json` 是 `files: []` + project references，直接
`npx tsc --noEmit` **不带 `--build` 时什么都不检查、永远 exit 0**——是假绿（10-12 踩过，白信了一整个会话）。
要手动跑就 `npx tsc -p tsconfig.app.json --noEmit`。

## 3D（Phase 1：草图 → 拉伸）

**几何照旧全在内核**：文档只存参数，网格由内核现算。
- 内核 `mesh.rs`：`closed_loop(Prim)` → 点环（直线/弧是半条曲线，返回 `None`）；
  `extrude(loop, height)` → **非索引**平坦着色三角面片（每顶点 6 浮点 xyz+nxyz，端盖用**耳切**）。
  FFI `extrude_mesh` → `[vertexCount, ...]`，0 = 不是封闭区域。
- 文档：`Solid { id, source: EntityId, height, layer }` 存在 **`doc.solids`**。
  **刻意不进 `Entity` union**：Entity 是 2D 草图（packScene/拾取/属性/DXF 全吃它），放侧表让那些
  2D 路径一行不改、3D 回归不到 2D。补丁 `solidAdd/solidRemove` + `danglingSolids`（删草图级联删实体）。
- 渲染 `gl.ts`：上下文 `depth:true`（深度缓冲必须建上下文时申请）；网格程序（MVP mat4 + 平面着色）；
  `drawMeshes` 前后开关 DEPTH_TEST/BLEND。相机 `render/orbit.ts`（Z-up 转台，列主序）。
- 交互：`ExtrudeTool`（别名 `X`）；Ribbon 视图组 2D/3D 切换；3D 下 CanvasView 跳过整个 2D 分支，
  拖拽转台、滚轮推拉（改眼距，不是 2D 缩放）。
- **下一步（展博未点）**：面拾取、多草图/基准面、布尔运算——都是各自的项目。

## 3D（Phase 2：基准面 + 参考坐标系）

- `DocPlane { id, name, origin, u, v, visible }`，**框架显式存储**（不按 id 推导）；法线 = `u×v`。
  `DocFrame { id, name, origin, xAxis, yAxis, visible }`。`doc.planes`（三个基础面 xy/yz/zx，不可删）/
  `doc.frames`（world + 用户建的）/`doc.activePlane`。
- **`EntityBase.plane?: PlaneId`——缺省即 XY**，旧文件零迁移；`planeOf(e)` 兜底。
- 草图 2D `(x,y)` = 平面的 `(u,v)`；放置映射 `origin + u·x + v·y`，拉伸沿 `u×v`。
  于是 **2D 管线完全不动**（模型坐标就是平面局部坐标），只有 3D 与拉伸多一次框架映射。
- 内核 `mesh.rs` 的 `Frame` + `Mesh` 带框架（局部→世界在 `tri()` 里做）；FFI `extrude_mesh` 收
  `frame: &[f64]`（9 个数：origin/u/v），缺省/退化回落 XY。
- **solid 不存平面**：从 `source` 草图所属平面推出，改草图所在面实体跟着走。网格缓存判据 =
  草图对象引用 + 高度 + 平面对象引用（都是引用比较，不 JSON）。
- `gl.ts` 有第三个通道：**不加光照的 3D 线段**（基准面边框 + 三脚标），深度 `LEQUAL`。
- 左栏「基准」页（`DatumPanel.tsx`）：显隐 / 点名字设为活动草图面 / 按活动面新建坐标系。
- **铁律（踩过）**：凡按状态（如活动面）过滤图元，**所有拾取入口都要改**——
  CanvasView 的 visible/snappable/pickable + `Workbench.pickEntityAt` + `store.selectAll`。
  第一版漏了 `pickEntityAt`，「YZ 面画圆拉伸」实际拉的是 XY 的示例圆。
- **3D 视图的栅格与光标**：栅格画在**活动基准面**上（`drawGrid3d`，间距按行数翻倍粗化——
  3D 的"缩放"是眼距，没法照抄 2D 的按像素自适应）；鼠标 = 射线（`orbit.ts` 的
  `screenRay`/`hitPlane`，**从相机基向量构造、不求逆矩阵**），命中活动面 → 强调色十字光标 +
  状态栏报该面局部 (u,v)。光标在 React `onPointerMove` 里算、**不走 16ms move tick**——
  无头测试要发真实指针事件（`agent-browser mouse move`）。
- **派生面（已做一种）**：`addOffsetPlane(baseId, offset)` 从三个基础面之一沿法线偏移出新面
  （u/v 沿用基础面）；用户面可删，**面上有图元时拒绝**，删活动面则「切回 XY」并入同一 Command。
  **3D 里可用鼠标点选基准面**：悬停高亮、单击（<3px）设为「新建基准面」的基准
  （`pickPlane` 命中**画出来的面块**而非无穷平面；`datumBase` 在 store，面板 chip 与 3D 点选共用）。
  未做：三点定面、成角/过点。
- 未做：坐标系参与绝对坐标变换、面拾取、布尔。
- 未做：坐标系参与绝对坐标变换、面拾取、布尔。
