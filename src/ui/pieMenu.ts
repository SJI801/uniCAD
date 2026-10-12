/**
 * 右键饼菜单的内容模型。
 *
 * 为什么单独一层：饼里每一项「能不能点、为什么不能点」都是**选择与命令状态的函数**
 * （`canApply` 已经能回答约束类的适用性，3D 视图下草图命令一律无意义……）。把这层
 * 做成纯数据 + 一个纯分发函数，它就**能在没有浏览器的情况下被断死**（见
 * `_probe_pie.test.ts`）；组件那一层只剩画扇形和收指针事件。
 *
 * 手势：右键永远出饼，「结束/取消」是饼里的一个扇区而不是右键本身——它重放今天的
 * `unicad:right-click` 事件，所以各工具原有语义（多段线右键闭合、修剪/偏置右键取消）
 * 一字不改。
 *
 * 内容不另造一份命令表：绘图/工具来自 `TOOL_SPECS`，约束与尺寸来自同源常量 +
 * `canApply`，尺寸值沿用「锁定现状」的种子规则（与 Ribbon「约束 ▾」、属性面板、
 * 画布标注同一条链路）。
 */

import type { CadDocument, ConstraintKind, Entity, EntityId, Vec2 } from '../core/types';
import {
  canApply,
  CONSTRAINT_GLYPH,
  CONSTRAINT_LABEL,
  describeConstraint,
  type ConstraintReport,
} from '../core/constraints';
import { TOOL_SPECS } from '../tools/registry';

// ---------------------------------------------------------------------------
// 动作与形状
// ---------------------------------------------------------------------------

/** 饼里一项能做的事。**数据**而非闭包：这样它能被断言，也能被随手写进日志。 */
export type PieAction =
  /** 交给当前工具收尾/取消——等价于今天的一次右键。 */
  | { kind: 'toolDone' }
  | { kind: 'tool'; id: string }
  | { kind: 'constraint'; value: ConstraintKind }
  | { kind: 'delete' }
  | { kind: 'duplicate' }
  | { kind: 'removeConstraints' }
  | { kind: 'property' }
  | { kind: 'zoomFit' }
  | { kind: 'toggle'; value: 'grid' | 'dims' | 'constraints' | 'endpoints' }
  | { kind: 'view3d'; on: boolean }
  /** 冲突项在组装时就抄进来（模型纯数据，分发端不需要再摸一遍文档）。 */
  | { kind: 'conflicts'; entities: EntityId[]; lines: string[] };

export interface PieLeaf {
  id: string;
  label: string;
  glyph: string;
  action: PieAction;
  enabled: boolean;
  /** 为什么不能点（置灰时必有）。 */
  reason?: string;
}

export interface PieSector {
  id: string;
  label: string;
  glyph: string;
  enabled: boolean;
  reason?: string;
  /** 叶子：点了直接执行。与 `children` 二选一。 */
  action?: PieAction;
  /** 分组：悬停展开外圈。 */
  children?: PieLeaf[];
  /** 冲突扇区画警示色。 */
  danger?: boolean;
  /** 悬停说明。分组的扇区用它写「展开什么」，结束/取消写当前工具自己的说法。 */
  hint?: string;
}

export interface PieInput {
  doc: CadDocument;
  selected: readonly Entity[];
  activeTool: string;
  view3d: boolean;
  report: ConstraintReport | null;
}

// ---------------------------------------------------------------------------
// 菜单内容
// ---------------------------------------------------------------------------

/** 绘图类工具（外圈「绘图」）。 */
const DRAW_TOOLS = ['line', 'polyline', 'rect', 'circle', 'arc', 'ellipse'];
/** 其余工具（外圈「工具」）：选择放第一位 = 「退出当前命令」。 */
const OTHER_TOOLS = ['select', 'trim', 'offset', 'measure', 'extrude'];

/** 几何关系（外圈「约束」）——顺序与右栏、Ribbon 菜单一致。 */
export const GEOMETRIC_KINDS: readonly ConstraintKind[] = [
  'coincident',
  'pointOnCurve',
  'tangent',
  'perpendicular',
  'parallel',
  'concentric',
  'equalRadius',
  'horizontal',
  'vertical',
];

/**
 * 尺寸类（外圈「尺寸」）。
 *
 * 点了就**锁定现状**（种子值 = 当前几何），与 Ribbon「约束 ▾」、属性面板同一规则；
 * 随后在左栏属性面板或画布那条标注上改值即可驱动。这里刻意不做「点了弹输入框」：
 * 那需要再造一个模态输入，而现值已经有两条改值入口。
 */
export const DIMENSION_KINDS: readonly ConstraintKind[] = [
  'distance',
  'distanceX',
  'distanceY',
  'angle',
  'radius',
  'diameter',
];

const toolSpec = (id: string) => TOOL_SPECS.find((t) => t.id === id);

function toolLeaves(ids: readonly string[], blocked?: string): PieLeaf[] {
  return ids.flatMap((id) => {
    const t = toolSpec(id);
    if (!t) return [];
    return [
      {
        id: `tool:${id}`,
        label: t.name,
        glyph: t.glyph,
        action: { kind: 'tool' as const, id },
        enabled: blocked === undefined,
        reason: blocked,
      },
    ];
  });
}

function constraintLeaves(
  kinds: readonly ConstraintKind[],
  selected: readonly Entity[],
  blocked?: string,
): PieLeaf[] {
  return kinds.map((k) => {
    // `canApply` 是唯一裁判：它给出的 reason 就是悬停时看到的置灰原因。
    const verdict = blocked === undefined ? canApply(k, selected) : { ok: false, reason: blocked };
    return {
      id: `constraint:${k}`,
      label: CONSTRAINT_LABEL[k],
      glyph: CONSTRAINT_GLYPH[k],
      action: { kind: 'constraint' as const, value: k },
      enabled: verdict.ok,
      reason: verdict.ok ? undefined : verdict.reason,
    };
  });
}

/** 选择相关的那三个叶子（删除 / 复制 / 删约束）共用同一套可用性判断。 */
function editLeaf(
  id: string,
  label: string,
  glyph: string,
  action: PieAction,
  usable: boolean,
  reason: string | undefined,
): PieLeaf {
  return { id, label, glyph, action, enabled: usable, reason: usable ? undefined : reason };
}

/**
 * 组装扇区。顺序固定（顶点起顺时针）：结束/取消、绘图、工具、约束、尺寸、编辑、
 * 视图，真的有问题时最后追加一个红色「冲突」——位置稳定，肌肉记忆才立得住。
 */
export function buildPieMenu(input: PieInput): PieSector[] {
  const { doc, selected, activeTool, view3d, report } = input;
  const hasSel = selected.length > 0;
  const toolBusy = activeTool !== 'select';
  const activeHint = toolSpec(activeTool)?.hint;
  // 3D 里没有草图可改：2D 命令一律置灰并说明原因，而不是隐藏——隐藏会让人以为
  // 功能被删了。
  const in3d = view3d ? '3D 视图下不作用于草图（先切回 2D）' : undefined;
  const selReason = in3d ?? (hasSel ? undefined : '先选中对象');

  const conflicts = report?.conflicting ?? [];
  const conflictEntities = report ? [...report.conflictingEntities] : [];

  const sectors: PieSector[] = [
    {
      id: 'toolDone',
      label: toolBusy ? '结束/取消' : '无命令',
      glyph: '↩',
      enabled: toolBusy,
      reason: toolBusy ? undefined : '没有正在执行的命令',
      hint: toolBusy ? activeHint : '先选一个绘图或修改命令',
      action: { kind: 'toolDone' },
    },
    {
      id: 'draw',
      label: '绘图',
      glyph: '✎',
      enabled: in3d === undefined,
      reason: in3d,
      hint: '绘制工具（直线 / 多段线 / 矩形 / 圆 / 弧 / 椭圆）',
      children: toolLeaves(DRAW_TOOLS, in3d),
    },
    {
      id: 'tools',
      label: '工具',
      glyph: '⚒',
      enabled: true,
      hint: '选择 / 修剪 / 偏置 / 测量 / 拉伸',
      children: toolLeaves(OTHER_TOOLS, in3d),
    },
    {
      id: 'constraints',
      label: '约束',
      glyph: '⊹',
      enabled: in3d === undefined,
      reason: in3d,
      hint: '几何关系：相切 / 垂直 / 平行 / 同心 / 等半径 / 水平 / 竖直…',
      children: constraintLeaves(GEOMETRIC_KINDS, selected, in3d),
    },
    {
      id: 'dimensions',
      label: '尺寸',
      glyph: '↔',
      enabled: in3d === undefined,
      reason: in3d,
      hint: '尺寸约束：点它就锁定当前值，之后在左栏或画布标注上改值驱动',
      children: constraintLeaves(DIMENSION_KINDS, selected, in3d),
    },
    {
      id: 'edit',
      label: '编辑',
      glyph: '⌫',
      enabled: true,
      hint: '删除 / 复制 / 删除所选约束 / 打开属性面板',
      children: [
        editLeaf('edit:delete', '删除', '⌫', { kind: 'delete' }, selReason === undefined, selReason),
        editLeaf(
          'edit:duplicate',
          '复制',
          '⧉',
          { kind: 'duplicate' },
          selReason === undefined,
          selReason,
        ),
        editLeaf(
          'edit:removeConstraints',
          '删约束',
          '⊘',
          { kind: 'removeConstraints' },
          selReason === undefined,
          selReason,
        ),
        editLeaf('edit:property', '属性', '☰', { kind: 'property' }, true, undefined),
      ],
    },
    {
      id: 'view',
      label: '视图',
      glyph: '⛶',
      enabled: true,
      hint: '缩放 / 2D-3D / 栅格与标注开关',
      children: [
        { id: 'view:fit', label: '缩放到范围', glyph: '⤢', action: { kind: 'zoomFit' }, enabled: true },
        {
          id: 'view:3d',
          label: view3d ? '回 2D' : '看 3D',
          glyph: view3d ? '▣' : '⬔',
          action: { kind: 'view3d', on: !view3d },
          enabled: true,
        },
        {
          id: 'view:grid',
          label: '栅格',
          glyph: '#',
          action: { kind: 'toggle', value: 'grid' },
          enabled: true,
        },
        {
          id: 'view:dims',
          label: '标注',
          glyph: '⇥',
          action: { kind: 'toggle', value: 'dims' },
          enabled: true,
        },
        {
          id: 'view:constraints',
          label: '约束标记',
          glyph: '⊹',
          action: { kind: 'toggle', value: 'constraints' },
          enabled: true,
        },
        {
          id: 'view:endpoints',
          label: '端点标色',
          glyph: '◉',
          action: { kind: 'toggle', value: 'endpoints' },
          enabled: true,
        },
      ],
    },
  ];

  // 只有真的立不住时才多一格：平时饼是 7 格，出问题时第 8 格自己出现，并把冲突项
  // 的原文一起带上（分发端不必再摸一遍文档）。
  if (conflicts.length > 0) {
    sectors.push({
      id: 'conflicts',
      label: `冲突 ${conflicts.length}`,
      glyph: '⚠',
      enabled: true,
      danger: true,
      hint: '查看冲突项（会写进日志并选中涉及的图元）',
      action: {
        kind: 'conflicts',
        entities: conflictEntities,
        lines: conflicts.map((c) => describeConstraint(c, doc)),
      },
    });
  }

  return sectors;
}

// ---------------------------------------------------------------------------
// 摆位与几何
// ---------------------------------------------------------------------------

/** 饼的半边长（像素）——外圈 120 + 文字，留到 150 才不会被自己的 viewBox 切。 */
export const PIE_HALF = 150;

/** 内外圈的半径（像素）。组件与探针共用，别处不要再抄一份。 */
export const PIE_RING = { inner: 40, innerOut: 92, outerIn: 100, outerOut: 120 } as const;

/**
 * 环形扇区路径，**以饼心为原点**（0,0 = 圆心）。
 *
 * 为什么强制原点在圆心：`viewBox` 是 `0 0 half*2 half*2` 的**内部坐标系**，与
 * `position: fixed` 的窗口坐标是两套东西。曾经这里把窗口坐标 `at.x/at.y` 当圆心传进来，
 * 圆心飞出 viewBox，整张饼错位（注释还写着"中心严格落在光标"，与实现不符）。
 * 现在唯一的换算就是外层那个 `translate(half half)`，几何函数拿不到绝对坐标，
 * 也就没地方再犯。
 */
export function wedgePath(r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number): string =>
    `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  return [
    `M ${p(r1, a0)}`,
    `A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}`,
    `L ${p(r0, a1)}`,
    `A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}`,
    'Z',
  ].join(' ');
}

/** 扇区的角平分线（顶点起顺时针，所以第一格的中心落在正上方）。 */
export function midAngle(index: number, count: number): number {
  return -Math.PI / 2 + ((Math.PI * 2) / count) * (index + 0.5);
}

/** 第 `index` 格的起止角。 */
export function ringBounds(index: number, count: number): [number, number] {
  const step = (Math.PI * 2) / count;
  const a0 = -Math.PI / 2 + step * index;
  return [a0, a0 + step];
}

/** 某一格在某半径上的中心点（**内部坐标系**，原点 = 饼心）。 */
export function ringMid(a0: number, a1: number, r: number): { x: number; y: number } {
  const mid = (a0 + a1) / 2;
  return { x: r * Math.cos(mid), y: r * Math.sin(mid) };
}

/**
 * 贴边时最多缩到这么小（再小标签就看不清了，宁可让它探出去一点）。
 */
export const PIE_MIN_SCALE = 0.7;

/**
 * 贴边时的**等比缩小系数**：中心永远在光标，只有半径随可用空间缩小。
 *
 * 为什么不是"往里推"（夹取），也不是"让它被切"：
 *
 * * **夹取**会把菜单从光标处挪开——右键就是在指那个位置，菜单跑到别处等于骗人。
 *   （曾经这么做过，被否掉。）
 * * **不缩**的话，在画布右边缘右键会有一大块探到窗口外，看起来就是"缺一块"。
 *
 * 缩小保住了两件事：中心分毫不动，**扇区的角度也不变**（方向记忆仍然成立），
 * 变的只有半径。触底（`PIE_MIN_SCALE`）后仍会探出一点——那种位置离屏幕边不到
 * 105px，属于极端情况。
 *
 * 纯函数，`_probe_pie.test.ts` 断言：中心不动、中间为 1、贴边小于 1、且只要没触底
 * 就**一定装得下**（`PIE_HALF·k ≤ 到最近边的距离`）。
 */
export function pieScale(at: Vec2, viewWidth: number, viewHeight: number): number {
  const room = Math.min(at.x, viewWidth - at.x, at.y, viewHeight - at.y);
  // 每次都显式判有限：`Math.max(undefined, x)` 或任何一步出 NaN，都会让上游算出
  // `left: NaNpx` —— 浏览器忽略非法值 → 饼落到静态位置（多半在视口外）变成"唤不出"，
  // 而全屏背板还在，右键反而被吞掉。这里宁可退回 1（正常大小）也不放 NaN 出去。
  if (!Number.isFinite(room)) return 1;
  const wanted = room / PIE_HALF;
  if (!Number.isFinite(wanted)) return 1;
  return Math.min(1, Math.max(PIE_MIN_SCALE, wanted));
}

/**
 * 饼的左上角：以光标为中心，减掉（缩放后的）半边长。
 *
 * 饼渲染在 `document.body` 的 portal 里、用 `position: fixed`，所以画布宿主与侧栏
 * 的 `overflow: hidden` 都裁不到它——只有窗口边缘能。
 */
export function pieOrigin(at: Vec2, half: number = PIE_HALF): Vec2 {
  return { x: at.x - half, y: at.y - half };
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

/** 饼需要的那部分 store（结构子集：探针塞真 store，组件塞 `getState()`）。 */
export interface PieStore {
  doc: CadDocument;
  activeTool: string;
  addConstraintAction(kind: ConstraintKind): void;
  setTool(id: string): void;
  deleteSelection(): void;
  duplicateSelection(offset: Vec2): void;
  removeConstraintsForSelection(): void;
  zoomToFit(): void;
  setView3d(on: boolean): void;
  toggleGrid(): void;
  toggleDims(): void;
  toggleConstraints(): void;
  toggleEndpoints(): void;
  select(ids: Iterable<EntityId>): void;
  pushLog(text: string): void;
}

/**
 * 执行一个饼动作。副作用只有两处不经过 store：交给工具的「收尾」和打开左栏属性页，
 * 两者都走项目既有的 `unicad:*` 事件通道（工具泵与面板本来就在听）。
 */
export function runPieAction(action: PieAction, s: PieStore, world?: Vec2): void {
  switch (action.kind) {
    case 'toolDone':
      // 与今天的一次右键**完全同一件事**，所以工具里那些语义（多段线闭合、
      // 修剪/偏置取消）不用改一行。`world` 是右键落点；工具泵会优先用当前光标。
      window.dispatchEvent(
        new CustomEvent('unicad:right-click', { detail: world ?? { x: 0, y: 0 } }),
      );
      return;
    case 'tool':
      s.setTool(action.id);
      s.pushLog(`工具: ${toolSpec(action.id)?.name ?? action.id}`);
      return;
    case 'constraint':
      s.addConstraintAction(action.value);
      return;
    case 'delete':
      s.deleteSelection();
      return;
    case 'duplicate':
      // 与 Ribbon 的「复制」同一个偏移量，免得两个入口给出不同结果。
      s.duplicateSelection({ x: 10, y: 10 });
      return;
    case 'removeConstraints':
      s.removeConstraintsForSelection();
      return;
    case 'property':
      window.dispatchEvent(new CustomEvent('unicad:panel', { detail: 'properties' }));
      return;
    case 'zoomFit':
      s.zoomToFit();
      return;
    case 'view3d':
      s.setView3d(action.on);
      s.pushLog(action.on ? '切到 3D' : '回到 2D');
      return;
    case 'toggle':
      switch (action.value) {
        case 'grid':
          s.toggleGrid();
          return;
        case 'dims':
          s.toggleDims();
          return;
        case 'constraints':
          s.toggleConstraints();
          return;
        case 'endpoints':
          s.toggleEndpoints();
          return;
      }
      return;
    case 'conflicts':
      // 0.3 的成果接进饼里：点名冲突项 + 选中涉及的图元（选中后画布上就是警示红）。
      s.pushLog(`⚠ 草图有 ${action.lines.length} 条冲突约束（无法同时成立）：`);
      for (const line of action.lines) s.pushLog(`   · ${line}`);
      s.pushLog('   删掉其中一条即可（右栏「几何约束」列表）。');
      if (action.entities.length > 0) s.select(action.entities);
      return;
  }
}
